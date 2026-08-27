/**
 * 模块职责：为生产 Composition 生成稳定的 Session Profile 身份并校验复用兼容性。
 *
 * 设计边界：A1 只冻结身份摘要；完整 Profile 内容与 ExtensionHost 生命周期留给 A5。
 * 关键流程：装配完成后计算摘要，新 Session 固化它，后续 Turn 与恢复先核对再运行。
 */
import {
  agentProfileIdentitySchema,
  canonicalJson,
  checksum,
  StoreError,
} from "../../core/ports/session_store/session-store-port.js";
import type {
  AgentProfileIdentity,
  RunConfigSnapshot,
  SessionHeader,
  SessionLineage,
} from "../../core/ports/session_store/session-store-port.js";
import type { AppConfig } from "./app-config.js";

export const ROOT_SESSION_LINEAGE: SessionLineage = Object.freeze({
  kind: "root",
  parentSessionId: null,
  parentPosition: null,
  parentRecordChecksum: null,
  delegationDepth: 0,
});

export function createAgentProfileIdentity(
  config: AppConfig,
  snapshot: RunConfigSnapshot,
): AgentProfileIdentity {
  return agentProfileIdentitySchema.parse({
    profileId: "coding-agent.default",
    profileVersion: "a1-v1",
    profileDigest: checksum({
      schemaVersion: 1,
      baseConfigDigest: snapshot.baseConfigDigest,
      modelConfigId: snapshot.modelConfigId,
      enabledToolSchemaDigest: snapshot.enabledToolSchemaDigest,
      policyVersion: snapshot.policyVersion,
      sandboxProfileVersion: snapshot.sandboxProfileVersion,
      toolOrder: config.tools.enabledNames,
      skillIds: config.skills.enabledIds,
      memoryProvider: config.memory.provider,
    }),
  });
}

export function assertSessionProfileCompatible(
  header: SessionHeader,
  expected: AgentProfileIdentity,
): void {
  // v1 没有 Profile 身份；保留读取和恢复兼容，由既有 Turn 环境快照继续校验。
  if (header.schemaVersion === 1) return;
  if (canonicalJson(header.profile) !== canonicalJson(expected)) {
    throw new StoreError(
      "conflict",
      `Session ${header.sessionId} 的 Agent Profile 与当前装配不一致`,
    );
  }
}
