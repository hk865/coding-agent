import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appConfigSchema } from "../../src/app/composition/app-config.js";
import { runCodingAgent } from "../../src/app/composition/composition-root.js";
import type {
  ModelClientPort,
  ModelEvent,
} from "../../src/core/ports/model_client/model-client-port.js";
import { ProviderRegistry } from "../../src/model/providers/registry/provider-registry.js";
import { SqliteStores } from "../../src/storage/adapters/sqlite/sqlite-stores.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/temp-workspace.js";

const workspaces: TempWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

class ReplayModelClient implements ModelClientPort {
  async *stream(request: Parameters<ModelClientPort["stream"]>[0]): AsyncIterable<ModelEvent> {
    yield {
      schemaVersion: 1,
      requestId: request.requestId,
      sequence: 1,
      type: "text_delta",
      delta: "M5 replay ok",
    };
    yield {
      schemaVersion: 1,
      requestId: request.requestId,
      sequence: 2,
      type: "usage_snapshot",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 0,
        costUsdMicros: null,
      },
    };
    yield {
      schemaVersion: 1,
      requestId: request.requestId,
      sequence: 3,
      type: "completed",
      reason: "final_answer",
    };
  }
}

describe("M5 Composition smoke", () => {
  it("显式 DeepSeek 选择贯通 Runtime、固定 ToolList 和 SQLite required sink", async () => {
    const workspace = await createTempWorkspace("m5-composition-");
    workspaces.push(workspace);
    const databasePath = workspace.resolve("app-data", "sessions.sqlite");
    const config = appConfigSchema.parse({
      schemaVersion: 1,
      model: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        options: {},
        maxOutputTokens: 128,
      },
      runtime: { tokenBudget: 8_000, maxModelRequests: 2, maxToolCalls: 3 },
      tools: { enabledNames: ["read", "edit", "shell"] },
      storage: { databasePath },
      skills: {
        resourceRoot: path.resolve("resources/skills"),
        enabledIds: ["coding-safety"],
      },
      memory: { provider: "empty" },
    });
    const registry = new ProviderRegistry().register({
      id: "deepseek",
      secretEnvironmentVariable: "DEEPSEEK_API_KEY",
      defaultBaseUrl: "https://api.deepseek.com",
      capabilities: { streaming: true, toolCalls: true, usage: true },
      create: () => new ReplayModelClient(),
    });
    const requestedSecrets: string[] = [];
    let output = "";
    const result = await runCodingAgent({
      config,
      workspaceRoot: workspace.root,
      input: "只返回 replay 结果",
      sessionId: "session-m5-smoke",
      providerRegistry: registry,
      secretSource: {
        get(name) {
          requestedSecrets.push(name);
          return "fixture-secret-never-persist";
        },
      },
      onTextDelta: (delta) => {
        output += delta;
      },
    });
    expect(result.state.status).toBe("completed");
    expect(result.provider).toBe("deepseek");
    expect(result.enabledTools).toEqual(["read", "edit", "shell"]);
    expect(requestedSecrets).toEqual(["DEEPSEEK_API_KEY"]);
    expect(output).toBe("M5 replay ok");

    const store = await SqliteStores.open(databasePath);
    try {
      const page = await store.read("session-m5-smoke", 0, 100, {
        signal: new AbortController().signal,
      });
      expect(page.records.map((record) => record.recordType)).toEqual([
        "session.created",
        "turn.started",
        "agent.event",
        "agent.event",
        "agent.event",
        "agent.event",
        "agent.event",
      ]);
      expect(JSON.stringify(page.records)).not.toContain("fixture-secret-never-persist");
    } finally {
      await store.close();
    }
  });
});
