import { describe, expect, it } from "vitest";

import {
  agentEventSchema,
  validateTransition,
} from "../../src/core/runtime/events/agent-events.js";
import {
  createInitialRunState,
  deriveRunPhase,
  runStateSchema,
  validateRunStateInvariants,
} from "../../src/core/runtime/state/run-state.js";
import type { AgentEvent } from "../../src/core/runtime/events/agent-events.js";
import type { Run, RunState } from "../../src/core/runtime/state/run-state.js";

const NOW = "2026-08-20T00:00:00.000Z";

function run(): Run {
  return {
    schemaVersion: 1,
    runId: "run-0001",
    turn: {
      turnId: "turn-0001",
      userMessage: {
        schemaVersion: 1,
        messageId: "message-user-0001",
        role: "user",
        content: "修复测试",
      },
    },
    createdAt: NOW,
  };
}

function meta(sequence: number, eventId = `event-${sequence}`) {
  return {
    schemaVersion: 1 as const,
    eventId,
    runId: "run-0001",
    turnId: "turn-0001",
    sequence,
    occurredAt: NOW,
    elapsedMs: sequence,
  };
}

function runningState(): RunState {
  return {
    ...createInitialRunState(run()),
    status: "running",
    startedAt: NOW,
    updatedAt: NOW,
    lastEventSequence: 1,
    lastEventId: "event-1",
  };
}

describe("M1-01 RunState contract", () => {
  it("创建严格、可 JSON round-trip 的初始快照", () => {
    const state = createInitialRunState(run());
    expect(state).toMatchObject({
      status: "created",
      transcript: [{ kind: "user_message" }],
      activeModelRequest: null,
      toolBatch: null,
      outcome: null,
      lastEventSequence: 0,
    });
    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(validateRunStateInvariants(state)).toEqual({ ok: true });
    expect(deriveRunPhase(state)).toBe("created");
  });

  it("拒绝未知字段和非法字段组合", () => {
    const initial = createInitialRunState(run());
    expect(runStateSchema.safeParse({ ...initial, vendorState: {} }).success).toBe(false);
    expect(
      validateRunStateInvariants({
        ...initial,
        status: "running",
        startedAt: null,
      }),
    ).toMatchObject({ ok: false });
  });

  it("从结构而不是第二套持久化字段派生运行阶段", () => {
    const running = runningState();
    expect(deriveRunPhase(running)).toBe("before_model");
    expect(
      deriveRunPhase({
        ...running,
        activeModelRequest: {
          requestId: "request-1",
          retryOfRequestId: null,
          startedAt: NOW,
        },
      }),
    ).toBe("awaiting_model");

    const finalState: RunState = {
      ...running,
      transcript: [
        ...running.transcript,
        {
          kind: "assistant_message",
          message: {
            schemaVersion: 1,
            messageId: "message-assistant-1",
            role: "assistant",
            content: "已完成",
          },
          toolCalls: [],
        },
      ],
    };
    expect(deriveRunPhase(finalState)).toBe("ready_to_complete");
  });
});

describe("M1-01 AgentEvent transition contract", () => {
  it("只允许 created 接收连续的 RunStarted", () => {
    const state = createInitialRunState(run());
    const started: AgentEvent = { type: "run.started", meta: meta(1), payload: {} };
    expect(validateTransition(state, started)).toEqual({ ok: true });
    expect(validateTransition(state, { ...started, meta: meta(2) })).toMatchObject({
      ok: false,
      violation: { code: "sequence_mismatch" },
    });
    expect(
      validateTransition(state, {
        ...started,
        meta: { ...meta(1), runId: "other-run" },
      }),
    ).toMatchObject({ ok: false, violation: { code: "identity_mismatch" } });
  });

  it("模型操作事件必须匹配 active request", () => {
    const state: RunState = {
      ...runningState(),
      activeModelRequest: {
        requestId: "request-1",
        retryOfRequestId: null,
        startedAt: NOW,
      },
      usage: { ...runningState().usage, modelRequestCount: 1 },
      lastEventSequence: 2,
      lastEventId: "event-2",
    };
    const completed: AgentEvent = {
      type: "assistant.message_completed",
      meta: meta(3),
      payload: {
        requestId: "request-1",
        message: {
          schemaVersion: 1,
          messageId: "message-assistant-1",
          role: "assistant",
          content: "完成",
        },
        toolCalls: [],
      },
    };
    expect(validateTransition(state, completed)).toEqual({ ok: true });
    expect(
      validateTransition(state, {
        ...completed,
        payload: { ...completed.payload, requestId: "request-other" },
      }),
    ).toMatchObject({ ok: false, violation: { code: "operation_mismatch" } });
  });

  it("终止快照不接受第二个终止事件", () => {
    const terminal: RunState = {
      ...runningState(),
      status: "cancelled",
      outcome: { kind: "cancelled", reason: "caller_requested" },
      endedAt: NOW,
      lastEventSequence: 2,
      lastEventId: "event-2",
    };
    const event: AgentEvent = {
      type: "run.failed",
      meta: meta(3),
      payload: {
        failure: {
          category: "internal",
          code: "duplicate-terminal",
          message: "不能重复终止",
          retryable: false,
          operationId: null,
        },
      },
    };
    expect(validateTransition(terminal, event)).toMatchObject({
      ok: false,
      violation: { code: "status_disallows_event" },
    });
  });

  it("事件 schema 拒绝未知 type、版本和字段", () => {
    expect(
      agentEventSchema.safeParse({
        type: "run.started",
        meta: meta(1),
        payload: {},
        vendor: "leak",
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({ type: "vendor.completed", meta: meta(1), payload: {} }).success,
    ).toBe(false);
  });
});
