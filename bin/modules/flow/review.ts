import {
  DYNAMIC_REVIEW_LANES,
  FIXED_REVIEW_LANES,
  FlowError,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  canonicalJson,
  isRecord,
  stableHash,
  sortedUnique,
} from "./common";

export const REVIEW_MODEL_LADDER: [string, string][] = [
  ["gpt-5.6-luna", "medium"],
  ["gpt-5.6-luna", "xhigh"],
  ["gpt-5.6-luna", "max"],
  ["gpt-6.1-sol", "high"],
];
export const DIRECT_REVIEW_LANE_PROFILES: Record<string, [string, string]> = {
  contract: ["gpt-5.6-luna", "medium"],
  "state-concurrency": ["gpt-5.6-luna", "xhigh"],
  "failure-data-safety": ["gpt-5.6-luna", "max"],
  "test-platform": ["gpt-6.1-sol", "high"],
};
export const DIRECT_REVIEW_PROFILES = new Set(
  REVIEW_MODEL_LADDER.map(([model, effort]) => `${model}:${effort}`),
);
export const SUBAGENT_STARTUP_UNAVAILABLE = "startup-unavailable";

export function reviewModelFallbacks(model: string): [string, string][] {
  return model === "gpt-5.6-luna" ? [["gpt-6.1-sol", "high"]] : [];
}

export function directReviewProfileResolution(
  declaredModel: string,
  declaredEffort: string,
  resolvedModel: string,
  resolvedEffort: string,
): Record<string, unknown> {
  const preferred = { model: declaredModel, effort: declaredEffort };
  const resolved = { model: resolvedModel, effort: resolvedEffort };
  if (declaredModel === resolvedModel && declaredEffort === resolvedEffort)
    return { preferred, resolved, fallback_reason: null, attempts: 1 };
  if (
    declaredModel === "gpt-5.6-luna" &&
    resolvedModel === "gpt-6.1-sol" &&
    resolvedEffort === "high"
  )
    return {
      preferred,
      resolved,
      fallback_reason: "luna-startup-unavailable",
      attempts: 2,
    };
  throw new FlowError(
    "direct review profile resolution is not on the allowed fallback ladder",
  );
}

export function parseLaneSpec(raw: string): {
  lane: string;
  model: string;
  effort: string;
} {
  const parts = raw.split(":");
  if (parts.length !== 3 || parts.some((part) => !part.trim()))
    throw new FlowError("review lane must use NAME:MODEL:EFFORT");
  const [lane, model, effort] = parts.map((part) => part.trim()) as [
    string,
    string,
    string,
  ];
  if (
    ![...DIRECT_REVIEW_PROFILES].includes(`${model}:${effort}`) &&
    model !== "gpt-5.6-luna"
  )
    throw new FlowError(`unsupported review model/effort: ${model}+${effort}`);
  return { lane, model, effort };
}

export function validateLaneSpecs(
  stage: string,
  lanes: { lane: string; model: string; effort: string }[],
  tier: number,
  highRequirement = false,
): void {
  if (highRequirement)
    throw new FlowError(
      "high-requirement is retired: direct review proof is required at merge convergence",
    );
  if (new Set(lanes.map((lane) => lane.lane)).size !== lanes.length)
    throw new FlowError("review wave contains duplicate lanes");
  for (const lane of lanes)
    if (!DIRECT_REVIEW_PROFILES.has(`${lane.model}:${lane.effort}`))
      throw new FlowError(
        "direct review wave lanes must use the supported Luna/Sol model ladder",
      );
  for (const lane of lanes) {
    const assigned = DIRECT_REVIEW_LANE_PROFILES[lane.lane];
    if (assigned && (assigned[0] !== lane.model || assigned[1] !== lane.effort))
      throw new FlowError(
        "direct fixed review lanes must use their assigned model profiles",
      );
  }
  if (stage === "risk-arbitration") {
    if (lanes.length !== 1 || lanes[0]?.lane !== "risk-arbitration")
      throw new FlowError(
        "risk arbitration requires one risk-arbitration lane",
      );
    return;
  }
  if (!new Set(["initial", "repair"]).has(stage))
    throw new FlowError(`unsupported review wave stage: ${stage}`);
  const names = new Set(lanes.map((lane) => lane.lane));
  const dynamic = [...names].filter((name) => !FIXED_REVIEW_LANES.has(name));
  const valid =
    [...FIXED_REVIEW_LANES].every((name) => names.has(name)) &&
    dynamic.every((name) => DYNAMIC_REVIEW_LANES.has(name)) &&
    dynamic.length <= 2 &&
    (tier !== 3 || dynamic.length === 0) &&
    (tier !== 4 || dynamic.length >= 1);
  if (!valid)
    throw new FlowError(
      "required review wave lane topology does not match its review tier",
    );
}

