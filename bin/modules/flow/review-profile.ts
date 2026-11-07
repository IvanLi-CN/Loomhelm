import {
  FlowError,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  isRecord,
  stableHash,
} from "./common";
import {
  DIRECT_REVIEW_PROFILES,
  SUBAGENT_STARTUP_UNAVAILABLE,
  reviewModelFallbacks,
  reviewModelMatchesLane,
} from "./review";

export interface DirectWaveLaneProfileOptions {
  repoPath: string;
  headSha: string;
  baseSha: string;
  waveId: string;
  lane: string;
  reviewProfile: string;
  declaredModel: string;
  declaredEffort: string;
  reviewModel: string;
  reviewEffort: string;
}

export function directWaveLaneProfileAuthorized(
  ledger: Record<string, unknown>,
  options: DirectWaveLaneProfileOptions,
): boolean {
  if (
    !reviewModelMatchesLane(
      options.declaredModel,
      options.declaredEffort,
      options.reviewModel,
      options.reviewEffort,
      true,
    )
  )
    return false;
  if (
    options.declaredModel === options.reviewModel &&
    options.declaredEffort === options.reviewEffort
  )
    return !hasUnavailableAttempt(
      ledger,
      options,
      options.declaredModel,
      options.declaredEffort,
    );
  const fallback = reviewModelFallbacks(options.declaredModel).some(
    ([model, effort]) =>
      model === options.reviewModel && effort === options.reviewEffort,
  );
  return (
    fallback &&
    hasUnavailableAttempt(
      ledger,
      options,
      options.declaredModel,
      options.declaredEffort,
    )
  );
}

function hasUnavailableAttempt(
  ledger: Record<string, unknown>,
  options: DirectWaveLaneProfileOptions,
  model: string,
  effort: string,
): boolean {
  const proofKey = `${options.repoPath}:${options.headSha}:${options.baseSha}:${options.reviewProfile}`;
  const waveProofKey = `${proofKey}:${options.waveId}:${options.lane}`;
  const identity = stableHash([
    "sub-agent-review-unavailable",
    waveProofKey,
    model,
    effort,
  ]);
  const expectedId = stableHash([
    ledger.run_id,
    "sub-agent-review-unavailable",
    identity,
  ]);
  const receipts = Array.isArray(ledger.receipts) ? ledger.receipts : [];
  return receipts.some((item) => {
    if (!isRecord(item)) return false;
    return (
      item.receipt_id === expectedId &&
      item.kind === "review_attempt" &&
      item.review_receipt_schema === REVIEW_RECEIPT_SCHEMA_VERSION &&
      item.review_profile === options.reviewProfile &&
      item.proof_key === proofKey &&
      item.wave_proof_key === waveProofKey &&
      item.head_sha === options.headSha &&
      item.base_sha === options.baseSha &&
      item.review_model === model &&
      item.review_effort === effort &&
      item.resolved_model === "unavailable" &&
      item.resolved_effort === "unavailable" &&
      canonicalProfileResolution(item.profile_resolution, model, effort) &&
      item.profile_proof_status === "sub-agent-declared" &&
      item.review_execution_source === "sub-agent" &&
      item.provenance_boundary === "sub-agent-structured-result" &&
      item.evidence_source === "sub-agent-structured-result" &&
      item.terminal_state === "unavailable" &&
      item.unavailability_classification === SUBAGENT_STARTUP_UNAVAILABLE &&
      item.wave_id === options.waveId &&
      item.lane === options.lane &&
      Array.isArray(item.finding_fingerprints) &&
      item.finding_fingerprints.length === 0 &&
      Array.isArray(item.review_findings) &&
      item.review_findings.length === 0 &&
      item.review_clear === false &&
      item.overall_correctness === "unavailable" &&
      item.evidence_valid === false &&
      item.post_execution_clean === true &&
      item.exit_code === 75 &&
      typeof item.recorded_at === "string" &&
      item.recorded_at.trim().length > 0
    );
  });
}

function canonicalProfileResolution(
  value: unknown,
  model: string,
  effort: string,
): boolean {
  if (!isRecord(value)) return false;
  const preferred = value.preferred;
  const resolved = value.resolved;
  return (
    isRecord(preferred) &&
    preferred.model === model &&
    preferred.effort === effort &&
    isRecord(resolved) &&
    resolved.model === "unavailable" &&
    resolved.effort === "unavailable" &&
    value.fallback_reason === "sub-agent-unavailable" &&
    value.attempts === 1
  );
}

export function assertDirectProfile(profile: string, role: string): void {
  if (!DIRECT_REVIEW_PROFILES.has(profile))
    throw new FlowError(`${role} review profile is not directly executable`);
}
