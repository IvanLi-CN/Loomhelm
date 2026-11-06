import { FlowError, isRecord } from "./common";

export const DIRECT_REVIEW_POLICY_PROFILES = [
  { model: "gpt-6-luna", effort: "high" },
  { model: "gpt-6-luna", effort: "max" },
  { model: "gpt-5.6-luna", effort: "xhigh" },
  { model: "gpt-5.6-luna", effort: "max" },
  { model: "gpt-6.1-terra", effort: "xhigh" },
  { model: "gpt-6.1-sol", effort: "medium" },
] as const;

const COMPLEXITY_INDEX: Record<string, number> = {
  ordinary: 0,
  complex: 2,
  rigorous: 3,
  special: 5,
  "high-risk": 4,
};
const ESCALATION_COMPLEXITIES = new Set(["special", "high-risk"]);
const OVERRIDE_SCOPES = new Set(["invocation", "lane"]);
const LANE_ALIASES: Record<string, Set<string>> = {
  contract: new Set(["合同", "契约", "协议"]),
  "state-concurrency": new Set(["状态", "并发", "竞争", "竞态"]),
  "failure-data-safety": new Set(["失败", "数据", "安全", "数据安全"]),
  "test-platform": new Set(["测试", "平台"]),
  security: new Set(["security", "安全", "凭据", "认证", "权限"]),
  migration: new Set(["migration", "迁移"]),
  performance: new Set(["performance", "性能"]),
};
const ESCALATION_MARKERS = [
  "risk",
  "risky",
  "require",
  "because",
  "due",
  "impact",
  "boundary",
  "race",
  "contention",
  "recovery",
  "failure",
  "unsafe",
  "critical",
  "escalat",
  "风险",
  "升级",
  "需要",
  "边界",
  "竞争",
  "恢复",
  "失败",
  "影响",
  "关键",
];

export const DIRECT_REVIEW_ESCALATION_MARKERS = ESCALATION_MARKERS;
export const DIRECT_REVIEW_LANE_ALIASES = LANE_ALIASES;

export type DirectReviewProfile = {
  model: string;
  effort: string;
  source: "allowlist" | "owner-override";
  lane: string;
  profile?: number;
  override_scope?: "invocation" | "lane";
  escalation_reason?: string;
};

export interface DirectReviewProfileOptions {
  lane: string;
  ownerOverride?: unknown | undefined;
  overrideScope?: string | undefined;
  escalationReason?: string | undefined;
}

export function selectDirectReviewProfile(
  complexity: string,
  options: DirectReviewProfileOptions,
): DirectReviewProfile {
  if (!Object.hasOwn(COMPLEXITY_INDEX, complexity))
    throw new FlowError(
      "direct-review complexity must be ordinary, complex, rigorous, special, or high-risk",
    );
  const lane = nonempty(options.lane, "direct-review lane");
  const reason = optionalNonempty(
    options.escalationReason,
    "direct-review escalation reason",
  );
  if (ESCALATION_COMPLEXITIES.has(complexity)) {
    if (!reason)
      throw new FlowError(
        "special or high-risk direct review requires an escalation reason",
      );
    if (!laneSpecificReason(lane, reason))
      throw new FlowError(
        "special or high-risk direct review requires a lane-specific escalation reason",
      );
  }
  const ownerPair = completeOwnerPair(options.ownerOverride);
  if (ownerPair) {
    const scope = options.overrideScope ?? "invocation";
    if (!OVERRIDE_SCOPES.has(scope))
      throw new FlowError(
        "direct-review owner override requires scope=invocation or scope=lane",
      );
    return {
      model: ownerPair.model,
      effort: ownerPair.effort,
      source: "owner-override",
      override_scope: scope as "invocation" | "lane",
      lane,
      ...(reason ? { escalation_reason: reason } : {}),
    };
  }
  if (options.overrideScope !== undefined)
    throw new FlowError(
      "direct-review override_scope requires a complete owner override",
    );
  const profileIndex = COMPLEXITY_INDEX[complexity];
  const selected = DIRECT_REVIEW_POLICY_PROFILES[profileIndex ?? -1];
  if (!selected) throw new FlowError("direct-review profile index is invalid");
  return {
    ...selected,
    source: "allowlist",
    profile: (profileIndex as number) + 1,
    lane,
    ...(reason ? { escalation_reason: reason } : {}),
  };
}

