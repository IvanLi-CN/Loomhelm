import {
  FlowError,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  canonicalJson,
  isRecord,
  stableHash,
} from "./common";
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
    typeof receipt.attempt_key !== "string" ||
    !receipt.attempt_key.trim() ||
    receipt.profile_verification !== "request_recorded" ||
    receipt.effective_profile !== null ||
    receipt.review_execution_source !== "parent-flow-request" ||
    receipt.provenance_boundary !==
      "parent-flow-request-and-subagent-result" ||
    receipt.evidence_source !== "parent-request-and-subagent-result"
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
  const requestedProfile = laneRequestedProfile(laneState);
  if (
    !isRecord(receipt.requested_profile) ||
    canonicalJson(receipt.requested_profile) !== canonicalJson(requestedProfile)
  )
    throw new FlowError("review receipt requested profile integrity is invalid");
  if (!validReportedProfile(receipt.reported_profile))
    throw new FlowError("review receipt reported profile is invalid");
  if (
    repoPath !== undefined &&
    receipt.proof_key !==
      `${repoPath}:${receipt.head_sha}:${receipt.base_sha}:${expectedProfile}`
  )
    throw new FlowError("review receipt provenance integrity is invalid");
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

function laneRequestedProfile(
  laneState: Record<string, unknown>,
): { model: string; effort: string } {
  const requested = laneState.requested_profile;
  if (
    isRecord(requested) &&
    typeof requested.model === "string" &&
    requested.model.trim() &&
    typeof requested.effort === "string" &&
    requested.effort.trim()
  ) {
    const legacy = { model: laneState.model, effort: laneState.effort };
    if (
      typeof legacy.model !== "string" ||
      typeof legacy.effort !== "string" ||
      canonicalJson({ model: requested.model, effort: requested.effort }) !==
        canonicalJson(legacy)
    )
      throw new FlowError("review lane requested profile is inconsistent");
    return { model: requested.model, effort: requested.effort };
  }
  throw new FlowError(
    "review lane requested profile is missing; open a fresh review wave",
  );
}

function validReportedProfile(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "effort,model")
    return false;
  return (
    (value.model === null || typeof value.model === "string") &&
    (value.effort === null || typeof value.effort === "string")
  );
}
