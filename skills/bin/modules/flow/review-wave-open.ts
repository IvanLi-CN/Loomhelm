import {
  DYNAMIC_REVIEW_LANES,
  FIXED_REVIEW_LANES,
  FlowError,
  REVIEW_SCOPE_CLASSES,
  canonicalJson,
  isoNow,
  isRecord,
  stableHash,
} from "./common";
import { normalizeAcceptanceManifest } from "./acceptance";
import { validateLaneSpecs } from "./review";
import { parseReviewResultJson } from "./review-result";
import { sortedStrings } from "./review-wave-utils";
import { prepareReviewWaveState } from "./review-open-guards";
import { assertReviewReceiptIntegrity } from "./review-receipt-integrity";
import { reviewState } from "./review-wave-support";

export function openReviewWaveState(
  ledger: Record<string, unknown>,
  options: {
    stage: string;
    baseRef?: string | undefined;
    baseSha: string;
    headSha: string;
    laneSpecs: { lane: string; model: string; effort: string }[];
    previousHeadSha?: string | undefined;
    repairPermitId?: string | undefined;
    scopeClass?: string | undefined;
    highRequirement?: boolean | undefined;
    arbitrationConflicts?: string[] | undefined;
    arbitrationBlockerFingerprints?: string[] | undefined;
  },
): Record<string, unknown> {
  const assessment = isRecord(ledger.review_assessment)
    ? ledger.review_assessment
    : undefined;
  const tier = typeof assessment?.tier === "number" ? assessment.tier : null;
  if (tier !== 3 && tier !== 4)
    throw new FlowError(
      "the recorded review necessity tier does not require a review wave",
    );
  validateLaneSpecs(
    options.stage,
    options.laneSpecs,
    tier,
    options.highRequirement ?? false,
  );
  const arbitrationConflicts = sortedStrings(
    options.arbitrationConflicts,
    "arbitration conflicts",
  );
  const arbitrationBlockerFingerprints = sortedStrings(
    options.arbitrationBlockerFingerprints,
    "arbitration blocker fingerprints",
  );
  const review = reviewState(ledger);
  if (review.active_wave_id) {
    const waves = isRecord(review.waves) ? review.waves : {};
    const active = isRecord(waves[review.active_wave_id])
      ? waves[review.active_wave_id]
      : undefined;
    const legacy = active ? isLegacyReviewWave(ledger, active) : false;
    const sameCandidate =
      active?.head_sha === options.headSha && active?.base_sha === options.baseSha;
    if (
      !active ||
      !reviewWaveIsTerminal(ledger, active) ||
      (!legacy && !reviewWaveIsClear(ledger, active)) ||
      (sameCandidate && !legacy)
    )
      throw new FlowError("another review wave is already active");
    active.state = "retired";
    active.retirement_reason = legacy
      ? "legacy-review-receipt-schema"
      : "candidate-inputs-changed";
    active.retired_at = isoNow();
    review.active_wave_id = null;
  }
  const scopeClass = options.scopeClass ?? "code";
  if (!REVIEW_SCOPE_CLASSES.has(scopeClass))
    throw new FlowError("unsupported review scope class");
  const epochs = Array.isArray(review.epochs)
    ? (review.epochs as Record<string, unknown>[])
    : [];
  let epoch = epochs.find((item) => item.epoch_id === review.active_epoch_id);
  if (!epoch && options.stage !== "initial")
    throw new FlowError(
      `${options.stage} review wave requires an active review epoch`,
    );
  if (!epoch) {
    const number = Number(review.next_epoch ?? 1);
    epoch = {
      epoch_id: stableHash([
        ledger.run_id,
        "epoch",
        number,
        options.headSha,
        options.baseSha,
      ]).slice(0, 16),
      number,
      base_sha: options.baseSha,
      start_head_sha: options.headSha,
      status: "active",
      repair_rounds_used: 0,
      risk_arbitration_used: false,
      blocker_history: [],
      waves: [],
      permits: [],
      arbitration_history: [],
      invariants: [],
    };
    epochs.push(epoch);
    review.next_epoch = number + 1;
    review.active_epoch_id = epoch.epoch_id;
    review.epochs = epochs;
  }
  const sourceWave = prepareReviewWaveState(
    ledger,
    review,
    epoch,
    options,
    arbitrationConflicts,
    arbitrationBlockerFingerprints,
  );
  if (!Array.isArray(epoch.waves)) epoch.waves = [];
  if (!Array.isArray(epoch.permits)) epoch.permits = [];
  const waveSeed = [
    ledger.run_id,
    epoch.epoch_id,
    options.stage,
    options.headSha,
    options.baseSha,
    scopeClass,
    options.laneSpecs,
  ];
  const waves = isRecord(review.waves) ? review.waves : {};
  let generation = 0;
  let waveId = stableHash([...waveSeed, generation]).slice(0, 20);
  while (Object.hasOwn(waves, waveId)) {
    generation += 1;
    waveId = stableHash([...waveSeed, generation]).slice(0, 20);
  }
  const lanes = Object.fromEntries(
    options.laneSpecs.map((lane) => [
      lane.lane,
      {
        model: lane.model,
        effort: lane.effort,
        requested_profile: {
          model: lane.model,
          effort: lane.effort,
        },
        receipt_id: null,
        state: "pending",
      },
    ]),
  );
  const wave: Record<string, unknown> = {
    wave_id: waveId,
    epoch_id: epoch.epoch_id,
    state: "open",
    stage: options.stage,
    base_sha: options.baseSha,
    base_ref: options.baseRef ?? null,
    head_sha: options.headSha,
    acceptance_manifest_digest: ledger.acceptance_manifest
      ? stableHash(normalizeAcceptanceManifest(ledger.acceptance_manifest))
      : null,
    lanes,
    blockers: [],
    blocker_fingerprints: [],
    scope_class: scopeClass,
    scope_binding: stableHash(["review-wave-scope", scopeClass]),
    previous_head_sha: options.previousHeadSha ?? null,
    repair_permit_id: options.repairPermitId ?? null,
    arbitration_source_wave_id:
      options.stage === "risk-arbitration"
        ? (sourceWave?.wave_id ?? null)
        : null,
    arbitration_conflicts: arbitrationConflicts,
    arbitration_blocker_fingerprints: arbitrationBlockerFingerprints,
    opened_at: isoNow(),
  };
  waves[waveId] = wave;
  review.waves = waves;
  review.active_wave_id = waveId;
  (epoch.waves as unknown[]).push(waveId);
  ledger.convergence = {
    ...(isRecord(ledger.convergence) ? ledger.convergence : {}),
    state: options.stage === "repair" ? "repair" : "initial",
  };
  return { wave, epoch, next: "record-review" };
}

