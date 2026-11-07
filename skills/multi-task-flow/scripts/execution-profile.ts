import {
  executionProfile,
  recommendedExecutionProfile,
  type ExecutionProfile,
  type Ledger,
} from "./schema";
import { requireCondition } from "./errors";

export const RECOMMENDATION_VERSION = "kind-v1";
export type ProfileCapabilities = { model: string; thinking: string[] }[];
export function validateProfileCapability(
  profile: ExecutionProfile,
  capabilities: ProfileCapabilities,
): ExecutionProfile {
  const pair = executionProfile.parse(profile);
  requireCondition(
    capabilities.some(
      (item) =>
        item.model === pair.model && item.thinking.includes(pair.thinking),
    ),
    "PROFILE_UNAVAILABLE",
    `Unsupported execution profile: ${pair.model}/${pair.thinking}`,
    3,
  );
  return pair;
}
export function effectiveProfile(
  ledger: Ledger,
  target: { execution_profile?: ExecutionProfile | null },
): ExecutionProfile {
  const profile = target.execution_profile ?? ledger.config.execution_profile;
  requireCondition(
    profile,
    "PROFILE_MIGRATION_REQUIRED",
    "Run has no execution profile; explicitly migrate it before writing",
    4,
  );
  return executionProfile.parse(profile);
}
export function profileFreezeReason(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
): string | null {
  const bound =
    targetType === "group"
      ? ledger.groups.find((item) => item.id === targetId)?.agent_thread_id
      : ledger.tasks.find((item) => item.id === targetId)?.thread_id;
  if (bound) return "对话已创建";
  // Only confirmed failure releases the request freeze; unknown remains reserved.
  const operation = ledger.operations.find(
    (item) =>
      item.kind === "dispatch" &&
      item.target_id === targetId &&
      (item.request.target_type === "group" ? "group" : "task") ===
        targetType &&
      !!item.request.native_request_id &&
      item.status !== "failed",
  );
  return operation ? "对话创建请求已提交，须先对账" : null;
}
export function materializeRecommendation(
  ledger: Ledger,
  target: Ledger["tasks"][number] | Ledger["groups"][number],
): void {
  if (
    target.execution_profile !== null &&
    target.execution_profile !== undefined
  )
    return;
  const kind = "kind" in target ? target.kind : "other";
  target.execution_profile = recommendedExecutionProfile(
    kind,
    effectiveProfile(ledger, target),
  );
  target.execution_profile_source = "recommendation";
  target.execution_profile_rule = RECOMMENDATION_VERSION;
}

export function profileProjection(
  ledger: Ledger,
  targetType: "group" | "task",
  target: { id: string; execution_profile?: ExecutionProfile | null },
) {
  return {
    effective_execution_profile: ledger.config.execution_profile
      ? effectiveProfile(ledger, target)
      : null,
    profile_freeze_reason: profileFreezeReason(ledger, targetType, target.id),
  };
}

export function profileMigrationWarnings(ledger: Ledger): { reason: string }[] {
  return ledger.config.execution_profile
    ? []
    : [
        {
          reason:
            "旧运行尚未迁移执行配置；当前只读，请使用 execution-profile-migrate 显式指定默认模型和思考等级。",
        },
      ];
}
