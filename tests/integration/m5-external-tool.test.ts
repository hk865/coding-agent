import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/tools/registry/tool-registry.js";

describe("M5 external Tool boundary", () => {
  it("external_echo 只通过 Registry 接入，不修改 Runtime", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "external_echo",
      description: "M5 test-only external tool",
      inputSchema: z.object({ text: z.string() }).strict(),
      effectClass: "read_only",
      requiredCapabilities: [],
      defaultTimeoutMs: 1_000,
      outputLimitBytes: 1_024,
      independentReadOnly: true,
      summarize: () => ({ paths: [], cwd: null, commandPreview: null }),
      handler: {
        async execute(call) {
          return {
            schemaVersion: 1,
            callId: call.callId,
            status: "success",
            output: [{ kind: "text", text: String(call.arguments["text"] ?? "") }],
            effects: {
              sideEffect: "none",
              changedPaths: [],
              workspaceRevision: null,
              artifactRefs: [],
            },
          };
        },
      },
    });
    const snapshot = registry.freeze(["external_echo"]);
    expect(snapshot.modelToolSpecs().map((tool) => tool.name)).toEqual(["external_echo"]);
    const definition = snapshot.resolve("external_echo");
    expect(
      await definition?.handler.execute(
        {
          schemaVersion: 1,
          callId: "external-call",
          name: "external_echo",
          arguments: { text: "echo-ok" },
        },
        { signal: new AbortController().signal },
      ),
    ).toMatchObject({ status: "success", output: [{ kind: "text", text: "echo-ok" }] });
  });
});
