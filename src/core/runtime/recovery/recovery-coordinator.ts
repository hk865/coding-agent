/**
 * 模块职责：从 Session 事件日志和可选 checkpoint 恢复 Run，并消解进程中断窗口。
 *
 * 设计边界：Session 记录是事实来源；checkpoint 只能加速，不能覆盖较新的已提交事件。
 * 关键流程：选择并验签 checkpoint，重放后续事件，核对环境，再生成必要的对账事件和恢复动作。
 */
import { randomUUID } from "node:crypto";

import type {
  Checkpoint,
  CheckpointStorePort,
} from "../../ports/checkpoint_store/checkpoint-store-port.js";
import { assertCheckpointChecksum } from "../../ports/checkpoint_store/checkpoint-store-port.js";
import type {
  RunConfigSnapshot,
  SessionRecord,
  SessionStorePort,
  StoreCallOptions,
  WorkspaceReference,
} from "../../ports/session_store/session-store-port.js";
import { canonicalJson, StoreError } from "../../ports/session_store/session-store-port.js";
import type { AgentEvent } from "../events/agent-events.js";
import { reduceRunState } from "../reducer/run-state-reducer.js";
import {
  createInitialRunState,
  deriveRunPhase,
  isTerminalRunStatus,
  validateRunStateInvariants,
} from "../state/run-state.js";
import type { RunState } from "../state/run-state.js";

export type RecoveryAction =
  | "start_run"
  | "continue_before_model"
  | "continue_before_tools"
  | "paused"
  | "terminal"
  | "side_effect_result_unknown";

export interface RecoveryResult {
  readonly sessionId: string;
  readonly revision: number;
  readonly lastPosition: number;
  readonly state: RunState;
  readonly action: RecoveryAction;
  readonly checkpointId: string | null;
  readonly reconciledEvent: AgentEvent | null;
}

export interface RecoveryEnvironment {
  readonly config: RunConfigSnapshot;
  readonly workspace: WorkspaceReference;
}

export interface RecoveryCoordinatorDependencies {
  readonly sessions: SessionStorePort;
  readonly checkpoints?: CheckpointStorePort;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

/**
 * 以 append-only Session 事实为真相恢复状态；checkpoint 只用于加速。
 * 恢复器先消解进程中断窗口，再把稳定状态交给 RuntimeRunner 继续。
 */
export class RecoveryCoordinator {
  readonly #sessions: SessionStorePort;
  readonly #checkpoints: CheckpointStorePort | undefined;
  readonly #idFactory: () => string;
  readonly #now: () => Date;

  constructor(dependencies: RecoveryCoordinatorDependencies) {
    this.#sessions = dependencies.sessions;
    this.#checkpoints = dependencies.checkpoints;
    this.#idFactory = dependencies.idFactory ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async recover(
    sessionId: string,
    options: Readonly<StoreCallOptions>,
    environment?: Readonly<RecoveryEnvironment>,
  ): Promise<RecoveryResult> {
    const header = await this.#sessions.get(sessionId, options);
    const records = await this.#readAll(sessionId, options);
    const turnIndex = records.findLastIndex((record) => record.recordType === "turn.started");
    if (turnIndex < 0) throw new StoreError("not_found", "Session 尚无可恢复 Turn");
    const turnRecord = records[turnIndex]!;
    if (turnRecord.recordType !== "turn.started")
      throw new StoreError("corrupt", "Turn record 非法");
    const runId = turnRecord.payload.run.runId;
    const runRecords = records.slice(turnIndex);
    const { checkpoint, state: checkpointState } = await this.#selectCheckpoint(
      turnRecord,
      runRecords,
      options,
    );
    let state = checkpointState ?? createInitialRunState(turnRecord.payload.run);
    const cursor = checkpoint?.recordPosition ?? turnRecord.position;
    for (const record of runRecords) {
      if (record.position <= cursor || record.recordType !== "agent.event") continue;
      if (record.payload.event.meta.runId !== runId) break;
      state = reduceRunState(state, record.payload.event);
    }
    let revision = header.revision;
    let lastPosition = records.at(-1)?.position ?? 0;
    let reconciledEvent: AgentEvent | null = null;
    let action: RecoveryAction;

