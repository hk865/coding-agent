/** M5 resume Composition：复用 Session 事实与 RecoveryCoordinator 继续未完成 Run。 */
import path from "node:path";

import type { ApprovalRequester } from "../../policy/approval/approval-coordinator.js";
import {
  ApprovalCoordinator,
  StaticApprovalRequester,
} from "../../policy/approval/approval-coordinator.js";
import {
  checksum,
  type RunConfigSnapshot,
  type SessionRecord,
} from "../../core/ports/session_store/session-store-port.js";
import { RecoveryCoordinator } from "../../core/runtime/recovery/recovery-coordinator.js";
import type { RecoveryAction } from "../../core/runtime/recovery/recovery-coordinator.js";
import { RuntimeRunner } from "../../core/runtime/loop/runtime-runner.js";
import type { RunState } from "../../core/runtime/state/run-state.js";
import { EmptyMemoryProvider } from "../../memory/providers/empty/empty-memory-provider.js";
import { createBuiltinProviderRegistry } from "../../model/providers/registry/builtin-provider-registry.js";
import type { ProviderRegistry } from "../../model/providers/registry/provider-registry.js";
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
import { assertSessionProfileCompatible, createAgentProfileIdentity } from "./agent-profile.js";
import type { AppConfig } from "./app-config.js";
import type { SecretSource } from "./composition-root.js";

export interface ResumeAppInput {
  readonly config: AppConfig;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly secretSource?: SecretSource;
  readonly approvalRequester?: ApprovalRequester;
  readonly providerRegistry?: ProviderRegistry;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void;
}

export interface ResumeAppResult {
  readonly sessionId: string;
  readonly state: RunState;
  readonly action: RecoveryAction;
  readonly enabledTools: readonly string[];
  readonly provider: string;
}

async function readRecords(
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

export async function resumeCodingAgent(input: Readonly<ResumeAppInput>): Promise<ResumeAppResult> {
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
  const policy = new DefaultPermissionPolicy({ policyVersion: "m5-v1" });
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
    baseConfigDigest: checksum(input.config),
  };
  const profile = createAgentProfileIdentity(input.config, snapshot);
  const currentWorkspace = {
    identity: workspace.identity,
    revision: await workspace.revision(),
    reference: "workspace:current",
  };
  const store = await SqliteStores.open(path.resolve(input.config.storage.databasePath));
  try {
    const header = await store.get(input.sessionId, { signal });
    assertSessionProfileCompatible(header, profile);
    const records = await readRecords(store, input.sessionId, signal);
    const turnRecord = records.findLast((record) => record.recordType === "turn.started");
    if (!turnRecord || turnRecord.recordType !== "turn.started") {
      throw new Error(`Session ${input.sessionId} 没有可恢复 Turn`);
    }
    const recovery = await new RecoveryCoordinator({ sessions: store, checkpoints: store }).recover(
      input.sessionId,
      { signal },
      { config: snapshot, workspace: currentWorkspace },
    );
    if (recovery.action === "terminal" || recovery.action === "side_effect_result_unknown") {
      return {
        sessionId: input.sessionId,
        state: recovery.state,
        action: recovery.action,
        enabledTools,
        provider: provider.id,
      };
    }

    const skillProvider = await (
      await FileSkillLoader.create(path.resolve(input.config.skills.resourceRoot))
    ).load(signal);
    const skills = await skillProvider.select(
      { schemaVersion: 1, requestedIds: input.config.skills.enabledIds },
      { signal },
    );
    const memory = new EmptyMemoryProvider();
    const memories = await memory.recall(
      {
        schemaVersion: 1,
        query: turnRecord.payload.run.turn.userMessage.content,
        workspaceIdentity: workspace.identity,
        limit: 20,
      },
      { signal },
    );
    const capabilities = new Set([
      "workspace_read" as const,
      "workspace_write" as const,
      ...(processProfile.available
        ? (["isolated_process", "network_isolated"] as const)
        : ([] as const)),
    ]);
    const dispatcher = new ToolDispatcher({
      registry: tools,
      permissionPolicy: policy,
      approval: new ApprovalCoordinator(
        input.approvalRequester ??
          new StaticApprovalRequester({ decision: "deny", reason: "interaction_unavailable" }),
      ),
      capabilities,
      runId: recovery.state.runId,
      workspaceIdentity: workspace.identity,
      workspaceRevision: () => workspace.revision(),
      sandboxProfileVersion: processProfile.version,
    });
    const sessionSink = await SessionEventSink.connect(store, input.sessionId, { signal });
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
      run: turnRecord.payload.run,
      baseSystemPrompt:
        "You are a coding agent. Use only the provided tools and stay within the workspace.",
      tools: tools.modelToolSpecs(),
      skills,
      memories,
      tokenBudget: input.config.runtime.tokenBudget,
      maxOutputTokens: input.config.model.maxOutputTokens,
    };
    const state =
      recovery.action === "paused"
        ? await runner.resume(recovery.state, context, { signal })
        : await runner.continueRecovered(recovery.state, context, { signal });
    return {
      sessionId: input.sessionId,
      state,
      action: recovery.action,
      enabledTools,
      provider: provider.id,
    };
  } finally {
    await store.close();
  }
}
