import { FlowError, isRecord } from "./common";

export function reviewProofClear(
  ledger: Record<string, unknown>,
  waveId: string,
): boolean {
  const review = isRecord(ledger.review) ? ledger.review : undefined;
  const waves = isRecord(review?.waves) ? review.waves : undefined;
  const wave = waves && isRecord(waves[waveId]) ? waves[waveId] : undefined;
  if (!wave) throw new FlowError(`review wave does not exist: ${waveId}`);
  return (
    wave.state === "finalized" &&
    Array.isArray(wave.blockers) &&
    wave.blockers.length === 0
  );
}
