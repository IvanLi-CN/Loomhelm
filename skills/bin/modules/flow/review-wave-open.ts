import {
  FlowError,
  REVIEW_SCOPE_CLASSES,
  isoNow,
  isRecord,
  stableHash,
} from "./common";
import { normalizeAcceptanceManifest } from "./acceptance";
import { validateLaneSpecs } from "./review";
import { sortedStrings } from "./review-wave-utils";
import { prepareReviewWaveState } from "./review-open-guards";
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
    if (!active || !isLegacyReviewWave(ledger, active))
      throw new FlowError("another review wave is already active");
    active.state = "retired";
    active.retirement_reason = "legacy-review-receipt-schema";
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
  const waves = isRecord(review.waves) ? review.waves : {};
  const waveIdSeed = [
    ledger.run_id,
    epoch.epoch_id,
    options.stage,
    options.headSha,
    options.baseSha,
    scopeClass,
    options.laneSpecs,
  ];
  let waveGeneration = 0;
  let waveId = stableHash(waveIdSeed).slice(0, 20);
  while (Object.hasOwn(waves, waveId)) {
    waveGeneration += 1;
    waveId = stableHash([
      ...waveIdSeed,
      "fresh-wave-generation",
      waveGeneration,
    ]).slice(0, 20);
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
    previous_head_sha: options.previousHeadSha ?? null,
    repair_permit_id: options.repairPermitId ?? null,
    arbitration_source_wave_id:
      options.stage === "risk-arbitration"
        ? (sourceWave?.wave_id ?? null)
        : null,
    arbitration_conflicts: arbitrationConflicts,
    arbitration_blocker_fingerprints: arbitrationBlockerFingerprints,
    wave_generation: waveGeneration,
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
  if (!isRecord(wave.lanes)) return false;
  const receipts = Array.isArray(ledger.receipts)
    ? (ledger.receipts as unknown[])
    : [];
  const migratedSchemaSix =
    ledger.legacy_compatibility === true && ledger.legacy_schema_version === 6;
  const lanes = Object.entries(wave.lanes);
  if (!lanes.length) return false;
  const hasSchemaSixReceipt = lanes.some(([laneName, rawLane]) => {
    if (!isRecord(rawLane) || typeof rawLane.receipt_id !== "string")
      return false;
    const receipt = receipts.find(
      (candidate) =>
        isRecord(candidate) && candidate.receipt_id === rawLane.receipt_id,
    );
    return (
      isRecord(receipt) &&
      receipt.review_receipt_schema === 6 &&
      receiptBindsToWave(receipt, wave, laneName)
    );
  });
  const legacyLaneShape = lanes.every(
    ([, rawLane]) =>
      isRecord(rawLane) && !Object.hasOwn(rawLane, "requested_profile"),
  );
  if (!legacyLaneShape) return false;
  for (const [laneName, rawLane] of lanes) {
    if (
      !isRecord(rawLane) ||
      typeof rawLane.model !== "string" ||
      !rawLane.model.trim() ||
      typeof rawLane.effort !== "string" ||
      !rawLane.effort.trim()
    )
      return false;
    if (rawLane.receipt_id !== null && typeof rawLane.receipt_id !== "string")
      return false;
    if (typeof rawLane.receipt_id === "string") {
      const receipt = receipts.find(
        (candidate) =>
          isRecord(candidate) && candidate.receipt_id === rawLane.receipt_id,
      );
      if (!isRecord(receipt) || !receiptBindsToWave(receipt, wave, laneName))
        return false;
      if (![6, 7].includes(Number(receipt.review_receipt_schema))) return false;
    }
  }
  return hasSchemaSixReceipt || (migratedSchemaSix && legacyLaneShape);
}

function receiptBindsToWave(
  receipt: Record<string, unknown>,
  wave: Record<string, unknown>,
  laneName: string,
): boolean {
  return (
    receipt.wave_id === wave.wave_id &&
    receipt.lane === laneName &&
    receipt.head_sha === wave.head_sha &&
    receipt.base_sha === wave.base_sha
  );
}
