import {
  FLOW_SCHEMA_VERSION,
  FlowError,
  REVIEW_NECESSITY_TIERS,
  TERMINAL_STATES,
  canonicalJson,
  deepClone,
  isRecord,
  normalizeSha,
  isoNow,
} from "./common";
import { normalizeAcceptanceManifest } from "./acceptance";
import { repositoryBindingIdentity } from "./state-policy";

export {
  repositoryBindingIdentity,
  requireRepositoryBindingMatch,
  validatePostMergeReleasePolicy,
} from "./state-policy";
export {
  isCurrentClearWave,
  reviewConvergenceStarted,
  reviewTier,
} from "./state-review";

export const PR_REF_PATTERN =
  /^(?:PR#\d+|[^\s/]+\/[^\s#]+#\d+|https?:\/\/[^\s]+\/pulls?\/\d+)$/;
export const POST_MERGE_FINALITY_STATUSES = {
  target_ci: new Set(["passed"]),
  release: new Set(["published", "not-applicable"]),
};

export function defaultReviewState(): Record<string, unknown> {
  return {
    next_epoch: 1,
    pr_ref: null,
    pr_base_sha: null,
    pr_head_sha: null,
    pr_bound_at: null,
    base_ref: null,
    base_ref_identity: null,
    pr_base_ref_identity: null,
    authorization_message_ids: [],
    terra_authorization_message_ids: [],
    active_epoch_id: null,
    active_wave_id: null,
    epochs: [],
    waves: {},
    cumulative: {
      finding_to_group: {},
      blocker_fingerprints: [],
      invariants: [],
      coverage_lanes: [],
      conflicts: [],
      conflict_dispositions: [],
    },
  };
}

export function pendingReviewAssessment(): Record<string, unknown> {
  return {
    tier: null,
    reason: null,
    assessed_at: null,
    assessed_head_sha: null,
    source: "pending",
  };
}

export function migratedReviewAssessment(): Record<string, unknown> {
  return {
    tier: 3,
    reason: "Migrated from the pre-tier mandatory direct review contract.",
    assessed_at: null,
    assessed_head_sha: null,
    source: "pre-tier-migration",
  };
}

export function reviewModeForTier(tier: number | null): string {
  if (tier === null) return "assessment-required";
  if (tier === 1) return "not-required";
  if (tier === 2) return "advisory";
  return `mandatory-tier-${tier}`;
}

export function normalizePostMergeEvidence(
  payload: unknown,
): Record<string, unknown> {
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 6 ||
    typeof payload.pr_ref !== "string" ||
    !PR_REF_PATTERN.test(payload.pr_ref.trim()) ||
    !isRecord(payload.finality)
  )
    throw new FlowError(
      "post-merge evidence does not match the required schema",
    );
  const mergedAt =
    typeof payload.merged_at === "string" ? payload.merged_at.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      mergedAt,
    ) ||
    Number.isNaN(Date.parse(mergedAt))
  )
    throw new FlowError("post-merge merged_at is invalid");
  if (Object.keys(payload.finality).length !== 2)
    throw new FlowError("post-merge finality is invalid");
  const finality: Record<string, Record<string, unknown>> = {};
  for (const surface of ["target_ci", "release"] as const) {
    const fact = payload.finality[surface];
    if (!isRecord(fact))
      throw new FlowError(`post-merge finality.${surface} is invalid`);
    const status =
      fact.status === "not_applicable" ? "not-applicable" : fact.status;
    if (
      typeof status !== "string" ||
      !POST_MERGE_FINALITY_STATUSES[surface].has(status)
    )
      throw new FlowError(`post-merge finality.${surface} is not terminal`);
    finality[surface] = {
      ...fact,
      status,
      bound_sha: normalizeSha(fact.bound_sha, `finality.${surface}.bound_sha`),
    };
    if (fact.run_id !== undefined && typeof fact.run_id !== "string")
      throw new FlowError(`post-merge finality.${surface}.run_id is invalid`);
    if (surface === "release" && status === "not-applicable") {
      const policy = fact.policy_evidence;
      if (fact.release_expected !== false || !isRecord(policy))
        throw new FlowError(
          "post-merge release not-applicable requires policy evidence",
        );
      if (!repositoryBindingIdentity(policy.repository))
        throw new FlowError("post-merge release policy repository is invalid");
      for (const field of ["target_branch", "policy_locator", "reason"]) {
        if (typeof policy[field] !== "string" || !policy[field].trim())
          throw new FlowError(`post-merge release policy ${field} is invalid`);
      }
      if (
        normalizeSha(policy.merge_sha, "release policy merge_sha") !==
        finality[surface].bound_sha
      )
        throw new FlowError(
          "post-merge release policy must bind the merge SHA",
        );
    } else if (
      surface === "release" &&
      "release_expected" in fact &&
      fact.release_expected !== true
    ) {
      throw new FlowError(
        "post-merge release finality conflicts with release_expected",
      );
    }
  }
  const mergeSha = normalizeSha(payload.merge_sha, "post-merge merge_sha");
  if (Object.values(finality).some((fact) => fact.bound_sha !== mergeSha))
    throw new FlowError("post-merge finality facts must bind the merge SHA");
  return {
    pr_ref: payload.pr_ref.trim(),
    head_sha: normalizeSha(payload.head_sha, "post-merge head_sha"),
    base_sha: normalizeSha(payload.base_sha, "post-merge base_sha"),
    merge_sha: mergeSha,
    merged_at: mergedAt,
    finality,
  };
}

