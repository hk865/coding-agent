/**
 * 模块职责：定义 Session 头、记录、分页读取、乐观并发追加和存储错误协议。
 *
 * 设计边界：Core 不依赖具体数据库；适配器必须自行保证原子性、顺序和 revision 语义。
 * 关键流程：创建 Session 后按 expectedRevision 追加记录，读取端按 position 分页重放。
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  isoUtcDateTimeSchema,
  jsonValueSchema,
  nonEmptyIdSchema,
} from "../../context/types/context-types.js";
import { agentEventSchema } from "../../runtime/events/agent-events.js";
import { runLimitsSchema } from "../../runtime/limits/limit-guard.js";
import { runSchema } from "../../runtime/state/run-state.js";

export const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const agentProfileIdentitySchema = z
  .object({
    profileId: nonEmptyIdSchema,
    profileVersion: nonEmptyIdSchema,
    profileDigest: checksumSchema,
  })
  .strict();

export const sessionLineageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("root"),
      parentSessionId: z.null(),
      parentPosition: z.null(),
      parentRecordChecksum: z.null(),
      delegationDepth: z.literal(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fork"),
      parentSessionId: nonEmptyIdSchema,
      parentPosition: z.number().int().positive(),
      parentRecordChecksum: checksumSchema,
      delegationDepth: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delegated"),
      parentSessionId: nonEmptyIdSchema,
      parentPosition: z.number().int().positive(),
      parentRecordChecksum: checksumSchema,
      delegationDepth: z.number().int().positive(),
    })
    .strict(),
]);

export const extensionFactEnvelopeSchema = z
  .object({
    namespace: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
    factType: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    schemaVersion: z.number().int().positive(),
    ignorable: z.boolean(),
    modelVisibility: z.enum(["hidden", "context"]),
    data: jsonValueSchema,
  })
  .strict();

export const workspaceReferenceSchema = z
  .object({
    identity: nonEmptyIdSchema,
    revision: nonEmptyIdSchema,
    reference: z.string().min(1),
  })
  .strict();

export const runConfigSnapshotSchema = z
  .object({
    modelConfigId: nonEmptyIdSchema,
    limits: runLimitsSchema,
    enabledToolSchemaDigest: checksumSchema,
    policyVersion: nonEmptyIdSchema,
    sandboxProfileVersion: nonEmptyIdSchema,
    baseConfigDigest: checksumSchema,
  })
  .strict();

const recordBaseV1 = {
  recordId: nonEmptyIdSchema,
  sessionId: nonEmptyIdSchema,
  position: z.number().int().positive(),
  schemaVersion: z.literal(1),
  recordedAt: isoUtcDateTimeSchema,
  checksum: checksumSchema,
};

const sessionCreatedV1RecordSchema = z
  .object({
    ...recordBaseV1,
    recordType: z.literal("session.created"),
    payload: z.object({ sessionId: nonEmptyIdSchema, createdAt: isoUtcDateTimeSchema }).strict(),
  })
  .strict();

const sessionCreatedV2RecordSchema = z
  .object({
    ...recordBaseV1,
    schemaVersion: z.literal(2),
    recordType: z.literal("session.created"),
    payload: z
      .object({
        sessionId: nonEmptyIdSchema,
        createdAt: isoUtcDateTimeSchema,
        lineage: sessionLineageSchema,
        profile: agentProfileIdentitySchema,
      })
      .strict(),
  })
  .strict();

const turnStartedRecordSchema = z
  .object({
    ...recordBaseV1,
    recordType: z.literal("turn.started"),
    payload: z
      .object({
        run: runSchema,
        config: runConfigSnapshotSchema,
        workspace: workspaceReferenceSchema,
      })
      .strict(),
  })
  .strict();

const agentEventRecordSchema = z
  .object({
    ...recordBaseV1,
    recordType: z.literal("agent.event"),
    payload: z.object({ event: agentEventSchema }).strict(),
  })
  .strict();

const extensionFactRecordSchema = z
  .object({
    ...recordBaseV1,
    recordType: z.literal("extension.fact"),
    payload: extensionFactEnvelopeSchema,
  })
  .strict();

export const sessionRecordSchema = z.union([
  sessionCreatedV1RecordSchema,
  sessionCreatedV2RecordSchema,
  turnStartedRecordSchema,
  agentEventRecordSchema,
  extensionFactRecordSchema,
]);

const draftBase = {
  recordId: nonEmptyIdSchema,
  schemaVersion: z.literal(1),
  recordedAt: isoUtcDateTimeSchema,
};

export const sessionRecordDraftSchema = z.discriminatedUnion("recordType", [
  z
    .object({
      ...draftBase,
      recordType: z.literal("turn.started"),
      payload: z
        .object({
          run: runSchema,
          config: runConfigSnapshotSchema,
          workspace: workspaceReferenceSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...draftBase,
      recordType: z.literal("agent.event"),
      payload: z.object({ event: agentEventSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...draftBase,
      recordType: z.literal("extension.fact"),
      payload: extensionFactEnvelopeSchema,
    })
    .strict(),
]);

const sessionHeaderBase = {
  sessionId: nonEmptyIdSchema,
  createdAt: isoUtcDateTimeSchema,
  updatedAt: isoUtcDateTimeSchema,
  revision: z.number().int().positive(),
  activeRunId: nonEmptyIdSchema.nullable(),
  activeTurnId: nonEmptyIdSchema.nullable(),
};

const sessionHeaderV1Schema = z
  .object({
    ...sessionHeaderBase,
    schemaVersion: z.literal(1),
  })
  .strict();

const sessionHeaderV2Schema = z
  .object({
    ...sessionHeaderBase,
    schemaVersion: z.literal(2),
    lineage: sessionLineageSchema,
    profile: agentProfileIdentitySchema,
  })
  .strict();

export const sessionHeaderSchema = z.discriminatedUnion("schemaVersion", [
  sessionHeaderV1Schema,
  sessionHeaderV2Schema,
]);

export const createSessionInputSchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1).optional(),
      sessionId: nonEmptyIdSchema,
      recordId: nonEmptyIdSchema,
      createdAt: isoUtcDateTimeSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      sessionId: nonEmptyIdSchema,
      recordId: nonEmptyIdSchema,
      createdAt: isoUtcDateTimeSchema,
      lineage: sessionLineageSchema,
      profile: agentProfileIdentitySchema,
    })
    .strict(),
]);

export type WorkspaceReference = z.infer<typeof workspaceReferenceSchema>;
export type RunConfigSnapshot = z.infer<typeof runConfigSnapshotSchema>;
export type AgentProfileIdentity = z.infer<typeof agentProfileIdentitySchema>;
export type SessionLineage = z.infer<typeof sessionLineageSchema>;
export type ExtensionFactEnvelope = z.infer<typeof extensionFactEnvelopeSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionRecordDraft = z.infer<typeof sessionRecordDraftSchema>;
export type SessionHeader = z.infer<typeof sessionHeaderSchema>;
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export type StoreErrorCode =
  | "not_found"
  | "already_exists"
  | "conflict"
  | "idempotency_conflict"
  | "invalid_record"
  | "version_unsupported"
  | "corrupt"
  | "busy"
  | "cancelled"
  | "closed"
  | "internal";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly lastTrustedPosition: number | null = null,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface StoreCallOptions {
  readonly signal: AbortSignal;
}

export interface AppendSessionResult {
  readonly revision: number;
  readonly positions: readonly number[];
  readonly records: readonly SessionRecord[];
}

export interface ReadSessionPage {
  readonly revision: number;
  readonly records: readonly SessionRecord[];
  readonly nextPosition: number | null;
}

export interface SessionListPage {
  readonly sessions: readonly SessionHeader[];
  readonly nextCursor: string | null;
}

export interface SessionStorePort {
  create(
    input: Readonly<CreateSessionInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<SessionHeader>;
  append(
    sessionId: string,
    expectedRevision: number,
    records: readonly Readonly<SessionRecordDraft>[],
    options: Readonly<StoreCallOptions>,
  ): Promise<AppendSessionResult>;
  read(
    sessionId: string,
    afterPosition: number,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<ReadSessionPage>;
  get(sessionId: string, options: Readonly<StoreCallOptions>): Promise<SessionHeader>;
  list(
    cursor: string | null,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<SessionListPage>;
  close(): Promise<void>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function computeSessionRecordChecksum(record: Omit<SessionRecord, "checksum">): string {
  return checksum(record);
}

export function createSessionArtifacts(inputValue: Readonly<CreateSessionInput>): {
  readonly header: SessionHeader;
  readonly record: SessionRecord;
} {
  const input = createSessionInputSchema.parse(inputValue);
  const content =
    input.schemaVersion === 2
      ? {
          recordId: input.recordId,
          sessionId: input.sessionId,
          position: 1,
          recordType: "session.created" as const,
          schemaVersion: 2 as const,
          recordedAt: input.createdAt,
          payload: {
            sessionId: input.sessionId,
            createdAt: input.createdAt,
            lineage: input.lineage,
            profile: input.profile,
          },
        }
      : {
          recordId: input.recordId,
          sessionId: input.sessionId,
          position: 1,
          recordType: "session.created" as const,
          schemaVersion: 1 as const,
          recordedAt: input.createdAt,
          payload: { sessionId: input.sessionId, createdAt: input.createdAt },
        };
  const record = sessionRecordSchema.parse({
    ...content,
    checksum: computeSessionRecordChecksum(content),
  });
  const commonHeader = {
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    revision: 1,
    activeRunId: null,
    activeTurnId: null,
  };
  const header = sessionHeaderSchema.parse(
    input.schemaVersion === 2
      ? {
          ...commonHeader,
          schemaVersion: 2,
          lineage: input.lineage,
          profile: input.profile,
        }
      : { ...commonHeader, schemaVersion: 1 },
  );
  return { header, record };
}

export function assertSessionRecordChecksum(record: SessionRecord): void {
  const { checksum: actual, ...content } = record;
  if (computeSessionRecordChecksum(content) !== actual) {
    throw new StoreError(
      "corrupt",
      `Session record ${record.position} checksum 不匹配`,
      record.position - 1,
    );
  }
}