function isLegacyReviewWave(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
): boolean {
  if (Object.hasOwn(wave, "scope_binding") || !isRecord(wave.lanes))
    return false;
  const lanes = Object.entries(wave.lanes);
  if (!lanes.length || !reviewLaneTopologyMatches(ledger, wave, lanes))
    return false;
  const receipts = Array.isArray(ledger.receipts)
    ? ledger.receipts.filter(isRecord)
    : [];
  return lanes.every(([laneName, rawLane]) => {
    if (
      !isRecord(rawLane) ||
      Object.hasOwn(rawLane, "requested_profile") ||
      typeof rawLane.model !== "string" ||
      !rawLane.model.trim() ||
      typeof rawLane.effort !== "string" ||
      !rawLane.effort.trim()
    )
      return false;
    return (
      typeof rawLane.receipt_id === "string" &&
      receipts.some((receipt) =>
        receipt.receipt_id === rawLane.receipt_id
          ? isHistoricalReviewReceipt(ledger, wave, laneName, receipt)
          : false,
      )
    );
  });
}

function isHistoricalReviewReceipt(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
  laneName: string,
  receipt: Record<string, unknown>,
): boolean {
  if (
    receipt.review_receipt_schema === 6 &&
    typeof receipt.review_model === "string" &&
    receipt.review_model.trim().length > 0 &&
    typeof receipt.review_effort === "string" &&
    receipt.review_effort.trim().length > 0 &&
    typeof receipt.resolved_model === "string" &&
    typeof receipt.resolved_effort === "string" &&
    isRecord(receipt.profile_resolution) &&
    receipt.profile_proof_status === "sub-agent-declared" &&
    receipt.review_execution_source === "sub-agent" &&
    receipt.provenance_boundary === "sub-agent-structured-result" &&
    receipt.evidence_source === "sub-agent-structured-result" &&
    !Object.hasOwn(receipt, "requested_profile") &&
    !Object.hasOwn(receipt, "profile_verification") &&
    !Object.hasOwn(receipt, "effective_profile") &&
    !Object.hasOwn(receipt, "attempt_key") &&
    !Object.hasOwn(receipt, "scope_class")
  ) {
    let parsed;
    try {
      parsed = parseReviewResultJson(JSON.stringify(receipt.review_result));
    } catch {
      return false;
    }
    const expectedProfile =
      wave.stage === "risk-arbitration"
        ? "risk-arbitration"
        : "pr-convergence";
    const expectedId = stableHash([
      ledger.run_id,
      "sub-agent-review",
      receipt.wave_proof_key,
      receipt.review_result_sha256,
    ]);
    return (
      receipt.kind === "review" &&
      receipt.review_profile === expectedProfile &&
      receipt.wave_id === wave.wave_id &&
      receipt.lane === laneName &&
      receipt.head_sha === wave.head_sha &&
      receipt.base_sha === wave.base_sha &&
      receipt.receipt_id === expectedId &&
      receipt.review_result_sha256 === parsed.resultSha256 &&
      Array.isArray(receipt.finding_fingerprints) &&
      Array.isArray(receipt.review_findings) &&
      canonicalJson(receipt.finding_fingerprints) ===
        canonicalJson(parsed.fingerprints) &&
      canonicalJson(receipt.review_findings) ===
        canonicalJson(parsed.result.findings) &&
      receipt.overall_correctness === parsed.result.overall_correctness &&
      receipt.overall_explanation === parsed.result.overall_explanation &&
      receipt.review_clear ===
        (parsed.fingerprints.length === 0 &&
          parsed.result.overall_correctness === "patch is correct")
    );
  }
  return false;
}

