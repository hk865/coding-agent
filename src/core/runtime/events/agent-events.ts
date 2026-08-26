/**
 * 模块职责：定义驱动 RunState 的 AgentEvent 联合类型、元数据和状态转换校验规则。
 *
 * 设计边界：事件只描述已经发生的事实，不直接修改状态，也不执行外部副作用。
 * 关键流程：生产者构造并校验事件，delivery 提交事实，reducer 根据事件得到下一状态。
 */
import { z } from "zod";

import {
  assistantMessageSchema,
  isoUtcDateTimeSchema,
  nonEmptyIdSchema,
} from "../../context/types/context-types.js";
import { modelUsageSchema } from "../../ports/model_client/model-client-port.js";
import {
  failedToolResultSchema,
  toolCallSchema,
  toolResultSchema,
} from "../../ports/tool_executor/tool-executor-port.js";
import {
  deriveRunPhase,
  pauseStateSchema,
  runFailureSchema,
  validateRunStateInvariants,
} from "../state/run-state.js";
import type { RunState } from "../state/run-state.js";

export const eventMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema,
    turnId: nonEmptyIdSchema,
    sequence: z.number().int().positive(),
    occurredAt: isoUtcDateTimeSchema,
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

const emptyPayloadSchema = z.object({}).strict();
const event = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) =>
  z.object({ type: z.literal(type), meta: eventMetaSchema, payload }).strict();

const runStartedEventSchema = event("run.started", emptyPayloadSchema);
const modelRequestStartedEventSchema = event(
  "model.request_started",
  z
    .object({
      requestId: nonEmptyIdSchema,
      retryOfRequestId: nonEmptyIdSchema.nullable(),
    })
    .strict(),
);
const modelUsageRecordedEventSchema = event(
  "model.usage_recorded",
  z.object({ requestId: nonEmptyIdSchema, delta: modelUsageSchema }).strict(),
);
const modelRequestFailedEventSchema = event(
  "model.request_failed",
  z.object({ requestId: nonEmptyIdSchema, failure: runFailureSchema }).strict(),
);
const assistantMessageCompletedEventSchema = event(
  "assistant.message_completed",
  z
    .object({
      requestId: nonEmptyIdSchema,
      message: assistantMessageSchema,
      toolCalls: z.array(toolCallSchema).readonly(),
    })
    .strict()
    .refine((value) => value.message.content.length > 0 || value.toolCalls.length > 0, {
      message: "assistant message 不能同时缺少文本和工具调用",
    }),
);
const toolStartedEventSchema = event("tool.started", z.object({ call: toolCallSchema }).strict());
const toolCompletedEventSchema = event(
  "tool.completed",
  z
    .object({ callId: nonEmptyIdSchema, result: toolResultSchema })
    .strict()
    .refine((value) => value.result.status === "success", {
      message: "tool.completed 必须携带 success result",
    })
    .refine((value) => value.callId === value.result.callId, {
      message: "tool.completed 的 callId 必须与 result 一致",
    }),
);
const toolFailedEventSchema = event(
  "tool.failed",
  z
    .object({
      callId: nonEmptyIdSchema,
      phase: z.enum(["pre_execution", "execution"]),
      result: failedToolResultSchema,
    })
    .strict()
    .refine((value) => value.callId === value.result.callId, {
      message: "tool.failed 的 callId 必须与 result 一致",
    }),
);
const runPausedEventSchema = event("run.paused", z.object({ pause: pauseStateSchema }).strict());
const runResumedEventSchema = event(
  "run.resumed",
  z.object({ resumedBy: z.enum(["runtime", "hook", "tool_executor", "app"]) }).strict(),
);
const runCompletedEventSchema = event(
  "run.completed",
  z.object({ finalMessageId: nonEmptyIdSchema }).strict(),
);
const runCancelledEventSchema = event(
  "run.cancelled",
  z.object({ reason: z.enum(["caller_requested", "user_interrupt", "process_signal"]) }).strict(),
);
const limitExceededEventSchema = event(
  "run.limit_exceeded",
  z
    .object({
      limit: z.enum([
        "model_requests",
        "tool_calls",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "cost",
        "deadline",
      ]),
      observed: z.number().int().nonnegative(),
      allowed: z.number().int().nonnegative(),
    })
    .strict(),
);
const runFailedEventSchema = event("run.failed", z.object({ failure: runFailureSchema }).strict());

export const agentEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  modelRequestStartedEventSchema,
  modelUsageRecordedEventSchema,
  modelRequestFailedEventSchema,
  assistantMessageCompletedEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  toolFailedEventSchema,
  runPausedEventSchema,
  runResumedEventSchema,
  runCompletedEventSchema,
  runCancelledEventSchema,
  limitExceededEventSchema,
  runFailedEventSchema,
]);

export type EventMeta = z.infer<typeof eventMetaSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;

export type TransitionViolationCode =
  | "schema_invalid"
  | "identity_mismatch"
  | "sequence_mismatch"
  | "elapsed_time_regression"
  | "status_disallows_event"
  | "phase_disallows_event"
  | "operation_mismatch"
  | "duplicate_id"
  | "invariant_violation";

export type TransitionValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly violation: {
        readonly code: TransitionViolationCode;
        readonly message: string;
      };
    };

