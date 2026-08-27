/**
 * 模块职责：用 SQLite 实现 Session 与 checkpoint 的跨进程持久化。
 *
 * 设计边界：适配器遵守 Core 端口，不包含恢复决策或 Runner 控制流程。
 * 关键流程：初始化表结构，在事务中执行乐观并发追加，读取时反序列化并复核记录与校验和。
 */
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Checkpoint,
  CheckpointCandidate,
  CheckpointDraft,
  CheckpointStorePort,
} from "../../../core/ports/checkpoint_store/checkpoint-store-port.js";
import {
  assertCheckpointChecksum,
  checkpointSchema,
  createCheckpoint,
} from "../../../core/ports/checkpoint_store/checkpoint-store-port.js";
import type {
  ClaimInboxInput,
  CompleteInboxInput,
  EnqueueInboxInput,
  EnqueueInboxResult,
  InboxItem,
  InboxListPage,
  InboxStorePort,
  RenewInboxClaimInput,
  ReleaseInboxInput,
} from "../../../core/ports/inbox_store/inbox-store-port.js";
import {
  claimInboxInputSchema,
  completeInboxInputSchema,
  enqueueInboxInputSchema,
  inboxItemSchema,
  renewInboxClaimInputSchema,
  releaseInboxInputSchema,
} from "../../../core/ports/inbox_store/inbox-store-port.js";
import type {
  AppendSessionResult,
  CreateSessionInput,
  ReadSessionPage,
  SessionHeader,
  SessionListPage,
  SessionRecord,
  SessionRecordDraft,
  SessionStorePort,
  StoreCallOptions,
} from "../../../core/ports/session_store/session-store-port.js";
import {
  agentProfileIdentitySchema,
  assertSessionRecordChecksum,
  canonicalJson,
  computeSessionRecordChecksum,
  createSessionArtifacts,
  sessionLineageSchema,
  sessionHeaderSchema,
  sessionRecordDraftSchema,
  sessionRecordSchema,
  StoreError,
} from "../../../core/ports/session_store/session-store-port.js";
import {
  applySessionDraft,
  isActiveSessionState,
  replaySessionRecords,
} from "../../../core/ports/session_store/session-projection.js";

type Row = Record<string, unknown>;

