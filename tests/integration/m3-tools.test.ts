import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalCoordinator,
  StaticApprovalRequester,
} from "../../src/policy/approval/approval-coordinator.js";
import { DefaultPermissionPolicy } from "../../src/policy/permissions/permission-policy.js";
import { ProcessSandbox } from "../../src/sandbox/process/process-sandbox.js";
import { WorkspaceSandbox } from "../../src/sandbox/workspace/workspace-sandbox.js";
import { createEditToolDefinition } from "../../src/tools/builtin/edit/edit-tool.js";
import { createReadToolDefinition } from "../../src/tools/builtin/read/read-tool.js";
import { createShellToolDefinition } from "../../src/tools/builtin/shell/shell-tool.js";
import { ToolDispatcher } from "../../src/tools/dispatcher/tool-dispatcher.js";
import { RegistryToolBatchPolicy, ToolRegistry } from "../../src/tools/registry/tool-registry.js";
import { createTempWorkspace } from "../helpers/temp-workspace.js";
import type { TempWorkspace } from "../helpers/temp-workspace.js";

const workspaces: TempWorkspace[] = [];

async function workspace(): Promise<{ temp: TempWorkspace; sandbox: WorkspaceSandbox }> {
  const temp = await createTempWorkspace("m3-tools-");
  workspaces.push(temp);
  return { temp, sandbox: await WorkspaceSandbox.create(temp.root) };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((entry) => entry.cleanup()));
});

