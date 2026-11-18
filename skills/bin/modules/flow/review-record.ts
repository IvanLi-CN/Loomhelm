import {
  FlowError,
  REVIEW_SCOPE_CLASSES,
  canonicalJson,
  isoNow,
  isRecord,
  stableHash,
} from "./common";
import { SUBAGENT_STARTUP_UNAVAILABLE } from "./review";
import {
  parseReviewResultJson,
  validateReviewFindingLocations,
} from "./review-result";
import { isFormalReviewRequestProfile } from "./review-profile-policy";
import { reviewWaveScopeBindingMatches } from "./review-wave-support";

export interface SubagentReviewOptions {
  reviewProfile: string;
  baseRef: string;
  reviewAttemptId?: string | undefined;
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
  if (!reviewWaveScopeBindingMatches(wave))
    throw new FlowError("review wave scope binding is invalid");
  const lane = options.lane ?? "";
  if (!isRecord(wave.lanes) || !isRecord(wave.lanes[lane]))
    throw new FlowError(`review lane does not exist: ${lane}`);
  const laneState = wave.lanes[lane];
  const requestedProfile = laneRequestedProfile(laneState);
  if (!isFormalReviewRequestProfile(requestedProfile))
    throw new FlowError(
      "review lane requested profile does not match the formal request",
    );
  const scopeClass = wave.scope_class;
  if (typeof scopeClass !== "string" || !REVIEW_SCOPE_CLASSES.has(scopeClass))
    throw new FlowError("review wave scope is invalid");
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
  const terminal = options.terminalState ?? "completed";
  const receipts = Array.isArray(ledger.receipts)
    ? (ledger.receipts as Record<string, unknown>[])
    : [];
  const proofKey = `${repoPath}:${headSha}:${baseSha}:${options.reviewProfile}`;
  const waveProofKey = `${proofKey}:${waveId}:${lane}`;
  const attemptKey = reviewAttemptKey(options);
  if (terminal === "unavailable")
    return recordUnavailable(
      ledger,
      receipts,
      options,
      waveId,
      lane,
      proofKey,
      waveProofKey,
      headSha,
      baseSha,
      requestedProfile,
      scopeClass,
      attemptKey,
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
  const parsed = parseReviewResultJson(options.reviewResultJson);
  if (repoPath)
    validateReviewFindingLocations(parsed.result, repoPath, baseSha, headSha);
  const receiptId = stableHash([
    ledger.run_id,
    "sub-agent-review",
    waveProofKey,
    scopeClass,
    parsed.resultSha256,
    attemptKey,
  ]);
  const existingAttempt = findAttemptReceipt(
    receipts,
    attemptKey,
    waveProofKey,
    scopeClass,
  );
  if (existingAttempt) {
    if (existingAttempt.terminal_state !== "completed")
      throw new FlowError(
        "review attempt id is already recorded with a different terminal state",
      );
    if (existingAttempt.receipt_id !== receiptId)
      throw new FlowError(
        "review attempt id is already bound to a different result",
      );
    return { reused: true, receipt: existingAttempt };
  }
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
  const receipt: Record<string, unknown> = {
    receipt_id: receiptId,
    kind: "review",
    review_receipt_schema: 7,
    proof_key: proofKey,
    wave_proof_key: waveProofKey,
    head_sha: headSha,
    base_sha: baseSha,
    review_profile: options.reviewProfile,
    attempt_key: attemptKey,
    scope_class: scopeClass,
    requested_profile: requestedProfile,
    profile_verification: "request_recorded",
    effective_profile: null,
    review_execution_source: "parent-flow-request",
    provenance_boundary: "parent-flow-request-and-subagent-result",
    evidence_source: "parent-request-and-subagent-result",
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
  headSha: string,
  baseSha: string,
  requestedProfile: { model: string; effort: string },
  scopeClass: string,
  attemptKey: string,
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
    requestedProfile.model,
    requestedProfile.effort,
    attemptKey,
  ]);
  const receiptId = stableHash([
    ledger.run_id,
    "sub-agent-review-unavailable",
    identity,
  ]);
  const existingAttempt = findAttemptReceipt(
    receipts,
    attemptKey,
    waveProofKey,
    scopeClass,
  );
  if (existingAttempt) {
    if (existingAttempt.terminal_state !== "unavailable")
      throw new FlowError(
        "review attempt id is already recorded with a different terminal state",
      );
    if (
      existingAttempt.kind !== "review_attempt" ||
      existingAttempt.receipt_id !== receiptId ||
      existingAttempt.proof_key !== proofKey ||
      existingAttempt.wave_proof_key !== waveProofKey ||
      existingAttempt.head_sha !== headSha ||
      existingAttempt.base_sha !== baseSha ||
      existingAttempt.review_profile !== options.reviewProfile ||
      existingAttempt.wave_id !== waveId ||
      existingAttempt.lane !== lane ||
      !isRecord(existingAttempt.requested_profile) ||
      canonicalJson(existingAttempt.requested_profile) !==
        canonicalJson(requestedProfile) ||
      existingAttempt.profile_verification !== "request_recorded" ||
      existingAttempt.effective_profile !== null ||
      existingAttempt.review_execution_source !== "parent-flow-request" ||
      existingAttempt.provenance_boundary !==
        "parent-flow-request-and-startup-observation" ||
      existingAttempt.evidence_source !==
        "parent-request-and-startup-observation" ||
      existingAttempt.terminal_state !== "unavailable" ||
      existingAttempt.unavailability_classification !==
        SUBAGENT_STARTUP_UNAVAILABLE ||
      existingAttempt.evidence_valid !== false ||
      existingAttempt.post_execution_clean !== true ||
      existingAttempt.exit_code !== 75
    )
      throw new FlowError("review attempt receipt integrity is invalid");
    return { reused: true, receipt: existingAttempt };
  }
  const receipt: Record<string, unknown> = {
    receipt_id: receiptId,
    kind: "review_attempt",
    review_receipt_schema: 7,
    proof_key: proofKey,
    wave_proof_key: waveProofKey,
    head_sha: headSha,
    base_sha: baseSha,
    review_profile: options.reviewProfile,
    attempt_key: attemptKey,
    scope_class: scopeClass,
    requested_profile: requestedProfile,
    profile_verification: "request_recorded",
    effective_profile: null,
    review_execution_source: "parent-flow-request",
    provenance_boundary: "parent-flow-request-and-startup-observation",
    evidence_source: "parent-request-and-startup-observation",
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

function findAttemptReceipt(
  receipts: Record<string, unknown>[],
  attemptKey: string,
  waveProofKey: string,
  scopeClass: string,
): Record<string, unknown> | undefined {
  return receipts.find(
    (receipt) =>
      receipt.review_receipt_schema === 7 &&
      receipt.attempt_key === attemptKey &&
      receipt.wave_proof_key === waveProofKey &&
      receipt.scope_class === scopeClass,
  );
}

function reviewState(ledger: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(ledger.review))
    throw new FlowError("ledger review state is invalid");
  return ledger.review;
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
      canonicalJson(requested) !== canonicalJson(legacy)
    )
      throw new FlowError("review lane requested profile is inconsistent");
    return { model: requested.model, effort: requested.effort };
  }
  throw new FlowError(
    "review lane requested profile is missing; open a fresh review wave",
  );
}

function reviewAttemptKey(options: SubagentReviewOptions): string {
  if (typeof options.reviewAttemptId !== "string" || !options.reviewAttemptId.trim())
    throw new FlowError(
      "sub-agent review requires a parent-supplied review attempt id",
    );
  return options.reviewAttemptId.trim();
}

export { assertReviewReceiptIntegrity } from "./review-receipt-integrity";
