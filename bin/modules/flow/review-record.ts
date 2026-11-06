import { FlowError, isoNow, isRecord, stableHash } from "./common";
import {
  directReviewProfileResolution,
  reviewModelMatchesLane,
  SUBAGENT_STARTUP_UNAVAILABLE,
} from "./review";
import { directWaveLaneProfileAuthorized } from "./review-profile";
import {
  parseReviewResultJson,
  validateReviewFindingLocations,
} from "./review-result";

export interface SubagentReviewOptions {
  reviewProfile: string;
  baseRef: string;
  reviewModel: string;
  reviewEffort: string;
  reviewResultJson: string;
  terminalState?: "completed" | "unavailable" | undefined;
  unavailabilityClassification?: string | undefined;
  headSha?: string | undefined;
  waveId?: string | undefined;
  lane?: string | undefined;
  repoPath?: string | undefined;
  baseSha?: string | undefined;
}

export function recordSubagentReviewState(
  ledger: Record<string, unknown>,
  options: SubagentReviewOptions,
): Record<string, unknown> {
  const review = reviewState(ledger);
  const waveId = options.waveId ?? String(review.active_wave_id ?? "");
  const assessment = isRecord(ledger.review_assessment)
    ? ledger.review_assessment
    : undefined;
  if (assessment?.tier !== 3 && assessment?.tier !== 4)
    throw new FlowError(
      "sub-agent review proof is only used by Tier 3/4 direct delivery",
    );
  if (review.active_wave_id !== waveId)
    throw new FlowError(
      "sub-agent review evidence is not bound to the active review wave",
    );
  const waves = isRecord(review.waves) ? review.waves : {};
  const wave = waveId && isRecord(waves[waveId]) ? waves[waveId] : undefined;
  if (!wave) throw new FlowError(`review wave does not exist: ${waveId}`);
  const lane = options.lane ?? "";
  if (!isRecord(wave.lanes) || !isRecord(wave.lanes[lane]))
    throw new FlowError(`review lane does not exist: ${lane}`);
  const laneState = wave.lanes[lane];
  const headSha = options.headSha ?? String(wave.head_sha);
  const baseSha = options.baseSha ?? String(wave.base_sha);
  if (headSha !== wave.head_sha || baseSha !== wave.base_sha)
    throw new FlowError("review receipt inputs do not match the active wave");
  const expectedProfile =
    wave.stage === "risk-arbitration" ? "risk-arbitration" : "pr-convergence";
  if (options.reviewProfile !== expectedProfile)
    throw new FlowError(
      "sub-agent review profile does not match its review wave stage",
    );
  const repoPath = options.repoPath ?? "";
  if (
    !reviewModelMatchesLane(
      String(laneState.model),
      String(laneState.effort),
      options.reviewModel,
      options.reviewEffort,
      true,
    )
  )
    throw new FlowError(
      "sub-agent review profile does not match its review lane",
    );
  const profileOptions = {
    repoPath,
    headSha,
    baseSha,
    waveId,
    lane,
    reviewProfile: options.reviewProfile,
    declaredModel: String(laneState.model),
    declaredEffort: String(laneState.effort),
    reviewModel: options.reviewModel,
    reviewEffort: options.reviewEffort,
  };
  const terminal = options.terminalState ?? "completed";
  const receipts = Array.isArray(ledger.receipts)
    ? (ledger.receipts as Record<string, unknown>[])
    : [];
  const proofKey = `${repoPath}:${headSha}:${baseSha}:${options.reviewProfile}`;
  const waveProofKey = `${proofKey}:${waveId}:${lane}`;
  if (terminal === "unavailable")
    return recordUnavailable(
      ledger,
      receipts,
      options,
      waveId,
      lane,
      proofKey,
      waveProofKey,
      profileOptions,
    );
  if (terminal !== "completed")
    throw new FlowError(
      "only completed or unavailable review terminal states are accepted",
    );
  if (options.unavailabilityClassification !== undefined)
    throw new FlowError(
      "completed sub-agent review cannot declare unavailability",
    );
  if (!options.reviewResultJson.trim())
    throw new FlowError("sub-agent review evidence is missing review result");
  if (!directWaveLaneProfileAuthorized(ledger, profileOptions) && repoPath)
    throw new FlowError("sub-agent review lane fallback is not authorized");
  const parsed = parseReviewResultJson(options.reviewResultJson);
  if (repoPath)
    validateReviewFindingLocations(parsed.result, repoPath, baseSha, headSha);
  const receiptId = stableHash([
    ledger.run_id,
    "sub-agent-review",
    waveProofKey,
    parsed.resultSha256,
  ]);
  const existingLaneId = laneState.receipt_id;
  if (existingLaneId) {
    const existing = receipts.find(
      (receipt) => receipt.receipt_id === existingLaneId,
    );
    if (!existing || existing.receipt_id !== receiptId)
      throw new FlowError(
        "review lane already has a different recorded receipt",
      );
    return { reused: true, receipt: existing };
  }
  const existing = receipts.find((receipt) => receipt.receipt_id === receiptId);
  if (existing) return { reused: true, receipt: existing };
  const resolution = directReviewProfileResolution(
    String(laneState.model),
    String(laneState.effort),
    options.reviewModel,
    options.reviewEffort,
  );
  const receipt: Record<string, unknown> = {
    receipt_id: receiptId,
    kind: "review",
    review_receipt_schema: 6,
    proof_key: proofKey,
    wave_proof_key: waveProofKey,
    head_sha: headSha,
    base_sha: baseSha,
    review_profile: options.reviewProfile,
    review_model: options.reviewModel,
    review_effort: options.reviewEffort,
    resolved_model: options.reviewModel,
    resolved_effort: options.reviewEffort,
    profile_resolution: resolution,
    profile_proof_status: "sub-agent-declared",
    review_execution_source: "sub-agent",
    provenance_boundary: "sub-agent-structured-result",
    evidence_source: "sub-agent-structured-result",
    terminal_state: "completed",
    wave_id: waveId,
    lane,
    finding_fingerprints: parsed.fingerprints,
    review_result: parsed.result,
    review_result_sha256: parsed.resultSha256,
    review_findings: parsed.result.findings,
    review_clear:
      parsed.fingerprints.length === 0 &&
      parsed.result.overall_correctness === "patch is correct",
    overall_correctness: parsed.result.overall_correctness,
    overall_explanation: parsed.result.overall_explanation,
    evidence_valid: true,
    post_execution_clean: true,
    exit_code: 0,
    unavailability_classification: null,
    recorded_at: isoNow(),
  };
  receipts.push(receipt);
  ledger.receipts = receipts;
  laneState.receipt_id = receiptId;
  laneState.state = "completed";
  return { reused: false, receipt };
}

