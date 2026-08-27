/**
 * 模块职责：定义 durable Inbox 的消息、幂等入队、租约领取和完成/释放协议。
 *
 * 设计边界：Inbox 只决定“下一件待办是什么”；RunState 与执行事实仍属于 Session 日志。
 * 关键流程：消息先按幂等键入队，Driver 以租约串行领取，成功完成或失败释放后才能处理下一条。
 */
import { z } from "zod";

import {
  isoUtcDateTimeSchema,
  nonEmptyIdSchema,
  userMessageSchema,
} from "../../context/types/context-types.js";
import type { StoreCallOptions } from "../session_store/session-store-port.js";

export const inboxFailureSchema = z
  .object({
    code: nonEmptyIdSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const inboxClaimSchema = z
  .object({
    claimToken: nonEmptyIdSchema,
    claimedBy: nonEmptyIdSchema,
    claimedAt: isoUtcDateTimeSchema,
    leaseExpiresAt: isoUtcDateTimeSchema,
  })
  .strict()
  .refine(
    (claim) => Date.parse(claim.leaseExpiresAt) > Date.parse(claim.claimedAt),
    "Inbox lease 必须晚于 claimedAt",
  );

export const inboxCompletionSchema = z
  .object({
    runId: nonEmptyIdSchema,
    turnId: nonEmptyIdSchema,
  })
  .strict();

const inboxItemBase = {
  schemaVersion: z.literal(1),
  itemId: nonEmptyIdSchema,
  sessionId: nonEmptyIdSchema,
  sequence: z.number().int().positive(),
  idempotencyKey: nonEmptyIdSchema,
  kind: z.literal("user_message"),
  message: userMessageSchema,
  acceptedAt: isoUtcDateTimeSchema,
  deliveryAttempt: z.number().int().nonnegative(),
  lastFailure: inboxFailureSchema.nullable(),
};

const pendingInboxItemSchema = z
  .object({
    ...inboxItemBase,
    status: z.literal("pending"),
    lastClaim: inboxClaimSchema.nullable(),
    releasedAt: isoUtcDateTimeSchema.nullable(),
    completedAt: z.null(),
    completion: z.null(),
  })
  .strict();

const claimedInboxItemSchema = z
  .object({
    ...inboxItemBase,
    status: z.literal("claimed"),
    deliveryAttempt: z.number().int().positive(),
    lastClaim: inboxClaimSchema,
    releasedAt: z.null(),
    completedAt: z.null(),
    completion: z.null(),
  })
  .strict();

const completedInboxItemSchema = z
  .object({
    ...inboxItemBase,
    status: z.literal("completed"),
    deliveryAttempt: z.number().int().positive(),
    lastClaim: inboxClaimSchema,
    releasedAt: z.null(),
    completedAt: isoUtcDateTimeSchema,
    completion: inboxCompletionSchema,
  })
  .strict();

export const inboxItemSchema = z.discriminatedUnion("status", [
  pendingInboxItemSchema,
  claimedInboxItemSchema,
  completedInboxItemSchema,
]);

export const enqueueInboxInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    itemId: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    idempotencyKey: nonEmptyIdSchema,
    message: userMessageSchema,
    acceptedAt: isoUtcDateTimeSchema,
  })
  .strict();

export const claimInboxInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: nonEmptyIdSchema,
    claim: inboxClaimSchema,
  })
  .strict();

export const completeInboxInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: nonEmptyIdSchema,
    itemId: nonEmptyIdSchema,
    claimToken: nonEmptyIdSchema,
    completedAt: isoUtcDateTimeSchema,
    completion: inboxCompletionSchema,
  })
  .strict();

export const renewInboxClaimInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: nonEmptyIdSchema,
    itemId: nonEmptyIdSchema,
    claimToken: nonEmptyIdSchema,
    renewedAt: isoUtcDateTimeSchema,
    leaseExpiresAt: isoUtcDateTimeSchema,
  })
  .strict()
  .refine(
    (input) => Date.parse(input.leaseExpiresAt) > Date.parse(input.renewedAt),
    "Inbox 续租截止时间必须晚于 renewedAt",
  );

export const releaseInboxInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: nonEmptyIdSchema,
    itemId: nonEmptyIdSchema,
    claimToken: nonEmptyIdSchema,
    releasedAt: isoUtcDateTimeSchema,
    failure: inboxFailureSchema,
  })
  .strict();

export type InboxFailure = z.infer<typeof inboxFailureSchema>;
export type InboxClaim = z.infer<typeof inboxClaimSchema>;
export type InboxCompletion = z.infer<typeof inboxCompletionSchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type EnqueueInboxInput = z.infer<typeof enqueueInboxInputSchema>;
export type ClaimInboxInput = z.infer<typeof claimInboxInputSchema>;
export type CompleteInboxInput = z.infer<typeof completeInboxInputSchema>;
export type RenewInboxClaimInput = z.infer<typeof renewInboxClaimInputSchema>;
export type ReleaseInboxInput = z.infer<typeof releaseInboxInputSchema>;

export interface EnqueueInboxResult {
  readonly item: InboxItem;
  readonly created: boolean;
}

export interface InboxListPage {
  readonly items: readonly InboxItem[];
  readonly nextSequence: number | null;
}

export interface InboxStorePort {
  enqueue(
    input: Readonly<EnqueueInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<EnqueueInboxResult>;
  claimNext(
    input: Readonly<ClaimInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem | null>;
  complete(
    input: Readonly<CompleteInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem>;
  renewClaim(
    input: Readonly<RenewInboxClaimInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem>;
  release(
    input: Readonly<ReleaseInboxInput>,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxItem>;
  getItem(itemId: string, options: Readonly<StoreCallOptions>): Promise<InboxItem>;
  listInbox(
    sessionId: string,
    afterSequence: number,
    limit: number,
    options: Readonly<StoreCallOptions>,
  ): Promise<InboxListPage>;
  close(): Promise<void>;
}