    const runningTool = state.toolBatch?.calls.some((call) => call.status === "running") ?? false;
    const recoveredPhase = deriveRunPhase(state);
    const willContinue =
      !isTerminalRunStatus(state.status) &&
      state.status !== "paused" &&
      !runningTool &&
      recoveredPhase !== "ready_to_complete";
    if (willContinue) {
      this.#assertCompatibleEnvironment(
        turnRecord.payload.config,
        this.#workspaceAtState(checkpoint?.workspace ?? turnRecord.payload.workspace, state),
        environment,
      );
    }

    if (isTerminalRunStatus(state.status)) action = "terminal";
    else if (state.status === "paused") action = "paused";
    else if (state.activeModelRequest) {
      reconciledEvent = this.#event(state, "model.request_failed", {
        requestId: state.activeModelRequest.requestId,
        failure: {
          category: "model",
          code: "process_interrupted",
          message: "模型请求因进程中断，允许以新 requestId 重试",
          retryable: true,
          operationId: state.activeModelRequest.requestId,
        },
      });
      ({ state, revision, lastPosition } = await this.#appendReconciliation(
        sessionId,
        revision,
        state,
        reconciledEvent,
        options,
      ));
      action = "continue_before_model";
    } else if (state.toolBatch?.calls.some((call) => call.status === "running")) {
      const running = state.toolBatch.calls.find((call) => call.status === "running")!;
      reconciledEvent = this.#event(state, "run.failed", {
        failure: {
          category: "tool_executor",
          code: "side_effect_result_unknown",
          message: `工具 ${running.requestedCall.name} 的结果未知；原 Run 不会自动重放`,
          retryable: false,
          operationId: running.requestedCall.callId,
        },
      });
      ({ state, revision, lastPosition } = await this.#appendReconciliation(
        sessionId,
        revision,
        state,
        reconciledEvent,
        options,
      ));
      action = "side_effect_result_unknown";
    } else {
      const phase = deriveRunPhase(state);
      if (phase === "ready_to_complete") {
        const last = state.transcript.at(-1);
        if (last?.kind !== "assistant_message") throw new StoreError("corrupt", "最终消息缺失");
        reconciledEvent = this.#event(state, "run.completed", {
          finalMessageId: last.message.messageId,
        });
        ({ state, revision, lastPosition } = await this.#appendReconciliation(
          sessionId,
          revision,
          state,
          reconciledEvent,
          options,
        ));
        action = "terminal";
      } else if (phase === "before_tools") action = "continue_before_tools";
      else if (phase === "created") action = "start_run";
      else action = "continue_before_model";
    }

    return {
      sessionId,
      revision,
      lastPosition,
      state,
      action,
      checkpointId: checkpoint?.checkpointId ?? null,
      reconciledEvent,
    };
  }

  async #readAll(sessionId: string, options: Readonly<StoreCallOptions>): Promise<SessionRecord[]> {
    const records: SessionRecord[] = [];
    let position = 0;
    while (true) {
      const page = await this.#sessions.read(sessionId, position, 256, options);
      records.push(...page.records);
      position = page.records.at(-1)?.position ?? position;
      if (page.nextPosition === null) return records;
    }
  }

  async #selectCheckpoint(
    turnRecord: Extract<SessionRecord, { recordType: "turn.started" }>,
    records: readonly SessionRecord[],
    options: Readonly<StoreCallOptions>,
  ): Promise<{ checkpoint: Checkpoint | null; state: RunState | null }> {
    if (!this.#checkpoints) return { checkpoint: null, state: null };
    const candidates = this.#checkpoints.listCheckpointCandidates
      ? await this.#checkpoints.listCheckpointCandidates(turnRecord.payload.run.runId, options)
      : (await this.#checkpoints.listCheckpoints(turnRecord.payload.run.runId, options)).map(
          (checkpoint) => ({ checkpointId: checkpoint.checkpointId, checkpoint }),
        );
    const invalid: string[] = [];
    for (const candidate of candidates) {
      const checkpoint = candidate.checkpoint;
      if (!checkpoint) {
        invalid.push(candidate.checkpointId);
        continue;
      }
      try {
        assertCheckpointChecksum(checkpoint);
        if (
          checkpoint.sessionId !== turnRecord.sessionId ||
          checkpoint.turnId !== turnRecord.payload.run.turn.turnId ||
          checkpoint.recordPosition < turnRecord.position ||
          canonicalJson(checkpoint.config) !== canonicalJson(turnRecord.payload.config) ||
          checkpoint.workspace.identity !== turnRecord.payload.workspace.identity ||
          checkpoint.workspace.reference !== turnRecord.payload.workspace.reference
        ) {
          throw new Error("checkpoint identity mismatch");
        }
        const cursorRecord = records.find(
          (record) => record.position === checkpoint.recordPosition,
        );
        if (
          checkpoint.lastEventSequence > 0 &&
          (cursorRecord?.recordType !== "agent.event" ||
            cursorRecord.payload.event.meta.eventId !== checkpoint.lastEventId)
        ) {
          throw new Error("checkpoint cursor mismatch");
        }
        const invariant = validateRunStateInvariants(checkpoint.state);
        if (!invariant.ok) throw new Error(invariant.message);
        if (invalid.length > 0) {
          await this.#checkpoints.deleteInvalid(invalid, options).catch(() => 0);
        }
        return { checkpoint, state: structuredClone(checkpoint.state) };
      } catch {
        invalid.push(checkpoint.checkpointId);
      }
    }
    if (invalid.length > 0) await this.#checkpoints.deleteInvalid(invalid, options).catch(() => 0);
    return { checkpoint: null, state: null };
  }

  #workspaceAtState(base: WorkspaceReference, state: Readonly<RunState>): WorkspaceReference {
    let revision = base.revision;
    for (const entry of state.transcript) {
      if (entry.kind === "tool_result" && entry.result.effects.workspaceRevision) {
        revision = entry.result.effects.workspaceRevision;
      }
    }
    return revision === base.revision ? base : { ...base, revision };
  }

  #assertCompatibleEnvironment(
    recordedConfig: RunConfigSnapshot,
    recordedWorkspace: WorkspaceReference,
    environment: Readonly<RecoveryEnvironment> | undefined,
  ): void {
    if (!environment) {
      throw new StoreError("conflict", "继续恢复需要提供当前 workspace 与运行配置");
    }
    if (canonicalJson(environment.config) !== canonicalJson(recordedConfig)) {
      throw new StoreError("conflict", "当前运行配置与 Session 记录不兼容");
    }
    if (
      environment.workspace.identity !== recordedWorkspace.identity ||
      environment.workspace.revision !== recordedWorkspace.revision ||
      environment.workspace.reference !== recordedWorkspace.reference
    ) {
      throw new StoreError("conflict", "当前 workspace 与 Session 记录不兼容");
    }
  }

  #event<TType extends AgentEvent["type"]>(
    state: RunState,
    type: TType,
    payload: Extract<AgentEvent, { type: TType }>["payload"],
  ): Extract<AgentEvent, { type: TType }> {
    return {
      type,
      meta: {
        schemaVersion: 1,
        eventId: `recovery:${this.#idFactory()}`,
        runId: state.runId,
        turnId: state.turn.turnId,
        sequence: state.lastEventSequence + 1,
        occurredAt: this.#now().toISOString(),
        elapsedMs: state.elapsedMs,
      },
      payload,
    } as Extract<AgentEvent, { type: TType }>;
  }

  async #appendReconciliation(
    sessionId: string,
    revision: number,
    state: RunState,
    event: AgentEvent,
    options: Readonly<StoreCallOptions>,
  ): Promise<{ state: RunState; revision: number; lastPosition: number }> {
    const next = reduceRunState(state, event);
    const result = await this.#sessions.append(
      sessionId,
      revision,
      [
        {
          recordId: `agent-event:${event.meta.eventId}`,
          recordType: "agent.event",
          schemaVersion: 1,
          recordedAt: event.meta.occurredAt,
          payload: { event },
        },
      ],
      options,
    );
    return { state: next, revision: result.revision, lastPosition: result.positions[0]! };
  }
}