function recordUnavailable(
  ledger: Record<string, unknown>,
  receipts: Record<string, unknown>[],
  options: SubagentReviewOptions,
  waveId: string,
  lane: string,
  proofKey: string,
  waveProofKey: string,
  profileOptions: Parameters<typeof directWaveLaneProfileAuthorized>[1],
): Record<string, unknown> {
  if (options.reviewResultJson.trim())
    throw new FlowError(
      "unavailable sub-agent review must not include a review result",
    );
  if (options.unavailabilityClassification !== SUBAGENT_STARTUP_UNAVAILABLE)
    throw new FlowError(
      "unavailable sub-agent review requires explicit startup-unavailable classification",
    );
  const identity = stableHash([
    "sub-agent-review-unavailable",
    waveProofKey,
    options.reviewModel,
    options.reviewEffort,
  ]);
  const receiptId = stableHash([
    ledger.run_id,
    "sub-agent-review-unavailable",
    identity,
  ]);
  const existing = receipts.find((receipt) => receipt.receipt_id === receiptId);
  if (existing) return { reused: true, receipt: existing };
  if (!directWaveLaneProfileAuthorized(ledger, profileOptions))
    throw new FlowError("sub-agent review lane fallback is not authorized");
  const receipt: Record<string, unknown> = {
    receipt_id: receiptId,
    kind: "review_attempt",
    review_receipt_schema: 6,
    proof_key: proofKey,
    wave_proof_key: waveProofKey,
    head_sha: profileOptions.headSha,
    base_sha: profileOptions.baseSha,
    review_profile: options.reviewProfile,
    review_model: options.reviewModel,
    review_effort: options.reviewEffort,
    resolved_model: "unavailable",
    resolved_effort: "unavailable",
    profile_resolution: {
      preferred: {
        model: options.reviewModel,
        effort: options.reviewEffort,
      },
      resolved: { model: "unavailable", effort: "unavailable" },
      fallback_reason: "sub-agent-unavailable",
      attempts: 1,
    },
    profile_proof_status: "sub-agent-declared",
    review_execution_source: "sub-agent",
    provenance_boundary: "sub-agent-structured-result",
    evidence_source: "sub-agent-structured-result",
    terminal_state: "unavailable",
    unavailability_classification: SUBAGENT_STARTUP_UNAVAILABLE,
    wave_id: waveId,
    lane,
    finding_fingerprints: [],
    review_findings: [],
    review_clear: false,
    overall_correctness: "unavailable",
    evidence_valid: false,
    post_execution_clean: true,
    exit_code: 75,
    recorded_at: isoNow(),
  };
  receipts.push(receipt);
  ledger.receipts = receipts;
  return { reused: false, receipt };
}

function reviewState(ledger: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(ledger.review))
    throw new FlowError("ledger review state is invalid");
  return ledger.review;
}

export { assertReviewReceiptIntegrity } from "./review-receipt-integrity";
