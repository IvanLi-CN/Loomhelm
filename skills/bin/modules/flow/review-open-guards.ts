import { FlowError, isoNow, isRecord } from "./common";
import { canonicalList } from "./review-wave-utils";

export interface ReviewWaveOpenOptions {
  stage: string;
  baseSha: string;
  headSha: string;
  laneSpecs: { lane: string; model: string; effort: string }[];
  previousHeadSha?: string | undefined;
  repairPermitId?: string | undefined;
  scopeClass?: string | undefined;
  highRequirement?: boolean | undefined;
  arbitrationConflicts?: string[] | undefined;
  arbitrationBlockerFingerprints?: string[] | undefined;
}

export function prepareReviewWaveState(
  ledger: Record<string, unknown>,
  review: Record<string, unknown>,
  epoch: Record<string, unknown>,
  options: ReviewWaveOpenOptions,
  arbitrationConflicts: string[],
  arbitrationBlockerFingerprints: string[],
): Record<string, unknown> | undefined {
  if (
    options.stage === "risk-arbitration" &&
    (!arbitrationConflicts.length || !arbitrationBlockerFingerprints.length)
  )
    throw new FlowError(
      "risk arbitration requires declared conflicts and blocker fingerprints",
    );
  if (
    options.stage !== "risk-arbitration" &&
    (arbitrationConflicts.length || arbitrationBlockerFingerprints.length)
  )
    throw new FlowError(
      "arbitration metadata is only valid for risk arbitration",
    );
  if (options.stage === "repair" && !options.repairPermitId)
    throw new FlowError("repair review wave requires a repair permit");
  if (options.stage === "repair" && !options.previousHeadSha)
    throw new FlowError("repair review wave requires previous_head_sha");
  if (options.stage !== "repair" && options.repairPermitId)
    throw new FlowError("repair permit is only valid for a repair wave");
  if (options.stage !== "repair" && options.previousHeadSha !== undefined)
    throw new FlowError("previous_head_sha is only valid for a repair wave");
  if (options.stage === "repair" && epoch.status !== "repair_authorized")
    throw new FlowError(
      "repair review wave requires an authorized repair permit",
    );
  if (options.stage === "risk-arbitration" && epoch.status !== "repair_pending")
    throw new FlowError("risk arbitration requires an active blocker set");
  if (options.stage === "risk-arbitration" && epoch.risk_arbitration_used)
    throw new FlowError("risk arbitration budget is exhausted for this epoch");
  if (options.stage === "repair") {
    const permit = (Array.isArray(epoch.permits) ? epoch.permits : []).find(
      (item) => isRecord(item) && item.permit_id === options.repairPermitId,
    );
    if (!isRecord(permit) || permit.status !== "issued")
      throw new FlowError(
        "repair review wave requires an issued repair permit",
      );
    if (
      permit.base_sha !== options.baseSha ||
      permit.from_head_sha !== options.previousHeadSha ||
      ledger.head_sha !== options.previousHeadSha ||
      options.headSha === options.previousHeadSha
    )
      throw new FlowError(
        "repair permit does not match the current review head",
      );
    permit.status = "used";
    permit.used_at = isoNow();
    permit.to_head_sha = options.headSha;
    ledger.head_sha = options.headSha;
    ledger.events = [
      ...(Array.isArray(ledger.events) ? ledger.events : []),
      {
        type: "repair_head_advanced",
        from_head_sha: options.previousHeadSha,
        to_head_sha: options.headSha,
        permit_id: options.repairPermitId,
        at: isoNow(),
      },
    ];
  }
  const waveCollection = isRecord(review.waves) ? review.waves : {};
  const sourceWave = (Array.isArray(epoch.waves) ? epoch.waves : [])
    .slice()
    .reverse()
    .map((id) => (typeof id === "string" ? waveCollection[id] : undefined))
    .find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        candidate.epoch_id === epoch.epoch_id &&
        candidate.state === "finalized" &&
        Array.isArray(candidate.blockers) &&
        candidate.blockers.length > 0,
    );
  if (options.stage === "risk-arbitration" && !sourceWave)
    throw new FlowError("risk arbitration requires a finalized blocker wave");
  if (options.stage === "risk-arbitration" && sourceWave) {
    if (!Array.isArray(sourceWave.conflicts) || !sourceWave.conflicts.length)
      throw new FlowError(
        "risk arbitration requires an unresolved reviewer conflict",
      );
    if (
      canonicalList(sourceWave.conflicts) !==
        canonicalList(arbitrationConflicts) ||
      canonicalList(sourceWave.blocker_fingerprints) !==
        canonicalList(arbitrationBlockerFingerprints)
    )
      throw new FlowError(
        "risk arbitration metadata does not match its source wave",
      );
  }
  if (options.stage === "risk-arbitration") epoch.risk_arbitration_used = true;
  return sourceWave;
}
