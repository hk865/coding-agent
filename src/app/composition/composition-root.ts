/** M5 生产 Composition Root：装配 Provider、工具、安全链、Session 与 Runtime。 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { AgentDriver } from "../../agent/driver/agent-driver.js";
import type { ApprovalRequester } from "../../policy/approval/approval-coordinator.js";
import {
  ApprovalCoordinator,
  StaticApprovalRequester,
} from "../../policy/approval/approval-coordinator.js";
import {
  checksum,
  type RunConfigSnapshot,
  type SessionRecord,
  StoreError,
} from "../../core/ports/session_store/session-store-port.js";
import { RuntimeRunner } from "../../core/runtime/loop/runtime-runner.js";
import { RecoveryCoordinator } from "../../core/runtime/recovery/recovery-coordinator.js";
import type { RunState } from "../../core/runtime/state/run-state.js";
import type { ProviderRegistry } from "../../model/providers/registry/provider-registry.js";
import { EmptyMemoryProvider } from "../../memory/providers/empty/empty-memory-provider.js";
import { createBuiltinProviderRegistry } from "../../model/providers/registry/builtin-provider-registry.js";
import { DefaultPermissionPolicy } from "../../policy/permissions/permission-policy.js";
import { ProcessSandbox } from "../../sandbox/process/process-sandbox.js";
import { WorkspaceSandbox } from "../../sandbox/workspace/workspace-sandbox.js";
import { FileSkillLoader } from "../../skills/loader/file-skill-loader.js";
import { SqliteStores } from "../../storage/adapters/sqlite/sqlite-stores.js";
import { SessionEventSink } from "../../storage/session_event_sink/session-event-sink.js";
import { createEditToolDefinition } from "../../tools/builtin/edit/edit-tool.js";
import { createReadToolDefinition } from "../../tools/builtin/read/read-tool.js";
import { createShellToolDefinition } from "../../tools/builtin/shell/shell-tool.js";
import { ToolDispatcher } from "../../tools/dispatcher/tool-dispatcher.js";
import { RegistryToolBatchPolicy, ToolRegistry } from "../../tools/registry/tool-registry.js";
import {
  assertSessionProfileCompatible,
  createAgentProfileIdentity,
  ROOT_SESSION_LINEAGE,
} from "./agent-profile.js";
import type { AppConfig } from "./app-config.js";

export interface SecretSource {
  get(name: string): string | undefined;
}

export interface RunAppInput {
  readonly config: AppConfig;
  readonly workspaceRoot: string;
  readonly input: string;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  readonly secretSource?: SecretSource;
  readonly approvalRequester?: ApprovalRequester;
  readonly providerRegistry?: ProviderRegistry;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void;
}

export interface RunAppResult {
  readonly sessionId: string;
  readonly state: RunState;
  readonly enabledTools: readonly string[];
  readonly provider: string;
  readonly inboxItemId: string;
}

async function readSessionRecords(
  store: SqliteStores,
  sessionId: string,
  signal: AbortSignal,
): Promise<readonly SessionRecord[]> {
  const records: SessionRecord[] = [];
  let position = 0;
  while (true) {
    const page = await store.read(sessionId, position, 256, { signal });
    records.push(...page.records);
    position = page.records.at(-1)?.position ?? position;
    if (page.nextPosition === null) return records;
  }
}

export async function runCodingAgent(input: Readonly<RunAppInput>): Promise<RunAppResult> {
  if (input.input.trim().length === 0) throw new Error("input 不能为空");
  const signal = input.signal ?? new AbortController().signal;
  const providerRegistry = input.providerRegistry ?? createBuiltinProviderRegistry();
  const provider = providerRegistry.get(input.config.model.provider);
  const source = input.secretSource ?? { get: (name: string) => process.env[name] };
  const apiKey = source.get(provider.secretEnvironmentVariable);
  if (!apiKey?.trim()) throw new Error(`${provider.secretEnvironmentVariable} 缺失或非法`);
  const modelClient = providerRegistry.create(provider.id, {
    apiKey,
    model: input.config.model.model,
    ...(input.config.model.baseUrl ? { baseUrl: input.config.model.baseUrl } : {}),
    options: input.config.model.options,
  });

  const workspaceRoot = path.resolve(input.workspaceRoot);
  const workspace = await WorkspaceSandbox.create(workspaceRoot);
  const processProfile = await ProcessSandbox.probe(workspaceRoot, workspace);
  const processSandbox = new ProcessSandbox(processProfile, workspaceRoot, workspace);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createReadToolDefinition(workspace));
  toolRegistry.register(createEditToolDefinition(workspace));
  toolRegistry.register(createShellToolDefinition(processSandbox));
  const tools = toolRegistry.freeze(input.config.tools.enabledNames);
  const enabledTools = tools.list().map((tool) => tool.name);
  const capabilities = new Set([
    "workspace_read" as const,
    "workspace_write" as const,
    ...(processProfile.available
      ? (["isolated_process", "network_isolated"] as const)
      : ([] as const)),
  ]);

  const sessionId = input.sessionId ?? randomUUID();
  const now = new Date().toISOString();
  if (input.idempotencyKey !== undefined && input.idempotencyKey.trim().length === 0) {
    throw new Error("idempotencyKey 不能为空");
  }
  const idempotencyKey = input.idempotencyKey?.trim() ?? randomUUID();
  const inboxIdentity = checksum({ sessionId, idempotencyKey });
  const inboxItemId = `inbox:${inboxIdentity}`;
  const policy = new DefaultPermissionPolicy({ policyVersion: "m5-v1" });
  const baseDigest = checksum(input.config);
  const limits = {
    maxModelRequests: input.config.runtime.maxModelRequests,
    maxToolCalls: input.config.runtime.maxToolCalls,
    maxInputTokens: null,
    maxOutputTokens: null,
    maxTotalTokens: null,
    maxCostUsdMicros: null,
    deadlineMs: null,
  };
  const snapshot: RunConfigSnapshot = {
    modelConfigId: `${provider.id}:${input.config.model.model}`,
    limits,
    enabledToolSchemaDigest: checksum(tools.modelToolSpecs()),
    policyVersion: policy.policyVersion,
    sandboxProfileVersion: processProfile.version,
    baseConfigDigest: baseDigest,
  };
  const profile = createAgentProfileIdentity(input.config, snapshot);

  const store = await SqliteStores.open(path.resolve(input.config.storage.databasePath));
  try {
    try {
      const existing = await store.get(sessionId, { signal });
      assertSessionProfileCompatible(existing, profile);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "not_found") {
        await store.create(
          {
            schemaVersion: 2,
            sessionId,
            recordId: `session:${sessionId}`,
            createdAt: now,
            lineage: ROOT_SESSION_LINEAGE,
            profile,
          },
          { signal },
        );
      } else throw error;
    }
    const queued = await store.enqueue(
      {
        schemaVersion: 1,
        itemId: inboxItemId,
        sessionId,
        idempotencyKey,
        acceptedAt: now,
        message: {
          schemaVersion: 1,
          messageId: `message:${inboxIdentity}`,
          role: "user",
          content: input.input,
        },
      },
      { signal },
    );
    if (queued.item.status === "completed") {
      throw new StoreError("conflict", "该幂等请求已完成，不会重复执行");
    }

    const skillLoader = await FileSkillLoader.create(
      path.resolve(input.config.skills.resourceRoot),
    );
    const skillProvider = await skillLoader.load(signal);
    const skills = await skillProvider.select(
      { schemaVersion: 1, requestedIds: input.config.skills.enabledIds },
      { signal },
    );
    const driver = new AgentDriver<RunState>({
      inbox: store,
      driverId: `composition:${randomUUID()}`,
      leaseMs: 300_000,
      handler: {
        async handle(item, handlerOptions) {
          const runId = `inbox-run:${item.itemId}`;
          const turnId = `inbox-turn:${item.itemId}`;
          const newRun = {
            schemaVersion: 1 as const,
            runId,
            turn: { turnId, userMessage: item.message },
            createdAt: new Date().toISOString(),
          };
          const currentWorkspace = {
            identity: workspace.identity,
            revision: await workspace.revision(),
            reference: "workspace:current",
          };
          const records = await readSessionRecords(store, sessionId, handlerOptions.signal);
          const recordedTurn = records.find(
            (record): record is Extract<SessionRecord, { recordType: "turn.started" }> =>
              record.recordType === "turn.started" && record.payload.run.runId === runId,
          );
          const run = recordedTurn?.payload.run ?? newRun;
          let recovered: Awaited<ReturnType<RecoveryCoordinator["recover"]>> | undefined;
          if (recordedTurn) {
            recovered = await new RecoveryCoordinator({
              sessions: store,
              checkpoints: store,
            }).recover(sessionId, handlerOptions, {
              config: snapshot,
              workspace: currentWorkspace,
            });
            if (recovered.state.runId !== runId) {
              throw new StoreError("conflict", "Inbox item 不是 Session 的最新 Turn");
            }
            if (
              recovered.action === "terminal" ||
              recovered.action === "side_effect_result_unknown"
            ) {
              return {
                completion: { runId, turnId },
                value: recovered.state,
              };
            }
          } else {
            const header = await store.get(sessionId, handlerOptions);
            if (header.activeRunId) {
              throw new StoreError("conflict", `Session ${sessionId} 仍有其他活动 Run`);
            }
            await store.append(
              sessionId,
              header.revision,
              [
                {
                  recordId: `turn:${turnId}`,
                  recordType: "turn.started",
                  schemaVersion: 1,
                  recordedAt: run.createdAt,
                  payload: { run, config: snapshot, workspace: currentWorkspace },
                },
              ],
              handlerOptions,
            );
          }

          const memories = await new EmptyMemoryProvider().recall(
            {
              schemaVersion: 1,
              query: item.message.content,
              workspaceIdentity: workspace.identity,
              limit: 20,
            },
            handlerOptions,
          );
          const dispatcher = new ToolDispatcher({
            registry: tools,
            permissionPolicy: policy,
            approval: new ApprovalCoordinator(
              input.approvalRequester ??
                new StaticApprovalRequester({
                  decision: "deny",
                  reason: "interaction_unavailable",
                }),
            ),
            capabilities,
            runId,
            workspaceIdentity: workspace.identity,
            workspaceRevision: () => workspace.revision(),
            sandboxProfileVersion: processProfile.version,
          });
          const sessionSink = await SessionEventSink.connect(store, sessionId, handlerOptions);
          const runner = new RuntimeRunner({
            modelClient,
            toolExecutor: dispatcher,
            eventSinks: [sessionSink],
            limits,
            toolBatchPolicy: new RegistryToolBatchPolicy(tools),
            maxModelRetries: 0,
            ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
          });
          const context = {
            run,
            baseSystemPrompt:
              "You are a coding agent. Use only the provided tools and stay within the workspace.",
            tools: tools.modelToolSpecs(),
            skills,
            memories,
            tokenBudget: input.config.runtime.tokenBudget,
            maxOutputTokens: input.config.model.maxOutputTokens,
          };
          const state = recovered
            ? recovered.action === "paused"
              ? await runner.resume(recovered.state, context, handlerOptions)
              : await runner.continueRecovered(recovered.state, context, handlerOptions)
            : await runner.run(context, handlerOptions);
          return { completion: { runId, turnId }, value: state };
        },
      },
    });

    while (true) {
      const processed = await driver.runNext(sessionId, { signal });
      if (!processed) {
        throw new StoreError("busy", "Session Inbox 当前由其他 Driver 处理");
      }
      if (processed.item.itemId === inboxItemId) {
        return {
          sessionId,
          state: processed.value,
          enabledTools,
          provider: provider.id,
          inboxItemId,
        };
      }
    }
  } finally {
    await store.close();
  }
}
