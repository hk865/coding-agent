/**
 * 模块职责：实现 Agent 主循环，串联上下文、Hook、模型、工具、事件和状态机。
 *
 * 设计边界：Runner 只依赖 Core 端口；权限、沙箱、存储和模型供应商由外层实现注入。
 * 关键流程：选择并构建上下文，调用模型，处理工具组，把每一步结果提交为事件，直到终态。
 */
import { randomUUID } from "node:crypto";

import type {
  ContextBuilderInput,
  ContextBuilderPort,
} from "../../context/builder/context-builder.js";
import { DeterministicContextBuilder } from "../../context/builder/context-builder.js";
import {
  CharacterTokenEstimator,
  ContextSelectionError,
  estimateTokens,
  selectContext,
} from "../../context/selection_policy/context-selection-policy.js";
import type { TokenEstimator } from "../../context/selection_policy/context-selection-policy.js";
import type {
  ContextFragment,
  MemoryItem,
  SkillContext,
} from "../../context/types/context-types.js";
import { HookExecutionError, HookExecutor } from "../../hooks/executor/hook-executor.js";
import type {
  ModelClientPort,
  ModelRequest,
  ModelToolSpec,
} from "../../ports/model_client/model-client-port.js";
import {
  assertToolResultMatchesCall,
  toolResultSchema,
} from "../../ports/tool_executor/tool-executor-port.js";
import { SerialToolBatchPolicy } from "../../ports/tool_batch_policy/tool-batch-policy-port.js";
import type {
  ToolBatchPolicy,
  ToolExecutionGroup,
} from "../../ports/tool_batch_policy/tool-batch-policy-port.js";
import type {
  FailedToolResult,
  ToolCall,
  ToolExecutorPort,
  ToolResult,
} from "../../ports/tool_executor/tool-executor-port.js";
import type { EventSinkPort } from "../../ports/event_sink/event-sink-port.js";
import { CancellationController } from "../cancellation/cancellation-controller.js";
import type { CancellationReason } from "../cancellation/cancellation-controller.js";
import { agentEventSchema } from "../events/agent-events.js";
import type { AgentEvent } from "../events/agent-events.js";
import { LimitGuard, UNLIMITED_RUN_LIMITS } from "../limits/limit-guard.js";
import type { LimitViolation, RunLimits } from "../limits/limit-guard.js";
import { reduceRunState } from "../reducer/run-state-reducer.js";
import {
  createInitialRunState,
  deriveRunPhase,
  isTerminalRunStatus,
  runStateSchema,
} from "../state/run-state.js";
import type { Run, RunFailure, RunState, TranscriptEntry } from "../state/run-state.js";
import { consumeModelStream } from "./model-stream-consumer.js";
import {
  EventDeliveryCoordinator,
  RequiredSinkError,
} from "../event_delivery/event-delivery-coordinator.js";

export interface RuntimeClock {
  now(): Date;
}

export interface RuntimeIdGenerator {
  next(): string;
}

export interface RunnerContextInput {
  readonly run: Run;
  readonly baseSystemPrompt: string;
  readonly additionalInstructions?: readonly ContextFragment[];
  readonly tools?: readonly ModelToolSpec[];
  readonly skills?: readonly SkillContext[];
  readonly memories?: readonly MemoryItem[];
  readonly tokenBudget: number;
  readonly maxOutputTokens?: number | null;
}

export interface RunnerCallOptions {
  readonly signal?: AbortSignal;
  readonly cancellationReason?: CancellationReason;
}

export interface RuntimeRunnerDependencies {
  readonly modelClient: ModelClientPort;
  readonly toolExecutor: ToolExecutorPort;
  readonly contextBuilder?: ContextBuilderPort;
  readonly tokenEstimator?: TokenEstimator;
  readonly hookExecutor?: HookExecutor;
  readonly eventSinks?: readonly EventSinkPort[];
  readonly limits?: RunLimits;
  readonly clock?: RuntimeClock;
  readonly idGenerator?: RuntimeIdGenerator;
  readonly toolBatchPolicy?: ToolBatchPolicy;
  readonly maxModelRetries?: number;
  readonly eventSinkTimeoutMs?: number;
  readonly onTextDelta?: (delta: string, requestId: string) => void;
  readonly onReasoningDelta?: (delta: string, requestId: string) => void;
}

