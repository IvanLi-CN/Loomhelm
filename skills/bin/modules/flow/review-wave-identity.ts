import { FlowError, canonicalJson, isRecord, stableHash } from "./common";

export interface ReviewWaveLaneSpec {
  lane: string;
  model: string;
  effort: string;
}

export function reviewAttemptIdentity(
  runId: string,
  waveProofKey: string,
  scopeClass: string,
  requestedProfile: { model: string; effort: string },
  attemptKey: string,
): string {
  return stableHash([
    runId,
    "sub-agent-review-attempt",
    waveProofKey,
    scopeClass,
    requestedProfile.model,
    requestedProfile.effort,
    attemptKey,
  ]);
}

export function reviewWaveIdentity(
  runId: string,
  epochId: string,
  stage: string,
  headSha: string,
  baseSha: string,
  scopeClass: string,
  laneSpecs: ReviewWaveLaneSpec[],
  generation: number,
): string {
  const canonicalLaneSpecs = [...laneSpecs].sort(compareLaneSpecs);
  const seed = [
    runId,
    epochId,
    stage,
    headSha,
    baseSha,
    scopeClass,
    canonicalLaneSpecs,
  ];
  return stableHash(
    generation === 0
      ? seed
      : [...seed, "fresh-wave-generation", generation],
  ).slice(0, 20);
}

export function reviewWaveLaneSpecs(
  wave: Record<string, unknown>,
): ReviewWaveLaneSpec[] {
  if (!isRecord(wave.lanes))
    throw new FlowError("review wave lane topology is invalid");
  return Object.entries(wave.lanes)
    .sort(([left], [right]) => compareLaneNames(left, right))
    .map(([lane, rawLane]) => {
    if (
      !isRecord(rawLane) ||
      typeof rawLane.model !== "string" ||
      !rawLane.model.trim() ||
      typeof rawLane.effort !== "string" ||
      !rawLane.effort.trim()
    )
      throw new FlowError("review wave lane topology is invalid");
      return { lane, model: rawLane.model, effort: rawLane.effort };
    });
}

function compareLaneSpecs(
  left: ReviewWaveLaneSpec,
  right: ReviewWaveLaneSpec,
): number {
  return compareLaneNames(left.lane, right.lane);
}

function compareLaneNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertReviewWaveTopology(
  wave: Record<string, unknown>,
): string[] {
  if (
    !Array.isArray(wave.required_lane_names) ||
    wave.required_lane_names.some(
      (lane) => typeof lane !== "string" || !lane.trim(),
    )
  )
    throw new FlowError("review wave required lane topology is invalid");
  const required = wave.required_lane_names as string[];
  if (new Set(required).size !== required.length)
    throw new FlowError("review wave required lane topology is invalid");
  if (!isRecord(wave.lanes))
    throw new FlowError("review wave required lane topology is invalid");
  const laneNames = Object.keys(wave.lanes).sort();
  const requiredNames = [...required].sort();
  if (canonicalJson(laneNames) !== canonicalJson(requiredNames))
    throw new FlowError("review wave required lane topology is invalid");
  return requiredNames;
}

export function assertReviewWaveIdentity(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
  waveId: string,
): void {
  if (wave.wave_id !== waveId)
    throw new FlowError("review wave identity integrity is invalid");
  assertReviewWaveTopology(wave);
  if (
    typeof ledger.run_id !== "string" ||
    typeof wave.epoch_id !== "string" ||
    typeof wave.stage !== "string" ||
    typeof wave.head_sha !== "string" ||
    typeof wave.base_sha !== "string" ||
    typeof wave.scope_class !== "string" ||
    typeof wave.wave_generation !== "number" ||
    !Number.isInteger(wave.wave_generation) ||
    wave.wave_generation < 0
  )
    throw new FlowError("review wave identity integrity is invalid");
  const expected = reviewWaveIdentity(
    ledger.run_id,
    wave.epoch_id,
    wave.stage,
    wave.head_sha,
    wave.base_sha,
    wave.scope_class,
    reviewWaveLaneSpecs(wave),
    wave.wave_generation,
  );
  if (expected !== waveId)
    throw new FlowError("review wave identity integrity is invalid");
}