describe("M3 ToolRegistry / Dispatcher / Sandbox", () => {
  it("read 只读取 workspace 普通 UTF-8 文件，并拒绝越界与 symlink", async () => {
    const { temp, sandbox } = await workspace();
    await writeFile(temp.resolve("hello.txt"), "第一行\n第二行\n", "utf8");
    const outside = await createTempWorkspace("m3-outside-");
    workspaces.push(outside);
    await writeFile(outside.resolve("secret.txt"), "secret", "utf8");
    await symlink(outside.resolve("secret.txt"), temp.resolve("escape.txt"));
    await symlink(outside.root, temp.resolve("directory-escape"));

    const registry = new ToolRegistry();
    registry.register(createReadToolDefinition(sandbox));
    const snapshot = registry.freeze(["read"]);
    const dispatcher = new ToolDispatcher({
      registry: snapshot,
      permissionPolicy: new DefaultPermissionPolicy(),
      capabilities: new Set(["workspace_read"]),
      runId: "run-read",
      workspaceIdentity: sandbox.identity,
      workspaceRevision: () => sandbox.revision(),
      sandboxProfileVersion: "workspace-m3-v1",
    });

    const ok = await dispatcher.execute(
      {
        schemaVersion: 1,
        callId: "call-read",
        name: "read",
        arguments: { path: "hello.txt", startLine: 2, endLine: 2 },
      },
      { signal: new AbortController().signal },
    );
    expect(ok.status).toBe("success");
    expect(ok.output[0]).toEqual({ kind: "text", text: "第二行" });
    expect(ok.effects.sideEffect).toBe("none");

    for (const [index, path] of [
      "../outside",
      "escape.txt",
      "directory-escape/secret.txt",
    ].entries()) {
      const denied = await dispatcher.execute(
        { schemaVersion: 1, callId: `call-denied-${index}`, name: "read", arguments: { path } },
        { signal: new AbortController().signal },
      );
      expect(denied.status).toBe("error");
      expect(denied.status === "error" && denied.error.code).toBe("permission_denied");
      expect(JSON.stringify(denied)).not.toContain("secret");
    }
  });

  it("edit 经过 Ask→AllowOnce 后原子替换，拒绝审批时零副作用", async () => {
    const { temp, sandbox } = await workspace();
    await writeFile(temp.resolve("source.ts"), "export const value = 1;\n", "utf8");
    const before = await sandbox.read("source.ts");
    const registry = new ToolRegistry();
    registry.register(createEditToolDefinition(sandbox));
    const snapshot = registry.freeze(["edit"]);
    const requester = new StaticApprovalRequester({ decision: "deny", reason: "operator denied" });
    const base = {
      registry: snapshot,
      permissionPolicy: new DefaultPermissionPolicy(),
      capabilities: new Set(["workspace_read", "workspace_write"] as const),
      runId: "run-edit",
      workspaceIdentity: sandbox.identity,
      workspaceRevision: () => sandbox.revision(),
      sandboxProfileVersion: "workspace-m3-v1",
    };
    const call = {
      schemaVersion: 1 as const,
      callId: "call-edit",
      name: "edit",
      arguments: {
        mode: "replace",
        path: "source.ts",
        oldText: "value = 1",
        newText: "value = 2",
        expectedRevision: before.revision,
      },
    };

    const denied = await new ToolDispatcher({
      ...base,
      approval: new ApprovalCoordinator(requester),
    }).execute(call, { signal: new AbortController().signal });
    expect(denied.status === "error" && denied.error.code).toBe("approval_denied");
    expect(await readFile(temp.resolve("source.ts"), "utf8")).toContain("value = 1");
    expect(requester.requests).toHaveLength(1);

    const allowedRequester = new StaticApprovalRequester({
      decision: "allow_once",
      reason: "approved",
    });
    const allowed = await new ToolDispatcher({
      ...base,
      approval: new ApprovalCoordinator(allowedRequester),
    }).execute(call, { signal: new AbortController().signal });
    expect(allowed.status).toBe("success");
    expect(allowed.effects.sideEffect).toBe("confirmed");
    expect(allowed.effects.changedPaths).toEqual(["source.ts"]);
    // 文件 revision 用于 expectedRevision；effects 中必须是整个 workspace 的恢复版本。
    expect(allowed.effects.workspaceRevision).toBe(await sandbox.revision());
    expect(await readFile(temp.resolve("source.ts"), "utf8")).toContain("value = 2");
    expect(allowedRequester.requests[0]?.argumentsPreview).not.toContain(temp.root);
  });

  it("只并行可信独立只读调用，effectful 与 unknown 调用保持串行", async () => {
    const { sandbox } = await workspace();
    const registry = new ToolRegistry();
    registry.register(createReadToolDefinition(sandbox));
    registry.register(createEditToolDefinition(sandbox));
    const snapshot = registry.freeze(["read", "edit"]);
    const policy = new RegistryToolBatchPolicy(snapshot);
    expect(
      policy.plan([
        { schemaVersion: 1, callId: "a", name: "read", arguments: { path: "a" } },
        { schemaVersion: 1, callId: "b", name: "read", arguments: { path: "b" } },
      ]),
    ).toEqual([{ mode: "parallel_read_only", callIds: ["a", "b"] }]);
    expect(
      policy.plan([
        { schemaVersion: 1, callId: "a", name: "read", arguments: { path: "a" } },
        { schemaVersion: 1, callId: "b", name: "edit", arguments: {} },
        { schemaVersion: 1, callId: "c", name: "hidden", arguments: {} },
      ]),
    ).toEqual([
      { mode: "serial", callIds: ["a"] },
      { mode: "serial", callIds: ["b"] },
      { mode: "serial", callIds: ["c"] },
    ]);
  });

  it("隔离能力缺失时 shell fail closed，不启动 handler", async () => {
    const { temp, sandbox } = await workspace();
    const processSandbox = new ProcessSandbox(
      {
        available: false,
        version: "bwrap-m3-v1",
        bwrapPath: null,
        reason: "missing",
      },
      temp.root,
      sandbox,
    );
    const registry = new ToolRegistry();
    registry.register(createShellToolDefinition(processSandbox));
    const snapshot = registry.freeze(["shell"]);
    const dispatcher = new ToolDispatcher({
      registry: snapshot,
      permissionPolicy: new DefaultPermissionPolicy(),
      approval: new ApprovalCoordinator(
        new StaticApprovalRequester({ decision: "allow_once", reason: "approved" }),
      ),
      capabilities: new Set(["workspace_read", "workspace_write"]),
      runId: "run-shell",
      workspaceIdentity: sandbox.identity,
      workspaceRevision: () => sandbox.revision(),
      sandboxProfileVersion: processSandbox.profile.version,
    });
    const result = await dispatcher.execute(
      {
        schemaVersion: 1,
        callId: "call-shell",
        name: "shell",
        arguments: { command: "touch should-not-exist" },
      },
      { signal: new AbortController().signal },
    );
    expect(result.status === "error" && result.error.code).toBe("sandbox_unavailable");
    await expect(readFile(temp.resolve("should-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("审批等待期间 workspace 变化时 AllowOnce 失效，handler 保持零调用", async () => {
    const { temp, sandbox } = await workspace();
    const registry = new ToolRegistry();
    registry.register(createEditToolDefinition(sandbox));
    const snapshot = registry.freeze(["edit"]);
    const requester = {
      async request() {
        // 模拟用户审批期间另一个进程修改了 workspace。
        await writeFile(temp.resolve("changed-during-approval.txt"), "changed", "utf8");
        return { decision: "allow_once" as const, reason: "approved" };
      },
    };
    const dispatcher = new ToolDispatcher({
      registry: snapshot,
      permissionPolicy: new DefaultPermissionPolicy(),
      approval: new ApprovalCoordinator(requester),
      capabilities: new Set(["workspace_read", "workspace_write"]),
      runId: "run-approval-race",
      workspaceIdentity: sandbox.identity,
      workspaceRevision: () => sandbox.revision(),
      sandboxProfileVersion: "workspace-m3-v1",
    });

    const result = await dispatcher.execute(
      {
        schemaVersion: 1,
        callId: "call-create-after-approval",
        name: "edit",
        arguments: { mode: "create", path: "must-not-exist.txt", newText: "unsafe" },
      },
      { signal: new AbortController().signal },
    );

    expect(result.status === "error" && result.error.code).toBe("approval_denied");
    await expect(readFile(temp.resolve("must-not-exist.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ProcessSandbox 参数屏蔽隐藏资源、只读挂载 .git，并从受信 fd 绑定 workspace", async () => {
    const { temp, sandbox } = await workspace();
    await mkdir(temp.resolve(".oracle"));
    await writeFile(temp.resolve(".oracle/answer.txt"), "hidden", "utf8");
    await mkdir(temp.resolve(".git"));
    await writeFile(temp.resolve(".git/config"), "private", "utf8");
    await writeFile(temp.resolve(".env"), "TOKEN=secret", "utf8");

    const harness = await createTempWorkspace("m3-fake-bwrap-");
    workspaces.push(harness);
    const capturePath = harness.resolve("arguments.txt");
    const fakeBwrap = harness.resolve("fake-bwrap.sh");
    await writeFile(
      fakeBwrap,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + capturePath + "'\nexit 0\n",
      "utf8",
    );
    await chmod(fakeBwrap, 0o755);

    const processSandbox = new ProcessSandbox(
      {
        available: true,
        version: "bwrap-m3-v2:test",
        bwrapPath: fakeBwrap,
        reason: null,
      },
      temp.root,
      sandbox,
    );
    await processSandbox.execute({
      command: "true",
      cwd: ".",
      timeoutMs: 5_000,
      outputLimitBytes: 1_024,
      signal: new AbortController().signal,
    });

    const argumentsText = await readFile(capturePath, "utf8");
    expect(argumentsText).toContain("--bind-fd\n3\n/workspace");
    expect(argumentsText).toContain("--tmpfs\n/workspace/.oracle");
    expect(argumentsText).toContain("--ro-bind\n/proc/self/fd/3/.git\n/workspace/.git");
    expect(argumentsText).toContain("--ro-bind\n/dev/null\n/workspace/.env");
    expect(argumentsText).not.toContain(temp.root);
  });
});