class SystemClock implements RuntimeClock {
  now(): Date {
    return new Date();
  }
}

class RandomIdGenerator implements RuntimeIdGenerator {
  next(): string {
    return randomUUID();
  }
}

export class RunnerBusyError extends Error {
  readonly code = "runner_busy";

  constructor() {
    super("同一个 RuntimeRunner 不能并发运行两个 Run");
    this.name = "RunnerBusyError";
  }
}

type ExecutionMode = "start" | "resume" | "continue";

interface ExecutionContext {
  readonly input: RunnerContextInput;
  readonly cancellation: CancellationController;
  readonly unlink: () => void;
  readonly startedEpochMs: number;
  readonly initialElapsedMs: number;
  readonly presentations: Map<string, ToolResult["output"]>;
}

function failure(
  category: RunFailure["category"],
  code: string,
  message: string,
  operationId: string | null = null,
  retryable = false,
): RunFailure {
  return { category, code, message, retryable, operationId };
}

function hookFailure(error: unknown): RunFailure {
  if (error instanceof HookExecutionError) {
    return failure("hook", error.code, error.message, error.hookId);
  }
  return failure("hook", "hook_failed", error instanceof Error ? error.message : "Hook 失败");
}

function cancelledToFailure(
  result: Extract<ToolResult, { status: "cancelled" }>,
): FailedToolResult {
  return {
    schemaVersion: 1,
    callId: result.callId,
    status: "error",
    error: { code: "execution_failed", message: result.reason, retryable: true },
    output: result.output,
    effects: result.effects,
  };
}

function withPresentations(
  transcript: readonly TranscriptEntry[],
  presentations: ReadonlyMap<string, ToolResult["output"]>,
): readonly TranscriptEntry[] {
  return transcript.map((entry) => {
    if (entry.kind !== "tool_result") return entry;
    const output = presentations.get(entry.callId);
    return output ? { ...entry, result: { ...entry.result, output } as ToolResult } : entry;
  });
}

function validatePlan(
  calls: readonly ToolCall[],
  groups: readonly ToolExecutionGroup[],
): readonly ToolExecutionGroup[] {
  const expected = calls.map((call) => call.callId).sort();
  const actual = groups.flatMap((group) => group.callIds).sort();
  if (
    expected.length !== actual.length ||
    expected.some((callId, index) => callId !== actual[index]) ||
    groups.some(
      (group) =>
        group.callIds.length === 0 || (group.mode === "serial" && group.callIds.length !== 1),
    )
  ) {
    throw new Error("ToolBatchPolicy 必须恰好覆盖所有调用，serial 组必须只有一个调用");
  }
  return groups;
}

/**
 * Runtime 的唯一编排入口：所有状态变化先构造 AgentEvent，再经 required sink
 * 提交和 Reducer 推进；模型、Hook、工具都不能直接修改 RunState。
 */
export class RuntimeRunner {
  readonly #modelClient: ModelClientPort;
  readonly #toolExecutor: ToolExecutorPort;
  readonly #contextBuilder: ContextBuilderPort;
  readonly #tokenEstimator: TokenEstimator;
  readonly #hooks: HookExecutor;
  readonly #delivery: EventDeliveryCoordinator;
  readonly #limitGuard: LimitGuard;
  readonly #clock: RuntimeClock;
  readonly #ids: RuntimeIdGenerator;
  readonly #toolBatchPolicy: ToolBatchPolicy;
  readonly #maxModelRetries: number;
  readonly #onTextDelta: ((delta: string, requestId: string) => void) | undefined;
  readonly #onReasoningDelta: ((delta: string, requestId: string) => void) | undefined;
  #busy = false;