export function normalizeReviewSynthesis(
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload))
    throw new FlowError("review synthesis must be an object");
  const required = ["groups", "invariants", "coverage", "conflicts"];
  const allowed = new Set([...required, "conflict_dispositions", "acceptance"]);
  if (
    required.some((key) => !Object.hasOwn(payload, key)) ||
    Object.keys(payload).some((key) => !allowed.has(key))
  )
    throw new FlowError("review synthesis does not match the required schema");
  if (!required.every((key) => Array.isArray(payload[key])))
    throw new FlowError("review synthesis does not match the required schema");
  const groups: Record<string, unknown>[] = [];
  const findingToGroup: Record<string, string> = {};
  const seenGroups = new Set<string>();
  for (const raw of payload.groups as unknown[]) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).sort().join(",") !==
        "blocker,finding_fingerprints,group_id,invariant" ||
      typeof raw.group_id !== "string" ||
      !raw.group_id.trim() ||
      seenGroups.has(raw.group_id) ||
      !Array.isArray(raw.finding_fingerprints) ||
      raw.finding_fingerprints.some(
        (item) => typeof item !== "string" || !item.trim(),
      ) ||
      typeof raw.blocker !== "boolean" ||
      typeof raw.invariant !== "string" ||
      !raw.invariant.trim() ||
      (raw.blocker && raw.finding_fingerprints.length === 0)
    )
      throw new FlowError("review synthesis groups are invalid");
    if (
      new Set(raw.finding_fingerprints as string[]).size !==
      raw.finding_fingerprints.length
    )
      throw new FlowError("review synthesis repeats a finding fingerprint");
    const fingerprints = sortedUnique(raw.finding_fingerprints as string[]);
    for (const fingerprint of fingerprints) {
      if (
        findingToGroup[fingerprint] &&
        findingToGroup[fingerprint] !== raw.group_id
      )
        throw new FlowError(
          "review synthesis maps one finding to multiple root groups",
        );
      findingToGroup[fingerprint] = raw.group_id;
    }
    seenGroups.add(raw.group_id);
    groups.push({
      group_id: raw.group_id,
      finding_fingerprints: fingerprints,
      blocker: raw.blocker,
      invariant: raw.invariant,
    });
  }
  const lists: Record<string, string[]> = {};
  for (const key of ["invariants", "coverage", "conflicts"]) {
    const values = payload[key] as unknown[];
    if (
      values.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(values).size !== values.length
    )
      throw new FlowError("review synthesis lists are invalid");
    lists[key] = sortedUnique(values as string[]);
  }
  const dispositions = payload.conflict_dispositions ?? [];
  if (
    !Array.isArray(dispositions) ||
    dispositions.some(
      (item) =>
        !isRecord(item) ||
        Object.keys(item).length !== 2 ||
        typeof item.conflict !== "string" ||
        typeof item.disposition !== "string" ||
        !item.conflict.trim() ||
        !item.disposition.trim(),
    ) ||
    new Set(
      (dispositions as Record<string, unknown>[]).map((item) => item.conflict),
    ).size !== dispositions.length ||
    (dispositions as Record<string, unknown>[]).some(
      (item) => !(lists.conflicts ?? []).includes(item.conflict as string),
    )
  )
    throw new FlowError("review synthesis conflict dispositions are invalid");
  const normalizedDispositions = (
    dispositions as Record<string, unknown>[]
  ).sort((left, right) =>
    `${left.conflict}:${left.disposition}`.localeCompare(
      `${right.conflict}:${right.disposition}`,
    ),
  );
  const acceptance = payload.acceptance ?? [];
  if (!Array.isArray(acceptance))
    throw new FlowError("review synthesis acceptance coverage is invalid");
  const seenAcceptance = new Set<string>();
  const normalizedAcceptance: Record<string, unknown>[] = [];
  for (const raw of acceptance) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).length !== 4 ||
      typeof raw.id !== "string" ||
      !raw.id ||
      seenAcceptance.has(raw.id) ||
      !["covered", "partial", "missing"].includes(String(raw.status)) ||
      !Array.isArray(raw.receipt_ids) ||
      raw.receipt_ids.some((id) => typeof id !== "string" || !id) ||
      !Array.isArray(raw.assertions) ||
      raw.assertions.some((item) => typeof item !== "string") ||
      new Set(raw.receipt_ids).size !== raw.receipt_ids.length ||
      new Set(raw.assertions).size !== raw.assertions.length
    )
      throw new FlowError("review synthesis acceptance coverage is invalid");
    seenAcceptance.add(raw.id);
    normalizedAcceptance.push({
      id: raw.id,
      status: raw.status,
      receipt_ids: sortedUnique(raw.receipt_ids as string[]),
      assertions: sortedUnique(raw.assertions as string[]),
    });
  }
  const blockers = groups.filter((group) => group.blocker === true);
  const blockerFingerprints = blockers
    .map((group) =>
      stableHash({
        group_id: group.group_id,
        finding_fingerprints: group.finding_fingerprints,
        invariant: group.invariant,
      }),
    )
    .sort();
  return {
    groups,
    invariants: lists.invariants,
    coverage: lists.coverage,
    conflicts: lists.conflicts,
    conflict_dispositions: normalizedDispositions,
    blockers: blockers.map((group) => group.group_id).sort(),
    blocker_fingerprints: blockerFingerprints,
    finding_to_group: findingToGroup,
    acceptance: normalizedAcceptance.sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    ),
    scope_fingerprint: stableHash({
      groups,
      invariants: lists.invariants,
      coverage: lists.coverage,
      conflicts: lists.conflicts,
      conflict_dispositions: normalizedDispositions,
    }),
  };
}

