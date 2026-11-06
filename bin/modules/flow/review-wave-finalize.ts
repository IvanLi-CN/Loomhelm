import { FlowError, isoNow, isRecord, stableHash } from "./common";
import { normalizeReviewSynthesis } from "./review";
import { recordReviewHistory } from "./review-history";
import { canonicalList, deriveReviewSynthesis } from "./review-wave-utils";
import { assertReviewReceiptIntegrity } from "./review-receipt-integrity";
import { validateReviewSynthesisAcceptance } from "./review-synthesis";
import { activeWave, reviewState } from "./review-wave-support";

export function finalizeReviewWaveState(
  ledger: Record<string, unknown>,
  waveId: string,
  synthesisInput: unknown | undefined,
  repoPath?: string,
): Record<string, unknown> {
  const wave = activeWave(ledger, waveId);
  if (wave.state !== "open" || !isRecord(wave.lanes))
    throw new FlowError("review wave is not open");
  const receipts = Array.isArray(ledger.receipts)
    ? (ledger.receipts as Record<string, unknown>[])
    : [];
  const allFindings = new Set<string>();
  for (const [laneName, rawLane] of Object.entries(wave.lanes)) {
    const lane = rawLane as Record<string, unknown>;
    if (typeof lane.receipt_id !== "string")
      throw new FlowError(
        "review wave requires terminal receipts for every lane",
      );
    const receipt = receipts.find(
      (item) => item.receipt_id === lane.receipt_id,
    );
    if (
      !receipt ||
      receipt.kind !== "review" ||
      receipt.terminal_state !== "completed" ||
      receipt.evidence_valid !== true ||
      receipt.post_execution_clean !== true ||
      receipt.exit_code !== 0 ||
      receipt.wave_id !== waveId ||
      receipt.lane !== laneName ||
      receipt.head_sha !== wave.head_sha ||
      receipt.base_sha !== wave.base_sha ||
      !Array.isArray(receipt.finding_fingerprints)
    )
      throw new FlowError(
        "review wave lane receipt is not valid current-head evidence",
      );
    assertReviewReceiptIntegrity(
      ledger,
      waveId,
      laneName,
      lane,
      receipt,
      repoPath,
    );
    const findings = new Set<string>();
    for (const fingerprint of receipt.finding_fingerprints) {
      if (typeof fingerprint !== "string" || !fingerprint.trim())
        throw new FlowError("review wave lane findings are invalid");
      if (findings.has(fingerprint))
        throw new FlowError("review wave lane findings are invalid");
      findings.add(fingerprint);
      allFindings.add(fingerprint);
    }
    const reviewClear = findings.size === 0 && receipt.review_clear === true;
    if (receipt.review_clear !== reviewClear)
      throw new FlowError(
        "review wave lane clear state does not match its findings",
      );
  }
  const synthesis = normalizeReviewSynthesis(
    synthesisInput ?? deriveReviewSynthesis(wave, allFindings),
  );
  const coverage = new Set(synthesis.coverage as string[]);
  const laneNames = new Set(Object.keys(wave.lanes));
  if (
    coverage.size !== laneNames.size ||
    [...laneNames].some((lane) => !coverage.has(lane))
  )
    throw new FlowError(
      "review synthesis coverage must match all declared lanes",
    );
  const mapped = Object.keys(
    synthesis.finding_to_group as Record<string, unknown>,
  );
  if (
    mapped.length !== allFindings.size ||
    mapped.some((finding) => !allFindings.has(finding))
  )
    throw new FlowError(
      "review synthesis must map every lane finding exactly once",
    );
  const synthesizedBlockers = new Set<string>();
  for (const group of synthesis.groups as Record<string, unknown>[]) {
    if (group.blocker !== true) continue;
    for (const finding of group.finding_fingerprints as string[])
      synthesizedBlockers.add(finding);
  }
  if (
    synthesizedBlockers.size !== allFindings.size ||
    [...allFindings].some((finding) => !synthesizedBlockers.has(finding))
  )
    throw new FlowError(
      "review synthesis blocker disposition does not match lane findings",
    );
  validateReviewSynthesisAcceptance(ledger, wave, synthesis);
  if (
    wave.stage === "risk-arbitration" &&
    (synthesis.blockers as string[]).length
  )
    throw new FlowError(
      "risk arbitration must resolve its blocker conflict before finalization",
    );
  const review = reviewState(ledger);
  let arbitrationSource: Record<string, unknown> | undefined;
  if (wave.stage === "risk-arbitration") {
    if (typeof wave.arbitration_source_wave_id !== "string")
      throw new FlowError("risk arbitration is missing its source wave");
    arbitrationSource = activeWave(ledger, wave.arbitration_source_wave_id);
    if (
      arbitrationSource.epoch_id !== wave.epoch_id ||
      arbitrationSource.state !== "finalized" ||
      !Array.isArray(arbitrationSource.blockers) ||
      arbitrationSource.blockers.length === 0
    )
      throw new FlowError(
        "risk arbitration source wave is no longer an active blocker wave",
      );
    if (
      !Array.isArray(arbitrationSource.conflicts) ||
      arbitrationSource.conflicts.length === 0 ||
      canonicalList(wave.arbitration_conflicts) !==
        canonicalList(arbitrationSource.conflicts) ||
      canonicalList(wave.arbitration_blocker_fingerprints) !==
        canonicalList(arbitrationSource.blocker_fingerprints) ||
      canonicalList(synthesis.conflicts) !==
        canonicalList(wave.arbitration_conflicts)
    )
      throw new FlowError(
        "risk arbitration synthesis conflicts do not match its source wave",
      );
    const dispositions = Array.isArray(synthesis.conflict_dispositions)
      ? synthesis.conflict_dispositions
      : [];
    if (
      canonicalList(
        dispositions
          .filter(isRecord)
          .map((item) => String(item.conflict ?? "")),
      ) !== canonicalList(wave.arbitration_conflicts)
    )
      throw new FlowError(
        "risk arbitration synthesis must dispose every declared conflict",
      );
  }
  const blockers = synthesis.blockers as string[];
  wave.state = "finalized";
  wave.blockers = blockers;
  wave.blocker_fingerprints = synthesis.blocker_fingerprints;
  wave.scope_fingerprint = synthesis.scope_fingerprint;
  wave.finding_to_group = synthesis.finding_to_group;
  wave.invariants = synthesis.invariants;
  wave.coverage = synthesis.coverage;
  wave.conflicts = synthesis.conflicts;
  wave.conflict_dispositions = synthesis.conflict_dispositions;
  wave.acceptance = synthesis.acceptance;
  wave.synthesis = synthesis;
  wave.synthesis_sha256 = stableHash(synthesis);
  wave.finalized_at = isoNow();
  const epoch = (review.epochs as Record<string, unknown>[]).find(
    (item) => item.epoch_id === wave.epoch_id,
  );
  if (!epoch)
    throw new FlowError("active review epoch is missing from the ledger");
  if (wave.stage === "risk-arbitration") {
    const history = Array.isArray(epoch.arbitration_history)
      ? epoch.arbitration_history
      : [];
    epoch.arbitration_history = [
      ...history,
      {
        wave_id: waveId,
        source_wave_id: arbitrationSource?.wave_id,
        conflicts: wave.arbitration_conflicts,
        blocker_fingerprints: wave.arbitration_blocker_fingerprints,
        dispositions: synthesis.conflict_dispositions,
        at: isoNow(),
      },
    ];
    wave.arbitration_resolution = {
      source_wave_id: arbitrationSource?.wave_id,
      conflicts: wave.arbitration_conflicts,
      blocker_fingerprints: wave.arbitration_blocker_fingerprints,
      dispositions: synthesis.conflict_dispositions,
    };
    recordReviewHistory(review, epoch, waveId, [], synthesis, {
      recordBlockerHistory: false,
    });
    epoch.status = "repair_pending";
    ledger.convergence = {
      ...(isRecord(ledger.convergence) ? ledger.convergence : {}),
      state: "repair_pending",
      blockers: arbitrationSource?.blockers ?? [],
    };
  } else {
    recordReviewHistory(review, epoch, waveId, blockers, synthesis);
    epoch.status = blockers.length ? "repair_pending" : "complete";
  }
  if (!blockers.length && wave.stage !== "risk-arbitration") {
    epoch.review_proof_wave_id = waveId;
    review.active_epoch_id = null;
  }
  review.active_wave_id = null;
  if (wave.stage !== "risk-arbitration")
    ledger.convergence = {
      ...(isRecord(ledger.convergence) ? ledger.convergence : {}),
      state: blockers.length ? "initial" : "complete",
      blockers,
    };
  return {
    wave,
    blockers:
      wave.stage === "risk-arbitration"
        ? (arbitrationSource?.blockers ?? [])
        : blockers,
    epoch,
    next:
      wave.stage === "risk-arbitration" || blockers.length
        ? "authorize-repair"
        : "merge-ready",
  };
}