  constructor(dependencies: RuntimeRunnerDependencies) {
    this.#modelClient = dependencies.modelClient;
    this.#toolExecutor = dependencies.toolExecutor;
    this.#contextBuilder = dependencies.contextBuilder ?? new DeterministicContextBuilder();
    this.#tokenEstimator = dependencies.tokenEstimator ?? new CharacterTokenEstimator();
    this.#hooks = dependencies.hookExecutor ?? new HookExecutor();
    this.#delivery = new EventDeliveryCoordinator(
      dependencies.eventSinks,
      undefined,
      dependencies.eventSinkTimeoutMs,
    );
    this.#limitGuard = new LimitGuard(dependencies.limits ?? UNLIMITED_RUN_LIMITS);
    this.#clock = dependencies.clock ?? new SystemClock();
    this.#ids = dependencies.idGenerator ?? new RandomIdGenerator();
    this.#toolBatchPolicy = dependencies.toolBatchPolicy ?? new SerialToolBatchPolicy();
    this.#maxModelRetries = dependencies.maxModelRetries ?? 0;
    if (!Number.isSafeInteger(this.#maxModelRetries) || this.#maxModelRetries < 0) {
      throw new RangeError("maxModelRetries 必须是非负安全整数");
    }
    this.#onTextDelta = dependencies.onTextDelta;
    this.#onReasoningDelta = dependencies.onReasoningDelta;
  }

  async run(
    input: Readonly<RunnerContextInput>,
    options: RunnerCallOptions = {},
  ): Promise<RunState> {
    return this.#guardedExecute(createInitialRunState(input.run), input, "start", options);
  }

  async resume(
    pausedState: Readonly<RunState>,
    input: Readonly<RunnerContextInput>,
    options: RunnerCallOptions = {},
  ): Promise<RunState> {
    const state = runStateSchema.parse(pausedState);
    if (state.status !== "paused") throw new Error("只有 paused RunState 可以 resume");
    if (state.runId !== input.run.runId) throw new Error("resume input 的 runId 不匹配");
    return this.#guardedExecute(state, input, "resume", options);
  }

  /**
   * 接收 RecoveryCoordinator 已完成 reconciliation 的稳定状态。
   * awaiting_model 或 running tool 必须先由恢复器消解，不能在这里猜测执行结果。
   */
  async continueRecovered(
    recoveredState: Readonly<RunState>,
    input: Readonly<RunnerContextInput>,
    options: RunnerCallOptions = {},
  ): Promise<RunState> {
    const state = runStateSchema.parse(recoveredState);
    if (state.runId !== input.run.runId) throw new Error("recovery input 的 runId 不匹配");
    if (isTerminalRunStatus(state.status)) return state;
    if (state.status === "paused") throw new Error("paused 状态请使用 resume");
    if (
      state.activeModelRequest ||
      state.toolBatch?.calls.some((call) => call.status === "running")
    ) {
      throw new Error("恢复状态仍包含未 reconciliation 的运行中操作");
    }
    const phase = deriveRunPhase(state);
    if (phase === "awaiting_model") throw new Error("恢复状态仍在等待模型结果");
    return this.#guardedExecute(state, input, phase === "created" ? "start" : "continue", options);
  }

