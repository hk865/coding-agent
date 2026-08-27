import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { CheckpointStorePort } from "../../src/core/ports/checkpoint_store/checkpoint-store-port.js";
import {
  canonicalJson,
  computeSessionRecordChecksum,
  createSessionInputSchema,
  sessionRecordSchema,
} from "../../src/core/ports/session_store/session-store-port.js";
import type {
  AgentProfileIdentity,
  SessionLineage,
  SessionRecordDraft,
  SessionStorePort,
} from "../../src/core/ports/session_store/session-store-port.js";
import { replaySessionRecords } from "../../src/core/ports/session_store/session-projection.js";
import { RecoveryCoordinator } from "../../src/core/runtime/recovery/recovery-coordinator.js";
import type { Run } from "../../src/core/runtime/state/run-state.js";
import { InMemoryStores } from "../../src/storage/adapters/in_memory/in-memory-stores.js";
import { SqliteStores } from "../../src/storage/adapters/sqlite/sqlite-stores.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/temp-workspace.js";

const time = "2026-08-27T00:00:00.000Z";
const digest = "a".repeat(64);
const options = { signal: new AbortController().signal };
const resources: Array<{ close(): Promise<void> }> = [];
const workspaces: TempWorkspace[] = [];
type Stores = SessionStorePort & CheckpointStorePort;

const lineage: SessionLineage = {
  kind: "root",
  parentSessionId: null,
  parentPosition: null,
  parentRecordChecksum: null,
  delegationDepth: 0,
};
const profile: AgentProfileIdentity = {
  profileId: "coding-agent.default",
  profileVersion: "a1-v1",
  profileDigest: digest,
};
const run: Run = {
  schemaVersion: 1,
  runId: "run-a1",
  turn: {
    turnId: "turn-a1",
    userMessage: {
      schemaVersion: 1,
      messageId: "message-a1",
      role: "user",
      content: "验证 Session v2",
    },
  },
  createdAt: time,
};

function extensionFact(recordId: string, ignorable: boolean): SessionRecordDraft {
  return {
    recordId,
    recordType: "extension.fact",
    schemaVersion: 1,
    recordedAt: time,
    payload: {
      namespace: "example.learning",
      factType: "flexibility.signal",
      schemaVersion: 7,
      ignorable,
      modelVisibility: "hidden",
      data: { source: "unknown-extension", score: 1 },
    },
  };
}

const turnStarted: SessionRecordDraft = {
  recordId: "turn-started-a1",
  recordType: "turn.started",
  schemaVersion: 1,
  recordedAt: time,
  payload: {
    run,
    config: {
      modelConfigId: "fake:model",
      limits: {
        maxModelRequests: null,
        maxToolCalls: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        maxTotalTokens: null,
        maxCostUsdMicros: null,
        deadlineMs: null,
      },
      enabledToolSchemaDigest: digest,
      policyVersion: "policy-v1",
      sandboxProfileVersion: "sandbox-v1",
      baseConfigDigest: digest,
    },
    workspace: {
      identity: "workspace-a1",
      revision: "revision-a1",
      reference: "workspace:current",
    },
  },
};

async function inMemory(): Promise<Stores> {
  const store = new InMemoryStores();
  resources.push(store);
  return store;
}

