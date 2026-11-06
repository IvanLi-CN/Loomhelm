import {
  FlowError,
  MAX_CONVERGENCE_ROUNDS,
  isRecord,
  isoNow,
  stableHash,
} from "./common";
import { canonicalList } from "./review-wave-utils";

function reviewState(ledger: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(ledger.review))
    throw new FlowError("ledger review state is invalid");
  return ledger.review;
}

function activeWave(
  ledger: Record<string, unknown>,
  waveId: string,
): Record<string, unknown> {
  const review = reviewState(ledger);
  const waves = isRecord(review.waves) ? review.waves : {};
  if (!isRecord(waves[waveId]))
    throw new FlowError(`review wave does not exist: ${waveId}`);
  return waves[waveId];
}

export function authorizeRepairState(
  ledger: Record<string, unknown>,
  waveId: string,
): Record<string, unknown> {
  const requestedWave = activeWave(ledger, waveId);
  const review = reviewState(ledger);
  if (review.active_wave_id)
    throw new FlowError(
      "repair authorization requires all lanes in the active review wave to finalize",
    );
  const epochs = Array.isArray(review.epochs)
    ? (review.epochs as Record<string, unknown>[])
    : [];
  const epoch = epochs.find((item) => item.epoch_id === requestedWave.epoch_id);
  if (!epoch)
    throw new FlowError("active review epoch is missing from the ledger");
  let wave = requestedWave;
  if (requestedWave.stage === "risk-arbitration") {
    if (requestedWave.state !== "finalized")
      throw new FlowError(
        "repair authorization requires a finalized review wave",
      );
    if (typeof requestedWave.arbitration_source_wave_id !== "string")
      throw new FlowError("risk arbitration is missing its source wave");
    wave = activeWave(ledger, requestedWave.arbitration_source_wave_id);
  }
  if (
    requestedWave.epoch_id !== epoch.epoch_id ||
    !Array.isArray(epoch.waves) ||
    !epoch.waves.includes(waveId) ||
    !epoch.waves.includes(String(wave.wave_id))
  )
    throw new FlowError("repair authorization wave is not in the active epoch");
  if (
    wave.state !== "finalized" ||
    !Array.isArray(wave.blockers) ||
    wave.blockers.length === 0
  )
    throw new FlowError(
      "repair authorization requires a finalized blocked wave",
    );
  const latestBlocker = [...epoch.waves]
    .reverse()
    .map((id) => (typeof id === "string" ? activeWave(ledger, id) : undefined))
    .find((candidate): candidate is Record<string, unknown> =>
      Boolean(
        candidate &&
        candidate.state === "finalized" &&
        Array.isArray(candidate.blockers) &&
        candidate.blockers.length,
      ),
    );
  if (!latestBlocker || latestBlocker.wave_id !== wave.wave_id)
    throw new FlowError(
      "repair authorization requires the latest finalized blocker wave",
    );
  const convergence = isRecord(ledger.convergence)
    ? ledger.convergence
    : undefined;
  if (
    !convergence ||
    canonicalList(convergence.blockers) !== canonicalList(wave.blockers)
  )
    throw new FlowError("repair authorization blocker set is stale");
  const used = Number(epoch.repair_rounds_used ?? 0);
  if (used >= MAX_CONVERGENCE_ROUNDS)
    throw new FlowError("review repair budget is exhausted");
  if (
    !new Set(["repair_pending", "diagnostic_required"]).has(
      String(epoch.status),
    )
  )
    throw new FlowError("repair authorization requires an active blocker wave");
  const blockers = wave.blockers as string[];
  const permits = Array.isArray(epoch.permits) ? epoch.permits : [];
  epoch.permits = permits;
  const permitNumber = used + 1;
  const permitId = stableHash([
    ledger.run_id,
    epoch.epoch_id,
    wave.wave_id,
    permitNumber,
    blockers,
    wave.base_sha,
    wave.head_sha,
  ]).slice(0, 20);
  const blockerDigest = stableHash(blockers);
  const sourceScopeFingerprint =
    typeof wave.scope_fingerprint === "string" && wave.scope_fingerprint
      ? wave.scope_fingerprint
      : stableHash({
          stage: wave.stage,
          base_sha: wave.base_sha,
          head_sha: wave.head_sha,
          finding_to_group: wave.finding_to_group ?? {},
        });
  const permit = {
    permit_id: permitId,
    source_wave_id: wave.wave_id,
    from_head_sha: wave.head_sha,
    base_sha: wave.base_sha,
    blocker_digest: blockerDigest,
    source_scope_fingerprint: sourceScopeFingerprint,
    scope_paths: [],
    scope_fingerprint: stableHash({
      source_wave_id: wave.wave_id,
      blocker_digest: blockerDigest,
      source_scope_fingerprint: sourceScopeFingerprint,
      scope_paths: [],
    }),
    scope: "root-cause-repair",
    status: "issued",
    issued_at: isoNow(),
  };
  (epoch.permits as unknown[]).push(permit);
  wave.repair_permit_id = permitId;
  epoch.repair_rounds_used = permitNumber;
  epoch.status = "repair_authorized";
  if (isRecord(ledger.convergence)) {
    ledger.convergence.repair_round = permitNumber;
    ledger.convergence.blockers = blockers;
  }
  return { repair_permit: permit, permit, epoch, next: "open-repair-wave" };
}