function cancelled(options: Readonly<StoreCallOptions>): void {
  if (options.signal.aborted) throw new StoreError("cancelled", "Storage 操作已取消");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseJson<T>(text: unknown, parser: (value: unknown) => T, kind: string): T {
  try {
    return parser(JSON.parse(String(text)));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("corrupt", `${kind} JSON 或 schema 损坏`);
  }
}

function draftMatches(
  record: SessionRecord,
  draft: SessionRecordDraft,
  sessionId: string,
): boolean {
  return (
    record.sessionId === sessionId &&
    record.recordId === draft.recordId &&
    record.recordType === draft.recordType &&
    record.schemaVersion === draft.schemaVersion &&
    record.recordedAt === draft.recordedAt &&
    canonicalJson(record.payload) === canonicalJson(draft.payload)
  );
}

/**
 * Session 与 Checkpoint 的 SQLite 适配器。短事务负责批次原子性和 revision
 * 冲突，所有 JSON 在入库和读取时都经过 strict schema 与 checksum 校验。
 */
export class SqliteStores implements SessionStorePort, CheckpointStorePort, InboxStorePort {
  readonly #database: DatabaseSync;
  #closed = false;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static async open(databasePath: string): Promise<SqliteStores> {
    const parent = path.dirname(databasePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const database = new DatabaseSync(databasePath);
    const stores = new SqliteStores(database);
    try {
      stores.#initialize();
      await chmod(databasePath, 0o600);
      return stores;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async create(
    input: Readonly<CreateSessionInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<SessionHeader> {
    this.#assertOpen();
    cancelled(options);
    return this.#transaction(() => {
      if (this.#sessionRow(input.sessionId))
        throw new StoreError("already_exists", "Session 已存在");
      const { record, header } = createSessionArtifacts(input);
      this.#database
        .prepare(
          "INSERT INTO sessions(session_id,schema_version,created_at,updated_at,revision,active_run_id,active_turn_id,lineage_json,profile_json) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.sessionId,
          header.schemaVersion,
          input.createdAt,
          input.createdAt,
          1,
          null,
          null,
          header.schemaVersion === 2 ? canonicalJson(header.lineage) : null,
          header.schemaVersion === 2 ? canonicalJson(header.profile) : null,
        );
      this.#insertRecord(record);
      cancelled(options);
      return clone(header);
    });
  }

  async append(
    sessionId: string,
    expectedRevision: number,
    draftsInput: readonly Readonly<SessionRecordDraft>[],
    options: Readonly<StoreCallOptions>,
  ): Promise<AppendSessionResult> {
    this.#assertOpen();
    cancelled(options);
    if (draftsInput.length === 0) throw new StoreError("invalid_record", "append batch 不能为空");
    let drafts: SessionRecordDraft[];
    try {
      drafts = draftsInput.map((draft) => sessionRecordDraftSchema.parse(draft));
    } catch {
      throw new StoreError("invalid_record", "Session record draft 非法");
    }
    if (new Set(drafts.map((draft) => draft.recordId)).size !== drafts.length) {
      throw new StoreError("invalid_record", "batch recordId 重复");
    }
    return this.#transaction(() => {
      const header = this.#header(sessionId);
      const existing = drafts.map((draft) => this.#recordById(draft.recordId));
      if (existing.every((record) => record !== null)) {
        const records = existing as SessionRecord[];
        if (!records.every((record, index) => draftMatches(record, drafts[index]!, sessionId))) {
          throw new StoreError("idempotency_conflict", "recordId 的重试内容不同");
        }
        return {
          revision: header["revision"],
          positions: records.map((record) => record["position"]),
          records: clone(records),
        };
      }
      if (existing.some((record) => record !== null)) {
        throw new StoreError("idempotency_conflict", "append batch 部分 recordId 已存在");
      }
      if (header["revision"] !== expectedRevision)
        throw new StoreError("conflict", "Session revision 冲突");
      const committed = this.#allRecords(sessionId);
      let state = replaySessionRecords(committed);
      const records: SessionRecord[] = [];
      for (const [index, draft] of drafts.entries()) {
        state = applySessionDraft(state, draft);
        const content = {
          ...draft,
          sessionId,
          position: committed.length + index + 1,
        };
        records.push(
          sessionRecordSchema.parse({
            ...content,
            checksum: computeSessionRecordChecksum(content),
          }),
        );
      }
      cancelled(options);
      for (const record of records) this.#insertRecord(record);
      const last = records.at(-1)!;
      const active = isActiveSessionState(state) ? state : null;
      const revision = header["revision"] + 1;
      this.#database
        .prepare(
          "UPDATE sessions SET updated_at=?,revision=?,active_run_id=?,active_turn_id=? WHERE session_id=? AND revision=?",
        )
        .run(
          last.recordedAt,
          revision,
          active?.runId ?? null,
          active?.turn.turnId ?? null,
          sessionId,
          expectedRevision,
        );
      return {
        revision,
        positions: records.map((record) => record["position"]),
        records: clone(records),
      };
    });
  }

  async read(
    sessionId: string,
    afterPosition: number,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<ReadSessionPage> {
    this.#assertOpen();
    cancelled(options);
    if (
      !Number.isSafeInteger(afterPosition) ||
      afterPosition < 0 ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ) {
      throw new StoreError("invalid_record", "read page 参数非法");
    }
    const header = this.#header(sessionId);
    const all = this.#allRecords(sessionId);
    const records = all.slice(afterPosition, afterPosition + limit);
    const lastPosition = records.at(-1)?.["position"] ?? afterPosition;
    return {
      revision: header["revision"],
      records: clone(records),
      nextPosition: lastPosition < all.length ? lastPosition : null,
    };
  }

  async get(sessionId: string, options: Readonly<StoreCallOptions>): Promise<SessionHeader> {
    this.#assertOpen();
    cancelled(options);
    return clone(this.#header(sessionId));
  }

  async list(
    cursor: string | null,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<SessionListPage> {
    this.#assertOpen();
    cancelled(options);
    const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new StoreError("invalid_record", "list page 参数非法");
    }
    const rows = this.#database
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, session_id ASC LIMIT ? OFFSET ?")
      .all(limit + 1, offset) as Row[];
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit).map((row) => {
      const header = this.#rowToHeader(row);
      this.#assertSessionV2Identity(header);
      return header;
    });
    return {
      sessions: clone(selected),
      nextCursor: hasNext ? String(offset + selected.length) : null,
    };
  }

  async enqueue(
    inputValue: Readonly<EnqueueInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<EnqueueInboxResult> {
    this.#assertOpen();
    cancelled(options);
    let input: EnqueueInboxInput;
    try {
      input = enqueueInboxInputSchema.parse(inputValue);
    } catch {
      throw new StoreError("invalid_record", "Inbox enqueue input 非法");
    }
    return this.#transaction(() => {
      this.#header(input.sessionId);
      const existingRow = this.#database
        .prepare("SELECT * FROM inbox_items WHERE session_id=? AND idempotency_key=?")
        .get(input.sessionId, input.idempotencyKey) as Row | undefined;
      if (existingRow) {
        const existing = this.#parseInboxItem(existingRow);
        if (canonicalJson(existing.message) !== canonicalJson(input.message)) {
          throw new StoreError("idempotency_conflict", "Inbox 幂等键的重试内容不同");
        }
        return { item: clone(existing), created: false };
      }
      if (
        this.#database.prepare("SELECT item_id FROM inbox_items WHERE item_id=?").get(input.itemId)
      ) {
        throw new StoreError("idempotency_conflict", "Inbox itemId 已被其他消息使用");
      }
      const sequence = Number(
        (
          this.#database
            .prepare(
              "SELECT COALESCE(MAX(sequence),0)+1 AS next_sequence FROM inbox_items WHERE session_id=?",
            )
            .get(input.sessionId) as Row
        )["next_sequence"],
      );
      const item = inboxItemSchema.parse({
        schemaVersion: 1,
        itemId: input.itemId,
        sessionId: input.sessionId,
        sequence,
        idempotencyKey: input.idempotencyKey,
        kind: "user_message",
        message: input.message,
        acceptedAt: input.acceptedAt,
        status: "pending",
        deliveryAttempt: 0,
        lastClaim: null,
        lastFailure: null,
        releasedAt: null,
        completedAt: null,
        completion: null,
      });
      cancelled(options);
      this.#database
        .prepare(
          "INSERT INTO inbox_items(session_id,sequence,item_id,idempotency_key,status,accepted_at,claim_token,lease_expires_at,item_json) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          item.sessionId,
          item.sequence,
          item.itemId,
          item.idempotencyKey,
          item.status,
          item.acceptedAt,
          null,
          null,
          canonicalJson(item),
        );
      return { item: clone(item), created: true };
    });
  }

  async claimNext(
    inputValue: Readonly<ClaimInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem | null> {
    this.#assertOpen();
    cancelled(options);
    let input: ClaimInboxInput;
    try {
      input = claimInboxInputSchema.parse(inputValue);
    } catch {
      throw new StoreError("invalid_record", "Inbox claim input 非法");
    }
    return this.#transaction(() => {
      this.#header(input.sessionId);
      const activeRow = this.#database
        .prepare(
          "SELECT * FROM inbox_items WHERE session_id=? AND status='claimed' ORDER BY sequence LIMIT 1",
        )
        .get(input.sessionId) as Row | undefined;
      let target: InboxItem | null;
      if (activeRow) {
        const active = this.#parseInboxItem(activeRow);
        if (active.status !== "claimed") throw new StoreError("corrupt", "Inbox 状态索引损坏");
        if (
          active.lastClaim.claimToken === input.claim.claimToken &&
          active.lastClaim.claimedBy === input.claim.claimedBy
        ) {
          return clone(active);
        }
        if (Date.parse(active.lastClaim.leaseExpiresAt) > Date.parse(input.claim.claimedAt)) {
          return null;
        }
        target = active;
      } else {
        const pendingRow = this.#database
          .prepare(
            "SELECT * FROM inbox_items WHERE session_id=? AND status='pending' ORDER BY sequence LIMIT 1",
          )
          .get(input.sessionId) as Row | undefined;
        target = pendingRow ? this.#parseInboxItem(pendingRow) : null;
      }
      if (!target) return null;
      if (Date.parse(input.claim.claimedAt) < Date.parse(target.acceptedAt)) {
        throw new StoreError("invalid_record", "Inbox claimedAt 早于 acceptedAt");
      }
      const claimed = inboxItemSchema.parse({
        ...target,
        status: "claimed",
        deliveryAttempt: target.deliveryAttempt + 1,
        lastClaim: input.claim,
        releasedAt: null,
        completedAt: null,
        completion: null,
      });
      cancelled(options);
      this.#updateInboxItem(claimed);
      return clone(claimed);
    });
  }

  async complete(
    inputValue: Readonly<CompleteInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem> {
    this.#assertOpen();
    cancelled(options);
    let input: CompleteInboxInput;
    try {
      input = completeInboxInputSchema.parse(inputValue);
    } catch {
      throw new StoreError("invalid_record", "Inbox complete input 非法");
    }
    return this.#transaction(() => {
      const item = this.#inboxItem(input.itemId, input.sessionId);
      if (item.status === "completed") {
        if (
          item.lastClaim.claimToken === input.claimToken &&
          item.completedAt === input.completedAt &&
          canonicalJson(item.completion) === canonicalJson(input.completion)
        ) {
          return clone(item);
        }
        throw new StoreError("idempotency_conflict", "Inbox complete 重试内容不同");
      }
      if (item.status !== "claimed" || item.lastClaim.claimToken !== input.claimToken) {
        throw new StoreError("conflict", "Inbox item 未由该 claim 持有");
      }
      if (Date.parse(input.completedAt) < Date.parse(item.lastClaim.claimedAt)) {
        throw new StoreError("invalid_record", "Inbox completedAt 早于 claimedAt");
      }
      const completed = inboxItemSchema.parse({
        ...item,
        status: "completed",
        releasedAt: null,
        completedAt: input.completedAt,
        completion: input.completion,
      });
      cancelled(options);
      this.#updateInboxItem(completed);
      return clone(completed);
    });
  }

  async renewClaim(
    inputValue: Readonly<RenewInboxClaimInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem> {
    this.#assertOpen();
    cancelled(options);
    let input: RenewInboxClaimInput;
    try {
      input = renewInboxClaimInputSchema.parse(inputValue);
    } catch {
      throw new StoreError("invalid_record", "Inbox renew input 非法");
    }
    return this.#transaction(() => {
      const item = this.#inboxItem(input.itemId, input.sessionId);
      if (item.status !== "claimed" || item.lastClaim.claimToken !== input.claimToken) {
        throw new StoreError("conflict", "Inbox item 未由该 claim 持有");
      }
      if (input.leaseExpiresAt === item.lastClaim.leaseExpiresAt) return clone(item);
      if (
        Date.parse(input.renewedAt) < Date.parse(item.lastClaim.claimedAt) ||
        Date.parse(input.leaseExpiresAt) <= Date.parse(item.lastClaim.leaseExpiresAt)
      ) {
        throw new StoreError("invalid_record", "Inbox 续租不能倒退");
      }
      const renewed = inboxItemSchema.parse({
        ...item,
        lastClaim: { ...item.lastClaim, leaseExpiresAt: input.leaseExpiresAt },
      });
      cancelled(options);
      this.#updateInboxItem(renewed);
      return clone(renewed);
    });
  }

  async release(
    inputValue: Readonly<ReleaseInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem> {
    this.#assertOpen();
    cancelled(options);
    let input: ReleaseInboxInput;
    try {
      input = releaseInboxInputSchema.parse(inputValue);
    } catch {
      throw new StoreError("invalid_record", "Inbox release input 非法");
    }
    return this.#transaction(() => {
      const item = this.#inboxItem(input.itemId, input.sessionId);
      if (
        item.status === "pending" &&
        item.lastClaim?.claimToken === input.claimToken &&
        item.releasedAt === input.releasedAt &&
        canonicalJson(item.lastFailure) === canonicalJson(input.failure)
      ) {
        return clone(item);
      }
      if (item.status !== "claimed" || item.lastClaim.claimToken !== input.claimToken) {
        throw new StoreError("conflict", "Inbox item 未由该 claim 持有");
      }
      if (Date.parse(input.releasedAt) < Date.parse(item.lastClaim.claimedAt)) {
        throw new StoreError("invalid_record", "Inbox releasedAt 早于 claimedAt");
      }
      const pending = inboxItemSchema.parse({
        ...item,
        status: "pending",
        lastFailure: input.failure,
        releasedAt: input.releasedAt,
        completedAt: null,
        completion: null,
      });
      cancelled(options);
      this.#updateInboxItem(pending);
      return clone(pending);
    });
  }

  async getItem(itemId: string, options: Readonly<StoreCallOptions>): Promise<InboxItem> {
    this.#assertOpen();
    cancelled(options);
    const row = this.#database.prepare("SELECT * FROM inbox_items WHERE item_id=?").get(itemId) as
      Row | undefined;
    if (!row) throw new StoreError("not_found", "Inbox item 不存在");
    return clone(this.#parseInboxItem(row));
  }

  async listInbox(
    sessionId: string,
    afterSequence: number,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxListPage> {
    this.#assertOpen();
    cancelled(options);
    this.#header(sessionId);
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ) {
      throw new StoreError("invalid_record", "Inbox list page 参数非法");
    }
    const rows = this.#database
      .prepare(
        "SELECT * FROM inbox_items WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(sessionId, afterSequence, limit + 1) as Row[];
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.#parseInboxItem(row));
    return {
      items: clone(items),
      nextSequence: hasNext ? (items.at(-1)?.sequence ?? afterSequence) : null,
    };
  }

  async save(
    draft: Readonly<CheckpointDraft>,
    options: Readonly<StoreCallOptions>,
  ): Promise<Checkpoint> {
    this.#assertOpen();
    cancelled(options);
    const checkpoint = createCheckpoint(draft);
    return this.#transaction(() => {
      const existing = this.#checkpointById(checkpoint.checkpointId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(checkpoint)) {
          throw new StoreError("idempotency_conflict", "checkpointId 内容冲突");
        }
        return clone(existing);
      }
      const count = Number(
        (
          this.#database
            .prepare("SELECT COUNT(*) AS count FROM session_records WHERE session_id=?")
            .get(checkpoint.sessionId) as Row
        )["count"],
      );
      if (count === 0) throw new StoreError("not_found", "Checkpoint Session 不存在");
      if (checkpoint.recordPosition > count) {
        throw new StoreError("invalid_record", "Checkpoint cursor 超过 Session 事实位置");
      }
      const latest = this.#database
        .prepare(
          "SELECT record_position FROM checkpoints WHERE run_id=? ORDER BY record_position DESC LIMIT 1",
        )
        .get(checkpoint.runId) as Row | undefined;
      if (latest && checkpoint.recordPosition <= Number(latest["record_position"])) {
        throw new StoreError("conflict", "Checkpoint cursor 不能倒退或重复");
      }
      this.#database
        .prepare(
          "INSERT INTO checkpoints(checkpoint_id,session_id,run_id,turn_id,record_position,created_at,checkpoint_json) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          checkpoint.checkpointId,
          checkpoint.sessionId,
          checkpoint.runId,
          checkpoint.turnId,
          checkpoint.recordPosition,
          checkpoint.createdAt,
          canonicalJson(checkpoint),
        );
      this.#database
        .prepare(
          "DELETE FROM checkpoints WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE run_id=? ORDER BY record_position DESC LIMIT -1 OFFSET 3)",
        )
        .run(checkpoint.runId);
      cancelled(options);
      return clone(checkpoint);
    });
  }

  async loadLatest(runId: string, options: Readonly<StoreCallOptions>): Promise<Checkpoint | null> {
    return (await this.listCheckpoints(runId, options))[0] ?? null;
  }

  async listCheckpoints(
    runId: string,
    options: Readonly<StoreCallOptions>,
  ): Promise<readonly Checkpoint[]> {
    this.#assertOpen();
    cancelled(options);
    const rows = this.#database
      .prepare(
        "SELECT checkpoint_json FROM checkpoints WHERE run_id=? ORDER BY record_position DESC",
      )
      .all(runId) as Row[];
    return rows.map((row) => this.#parseCheckpoint(row["checkpoint_json"]));
  }

  async listCheckpointCandidates(
    runId: string,
    options: Readonly<StoreCallOptions>,
  ): Promise<readonly CheckpointCandidate[]> {
    this.#assertOpen();
    cancelled(options);
    const rows = this.#database
      .prepare(
        "SELECT checkpoint_id,checkpoint_json FROM checkpoints WHERE run_id=? ORDER BY record_position DESC",
      )
      .all(runId) as Row[];
    return rows.map((row) => {
      const checkpointId = String(row["checkpoint_id"]);
      try {
        return { checkpointId, checkpoint: this.#parseCheckpoint(row["checkpoint_json"]) };
      } catch {
        return { checkpointId, checkpoint: null };
      }
    });
  }

  async deleteInvalid(
    checkpointIds: readonly string[],
    options: Readonly<StoreCallOptions>,
  ): Promise<number> {
    this.#assertOpen();
    cancelled(options);
    return this.#transaction(() => {
      let deleted = 0;
      const statement = this.#database.prepare("DELETE FROM checkpoints WHERE checkpoint_id=?");
      for (const id of checkpointIds) deleted += Number(statement.run(id).changes);
      return deleted;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #initialize(): void {
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec("PRAGMA trusted_schema=OFF");
    this.#database.exec("PRAGMA busy_timeout=1000");
    this.#database.enableDefensive(true);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions(
        session_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        active_run_id TEXT,
        active_turn_id TEXT,
        lineage_json TEXT,
        profile_json TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_records(
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
      CREATE TABLE IF NOT EXISTS checkpoints(
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        record_position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_items(
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        sequence INTEGER NOT NULL,
        item_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        claim_token TEXT,
        lease_expires_at TEXT,
        item_json TEXT NOT NULL,
        PRIMARY KEY(session_id, sequence),
        UNIQUE(session_id, idempotency_key)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_one_claimed_per_session
        ON inbox_items(session_id) WHERE status='claimed';
    `);
    const version = this.#database
      .prepare("SELECT value FROM metadata WHERE key='database_schema_version'")
      .get() as Row | undefined;
    if (!version) {
      this.#ensureSessionV2Columns();
      this.#database
        .prepare("INSERT INTO metadata(key,value) VALUES('database_schema_version','3')")
        .run();
    } else if (version["value"] === "1" || version["value"] === "2") {
      this.#ensureSessionV2Columns();
      this.#database
        .prepare("UPDATE metadata SET value='3' WHERE key='database_schema_version'")
        .run();
    } else if (version["value"] === "3") {
      this.#ensureSessionV2Columns();
    } else {
      throw new StoreError(
        "version_unsupported",
        `不支持数据库 schema version ${String(version["value"])}`,
      );
    }
    const foreignKeys = this.#database.prepare("PRAGMA foreign_keys").get() as Row;
    const trustedSchema = this.#database.prepare("PRAGMA trusted_schema").get() as Row;
    if (
      Number(foreignKeys["foreign_keys"]) !== 1 ||
      Number(trustedSchema["trusted_schema"]) !== 0
    ) {
      throw new StoreError("internal", "SQLite 安全 PRAGMA 未生效");
    }
  }

  #ensureSessionV2Columns(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(sessions)").all() as Row[]).map((row) =>
        String(row["name"]),
      ),
    );
    if (!columns.has("lineage_json")) {
      this.#database.exec("ALTER TABLE sessions ADD COLUMN lineage_json TEXT");
    }
    if (!columns.has("profile_json")) {
      this.#database.exec("ALTER TABLE sessions ADD COLUMN profile_json TEXT");
    }
  }

  #insertRecord(record: SessionRecord): void {
    const event = record.recordType === "agent.event" ? record.payload.event : null;
    const runId =
      record.recordType === "turn.started"
        ? record.payload.run.runId
        : record.recordType === "agent.event"
          ? record.payload.event.meta.runId
          : null;
    const turnId =
      record.recordType === "turn.started"
        ? record.payload.run.turn.turnId
        : record.recordType === "agent.event"
          ? record.payload.event.meta.turnId
          : null;
    this.#database
      .prepare(
        "INSERT INTO session_records(session_id,position,record_id,record_type,run_id,turn_id,event_sequence,record_json) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        record.sessionId,
        record["position"],
        record.recordId,
        record.recordType,
        runId,
        turnId,
        event?.meta.sequence ?? null,
        canonicalJson(record),
      );
  }

  #allRecords(sessionId: string): SessionRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT position,record_json FROM session_records WHERE session_id=? ORDER BY position",
      )
      .all(sessionId) as Row[];
    return rows.map((row, index) => {
      if (Number(row["position"]) !== index + 1) {
        throw new StoreError("corrupt", "Session position 不连续", index);
      }
      const record = parseJson(
        row["record_json"],
        (value) => sessionRecordSchema.parse(value),
        "Session record",
      );
      assertSessionRecordChecksum(record);
      return record;
    });
  }

  #recordById(recordId: string): SessionRecord | null {
    const row = this.#database
      .prepare("SELECT record_json FROM session_records WHERE record_id=?")
      .get(recordId) as Row | undefined;
    if (!row) return null;
    const record = parseJson(
      row["record_json"],
      (value) => sessionRecordSchema.parse(value),
      "Session record",
    );
    assertSessionRecordChecksum(record);
    return record;
  }

  #inboxItem(itemId: string, sessionId: string): InboxItem {
    const row = this.#database
      .prepare("SELECT * FROM inbox_items WHERE item_id=? AND session_id=?")
      .get(itemId, sessionId) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Inbox item 不存在");
    return this.#parseInboxItem(row);
  }

  #parseInboxItem(row: Row): InboxItem {
    const item = parseJson(row["item_json"], (value) => inboxItemSchema.parse(value), "Inbox item");
    const activeClaim = item.status === "claimed" ? item.lastClaim : null;
    if (
      item.sessionId !== String(row["session_id"]) ||
      item.sequence !== Number(row["sequence"]) ||
      item.itemId !== String(row["item_id"]) ||
      item.idempotencyKey !== String(row["idempotency_key"]) ||
      item.status !== String(row["status"]) ||
      item.acceptedAt !== String(row["accepted_at"]) ||
      (activeClaim?.claimToken ?? null) !==
        (row["claim_token"] === null ? null : String(row["claim_token"])) ||
      (activeClaim?.leaseExpiresAt ?? null) !==
        (row["lease_expires_at"] === null ? null : String(row["lease_expires_at"]))
    ) {
      throw new StoreError("corrupt", "Inbox item JSON 与索引列不一致");
    }
    return item;
  }

  #updateInboxItem(item: InboxItem): void {
    const activeClaim = item.status === "claimed" ? item.lastClaim : null;
    const result = this.#database
      .prepare(
        "UPDATE inbox_items SET status=?,claim_token=?,lease_expires_at=?,item_json=? WHERE item_id=? AND session_id=?",
      )
      .run(
        item.status,
        activeClaim?.claimToken ?? null,
        activeClaim?.leaseExpiresAt ?? null,
        canonicalJson(item),
        item.itemId,
        item.sessionId,
      );
    if (Number(result.changes) !== 1) throw new StoreError("internal", "Inbox item 更新失败");
  }

  #sessionRow(sessionId: string): Row | undefined {
    return this.#database.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as
      Row | undefined;
  }

  #header(sessionId: string): SessionHeader {
    const row = this.#sessionRow(sessionId);
    if (!row) throw new StoreError("not_found", "Session 不存在");
    const header = this.#rowToHeader(row);
    this.#assertSessionV2Identity(header);
    return header;
  }

  #rowToHeader(row: Row): SessionHeader {
    const schemaVersion = Number(row["schema_version"]);
    const common = {
      sessionId: String(row["session_id"]),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      revision: Number(row["revision"]),
      activeRunId: row["active_run_id"] === null ? null : String(row["active_run_id"]),
      activeTurnId: row["active_turn_id"] === null ? null : String(row["active_turn_id"]),
    };
    if (schemaVersion === 1) {
      return sessionHeaderSchema.parse({ ...common, schemaVersion: 1 });
    }
    if (schemaVersion === 2) {
      return sessionHeaderSchema.parse({
        ...common,
        schemaVersion: 2,
        lineage: parseJson(
          row["lineage_json"],
          (value) => sessionLineageSchema.parse(value),
          "Session lineage",
        ),
        profile: parseJson(
          row["profile_json"],
          (value) => agentProfileIdentitySchema.parse(value),
          "Agent profile identity",
        ),
      });
    }
    throw new StoreError("version_unsupported", `不支持 Session schema version ${schemaVersion}`);
  }

  #assertSessionV2Identity(header: SessionHeader): void {
    if (header.schemaVersion === 1) return;
    const row = this.#database
      .prepare("SELECT record_json FROM session_records WHERE session_id=? AND position=1")
      .get(header.sessionId) as Row | undefined;
    if (!row) throw new StoreError("corrupt", "Session v2 缺少 session.created", 0);
    const record = parseJson(
      row["record_json"],
      (value) => sessionRecordSchema.parse(value),
      "Session created record",
    );
    assertSessionRecordChecksum(record);
    if (
      record.recordType !== "session.created" ||
      record.schemaVersion !== 2 ||
      record.payload.sessionId !== header.sessionId ||
      record.payload.createdAt !== header.createdAt ||
      canonicalJson(record.payload.lineage) !== canonicalJson(header.lineage) ||
      canonicalJson(record.payload.profile) !== canonicalJson(header.profile)
    ) {
      throw new StoreError("corrupt", "Session v2 Header 与创建事实不一致", 0);
    }
  }

  #checkpointById(checkpointId: string): Checkpoint | null {
    const row = this.#database
      .prepare("SELECT checkpoint_json FROM checkpoints WHERE checkpoint_id=?")
      .get(checkpointId) as Row | undefined;
    return row ? this.#parseCheckpoint(row["checkpoint_json"]) : null;
  }

  #parseCheckpoint(value: unknown): Checkpoint {
    const checkpoint = parseJson(
      value,
      (candidate) => checkpointSchema.parse(candidate),
      "Checkpoint",
    );
    assertCheckpointChecksum(checkpoint);
    return checkpoint;
  }

  #transaction<T>(operation: () => T): T {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // 事务可能已由 SQLite 自动回滚。
      }
      if (error instanceof StoreError) throw error;
      const code = (error as { code?: string }).code ?? "";
      if (code.includes("BUSY") || code.includes("LOCKED")) {
        throw new StoreError("busy", "SQLite 正忙");
      }
      if (code.includes("CONSTRAINT")) {
        throw new StoreError("idempotency_conflict", "SQLite 唯一约束冲突");
      }
      throw new StoreError("internal", "SQLite 操作失败");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new StoreError("closed", "Storage 已关闭");
  }
}