  async #guardedExecute(
    initialState: RunState,
    input: Readonly<RunnerContextInput>,
    mode: ExecutionMode,
    options: RunnerCallOptions,
  ): Promise<RunState> {
    if (this.#busy) throw new RunnerBusyError();
    this.#busy = true;
    const cancellation = new CancellationController();
    const unlink = cancellation.link(
      options.signal,
      options.cancellationReason ?? "caller_requested",
    );
    const context: ExecutionContext = {
      input: {
        ...input,
        additionalInstructions: input.additionalInstructions ?? [],
        tools: input.tools ?? [],
        skills: input.skills ?? [],
        memories: input.memories ?? [],
        maxOutputTokens: input.maxOutputTokens ?? null,
      },
      cancellation,
      unlink,
      startedEpochMs: this.#clock.now().getTime(),
      initialElapsedMs: initialState.elapsedMs,
      presentations: new Map(),
    };
    try {
      return await this.#execute(initialState, context, mode);
    } finally {
      unlink();
      this.#busy = false;
    }
  }

  #elapsed(context: ExecutionContext, floor = context.initialElapsedMs): number {
    return Math.max(
      floor,
      context.initialElapsedMs + Math.max(0, this.#clock.now().getTime() - context.startedEpochMs),
    );
  }

  #createEvent(
    state: Readonly<RunState>,
    context: ExecutionContext,
    type: AgentEvent["type"],
    payload: unknown,
  ): AgentEvent {
    const now = this.#clock.now();
    return agentEventSchema.parse({
      type,
      meta: {
        schemaVersion: 1,
        eventId: this.#ids.next(),
        runId: state.runId,
        turnId: state.turn.turnId,
        sequence: state.lastEventSequence + 1,
        occurredAt: now.toISOString(),
        elapsedMs: this.#elapsed(context, state.elapsedMs),
      },
      payload,
    });
  }

  async #commit(
    state: RunState,
    context: ExecutionContext,
    type: AgentEvent["type"],
    payload: unknown,
    excludedSinkIds: ReadonlySet<string> = new Set(),
  ): Promise<RunState> {
    const event = this.#createEvent(state, context, type, payload);
    const deliverySignal = new AbortController().signal;
    try {
      return await this.#delivery.commit(state, event, deliverySignal, excludedSinkIds);
    } catch (error) {
      if (!(error instanceof RequiredSinkError)) throw error;
      const candidate = reduceRunState(state, event);
      if (isTerminalRunStatus(candidate.status)) return candidate;
      const failedEvent = this.#createEvent(candidate, context, "run.failed", {
        failure: failure(
          "required_sink",
          "required_sink_failed",
          `Required sink ${error.sinkId} 失败`,
          error.sinkId,
        ),
      });
      return this.#delivery.commit(
        candidate,
        failedEvent,
        deliverySignal,
        new Set([...excludedSinkIds, ...error.failedSinkIds]),
      );
    }
  }

  async #terminateForLimit(
    state: RunState,
    context: ExecutionContext,
    violation: LimitViolation,
  ): Promise<RunState> {
    return this.#commit(state, context, "run.limit_exceeded", violation);
  }

  async #checkStop(state: RunState, context: ExecutionContext): Promise<RunState | null> {
    const deadline = this.#limitGuard.atElapsed(this.#elapsed(context, state.elapsedMs));
    if (deadline) return this.#terminateForLimit(state, context, deadline);
    if (context.cancellation.signal.aborted) {
      return this.#commit(state, context, "run.cancelled", {
        reason: context.cancellation.reason ?? "caller_requested",
      });
    }
    return null;
  }

  async #execute(
    initialState: RunState,
    context: ExecutionContext,
    mode: ExecutionMode,
  ): Promise<RunState> {
    let state = initialState;
    if (mode === "resume") {
      state = await this.#commit(state, context, "run.resumed", { resumedBy: "app" });
    } else if (mode === "start") {
      state = await this.#commit(state, context, "run.started", {});
    }
    if (isTerminalRunStatus(state.status)) return state;

    let retryCount = 0;
    let retryOfRequestId: string | null = null;
    try {
      while (!isTerminalRunStatus(state.status) && state.status !== "paused") {
        const stopped = await this.#checkStop(state, context);
        if (stopped) return stopped;
        const phase = deriveRunPhase(state);
        if (phase === "ready_to_complete") {
          const last = state.transcript.at(-1);
          if (last?.kind !== "assistant_message") throw new Error("最终消息缺失");
          return this.#commit(state, context, "run.completed", {
            finalMessageId: last.message.messageId,
          });
        }
        if (phase === "before_tools") {
          state = await this.#executeTools(state, context);
          continue;
        }
        if (phase !== "before_model") throw new Error(`Runner 无法处理阶段 ${phase}`);

        const modelLimit = this.#limitGuard.beforeModel(state);
        if (modelLimit) return this.#terminateForLimit(state, context, modelLimit);
        const requestId = this.#ids.next();
        const builderInput: ContextBuilderInput = {
          requestId,
          runId: state.runId,
          baseSystemPrompt: context.input.baseSystemPrompt,
          additionalInstructions: context.input.additionalInstructions ?? [],
          transcript: withPresentations(state.transcript, context.presentations),
          tools: context.input.tools ?? [],
          skills: context.input.skills ?? [],
          memories: context.input.memories ?? [],
          tokenBudget: context.input.tokenBudget,
          maxOutputTokens: context.input.maxOutputTokens ?? null,
        };
        const selected = selectContext(builderInput, this.#tokenEstimator);
        let request: ModelRequest = this.#contextBuilder.build(selected.input);
        const beforeModel = await this.#hooks.beforeModel(
          state,
          request,
          context.cancellation.signal,
        );
        if (beforeModel.kind === "block") {
          return this.#commit(state, context, "run.failed", {
            failure: failure("hook", "hook_blocked", beforeModel.reason, requestId),
          });
        }
        if (beforeModel.kind === "pause") {
          return this.#commit(state, context, "run.paused", {
            pause: {
              reason: "hook_requested",
              requestedBy: "hook",
              pausedAt: this.#clock.now().toISOString(),
              pendingToolCallId: null,
            },
          });
        }
        if (beforeModel.kind === "fail") {
          return this.#commit(state, context, "run.failed", { failure: beforeModel.failure });
        }
        if (beforeModel.kind === "modify") {
          request = beforeModel.value;
          // Hook 可以调整提示词，但不能借此绕过调用方给定的模型上下文窗口。
          const modifiedEstimate = estimateTokens(request, this.#tokenEstimator);
          if (modifiedEstimate > context.input.tokenBudget) {
            throw new ContextSelectionError(
              "required_content_over_budget",
              `Hook 修改后的请求需要 ${modifiedEstimate} tokens，预算为 ${context.input.tokenBudget}`,
            );
          }
        }

        state = await this.#commit(state, context, "model.request_started", {
          requestId,
          retryOfRequestId,
        });
        if (isTerminalRunStatus(state.status)) return state;
        const stream = await consumeModelStream(this.#modelClient, request, {
          signal: context.cancellation.signal,
          ...(this.#onTextDelta
            ? { onTextDelta: (delta: string) => this.#onTextDelta?.(delta, requestId) }
            : {}),
          ...(this.#onReasoningDelta
            ? { onReasoningDelta: (delta: string) => this.#onReasoningDelta?.(delta, requestId) }
            : {}),
        });
        if ("usage" in stream && stream.usage) {
          state = await this.#commit(state, context, "model.usage_recorded", {
            requestId,
            delta: stream.usage,
          });
          const usageLimit = this.#limitGuard.afterUsage(state);
          if (usageLimit) return this.#terminateForLimit(state, context, usageLimit);
          if (this.#limitGuard.requiresKnownCost() && state.usage.costUsdMicros === null) {
            state = await this.#commit(state, context, "model.request_failed", {
              requestId,
              failure: failure("model", "usage_cost_unknown", "Provider 未提供成本", requestId),
            });
            return this.#commit(state, context, "run.failed", {
              failure: failure(
                "model",
                "usage_cost_unknown",
                "启用成本上限时成本必须可知",
                requestId,
              ),
            });
          }
        }

        if (stream.kind === "completed") {
          state = await this.#commit(state, context, "assistant.message_completed", {
            requestId,
            message: {
              schemaVersion: 1,
              messageId: this.#ids.next(),
              role: "assistant",
              content: stream.text,
              ...(stream.reasoning ? { reasoningContent: stream.reasoning } : {}),
            },
            toolCalls: stream.toolCalls,
          });
          retryCount = 0;
          retryOfRequestId = null;
          continue;
        }

        // 调用方取消优先于 Provider 在中止竞态中返回的 error/protocol_error。
        if (context.cancellation.signal.aborted) {
          return this.#commit(state, context, "run.cancelled", {
            reason: context.cancellation.reason ?? "caller_requested",
          });
        }
        const modelFailure =
          stream.kind === "protocol_error"
            ? failure("model_protocol", stream.code, stream.message, requestId)
            : stream.kind === "error"
              ? failure("model", stream.code, stream.message, requestId, stream.retryable)
              : failure("model", stream.kind, stream.message, requestId);
        state = await this.#commit(state, context, "model.request_failed", {
          requestId,
          failure: modelFailure,
        });
        if (modelFailure.retryable && retryCount < this.#maxModelRetries) {
          retryCount += 1;
          retryOfRequestId = requestId;
          continue;
        }
        return this.#commit(state, context, "run.failed", { failure: modelFailure });
      }
      return state;
    } catch (error) {
      if (isTerminalRunStatus(state.status)) return state;
      if (context.cancellation.signal.aborted) {
        return this.#commit(state, context, "run.cancelled", {
          reason: context.cancellation.reason ?? "caller_requested",
        });
      }
      const normalized =
        error instanceof ContextSelectionError
          ? failure("context", error.code, error.message)
          : error instanceof HookExecutionError
            ? hookFailure(error)
            : failure(
                "internal",
                "runner_internal",
                error instanceof Error ? error.message : "Runner 异常",
              );
      return this.#commit(state, context, "run.failed", { failure: normalized });
    }
  }

  async #executeTools(stateInput: RunState, context: ExecutionContext): Promise<RunState> {
    let state = stateInput;
    const pending = state.toolBatch?.calls.filter((call) => call.status === "pending") ?? [];
    const effectiveCalls: ToolCall[] = [];

    for (const execution of pending) {
      const stopped = await this.#checkStop(state, context);
      if (stopped) return stopped;
      const beforeTool = await this.#hooks.beforeTool(
        state,
        execution.requestedCall,
        context.cancellation.signal,
      );
      if (beforeTool.kind === "block") {
        const result: FailedToolResult = {
          schemaVersion: 1,
          callId: execution.requestedCall.callId,
          status: "error",
          error: { code: "hook_blocked", message: beforeTool.reason, retryable: false },
          output: [{ kind: "text", text: beforeTool.reason }],
          effects: {
            sideEffect: "none",
            changedPaths: [],
            workspaceRevision: null,
            artifactRefs: [],
          },
        };
        state = await this.#commit(state, context, "tool.failed", {
          callId: result.callId,
          phase: "pre_execution",
          result,
        });
        continue;
      }
      if (beforeTool.kind === "pause") {
        return this.#commit(state, context, "run.paused", {
          pause: {
            reason: "hook_requested",
            requestedBy: "hook",
            pausedAt: this.#clock.now().toISOString(),
            pendingToolCallId: execution.requestedCall.callId,
          },
        });
      }
      if (beforeTool.kind === "fail") {
        return this.#commit(state, context, "run.failed", { failure: beforeTool.failure });
      }
      effectiveCalls.push(
        beforeTool.kind === "modify" ? beforeTool.value : execution.requestedCall,
      );
    }

    if (
      isTerminalRunStatus(state.status) ||
      state.status === "paused" ||
      effectiveCalls.length === 0
    ) {
      return state;
    }
    const groups = validatePlan(effectiveCalls, this.#toolBatchPolicy.plan(effectiveCalls));
    const callsById = new Map(effectiveCalls.map((call) => [call.callId, call]));
    for (const group of groups) {
      const calls = group.callIds.map((callId) => callsById.get(callId)!);
      for (const call of calls) {
        const toolLimit = this.#limitGuard.beforeTool(state);
        if (toolLimit) return this.#terminateForLimit(state, context, toolLimit);
        state = await this.#commit(state, context, "tool.started", { call });
      }
      const executions = calls.map(async (call) => {
        const raw = await this.#toolExecutor.execute(call, { signal: context.cancellation.signal });
        const parsed = toolResultSchema.parse(raw);
        assertToolResultMatchesCall(call, parsed);
        return { call, result: parsed };
      });
      let results: readonly { call: ToolCall; result: ToolResult }[];
      try {
        results =
          group.mode === "parallel_read_only"
            ? await Promise.all(executions)
            : [await executions[0]!];
      } catch (error) {
        if (context.cancellation.signal.aborted) {
          return this.#commit(state, context, "run.cancelled", {
            reason: context.cancellation.reason ?? "caller_requested",
          });
        }
        return this.#commit(state, context, "run.failed", {
          failure: failure(
            "tool_executor",
            "tool_executor_rejected",
            error instanceof Error ? error.message : "ToolExecutor 异常",
          ),
        });
      }

      for (const { call, result: originalResult } of results) {
        let result = originalResult;
        const afterTool = await this.#hooks.afterTool(state, result, context.cancellation.signal);
        if (afterTool.kind === "pause") {
          return this.#commit(state, context, "run.failed", {
            failure: failure("hook", "after_tool_pause_unsupported", afterTool.reason, call.callId),
          });
        }
        if (afterTool.kind === "fail") {
          return this.#commit(state, context, "run.failed", { failure: afterTool.failure });
        }
        if (afterTool.kind === "modify") {
          context.presentations.set(call.callId, afterTool.value.output);
        }
        if (result.status === "cancelled") {
          if (context.cancellation.signal.aborted) {
            return this.#commit(state, context, "run.cancelled", {
              reason: context.cancellation.reason ?? "caller_requested",
            });
          }
          result = cancelledToFailure(result);
        }
        if (result.status === "success") {
          state = await this.#commit(state, context, "tool.completed", {
            callId: call.callId,
            result,
          });
        } else {
          state = await this.#commit(state, context, "tool.failed", {
            callId: call.callId,
            phase: "execution",
            result,
          });
        }
      }
    }
    return state;
  }
}
