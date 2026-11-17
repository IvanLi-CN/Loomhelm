import {
  FlowError,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  isRecord,
  stableHash,
} from "./common";
import {
  DIRECT_REVIEW_PROFILES,
  SUBAGENT_STARTUP_UNAVAILABLE,
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
  return (
    DIRECT_REVIEW_PROFILES.has(
      `${options.declaredModel}:${options.declaredEffort}`,
    ) &&
    !hasUnavailableAttempt(
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
      isRecord(item.requested_profile) &&
      item.requested_profile.model === model &&
      item.requested_profile.effort === effort &&
      item.profile_verification === "request_recorded" &&
      item.effective_profile === null &&
      item.review_execution_source === "parent-flow-request" &&
      item.provenance_boundary === "parent-flow-request-and-subagent-result" &&
      item.evidence_source === "parent-request-and-subagent-result" &&
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

export function assertDirectProfile(profile: string, role: string): void {
  if (!DIRECT_REVIEW_PROFILES.has(profile))
    throw new FlowError(`${role} review profile is not directly executable`);
}