export function selectDirectReviewProfiles(
  laneComplexities: Record<string, string>,
  options: {
    ownerOverride?: unknown;
    overrideScope?: string;
    overrideLane?: string;
    escalationReasons?: Record<string, string>;
  } = {},
): Record<string, DirectReviewProfile> {
  const lanes = Object.keys(laneComplexities);
  if (!lanes.length)
    throw new FlowError(
      "direct-review lane complexities must be a non-empty mapping",
    );
  if (lanes.some((lane) => !lane.trim()))
    throw new FlowError("direct-review lane names must be non-empty text");
  if (
    Object.values(laneComplexities).some((value) => typeof value !== "string")
  )
    throw new FlowError("direct-review lane complexity values must be text");
  if (
    options.escalationReasons &&
    Object.keys(options.escalationReasons).some((lane) => !lanes.includes(lane))
  )
    throw new FlowError(
      "direct-review escalation reasons must target known lanes",
    );
  const ownerPair = completeOwnerPair(options.ownerOverride);
  let scope = options.overrideScope;
  if (!ownerPair) {
    if (scope !== undefined || options.overrideLane !== undefined)
      throw new FlowError(
        "direct-review override target requires a complete owner override",
      );
  } else {
    scope ??= options.overrideLane !== undefined ? "lane" : "invocation";
    if (!OVERRIDE_SCOPES.has(scope))
      throw new FlowError(
        "direct-review owner override requires scope=invocation or scope=lane",
      );
  }
  if (scope === "invocation" && options.overrideLane !== undefined)
    throw new FlowError(
      "invocation-wide direct-review override cannot name a lane",
    );
  if (scope === "lane" && !lanes.includes(options.overrideLane ?? ""))
    throw new FlowError(
      "lane-scoped direct-review override must name a known lane",
    );
  return Object.fromEntries(
    lanes.map((lane) => {
      const applies =
        ownerPair !== undefined &&
        (scope === "invocation" || lane === options.overrideLane);
      return [
        lane,
        selectDirectReviewProfile(laneComplexities[lane]!, {
          lane,
          ownerOverride: applies ? options.ownerOverride : undefined,
          overrideScope: applies ? scope : undefined,
          escalationReason: options.escalationReasons?.[lane],
        }),
      ];
    }),
  );
}

export function directReviewRuntimeFields(profile: unknown): {
  model: string;
  reasoning_effort: string;
} {
  if (!isRecord(profile))
    throw new FlowError("direct-review profile must be an object");
  const model = nonempty(profile.model, "direct-review profile.model");
  const effort = nonempty(profile.effort, "direct-review profile.effort");
  return { model, reasoning_effort: effort };
}

function completeOwnerPair(
  value: unknown,
): { model: string; effort: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "model") ||
    !Object.hasOwn(value, "effort")
  )
    throw new FlowError(
      "direct-review owner override requires the complete model and effort pair",
    );
  return {
    model: nonempty(value.model, "direct-review owner override model"),
    effort: nonempty(value.effort, "direct-review owner override effort"),
  };
}

export function laneSpecificReason(lane: string, reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (
    /\b(no|without|none|not|low)\b[^\n]{0,32}\b(reason|risk|escalat)/.test(
      normalized,
    ) ||
    /\b(reason|risk|escalat)\b[^\n]{0,32}\b(no|without|none|not|low)\b/.test(
      normalized,
    ) ||
    /(?:无|没有|无需|不需要|不含)[^\n]{0,20}(升级|风险|理由)/.test(
      normalized,
    ) ||
    /(?:低|较低|不高)[^\n]{0,20}(升级|风险|理由)|(?:升级|风险|理由)[^\n]{0,20}(?:低|较低|不高)/.test(
      normalized,
    )
  )
    return false;
  const aliases = LANE_ALIASES[lane] ?? new Set<string>();
  const laneMatch =
    [...aliases].some((alias) => normalized.includes(alias)) ||
    [...laneTokens(lane)].some((token) =>
      new Set(normalized.match(/[a-z0-9]+/g) ?? []).has(token),
    );
  return (
    laneMatch &&
    ESCALATION_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function laneTokens(lane: string): Set<string> {
  const ignored = new Set([
    "lane",
    "review",
    "formal",
    "direct",
    "ordinary",
    "complex",
    "rigorous",
    "special",
    "high",
    "risk",
    "reason",
    "rationale",
    "reviewer",
  ]);
  return new Set(
    lane
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token && !ignored.has(token)),
  );
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new FlowError(`${field} must be non-empty text`);
  return value;
}

function optionalNonempty(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nonempty(value, field);
}
