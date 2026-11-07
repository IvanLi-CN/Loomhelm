import {
  FlowError,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  canonicalJson,
  isRecord,
  stableHash,
} from "./common";
import {
  directReviewProfileResolution,
  reviewModelMatchesLane,
} from "./review";
import { directWaveLaneProfileAuthorized } from "./review-profile";
import {
  parseReviewResultJson,
  validateReviewFindingLocations,
} from "./review-result";

export function assertReviewReceiptIntegrity(
  ledger: Record<string, unknown>,
  waveId: string,
  laneName: string,
  laneState: Record<string, unknown>,
  receipt: Record<string, unknown>,
  repoPath?: string,
): void {
  const review = isRecord(ledger.review) ? ledger.review : undefined;
  const waves = review && isRecord(review.waves) ? review.waves : undefined;
  const wave = waves && isRecord(waves[waveId]) ? waves[waveId] : undefined;
  if (
    !wave ||
    receipt.kind !== "review" ||
    receipt.review_receipt_schema !== REVIEW_RECEIPT_SCHEMA_VERSION ||
    receipt.wave_id !== waveId ||
    receipt.lane !== laneName ||
    receipt.terminal_state !== "completed" ||
    receipt.evidence_valid !== true ||
    receipt.post_execution_clean !== true ||
    receipt.exit_code !== 0 ||
    receipt.profile_proof_status !== "sub-agent-declared" ||
    receipt.review_execution_source !== "sub-agent" ||
    receipt.provenance_boundary !== "sub-agent-structured-result" ||
    receipt.evidence_source !== "sub-agent-structured-result"
  )
    throw new FlowError("review receipt integrity is invalid");
  const expectedProfile =
    wave.stage === "risk-arbitration"
      ? "risk-arbitration"
      : wave.stage === "initial" || wave.stage === "repair"
        ? "pr-convergence"
        : undefined;
  if (!expectedProfile || receipt.review_profile !== expectedProfile)
    throw new FlowError("review receipt profile integrity is invalid");
  if (
    receipt.head_sha !== wave.head_sha ||
    receipt.base_sha !== wave.base_sha ||
    typeof receipt.proof_key !== "string" ||
    receipt.wave_proof_key !== `${receipt.proof_key}:${waveId}:${laneName}`
  )
    throw new FlowError("review receipt provenance integrity is invalid");
  const declaredModel = String(laneState.model ?? "");
  const declaredEffort = String(laneState.effort ?? "");
  const reviewModel = String(receipt.review_model ?? "");
  const reviewEffort = String(receipt.review_effort ?? "");
  if (
    !reviewModelMatchesLane(
      declaredModel,
      declaredEffort,
      reviewModel,
      reviewEffort,
      true,
    )
  )
    throw new FlowError("review receipt lane profile integrity is invalid");
  if (
    repoPath !== undefined &&
    receipt.proof_key !==
      `${repoPath}:${receipt.head_sha}:${receipt.base_sha}:${expectedProfile}`
  )
    throw new FlowError("review receipt provenance integrity is invalid");
  if (
    repoPath !== undefined &&
    !directWaveLaneProfileAuthorized(ledger, {
      repoPath,
      headSha: String(receipt.head_sha),
      baseSha: String(receipt.base_sha),
      waveId,
      lane: laneName,
      reviewProfile: expectedProfile,
      declaredModel,
      declaredEffort,
      reviewModel,
      reviewEffort,
    })
  )
    throw new FlowError("review receipt profile authorization is invalid");
  if (!isRecord(receipt.review_result))
    throw new FlowError("review receipt result is invalid");
  let parsed;
  try {
    parsed = parseReviewResultJson(JSON.stringify(receipt.review_result));
  } catch (error) {
    throw new FlowError("review receipt result is invalid", { cause: error });
  }
  if (repoPath)
    validateReviewFindingLocations(
      parsed.result,
      repoPath,
      String(receipt.base_sha),
      String(receipt.head_sha),
    );
  if (
    receipt.review_result_sha256 !== parsed.resultSha256 ||
    canonicalJson(receipt.review_findings) !==
      canonicalJson(parsed.result.findings) ||
    canonicalJson(receipt.finding_fingerprints) !==
      canonicalJson(parsed.fingerprints) ||
    receipt.overall_correctness !== parsed.result.overall_correctness ||
    receipt.overall_explanation !== parsed.result.overall_explanation ||
    receipt.review_clear !==
      (parsed.fingerprints.length === 0 &&
        parsed.result.overall_correctness === "patch is correct")
  )
    throw new FlowError("review receipt result integrity is invalid");
  let resolution: Record<string, unknown>;
  try {
    resolution = directReviewProfileResolution(
      declaredModel,
      declaredEffort,
      reviewModel,
      reviewEffort,
    );
  } catch (error) {
    throw new FlowError("review receipt profile resolution is invalid", {
      cause: error,
    });
  }
  if (
    receipt.resolved_model !== reviewModel ||
    receipt.resolved_effort !== reviewEffort ||
    canonicalJson(receipt.profile_resolution) !== canonicalJson(resolution)
  )
    throw new FlowError("review receipt profile integrity is invalid");
  const expectedId = stableHash([
    ledger.run_id,
    "sub-agent-review",
    receipt.wave_proof_key,
    receipt.review_result_sha256,
  ]);
  if (
    receipt.receipt_id !== expectedId ||
    typeof receipt.proof_key !== "string" ||
    typeof receipt.wave_proof_key !== "string"
  )
    throw new FlowError("review receipt identity integrity is invalid");
}
