/**
 * 模块职责：提供受 workspace 根目录约束的读、写、创建、删除和补丁文件操作。
 *
 * 设计边界：禁止目录逃逸、符号链接穿透和非预期覆盖；不负责用户审批。
 * 关键流程：解析并验证相对路径，执行带并发保护的原子操作，再更新 workspace revision。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";

import type { ToolEffects } from "../../core/ports/tool_executor/tool-executor-port.js";
import { normalizeWorkspacePath } from "../../policy/permissions/permission-policy.js";

export type WorkspaceErrorCode =
  | "invalid_path"
  | "permission_denied"
  | "not_found"
  | "not_file"
  | "binary_file"
  | "invalid_encoding"
  | "too_large"
  | "file_changed"
  | "already_exists"
  | "parent_missing"
  | "no_match"
  | "ambiguous_match"
  | "io_error";

export class WorkspaceSandboxError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly effects: ToolEffects = {
      sideEffect: "none",
      changedPaths: [],
      workspaceRevision: null,
      artifactRefs: [],
    },
  ) {
    super(message);
    this.name = "WorkspaceSandboxError";
  }
}

export interface WorkspaceFile {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly revision: string;
  readonly mode: number;
  readonly identity: string;
}

export interface WorkspaceWriteResult {
  readonly path: string;
  readonly oldRevision: string | null;
  readonly newRevision: string;
  readonly changedBytes: number;
  readonly effects: ToolEffects;
}

export interface WorkspaceSnapshot {
  readonly revision: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface WorkspaceSandboxOptions {
  readonly deniedPrefixes?: readonly string[];
  readonly maxFileBytes?: number;
}

function hash(buffer: Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isWithin(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function identity(value: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(value.dev)}:${String(value.ino)}`;
}

function decodeUtf8(buffer: Buffer, relativePath: string): string {
  if (buffer.subarray(0, 8_192).includes(0)) {
    throw new WorkspaceSandboxError("binary_file", `${relativePath} 不是文本文件`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new WorkspaceSandboxError("invalid_encoding", `${relativePath} 不是有效 UTF-8`);
  }
}

function mapIoError(error: unknown, relativePath: string): WorkspaceSandboxError {
  if (error instanceof WorkspaceSandboxError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new WorkspaceSandboxError("not_found", `${relativePath} 不存在`);
  if (code === "EEXIST") {
    return new WorkspaceSandboxError("already_exists", `${relativePath} 已存在`);
  }
  if (code === "ELOOP" || code === "EACCES" || code === "EPERM") {
    return new WorkspaceSandboxError("permission_denied", "路径不允许访问");
  }
  if (code === "ENOTDIR") {
    // O_NOFOLLOW 打开中间 symlink 在部分 Linux 文件系统返回 ENOTDIR；统一按越界拒绝处理。
    return new WorkspaceSandboxError("permission_denied", "路径不允许访问");
  }
  return new WorkspaceSandboxError("io_error", `${relativePath} 文件操作失败`);
}

/**
 * Linux /proc/self/fd 路径始终锚定到已经打开的目录句柄。
 * 即使原目录名随后被替换，也不会重新从可变的 workspace 字符串路径解析。
 */
function handlePath(handle: FileHandle, child?: string): string {
  const base = `/proc/self/fd/${String(handle.fd)}`;
  return child === undefined ? base : `${base}/${child}`;
}

/**
 * 基于受信目录句柄的 workspace 文件能力。所有路径逐段 O_NOFOLLOW 打开，
 * 避免“先检查路径、后使用路径”的 symlink 竞态逃逸。
 */
export class WorkspaceSandbox {
  readonly #root: string;
  readonly #rootIdentity: string;
  readonly #deniedPrefixes: readonly string[];
  readonly #maxFileBytes: number;

