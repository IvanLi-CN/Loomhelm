import { REVIEW_NECESSITY_TIERS, isRecord, stableHash } from "./common";

export function reviewTier(ledger: Record<string, unknown>): number | null {
  if (typeof ledger.flow_type !== "string") return null;
  const assessment = isRecord(ledger.review_assessment)
    ? ledger.review_assessment
    : undefined;
  return DIRECT_REVIEW_TYPES.has(ledger.flow_type) &&
    typeof assessment?.tier === "number" &&
    REVIEW_NECESSITY_TIERS.has(assessment.tier)
    ? assessment.tier
    : null;
}

export function reviewConvergenceStarted(
  review: Record<string, unknown>,
): boolean {
  return Boolean(
    review.active_wave_id ||
    review.active_epoch_id ||
    (Array.isArray(review.epochs) && review.epochs.length),
  );
}

export function isCurrentClearWave(
  wave: unknown,
  headSha: string,
  baseSha: string,
  tier: number,
): boolean {
  if (
    !isRecord(wave) ||
    !["initial", "repair"].includes(String(wave.stage)) ||
    wave.state !== "finalized" ||
    (Array.isArray(wave.blockers) && wave.blockers.length) ||
    wave.head_sha !== headSha ||
    wave.base_sha !== baseSha ||
    typeof wave.synthesis_sha256 !== "string" ||
    !isRecord(wave.synthesis) ||
    stableHash(wave.synthesis) !== wave.synthesis_sha256
  )
    return false;
  if (!isRecord(wave.lanes)) return false;
  const names = new Set(Object.keys(wave.lanes));
  const fixed = [...FIXED_REVIEW_LANES].every((name) => names.has(name));
  const dynamic = [...names].filter((name) => !FIXED_REVIEW_LANES.has(name));
  return tier === 3
    ? fixed && dynamic.length === 0
    : tier === 4
      ? fixed &&
        dynamic.length >= 1 &&
        dynamic.length <= 2 &&
        dynamic.every((name) => DYNAMIC_REVIEW_LANES.has(name))
      : false;
}

const DIRECT_REVIEW_TYPES = new Set(["fast-track", "normal", "local-merge"]);

const FIXED_REVIEW_LANES = new Set([
  "contract",
  "state-concurrency",
  "failure-data-safety",
  "test-platform",
]);
const DYNAMIC_REVIEW_LANES = new Set([
  "ui-accessibility",
  "security",
  "database-migration",
  "release-infra",
]);
