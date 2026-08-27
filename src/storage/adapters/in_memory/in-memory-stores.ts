/**
 * 模块职责：用内存实现 SessionStorePort 与 CheckpointStorePort，便于测试和短生命周期运行。
 *
 * 设计边界：数据不跨进程持久化，但仍严格模拟 revision、position、幂等和校验语义。
 * 关键流程：写入前校验草稿和预期 revision，复制保存；读取时分页或选择最近 checkpoint。
 */
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
  assertSessionRecordChecksum,
  canonicalJson,
  computeSessionRecordChecksum,
  createSessionArtifacts,
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

interface StoredSession {
  header: SessionHeader;
  records: SessionRecord[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cancelled(options: Readonly<StoreCallOptions>): void {
  if (options.signal.aborted) throw new StoreError("cancelled", "Storage 操作已取消");
}

function positiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new StoreError("invalid_record", "limit 必须为正整数");
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

export class InMemoryStores implements SessionStorePort, CheckpointStorePort, InboxStorePort {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #recordsById = new Map<string, SessionRecord>();
  readonly #checkpoints = new Map<string, Checkpoint>();
  readonly #inboxBySession = new Map<string, InboxItem[]>();
  readonly #inboxByItemId = new Map<string, InboxItem>();
  #closed = false;

  async create(
    input: Readonly<CreateSessionInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<SessionHeader> {
    this.#assertOpen();
    cancelled(options);
    if (this.#sessions.has(input.sessionId))
      throw new StoreError("already_exists", "Session 已存在");
    if (this.#recordsById.has(input.recordId))
      throw new StoreError("already_exists", "recordId 已存在");
    const { record, header } = createSessionArtifacts(input);
    cancelled(options);
    this.#sessions.set(input.sessionId, { header, records: [record] });
    this.#recordsById.set(input.recordId, record);
    return clone(header);
  }

  async append(
    sessionId: string,
    expectedRevision: number,
    draftsInput: readonly Readonly<SessionRecordDraft>[],
    options: Readonly<StoreCallOptions>,
  ): Promise<AppendSessionResult> {
    this.#assertOpen();
    cancelled(options);
    const session = this.#session(sessionId);
    if (draftsInput.length === 0) throw new StoreError("invalid_record", "append batch 不能为空");
    let drafts: SessionRecordDraft[];
    try {
      drafts = draftsInput.map((draft) => sessionRecordDraftSchema.parse(draft));
    } catch {
      throw new StoreError("invalid_record", "Session record draft 非法");
    }
    const ids = drafts.map((draft) => draft.recordId);
    if (new Set(ids).size !== ids.length)
      throw new StoreError("invalid_record", "batch recordId 重复");

    const existing = drafts.map((draft) => this.#recordsById.get(draft.recordId));
    if (existing.every((record) => record !== undefined)) {
      const records = existing as SessionRecord[];
      if (!records.every((record, index) => draftMatches(record, drafts[index]!, sessionId))) {
        throw new StoreError("idempotency_conflict", "recordId 的重试内容不同");
      }
      return {
        revision: session.header.revision,
        positions: records.map((record) => record.position),
        records: clone(records),
      };
    }
    if (existing.some((record) => record !== undefined)) {
      throw new StoreError("idempotency_conflict", "append batch 部分 recordId 已存在");
    }
    if (session.header.revision !== expectedRevision) {
      throw new StoreError("conflict", "Session revision 冲突");
    }

    let state = replaySessionRecords(session.records);
    const records: SessionRecord[] = [];
    for (const [index, draft] of drafts.entries()) {
      state = applySessionDraft(state, draft);
      const content = {
        ...draft,
        sessionId,
        position: session.records.length + index + 1,
      };
      records.push(
        sessionRecordSchema.parse({
          ...content,
          checksum: computeSessionRecordChecksum(content),
        }),
      );
    }
    cancelled(options);
    const last = records.at(-1)!;
    const active = isActiveSessionState(state) ? state : null;
    session.records.push(...records);
    session.header = sessionHeaderSchema.parse({
      ...session.header,
      updatedAt: last.recordedAt,
      revision: session.header.revision + 1,
      activeRunId: active?.runId ?? null,
      activeTurnId: active?.turn.turnId ?? null,
    });
    for (const record of records) this.#recordsById.set(record.recordId, record);
    return {
      revision: session.header.revision,
      positions: records.map((record) => record.position),
      records: clone(records),
    };
  }

  async read(
    sessionId: string,
    afterPosition: number,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<ReadSessionPage> {
    this.#assertOpen();
    cancelled(options);
    positiveLimit(limit);
    if (!Number.isSafeInteger(afterPosition) || afterPosition < 0) {
      throw new StoreError("invalid_record", "afterPosition 非法");
    }
    const session = this.#session(sessionId);
    for (const [index, record] of session.records.entries()) {
      if (record.position !== index + 1)
        throw new StoreError("corrupt", "Session position 不连续", index);
      sessionRecordSchema.parse(record);
      assertSessionRecordChecksum(record);
    }
    const records = session.records.slice(afterPosition, afterPosition + limit);
    const lastPosition = records.at(-1)?.position ?? afterPosition;
    return {
      revision: session.header.revision,
      records: clone(records),
      nextPosition: lastPosition < session.records.length ? lastPosition : null,
    };
  }

  async get(sessionId: string, options: Readonly<StoreCallOptions>): Promise<SessionHeader> {
    this.#assertOpen();
    cancelled(options);
    return clone(this.#session(sessionId).header);
  }

  async list(
    cursor: string | null,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<SessionListPage> {
    this.#assertOpen();
    cancelled(options);
    positiveLimit(limit);
    const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new StoreError("invalid_record", "cursor 非法");
    const all = [...this.#sessions.values()]
      .map((session) => session.header)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
    const sessions = all.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    return {
      sessions: clone(sessions),
      nextCursor: nextOffset < all.length ? String(nextOffset) : null,
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
    this.#session(input.sessionId);
    const items = this.#inboxBySession.get(input.sessionId) ?? [];
    const byKey = items.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (byKey) {
      if (canonicalJson(byKey.message) !== canonicalJson(input.message)) {
        throw new StoreError("idempotency_conflict", "Inbox 幂等键的重试内容不同");
      }
      return { item: clone(byKey), created: false };
    }
    if (this.#inboxByItemId.has(input.itemId)) {
      throw new StoreError("idempotency_conflict", "Inbox itemId 已被其他消息使用");
    }
    const item = inboxItemSchema.parse({
      schemaVersion: 1,
      itemId: input.itemId,
      sessionId: input.sessionId,
      sequence: items.length + 1,
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
    items.push(item);
    this.#inboxBySession.set(input.sessionId, items);
    this.#inboxByItemId.set(input.itemId, item);
    return { item: clone(item), created: true };
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
    this.#session(input.sessionId);
    const items = this.#inboxBySession.get(input.sessionId) ?? [];
    const active = items.find((item) => item.status === "claimed");
    let target: InboxItem | undefined;
    if (active?.status === "claimed") {
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
      target = items.find((item) => item.status === "pending");
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
    this.#replaceInboxItem(claimed);
    return clone(claimed);
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
    this.#replaceInboxItem(completed);
    return clone(completed);
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
    this.#replaceInboxItem(renewed);
    return clone(renewed);
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
    this.#replaceInboxItem(pending);
    return clone(pending);
  }

  async getItem(itemId: string, options: Readonly<StoreCallOptions>): Promise<InboxItem> {
    this.#assertOpen();
    cancelled(options);
    const item = this.#inboxByItemId.get(itemId);
    if (!item) throw new StoreError("not_found", "Inbox item 不存在");
    return clone(inboxItemSchema.parse(item));
  }

  async listInbox(
    sessionId: string,
    afterSequence: number,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxListPage> {
    this.#assertOpen();
    cancelled(options);
    this.#session(sessionId);
    positiveLimit(limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new StoreError("invalid_record", "Inbox afterSequence 非法");
    }
    const all = this.#inboxBySession.get(sessionId) ?? [];
    const items = all.slice(afterSequence, afterSequence + limit);
    const lastSequence = items.at(-1)?.sequence ?? afterSequence;
    return {
      items: clone(items.map((item) => inboxItemSchema.parse(item))),
      nextSequence: lastSequence < all.length ? lastSequence : null,
    };
  }

  async save(
    draft: Readonly<CheckpointDraft>,
    options: Readonly<StoreCallOptions>,
  ): Promise<Checkpoint> {
    this.#assertOpen();
    cancelled(options);
    const checkpoint = createCheckpoint(draft);
    const session = this.#session(checkpoint.sessionId);
    if (checkpoint.recordPosition > session.records.length) {
      throw new StoreError("invalid_record", "Checkpoint cursor 超过 Session 事实位置");
    }
    const existing = this.#checkpoints.get(checkpoint.checkpointId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(checkpoint)) {
        throw new StoreError("idempotency_conflict", "checkpointId 内容冲突");
      }
      return clone(existing);
    }
    const sameRun = [...this.#checkpoints.values()].filter(
      (candidate) => candidate.runId === checkpoint.runId,
    );
    const latest = sameRun.sort((a, b) => b.recordPosition - a.recordPosition)[0];
    if (latest && checkpoint.recordPosition <= latest.recordPosition) {
      throw new StoreError("conflict", "Checkpoint cursor 不能倒退或重复");
    }
    this.#checkpoints.set(checkpoint.checkpointId, checkpoint);
    const retained = [...sameRun, checkpoint]
      .sort((a, b) => b.recordPosition - a.recordPosition)
      .slice(3);
    for (const candidate of retained) this.#checkpoints.delete(candidate.checkpointId);
    return clone(checkpoint);
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
    const checkpoints = [...this.#checkpoints.values()]
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => right.recordPosition - left.recordPosition);
    for (const checkpoint of checkpoints) {
      checkpointSchema.parse(checkpoint);
      assertCheckpointChecksum(checkpoint);
    }
    return clone(checkpoints);
  }

  async listCheckpointCandidates(
    runId: string,
    options: Readonly<StoreCallOptions>,
  ): Promise<readonly CheckpointCandidate[]> {
    this.#assertOpen();
    cancelled(options);
    return [...this.#checkpoints.values()]
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => right.recordPosition - left.recordPosition)
      .map((checkpoint) => {
        try {
          checkpointSchema.parse(checkpoint);
          assertCheckpointChecksum(checkpoint);
          return { checkpointId: checkpoint.checkpointId, checkpoint: clone(checkpoint) };
        } catch {
          return { checkpointId: checkpoint.checkpointId, checkpoint: null };
        }
      });
  }

  async deleteInvalid(
    checkpointIds: readonly string[],
    options: Readonly<StoreCallOptions>,
  ): Promise<number> {
    this.#assertOpen();
    cancelled(options);
    let deleted = 0;
    for (const id of checkpointIds) {
      if (this.#checkpoints.delete(id)) deleted += 1;
    }
    return deleted;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #session(sessionId: string): StoredSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new StoreError("not_found", "Session 不存在");
    return session;
  }

  #inboxItem(itemId: string, sessionId: string): InboxItem {
    const item = this.#inboxByItemId.get(itemId);
    if (!item) throw new StoreError("not_found", "Inbox item 不存在");
    if (item.sessionId !== sessionId) throw new StoreError("not_found", "Inbox item 不存在");
    return item;
  }

  #replaceInboxItem(item: InboxItem): void {
    const items = this.#inboxBySession.get(item.sessionId);
    const index = items?.findIndex((candidate) => candidate.itemId === item.itemId) ?? -1;
    if (!items || index < 0) throw new StoreError("internal", "Inbox item 索引损坏");
    items[index] = item;
    this.#inboxByItemId.set(item.itemId, item);
  }

  #assertOpen(): void {
    if (this.#closed) throw new StoreError("closed", "Storage 已关闭");
  }
}
