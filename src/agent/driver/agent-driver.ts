/**
 * 模块职责：串行领取 durable Inbox 消息，并把一次处理结果可靠标记为完成或释放。
 *
 * 设计边界：Driver 不直接修改 RunState，也不理解模型和工具；具体执行由 handler 注入。
 * 关键流程：claim -> handle -> complete；失败走 release，跨进程互斥由 InboxStore 租约保证。
 */
import { randomUUID } from "node:crypto";

import type {
  EnqueueInboxInput,
  EnqueueInboxResult,
  InboxCompletion,
  InboxItem,
  InboxStorePort,
} from "../../core/ports/inbox_store/inbox-store-port.js";
import type { StoreCallOptions } from "../../core/ports/session_store/session-store-port.js";

export interface AgentDriverHandlerResult<TResult> {
  readonly completion: InboxCompletion;
  readonly value: TResult;
}

export interface AgentDriverHandler<TResult> {
  handle(
    item: Extract<InboxItem, { status: "claimed" }>,
    options: Readonly<StoreCallOptions>,
  ): Promise<AgentDriverHandlerResult<TResult>>;
}

export interface AgentDriverRunResult<TResult> {
  readonly item: InboxItem;
  readonly value: TResult;
}

export interface AgentDriverOptions<TResult> {
  readonly inbox: InboxStorePort;
  readonly handler: AgentDriverHandler<TResult>;
  readonly driverId: string;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly claimTokenFactory?: () => string;
}

export class AgentDriverBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`AgentDriver 正在处理 Session ${sessionId}`);
    this.name = "AgentDriverBusyError";
  }
}

export class AgentDriver<TResult> {
  readonly #inbox: InboxStorePort;
  readonly #handler: AgentDriverHandler<TResult>;
  readonly #driverId: string;
  readonly #leaseMs: number;
  readonly #now: () => Date;
  readonly #claimTokenFactory: () => string;
  readonly #activeSessions = new Set<string>();

  constructor(options: Readonly<AgentDriverOptions<TResult>>) {
    if (!Number.isSafeInteger(options.leaseMs ?? 300_000) || (options.leaseMs ?? 300_000) <= 0) {
      throw new Error("leaseMs 必须为正整数");
    }
    if (options.driverId.trim().length === 0) throw new Error("driverId 不能为空");
    this.#inbox = options.inbox;
    this.#handler = options.handler;
    this.#driverId = options.driverId;
    this.#leaseMs = options.leaseMs ?? 300_000;
    this.#now = options.now ?? (() => new Date());
    this.#claimTokenFactory = options.claimTokenFactory ?? randomUUID;
  }

  submit(
    input: Readonly<EnqueueInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<EnqueueInboxResult> {
    return this.#inbox.enqueue(input, options);
  }

  async runNext(
    sessionId: string,
    options: Readonly<StoreCallOptions>,
  ): Promise<AgentDriverRunResult<TResult> | null> {
    if (this.#activeSessions.has(sessionId)) throw new AgentDriverBusyError(sessionId);
    this.#activeSessions.add(sessionId);
    try {
      const claimedAt = this.#now();
      const item = await this.#inbox.claimNext(
        {
          schemaVersion: 1,
          sessionId,
          claim: {
            claimToken: this.#claimTokenFactory(),
            claimedBy: this.#driverId,
            claimedAt: claimedAt.toISOString(),
            leaseExpiresAt: new Date(claimedAt.getTime() + this.#leaseMs).toISOString(),
          },
        },
        options,
      );
      if (!item) return null;
      if (item.status !== "claimed") throw new Error("InboxStore 返回了非 claimed item");

      let renewalError: unknown;
      let renewal = Promise.resolve();
      const lifecycleOptions = { signal: new AbortController().signal };
      const heartbeat = setInterval(
        () => {
          renewal = renewal.then(async () => {
            if (renewalError) return;
            const renewedAt = this.#now();
            try {
              await this.#inbox.renewClaim(
                {
                  schemaVersion: 1,
                  sessionId,
                  itemId: item.itemId,
                  claimToken: item.lastClaim.claimToken,
                  renewedAt: renewedAt.toISOString(),
                  leaseExpiresAt: new Date(renewedAt.getTime() + this.#leaseMs).toISOString(),
                },
                lifecycleOptions,
              );
            } catch (error) {
              renewalError = error;
            }
          });
        },
        Math.max(1, Math.floor(this.#leaseMs / 3)),
      );
      heartbeat.unref();
      let result: AgentDriverHandlerResult<TResult>;
      try {
        result = await this.#handler.handle(item, options);
      } catch (error) {
        clearInterval(heartbeat);
        await renewal;
        const message = error instanceof Error ? error.message : String(error);
        try {
          await this.#inbox.release(
            {
              schemaVersion: 1,
              sessionId,
              itemId: item.itemId,
              claimToken: item.lastClaim.claimToken,
              releasedAt: this.#now().toISOString(),
              failure: {
                code: error instanceof Error ? error.name : "unknown_error",
                message: message.length > 0 ? message : "Agent handler failed",
                retryable: true,
              },
            },
            lifecycleOptions,
          );
        } catch {
          // release 失败时租约仍会过期，不能用清理错误覆盖原始执行错误。
        }
        throw error;
      }
      clearInterval(heartbeat);
      await renewal;
      if (renewalError) throw renewalError;
      // handler 已成功后，complete 失败不能 release，否则会立即重复外部副作用。
      const completed = await this.#inbox.complete(
        {
          schemaVersion: 1,
          sessionId,
          itemId: item.itemId,
          claimToken: item.lastClaim.claimToken,
          completedAt: this.#now().toISOString(),
          completion: result.completion,
        },
        lifecycleOptions,
      );
      return { item: completed, value: result.value };
    } finally {
      this.#activeSessions.delete(sessionId);
    }
  }
}