export function reviewSynthesisInput(
  synthesis: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [
      "groups",
      "invariants",
      "coverage",
      "conflicts",
      "conflict_dispositions",
      "acceptance",
    ].map((key) => [key, synthesis[key]]),
  );
}

export function profileResolutionForReview(
  declaredModel: string,
  declaredEffort: string,
  resolvedModel: string,
  resolvedEffort: string,
): Record<string, unknown> {
  return directReviewProfileResolution(
    declaredModel,
    declaredEffort,
    resolvedModel,
    resolvedEffort,
  );
}

export function reviewModelMatchesLane(
  declaredModel: string,
  declaredEffort: string,
  actualModel: string,
  actualEffort: string,
  enforceDirect = false,
): boolean {
  if (
    enforceDirect &&
    !DIRECT_REVIEW_PROFILES.has(`${declaredModel}:${declaredEffort}`)
  )
    return false;
  if (
    enforceDirect &&
    !DIRECT_REVIEW_PROFILES.has(`${actualModel}:${actualEffort}`)
  )
    return false;
  return (
    (declaredModel === actualModel && declaredEffort === actualEffort) ||
    reviewModelFallbacks(declaredModel).some(
      ([model, effort]) => model === actualModel && effort === actualEffort,
    )
  );
}

export function reviewReceiptIdentity(
  runId: string,
  proofKey: string,
  waveId: string,
  lane: string,
): string {
  return stableHash([
    runId,
    "sub-agent-review",
    proofKey,
    waveId,
    lane,
    REVIEW_RECEIPT_SCHEMA_VERSION,
  ]);
}

export function hasClearReviewReceipt(
  receipt: Record<string, unknown>,
): boolean {
  return (
    receipt.kind === "review" &&
    receipt.terminal_state === "completed" &&
    receipt.evidence_valid === true &&
    receipt.review_clear === true &&
    receipt.exit_code === 0 &&
    receipt.post_execution_clean === true
  );
}

export function isSameProfile(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