function rejected(code: TransitionViolationCode, message: string): TransitionValidationResult {
  return { ok: false, violation: { code, message } };
}

function findTool(state: RunState, callId: string) {
  return state.toolBatch?.calls.find((call) => call.requestedCall.callId === callId);
}

export function validateTransition(
  stateInput: Readonly<RunState>,
  eventInput: unknown,
): TransitionValidationResult {
  const invariant = validateRunStateInvariants(stateInput);
  if (!invariant.ok) return rejected("invariant_violation", invariant.message);
  const parsed = agentEventSchema.safeParse(eventInput);
  if (!parsed.success) {
    return rejected("schema_invalid", parsed.error.issues[0]?.message ?? "AgentEvent schema 非法");
  }
  const state = stateInput;
  const currentEvent = parsed.data;

  if (currentEvent.meta.runId !== state.runId || currentEvent.meta.turnId !== state.turn.turnId) {
    return rejected("identity_mismatch", "Event 的 runId/turnId 与 RunState 不一致");
  }
  if (currentEvent.meta.sequence !== state.lastEventSequence + 1) {
    return rejected("sequence_mismatch", "Event sequence 必须严格连续");
  }
  if (currentEvent.meta.elapsedMs < state.elapsedMs) {
    return rejected("elapsed_time_regression", "Event elapsedMs 不能倒退");
  }
  if (currentEvent.meta.eventId === state.lastEventId) {
    return rejected("duplicate_id", "eventId 不能与最后事件重复");
  }

  const phase = deriveRunPhase(state);
  if (phase === "terminal") {
    return rejected("status_disallows_event", "终止 State 不接受任何后续 Event");
  }

  switch (currentEvent.type) {
    case "run.started":
      return phase === "created"
        ? { ok: true }
        : rejected("status_disallows_event", "只有 created State 可以开始");
    case "model.request_started":
      return phase === "before_model"
        ? { ok: true }
        : rejected("phase_disallows_event", "当前阶段不能开始模型请求");
    case "model.usage_recorded":
    case "model.request_failed":
    case "assistant.message_completed": {
      if (phase !== "awaiting_model") {
        return rejected("phase_disallows_event", "当前没有等待中的模型请求");
      }
      if (currentEvent.payload.requestId !== state.activeModelRequest?.requestId) {
        return rejected("operation_mismatch", "Event 的 requestId 与 active request 不一致");
      }
      if (currentEvent.type === "assistant.message_completed") {
        const existingMessageIds = state.transcript
          .filter((entry) => entry.kind !== "tool_result")
          .map((entry) => entry.message.messageId);
        if (existingMessageIds.includes(currentEvent.payload.message.messageId)) {
          return rejected("duplicate_id", "assistant messageId 已存在");
        }
        const callIds = currentEvent.payload.toolCalls.map((call) => call.callId);
        if (new Set(callIds).size !== callIds.length) {
          return rejected("duplicate_id", "同一 assistant message 的 callId 必须唯一");
        }
      }
      return { ok: true };
    }
    case "tool.started": {
      if (phase !== "before_tools") {
        return rejected("phase_disallows_event", "当前阶段不能开始工具");
      }
      const pending = findTool(state, currentEvent.payload.call.callId);
      if (!pending || pending.status !== "pending") {
        return rejected("operation_mismatch", "tool.started 必须对应 pending call");
      }
      return { ok: true };
    }
    case "tool.completed":
    case "tool.failed": {
      if (phase !== "before_tools") {
        return rejected("phase_disallows_event", "当前阶段不能结算工具");
      }
      const execution = findTool(state, currentEvent.payload.callId);
      const expectedStatus =
        currentEvent.type === "tool.failed" && currentEvent.payload.phase === "pre_execution"
          ? "pending"
          : "running";
      if (!execution || execution.status !== expectedStatus) {
        return rejected("operation_mismatch", `工具结算要求调用处于 ${expectedStatus} 状态`);
      }
      return { ok: true };
    }
    case "run.paused": {
      if (
        state.status !== "running" ||
        !["before_model", "before_tools", "ready_to_complete"].includes(phase)
      ) {
        return rejected("phase_disallows_event", "只能在无活动操作的稳定边界暂停");
      }
      const pendingCallId = currentEvent.payload.pause.pendingToolCallId;
      if (pendingCallId !== null && findTool(state, pendingCallId)?.status !== "pending") {
        return rejected("operation_mismatch", "暂停引用的工具调用不是 pending 状态");
      }
      return { ok: true };
    }
    case "run.resumed":
      return phase === "paused"
        ? { ok: true }
        : rejected("status_disallows_event", "只有 paused State 可以恢复");
    case "run.completed": {
      if (phase !== "ready_to_complete") {
        return rejected("phase_disallows_event", "只有最终答复候选可以完成 Run");
      }
      const last = state.transcript.at(-1);
      return last?.kind === "assistant_message" &&
        last.message.messageId === currentEvent.payload.finalMessageId
        ? { ok: true }
        : rejected("operation_mismatch", "finalMessageId 不是当前最终答复");
    }
    case "run.cancelled":
    case "run.limit_exceeded":
    case "run.failed":
      return state.status === "running" || state.status === "paused"
        ? { ok: true }
        : rejected("status_disallows_event", "当前 State 不能终止");
  }
}