async function sqlite(): Promise<Stores> {
  const workspace = await createTempWorkspace("a1-session-v2-");
  workspaces.push(workspace);
  const store = await SqliteStores.open(workspace.resolve("sessions.sqlite"));
  resources.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

for (const [name, factory] of [
  ["InMemory", inMemory],
  ["SQLite", sqlite],
] as const) {
  describe(`${name} Session v2 contract`, () => {
    it("固化 lineage/profile，并在恢复投影中跳过未知可忽略扩展事实", async () => {
      const store = await factory();
      const header = await store.create(
        {
          schemaVersion: 2,
          sessionId: "session-a1",
          recordId: "session-created-a1",
          createdAt: time,
          lineage,
          profile,
        },
        options,
      );
      expect(header).toMatchObject({ schemaVersion: 2, lineage, profile, revision: 1 });

      const beforeTurn = await store.append(
        "session-a1",
        1,
        [extensionFact("extension-before-turn", true)],
        options,
      );
      const withTurn = await store.append(
        "session-a1",
        beforeTurn.revision,
        [turnStarted, extensionFact("extension-after-turn", true)],
        options,
      );
      const page = await store.read("session-a1", 0, 20, options);
      expect(page.records.map((record) => record.recordType)).toEqual([
        "session.created",
        "extension.fact",
        "turn.started",
        "extension.fact",
      ]);
      const created = page.records[0]!;
      expect(created).toMatchObject({
        recordType: "session.created",
        schemaVersion: 2,
        payload: { lineage, profile },
      });
      const state = replaySessionRecords(page.records);
      expect(state).toMatchObject({ runId: "run-a1", lastEventSequence: 0 });
      const recovered = await new RecoveryCoordinator({
        sessions: store,
        checkpoints: store,
      }).recover("session-a1", options, {
        config: turnStarted.payload.config,
        workspace: turnStarted.payload.workspace,
      });
      expect(recovered).toMatchObject({
        action: "start_run",
        state: { runId: "run-a1", lastEventSequence: 0 },
      });

      await expect(
        store.append(
          "session-a1",
          withTurn.revision,
          [extensionFact("required-unknown-extension", false)],
          options,
        ),
      ).rejects.toMatchObject({ code: "version_unsupported" });
      expect((await store.get("session-a1", options)).revision).toBe(withTurn.revision);
      expect((await store.read("session-a1", 0, 20, options)).records).toHaveLength(4);
    });

    it("省略创建版本时继续生成可读的 v1 Session", async () => {
      const store = await factory();
      const header = await store.create(
        {
          sessionId: "legacy-source-compatible",
          recordId: "legacy-source-compatible-created",
          createdAt: time,
        },
        options,
      );
      expect(header.schemaVersion).toBe(1);
      const record = (await store.read("legacy-source-compatible", 0, 10, options)).records[0]!;
      expect(record).toMatchObject({ recordType: "session.created", schemaVersion: 1 });
    });
  });
}

it("SQLite 原位迁移 database schema v1，且不改写旧 Session 记录", async () => {
  const workspace = await createTempWorkspace("a1-sqlite-migration-");
  workspaces.push(workspace);
  const databasePath = workspace.resolve("legacy.sqlite");
  const content = {
    recordId: "legacy-record",
    sessionId: "legacy-session",
    position: 1,
    recordType: "session.created" as const,
    schemaVersion: 1 as const,
    recordedAt: time,
    payload: { sessionId: "legacy-session", createdAt: time },
  };
  const record = sessionRecordSchema.parse({
    ...content,
    checksum: computeSessionRecordChecksum(content),
  });
  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE sessions(
      session_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      active_run_id TEXT,
      active_turn_id TEXT
    ) STRICT;
    CREATE TABLE session_records(
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      position INTEGER NOT NULL,
      record_id TEXT NOT NULL UNIQUE,
      record_type TEXT NOT NULL,
      run_id TEXT,
      turn_id TEXT,
      event_sequence INTEGER,
      record_json TEXT NOT NULL,
      PRIMARY KEY(session_id, position),
      UNIQUE(run_id, event_sequence)
    ) STRICT;
    CREATE TABLE checkpoints(
      checkpoint_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      record_position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL
    ) STRICT;
  `);
  raw.prepare("INSERT INTO metadata(key,value) VALUES('database_schema_version','1')").run();
  raw
    .prepare(
      "INSERT INTO sessions(session_id,schema_version,created_at,updated_at,revision,active_run_id,active_turn_id) VALUES(?,?,?,?,?,?,?)",
    )
    .run("legacy-session", 1, time, time, 1, null, null);
  raw
    .prepare(
      "INSERT INTO session_records(session_id,position,record_id,record_type,run_id,turn_id,event_sequence,record_json) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "legacy-session",
      1,
      "legacy-record",
      "session.created",
      null,
      null,
      null,
      canonicalJson(record),
    );
  raw.close();

  const store = await SqliteStores.open(databasePath);
  resources.push(store);
  expect(await store.get("legacy-session", options)).toMatchObject({
    schemaVersion: 1,
    revision: 1,
  });
  expect((await store.read("legacy-session", 0, 10, options)).records).toEqual([record]);
  await store.append("legacy-session", 1, [extensionFact("post-migration-fact", true)], options);
  await store.close();

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  const version = migrated
    .prepare("SELECT value FROM metadata WHERE key='database_schema_version'")
    .get() as Record<string, unknown>;
  const columns = migrated.prepare("PRAGMA table_info(sessions)").all() as Array<
    Record<string, unknown>
  >;
  migrated.close();
  expect(version["value"]).toBe("3");
  expect(columns.map((column) => column["name"])).toEqual(
    expect.arrayContaining(["lineage_json", "profile_json"]),
  );
});

it("SQLite 拒绝与创建事实不一致的合法 Profile 索引行", async () => {
  const workspace = await createTempWorkspace("a1-profile-drift-");
  workspaces.push(workspace);
  const databasePath = workspace.resolve("profile.sqlite");
  const store = await SqliteStores.open(databasePath);
  await store.create(
    {
      schemaVersion: 2,
      sessionId: "profile-session",
      recordId: "profile-session-created",
      createdAt: time,
      lineage,
      profile,
    },
    options,
  );
  await store.close();

  const raw = new DatabaseSync(databasePath);
  raw
    .prepare("UPDATE sessions SET profile_json=? WHERE session_id=?")
    .run(canonicalJson({ ...profile, profileDigest: "b".repeat(64) }), "profile-session");
  raw.close();

  const reopened = await SqliteStores.open(databasePath);
  resources.push(reopened);
  await expect(reopened.get("profile-session", options)).rejects.toMatchObject({
    code: "corrupt",
    lastTrustedPosition: 0,
  });
});

it("严格 schema 拒绝伪造命名空间和不完整 lineage", () => {
  expect(() =>
    sessionRecordSchema.parse({
      recordId: "invalid-extension",
      sessionId: "session-a1",
      position: 1,
      recordType: "extension.fact",
      schemaVersion: 1,
      recordedAt: time,
      checksum: digest,
      payload: {
        namespace: "../escape",
        factType: "fact",
        schemaVersion: 1,
        ignorable: true,
        modelVisibility: "hidden",
        data: null,
      },
    }),
  ).toThrow();
  expect(() =>
    createSessionInputSchema.parse({
      schemaVersion: 2,
      sessionId: "invalid-lineage",
      recordId: "invalid-lineage-created",
      createdAt: time,
      lineage: {
        kind: "root",
        parentSessionId: "must-be-null",
        parentPosition: null,
        parentRecordChecksum: null,
        delegationDepth: 0,
      },
      profile,
    }),
  ).toThrow();
});