  private constructor(
    root: string,
    rootIdentity: string,
    deniedPrefixes: readonly string[],
    maxFileBytes: number,
  ) {
    this.#root = root;
    this.#rootIdentity = rootIdentity;
    this.#deniedPrefixes = deniedPrefixes;
    this.#maxFileBytes = maxFileBytes;
  }

  static async create(
    root: string,
    options: WorkspaceSandboxOptions = {},
  ): Promise<WorkspaceSandbox> {
    const resolved = await realpath(root);
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) throw new Error("workspace root 必须是目录");
    const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new RangeError("maxFileBytes 必须是正整数");
    }
    const denied = (options.deniedPrefixes ?? [".evaluator", ".oracle", "hidden-tests"])
      .map((value) => normalizeWorkspacePath(value))
      .sort();
    const sandbox = new WorkspaceSandbox(resolved, identity(rootStat), denied, maxFileBytes);
    // 创建时立即验证目录句柄与 /proc/self/fd 原语可用；失败时不授予 capability。
    const rootHandle = await sandbox.#openRoot();
    await rootHandle.close();
    return sandbox;
  }

  get identity(): string {
    return this.#rootIdentity;
  }

  get deniedPrefixes(): readonly string[] {
    return [...this.#deniedPrefixes];
  }

  /**
   * 仅供 ProcessSandbox 继承到 bwrap 的受信根目录句柄；调用方负责 close。
   * 公开值中不包含宿主路径，具体 ToolHandler 也拿不到该 capability。
   */
  async acquireRootHandleForProcess(): Promise<FileHandle> {
    return this.#openRoot();
  }

  async revision(): Promise<string> {
    return (await this.snapshot()).revision;
  }

  async read(relativePath: string, maxBytes = this.#maxFileBytes): Promise<WorkspaceFile> {
    const normalized = this.#normalize(relativePath);
    const limit = Math.min(maxBytes, this.#maxFileBytes);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new WorkspaceSandboxError("too_large", "读取上限非法");
    }
    const capability = await this.#openParent(normalized);
    try {
      return await this.#readAt(capability.parent, capability.name, normalized, limit);
    } finally {
      await capability.parent.close();
    }
  }

  async replace(
    relativePath: string,
    oldText: string,
    newText: string,
    expectedRevision: string,
  ): Promise<WorkspaceWriteResult> {
    const normalized = this.#normalize(relativePath);
    const capability = await this.#openParent(normalized);
    try {
      const current = await this.#readAt(
        capability.parent,
        capability.name,
        normalized,
        this.#maxFileBytes,
      );
      if (current.revision !== expectedRevision) {
        throw new WorkspaceSandboxError("file_changed", `${normalized} 已被其他操作修改`);
      }
      const first = current.content.indexOf(oldText);
      if (first < 0) {
        throw new WorkspaceSandboxError("no_match", `${normalized} 中未找到待替换文本`);
      }
      if (current.content.indexOf(oldText, first + oldText.length) >= 0) {
        throw new WorkspaceSandboxError("ambiguous_match", `${normalized} 中待替换文本不唯一`);
      }
      const nextContent =
        current.content.slice(0, first) + newText + current.content.slice(first + oldText.length);
      return await this.#atomicReplace(
        capability.parent,
        capability.name,
        normalized,
        current,
        nextContent,
      );
    } finally {
      await capability.parent.close();
    }
  }

  async createFile(relativePath: string, content: string): Promise<WorkspaceWriteResult> {
    const normalized = this.#normalize(relativePath);
    const capability = await this.#openParent(normalized);
    const temporaryName = `.codex-edit-${randomUUID()}.tmp`;
    const temporary = handlePath(capability.parent, temporaryName);
    const target = handlePath(capability.parent, capability.name);
    let published = false;
    try {
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > this.#maxFileBytes) {
        throw new WorkspaceSandboxError("too_large", "新文件超过上限");
      }
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // hard-link 发布是排他的：目标已存在或是 symlink 时都不会被覆盖。
      await link(temporary, target);
      published = true;
      await unlink(temporary);
      const fileRevision = hash(bytes);
      const workspaceRevision = await this.revision();
      return {
        path: normalized,
        oldRevision: null,
        newRevision: fileRevision,
        changedBytes: bytes.byteLength,
        effects: this.#confirmed(normalized, workspaceRevision),
      };
    } catch (error) {
      if (published) {
        const workspaceRevision = await this.revision().catch(() => null);
        throw new WorkspaceSandboxError(
          "io_error",
          `${normalized} 已创建但后续确认失败`,
          this.#confirmed(normalized, workspaceRevision),
        );
      }
      throw mapIoError(error, normalized);
    } finally {
      await unlink(temporary).catch(() => undefined);
      await capability.parent.close();
    }
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const root = await this.#openRoot();
    try {
      const files = new Map<string, string>();
      await this.#walk(root, ".", files);
      const canonical = [...files.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, revision]) => `${name}\0${revision}\n`)
        .join("");
      return { files, revision: hash(canonical) };
    } finally {
      await root.close();
    }
  }

  diff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): readonly string[] {
    return [...new Set([...before.files.keys(), ...after.files.keys()])]
      .filter((name) => before.files.get(name) !== after.files.get(name))
      .sort();
  }

  async #atomicReplace(
    parent: FileHandle,
    name: string,
    normalized: string,
    current: WorkspaceFile,
    nextContent: string,
  ): Promise<WorkspaceWriteResult> {
    const temporaryName = `.codex-edit-${randomUUID()}.tmp`;
    const temporary = handlePath(parent, temporaryName);
    const target = handlePath(parent, name);
    let renamed = false;
    try {
      const bytes = Buffer.from(nextContent, "utf8");
      if (bytes.byteLength > this.#maxFileBytes) {
        throw new WorkspaceSandboxError("too_large", "修改后文件超过上限");
      }
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        current.mode,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(current.mode);
      } finally {
        await handle.close();
      }
      const latest = await this.#readAt(parent, name, normalized, this.#maxFileBytes);
      if (latest.identity !== current.identity || latest.revision !== current.revision) {
        throw new WorkspaceSandboxError("file_changed", `${normalized} 已被其他操作修改`);
      }
      await rename(temporary, target);
      renamed = true;
      const next = await this.#readAt(parent, name, normalized, this.#maxFileBytes);
      const expected = hash(bytes);
      if (next.revision !== expected) {
        throw new WorkspaceSandboxError("file_changed", `${normalized} 写入后校验失败`, {
          sideEffect: "possible",
          changedPaths: [normalized],
          workspaceRevision: null,
          artifactRefs: [],
        });
      }
      const workspaceRevision = await this.revision();
      return {
        path: normalized,
        oldRevision: current.revision,
        newRevision: next.revision,
        changedBytes: Math.abs(bytes.byteLength - current.byteLength),
        effects: this.#confirmed(normalized, workspaceRevision),
      };
    } catch (error) {
      if (
        renamed &&
        !(error instanceof WorkspaceSandboxError && error.effects.sideEffect !== "none")
      ) {
        throw new WorkspaceSandboxError("io_error", `${normalized} 写入结果无法确认`, {
          sideEffect: "possible",
          changedPaths: [normalized],
          workspaceRevision: null,
          artifactRefs: [],
        });
      }
      throw mapIoError(error, normalized);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  #normalize(value: string): string {
    let normalized: string;
    try {
      normalized = normalizeWorkspacePath(value);
    } catch {
      throw new WorkspaceSandboxError("invalid_path", "路径不在允许的 workspace 范围内");
    }
    if (this.#deniedPrefixes.some((prefix) => isWithin(normalized, prefix))) {
      throw new WorkspaceSandboxError("permission_denied", "路径不允许访问");
    }
    return normalized;
  }

  async #openRoot(): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.#root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (!opened.isDirectory() || identity(opened) !== this.#rootIdentity) {
        throw new WorkspaceSandboxError("permission_denied", "workspace capability 已失效");
      }
      return handle;
    } catch (error) {
      await handle?.close();
      throw mapIoError(error, ".");
    }
  }

  async #openParent(
    normalized: string,
  ): Promise<{ readonly parent: FileHandle; readonly name: string }> {
    const segments = normalized.split("/");
    const name = segments.pop()!;
    let current = await this.#openRoot();
    try {
      for (const segment of segments) {
        const next = await open(
          handlePath(current, segment),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const opened = await next.stat();
        if (!opened.isDirectory()) {
          await next.close();
          throw new WorkspaceSandboxError("parent_missing", "父目录不存在");
        }
        await current.close();
        current = next;
      }
      return { parent: current, name };
    } catch (error) {
      await current.close();
      throw mapIoError(error, normalized);
    }
  }

  async #readAt(
    parent: FileHandle,
    name: string,
    normalized: string,
    limit: number,
  ): Promise<WorkspaceFile> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        handlePath(parent, name),
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new WorkspaceSandboxError("not_file", `${normalized} 不是普通文件`);
      }
      if (before.size > limit) {
        throw new WorkspaceSandboxError("too_large", `${normalized} 超过读取上限`);
      }
      const allocated = Buffer.alloc(Math.min(limit + 1, before.size + 1));
      const { bytesRead } = await handle.read(allocated, 0, allocated.byteLength, 0);
      if (bytesRead > limit) {
        throw new WorkspaceSandboxError("too_large", `${normalized} 超过读取上限`);
      }
      const buffer = allocated.subarray(0, bytesRead);
      const after = await handle.stat();
      if (
        identity(before) !== identity(after) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new WorkspaceSandboxError("file_changed", `${normalized} 在读取期间发生变化`);
      }
      return {
        path: normalized,
        content: decodeUtf8(buffer, normalized),
        byteLength: buffer.byteLength,
        revision: hash(buffer),
        mode: before.mode & 0o777,
        identity: identity(before),
      };
    } catch (error) {
      throw mapIoError(error, normalized);
    } finally {
      await handle?.close();
    }
  }

  async #walk(
    directory: FileHandle,
    relativeDirectory: string,
    output: Map<string, string>,
  ): Promise<void> {
    const entries = await readdir(handlePath(directory), { withFileTypes: true });
    for (const entry of entries) {
      const relative =
        relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (this.#deniedPrefixes.some((prefix) => isWithin(relative, prefix))) continue;
      let child: FileHandle | undefined;
      try {
        // lstat 只用于识别并跳过 symlink；后续 open 仍带 O_NOFOLLOW，竞态替换会 fail closed。
        const metadata = await lstat(handlePath(directory, entry.name));
        if (metadata.isSymbolicLink()) continue;
        child = await open(
          handlePath(directory, entry.name),
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        const before = await child.stat();
        if (before.isDirectory()) {
          await this.#walk(child, relative, output);
        } else if (before.isFile()) {
          const revision = await this.#hashFile(child, before, relative);
          output.set(relative, revision);
        }
      } catch (error) {
        throw mapIoError(error, relative);
      } finally {
        await child?.close();
      }
    }
  }

  async #hashFile(
    handle: FileHandle,
    before: Awaited<ReturnType<FileHandle["stat"]>>,
    relative: string,
  ): Promise<string> {
    const digest = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      identity(before) !== identity(after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new WorkspaceSandboxError("file_changed", `${relative} 在快照期间发生变化`);
    }
    return digest.digest("hex");
  }

  #confirmed(normalized: string, workspaceRevision: string | null): ToolEffects {
    return {
      sideEffect: "confirmed",
      changedPaths: [normalized],
      workspaceRevision,
      artifactRefs: [],
    };
  }
}
