import { FlowError, isRecord, stableHash } from "./common";

export function reviewState(
  ledger: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(ledger.review))
    throw new FlowError("ledger review state is invalid");
  return ledger.review;
}

export function activeWave(
  ledger: Record<string, unknown>,
  waveId?: string,
): Record<string, unknown> {
  const review = reviewState(ledger);
  const id =
    waveId ??
    (typeof review.active_wave_id === "string" ? review.active_wave_id : "");
  const waves = isRecord(review.waves) ? review.waves : {};
  if (!id || !isRecord(waves[id]))
    throw new FlowError(`review wave does not exist: ${id}`);
  return waves[id];
}

export function reviewWaveScopeBindingMatches(
  wave: Record<string, unknown>,
): boolean {
  if (!Object.hasOwn(wave, "scope_binding")) {
    const lanes = wave.lanes;
    const isCurrentWave =
      isRecord(lanes) &&
      Object.values(lanes).some(
        (lane) => isRecord(lane) && Object.hasOwn(lane, "requested_profile"),
      );
    return !isCurrentWave;
  }
  return (
    typeof wave.scope_class === "string" &&
    typeof wave.scope_binding === "string" &&
    wave.scope_binding === stableHash(["review-wave-scope", wave.scope_class])
  );
}
