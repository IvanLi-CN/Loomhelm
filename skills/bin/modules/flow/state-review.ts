import {
  DYNAMIC_REVIEW_LANES,
  FIXED_REVIEW_LANES,
  MAX_DYNAMIC_REVIEW_LANES,
  RETIRED_REVIEW_LANES,
  REVIEW_NECESSITY_TIERS,
  isRecord,
  stableHash,
} from "./common";

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
  options: { legacySchema?: boolean } = {},
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
  if (options.legacySchema && matchesRetiredTopology(names, tier)) return true;
  const fixed = [...FIXED_REVIEW_LANES].every((name) => names.has(name));
  const dynamic = [...names].filter((name) => !FIXED_REVIEW_LANES.has(name));
  return tier === 3
    ? fixed && dynamic.length === 0
    : tier === 4
      ? fixed &&
        dynamic.length >= 1 &&
        dynamic.length <= MAX_DYNAMIC_REVIEW_LANES &&
        dynamic.every((name) => DYNAMIC_REVIEW_LANES.has(name))
      : false;
}

/**
 * Retired four-lane topology from ADR 0043. Callers gate this on the ledger's
 * schema version so a current wave can never authorize it.
 */
function matchesRetiredTopology(names: Set<string>, tier: number): boolean {
  if (tier !== 3 && tier !== 4) return false;
  if (![...RETIRED_REVIEW_LANES].every((lane) => names.has(lane))) return false;
  const dynamic = [...names].filter((lane) => !RETIRED_REVIEW_LANES.has(lane));
  return tier === 3
    ? dynamic.length === 0
    : dynamic.length >= 1 &&
        dynamic.length <= MAX_DYNAMIC_REVIEW_LANES &&
        dynamic.every((lane) => DYNAMIC_REVIEW_LANES.has(lane));
}

const DIRECT_REVIEW_TYPES = new Set(["fast-track", "normal", "local-merge"]);

