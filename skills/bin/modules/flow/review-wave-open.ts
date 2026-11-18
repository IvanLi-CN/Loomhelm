import {
  DYNAMIC_REVIEW_LANES,
  FIXED_REVIEW_LANES,
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
  if (
    ledger.legacy_compatibility !== true ||
    ledger.legacy_schema_version !== 6 ||
    !isRecord(wave.lanes)
  )
    return false;
  const lanes = Object.entries(wave.lanes);
  if (!lanes.length || !legacyLaneTopologyMatches(ledger, wave, lanes))
    return false;
  return lanes.every(([, rawLane]) => {
    if (
      !isRecord(rawLane) ||
      Object.hasOwn(rawLane, "requested_profile") ||
      typeof rawLane.model !== "string" ||
      !rawLane.model.trim() ||
      typeof rawLane.effort !== "string" ||
      !rawLane.effort.trim()
    )
      return false;
    return true;
  });
}

function legacyLaneTopologyMatches(
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