export function normalizeLedger(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new FlowError("ledger payload is invalid");
  if (input.flow_type === "initiative") return input;
  const payload = input;
  const rawVersion = payload.schema_version ?? 1;
  if (
    typeof rawVersion !== "number" ||
    !Number.isInteger(rawVersion) ||
    ![5, 6, FLOW_SCHEMA_VERSION].includes(rawVersion)
  )
    throw new FlowError(
      "flow receipt supports only schema v5/v6 migration or schema v7",
    );
  const version = rawVersion;
  if (version === 5) {
    if (
      payload.state !== "active" &&
      !(typeof payload.state === "string" && TERMINAL_STATES.has(payload.state))
    )
      throw new FlowError("schema v5 receipt state is invalid");
    if (payload.state !== "active") return payload;
    if (payload.review !== undefined && payload.legacy_review === undefined)
      payload.legacy_review = deepClone(payload.review);
    if (
      payload.review_assessment !== undefined &&
      payload.legacy_review_assessment === undefined
    )
      payload.legacy_review_assessment = deepClone(payload.review_assessment);
    const legacyReview = isRecord(payload.legacy_review)
      ? payload.legacy_review
      : undefined;
    payload.legacy_compatibility = true;
    payload.legacy_schema_version = version;
    payload.schema_version = FLOW_SCHEMA_VERSION;
    payload.review = defaultReviewState();
    for (const key of [
      "pr_ref",
      "pr_base_sha",
      "pr_head_sha",
      "pr_bound_at",
      "pr_base_ref_identity",
      "base_ref",
      "base_ref_identity",
    ])
      if (legacyReview && Object.hasOwn(legacyReview, key))
        (payload.review as Record<string, unknown>)[key] = legacyReview[key];
    payload.review_assessment = migratedReviewAssessment();
  } else if (version === 6) {
    payload.review_assessment ??= pendingReviewAssessment();
    payload.legacy_compatibility = true;
    payload.legacy_schema_version = version;
    payload.schema_version = FLOW_SCHEMA_VERSION;
    payload.repository_binding ??= null;
    payload.provider_facts ??= null;
  } else {
    payload.review_assessment ??= pendingReviewAssessment();
    payload.repository_binding ??= null;
    payload.provider_facts ??= null;
  }
  const assessment = payload.review_assessment;
  if (!isRecord(assessment))
    throw new FlowError("ledger review assessment is invalid");
  const tier = assessment.tier;
  if (
    tier !== null &&
    (typeof tier !== "number" || !REVIEW_NECESSITY_TIERS.has(tier))
  )
    throw new FlowError("ledger review assessment tier is invalid");
  if (tier === null) {
    if (
      assessment.reason !== null ||
      assessment.assessed_at !== null ||
      assessment.assessed_head_sha !== null ||
      assessment.source !== "pending"
    )
      throw new FlowError("pending review assessment is invalid");
  } else if (typeof assessment.reason !== "string" || !assessment.reason.trim())
    throw new FlowError("recorded review assessment reason is invalid");
  else if (assessment.source === "pre-tier-migration") {
    if (canonicalJson(assessment) !== canonicalJson(migratedReviewAssessment()))
      throw new FlowError("migrated review assessment is invalid");
  } else {
    if (
      assessment.source !== "agent-assessment" ||
      typeof assessment.assessed_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        assessment.assessed_at,
      ) ||
      Number.isNaN(Date.parse(assessment.assessed_at)) ||
      typeof assessment.assessed_head_sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(assessment.assessed_head_sha)
    )
      throw new FlowError("recorded review assessment is invalid");
  }
  payload.review_mode = reviewModeForTier(tier as number | null);
  payload.acceptance_required = true;
  payload.acceptance_manifest ??= null;
  payload.phase_acceptance_evidence ??= [];
  if (!Array.isArray(payload.phase_acceptance_evidence))
    throw new FlowError("phase acceptance evidence is invalid");
  if (payload.acceptance_manifest)
    payload.acceptance_manifest = normalizeAcceptanceManifest(
      payload.acceptance_manifest,
    );
  if (payload.review !== undefined && !isRecord(payload.review))
    throw new FlowError("ledger review state is invalid");
  const review = isRecord(payload.review) ? payload.review : {};
  const defaults = defaultReviewState();
  for (const [key, value] of Object.entries(defaults))
    review[key] ??= deepClone(value);
  payload.review = review;
  payload.receipts ??= [];
  payload.events ??= [];
  if (!Array.isArray(payload.receipts) || !Array.isArray(payload.events))
    throw new FlowError("ledger receipts or events are invalid");
  payload.convergence ??= {
    state: "pending",
    round: 0,
    repair_round: 0,
    diagnostic_used: false,
    blockers: [],
  };
  if (!isRecord(payload.convergence))
    throw new FlowError("ledger convergence state is invalid");
  return payload;
}

export function projectStatusPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectStatusPayload);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !(key.startsWith("validation") && key.endsWith("_scope")) &&
          !(key.startsWith("full_") && key.includes("validation")),
      )
      .map(([key, item]) => [key, projectStatusPayload(item)]),
  );
}

export function initialLedger(
  runId: string,
  flowType: string,
  baseSha: string,
  headSha: string,
  manifest: unknown,
  prRef?: string,
): Record<string, unknown> {
  const review = defaultReviewState();
  review.pr_ref = prRef?.trim() || null;
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: runId,
    flow_type: flowType,
    base_sha: baseSha,
    head_sha: headSha,
    state: "active",
    created_at: isoNow(),
    updated_at: isoNow(),
    command_budget_seconds: 1800,
    retry_budget_per_identity: 1,
    convergence: {
      state: "pending",
      round: 0,
      repair_round: 0,
      diagnostic_used: false,
      blockers: [],
    },
    review,
    acceptance_manifest: manifest,
    acceptance_required: true,
    receipts: [],
    events: [],
    review_assessment: pendingReviewAssessment(),
    review_mode: "assessment-required",
    repository_binding: null,
    provider_facts: null,
  };
}