function reviewWaveIsTerminal(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
): boolean {
  if (!isRecord(wave.lanes)) return false;
  const receipts = Array.isArray(ledger.receipts)
    ? ledger.receipts.filter(isRecord)
    : [];
  const lanes = Object.entries(wave.lanes);
  if (!reviewLaneTopologyMatches(ledger, wave, lanes)) return false;
  const legacy = isLegacyReviewWave(ledger, wave);
  return lanes.every(([laneName, lane]) => {
    if (
      !isRecord(lane) ||
      lane.state !== "completed" ||
      typeof lane.receipt_id !== "string" ||
      !lane.receipt_id.trim()
    )
      return false;
    const receipt = receipts.find(
      (candidate) => candidate.receipt_id === lane.receipt_id,
    );
    if (
      !isRecord(receipt) ||
      receipt.review_receipt_schema !== (legacy ? 6 : 7) ||
      receipt.kind !== "review" ||
      receipt.terminal_state !== "completed" ||
      receipt.evidence_valid !== true ||
      receipt.post_execution_clean !== true ||
      receipt.exit_code !== 0 ||
      receipt.wave_id !== wave.wave_id ||
      receipt.lane !== laneName ||
      receipt.base_sha !== wave.base_sha ||
      receipt.head_sha !== wave.head_sha
    )
      return false;
    if (
      legacy &&
      !isHistoricalReviewReceipt(ledger, wave, laneName, receipt)
    )
      return false;
    if (!legacy) {
      try {
        assertReviewReceiptIntegrity(
          ledger,
          String(wave.wave_id),
          laneName,
          lane,
          receipt,
        );
      } catch {
        return false;
      }
    }
    return true;
  });
}

function reviewWaveIsClear(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
): boolean {
  if (!isRecord(wave.lanes)) return false;
  const receipts = Array.isArray(ledger.receipts)
    ? ledger.receipts.filter(isRecord)
    : [];
  return Object.values(wave.lanes).every((lane) => {
    if (!isRecord(lane)) return false;
    const receipt = receipts.find(
      (candidate) => candidate.receipt_id === lane.receipt_id,
    );
    return (
      isRecord(receipt) &&
      receipt.review_clear === true &&
      receipt.overall_correctness === "patch is correct" &&
      Array.isArray(receipt.finding_fingerprints) &&
      receipt.finding_fingerprints.length === 0
    );
  });
}

function reviewLaneTopologyMatches(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
  lanes: [string, unknown][],
): boolean {
  const names = new Set(lanes.map(([lane]) => lane));
  const assessment = isRecord(ledger.review_assessment)
    ? ledger.review_assessment
    : undefined;
  if (wave.stage === "risk-arbitration")
    return names.size === 1 && names.has("risk-arbitration");
  const fixed = [...FIXED_REVIEW_LANES].every((lane) => names.has(lane));
  const dynamic = [...names].filter((lane) => !FIXED_REVIEW_LANES.has(lane));
  return (
    fixed &&
    dynamic.length <= 2 &&
    dynamic.every((lane) => DYNAMIC_REVIEW_LANES.has(lane)) &&
    (assessment?.tier === 3
      ? dynamic.length === 0
      : assessment?.tier === 4 && dynamic.length >= 1)
  );
}
