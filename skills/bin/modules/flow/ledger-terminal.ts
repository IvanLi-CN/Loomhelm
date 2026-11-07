import { existsSync, readFileSync } from "node:fs";
import {
  FlowError,
  MAX_CONVERGENCE_ROUNDS,
  PR_BOUND_FLOW_TYPES,
  TRANSIENT_VALIDATION_EXIT_CODES,
  TERMINAL_STATES,
  deepClone,
  isoNow,
  isRecord,
  nonemptyString,
  normalizeSha,
} from "./common";
import {
  assertAcceptanceAssertionsComplete,
  normalizeAcceptanceEvidence,
  normalizeAcceptanceManifest,
  validateAcceptanceEvidence,
  type AcceptanceEvidence,
} from "./acceptance";
import {
  classifyDelta,
  effectiveMergeFingerprint,
  gitChangedPaths,
  gitCommit,
  specContractChanged,
} from "./git";
import { hasClearReviewReceipt } from "./review";
import { assertReviewReceiptIntegrity } from "./review-record";
import { assertReviewSynthesisIntegrity } from "./review-ledger";
import { bindingForLedger, readLivePullRequest } from "../hosting/pull-request";
import { prettyJson } from "./storage";
import {
  isCurrentClearWave,
  normalizePostMergeEvidence,
  normalizeLedger,
  projectStatusPayload,
  reviewTier,
  validatePostMergeReleasePolicy,
} from "./state";
import type { FlowLedger } from "./ledger";

export function classifyGitDelta(
  ledger: FlowLedger,
  sourceHead: string,
  targetHead: string,
  requireCurrent = false,
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError(
      "Git delta classification requires a repository-bound ledger",
    );
  const current = ledger.read();
  const source = gitCommit(ledger.repo, sourceHead);
  const target = gitCommit(ledger.repo, targetHead);
  if (requireCurrent && target !== gitCommit(ledger.repo, "HEAD"))
    throw new FlowError(
      "attestation target must be the repository current HEAD",
    );
  const paths = gitChangedPaths(ledger.repo, source, target);
  const contractChanged = specContractChanged(
    ledger.repo,
    source,
    target,
    paths,
  );
  const classification = classifyDelta(
    paths,
    contractChanged,
    effectiveMergeFingerprint(ledger.repo, String(current.base_sha), source),
    effectiveMergeFingerprint(ledger.repo, String(current.base_sha), target),
  );
  return {
    source_head: source,
    target_head: target,
    paths,
    spec_contract_changed: contractChanged,
    effective_merge_before: effectiveMergeFingerprint(
      ledger.repo,
      String(current.base_sha),
      source,
    ),
    effective_merge_after: effectiveMergeFingerprint(
      ledger.repo,
      String(current.base_sha),
      target,
    ),
    classification,
  };
}

export function status(ledger: FlowLedger): Record<string, unknown> {
  const current = projectStatusPayload(ledger.read()) as Record<
    string,
    unknown
  >;
  const convergence = current.convergence as Record<string, unknown>;
  const receipts = current.receipts as unknown[];
  const review = current.review as Record<string, unknown>;
  const activeEpoch =
    typeof review.active_epoch_id === "string" && Array.isArray(review.epochs)
      ? (review.epochs as Record<string, unknown>[]).find(
          (epoch) => epoch.epoch_id === review.active_epoch_id,
        )
      : undefined;
  const failedByIdentity = new Map<string, number[]>();
  for (const receipt of receipts) {
    if (
      !isRecord(receipt) ||
      receipt.kind !== "validation" ||
      typeof receipt.identity !== "string" ||
      typeof receipt.exit_code !== "number" ||
      receipt.exit_code === 0
    )
      continue;
    const attempts = failedByIdentity.get(receipt.identity) ?? [];
    attempts.push(receipt.exit_code);
    failedByIdentity.set(receipt.identity, attempts);
  }
  current.budget_status = {
    command_budget_seconds: current.command_budget_seconds,
    convergence_repair_rounds_remaining: Math.max(
      0,
      MAX_CONVERGENCE_ROUNDS - Number(convergence.repair_round ?? 0),
    ),
    transient_retries_remaining_by_identity: Object.fromEntries(
      [...failedByIdentity.entries()].map(([identity, attempts]) => [
        identity,
        attempts.length === 1 &&
        TRANSIENT_VALIDATION_EXIT_CODES.has(attempts[0] ?? -1)
          ? 1
          : 0,
      ]),
    ),
    active_review_epoch: activeEpoch?.epoch_id ?? null,
    review_repair_rounds_remaining: activeEpoch
      ? Math.max(
          0,
          MAX_CONVERGENCE_ROUNDS - Number(activeEpoch.repair_rounds_used ?? 0),
        )
      : MAX_CONVERGENCE_ROUNDS,
    active_review_wave: review.active_wave_id ?? null,
  };
  current.recent_receipts = receipts.slice(-5);
  return current;
}

export function closeFlow(
  ledger: FlowLedger,
  state: string,
): Record<string, unknown> {
  if (!TERMINAL_STATES.has(state))
    throw new FlowError(
      `close state must be terminal: ${[...TERMINAL_STATES].sort().join(", ")}`,
    );
  return ledger.withLifecycleLock(
    () =>
      ledger.withLock(() => {
        const raw = ledger.readRaw();
        if (raw.state !== "active") {
          if (raw.state !== state)
            throw new FlowError(
              `flow receipt ledger is terminal: ${String(raw.state)}`,
            );
          const archive = ledger.archivePath(String(raw.run_id ?? ""));
          if (
            !existsSync(archive) ||
            Buffer.compare(
              Buffer.from(readFileSync(archive)),
              Buffer.from(prettyJson(raw)),
            ) !== 0
          )
            throw new FlowError(
              "terminal ledger is missing its sealed archive",
            );
          return normalizeLedger(raw);
        }
        const current = normalizeLedger(deepClone(raw));
        ledger.recoverStaleTerminalArchive(raw);
        requireComplete(ledger, current, state);
        const terminal = {
          ...current,
          state,
          closed_at: isoNow(),
          updated_at: isoNow(),
        };
        try {
          ledger.write(terminal);
          ledger.archive(terminal);
          return terminal;
        } catch (error) {
          ledger.rollbackTerminalSeal(raw, terminal);
          throw new FlowError("terminal sealing failed", { cause: error });
        }
      }),
    0,
  );
}

function requireComplete(
  owner: FlowLedger,
  ledger: Record<string, unknown>,
  state: string,
): void {
  if (state !== "complete") return;
  const flowType = String(ledger.flow_type ?? "");
  const review = isRecord(ledger.review) ? ledger.review : {};
  const receipts = Array.isArray(ledger.receipts)
    ? ledger.receipts.filter(isRecord)
    : [];
  const tier = reviewTier(ledger);
  if (tier === 3 || tier === 4) {
    const waves = isRecord(review.waves) ? Object.values(review.waves) : [];
    if (review.active_wave_id !== null && review.active_wave_id !== undefined)
      throw new FlowError(
        "complete requires no active review wave after proof finalization",
      );
    if (review.active_epoch_id !== null && review.active_epoch_id !== undefined)
      throw new FlowError(
        "complete requires no active review epoch after proof finalization",
      );
    const proofEpoch = (Array.isArray(review.epochs) ? review.epochs : [])
      .filter(isRecord)
      .find(
        (epoch) =>
          epoch.status === "complete" &&
          typeof epoch.review_proof_wave_id === "string",
      );
    const wave = proofEpoch
      ? waves.find(
          (candidate) =>
            isRecord(candidate) &&
            candidate.wave_id === proofEpoch.review_proof_wave_id &&
            candidate.epoch_id === proofEpoch.epoch_id &&
            isCurrentClearWave(
              candidate,
              String(ledger.head_sha),
              String(ledger.base_sha),
              tier,
            ),
        )
      : undefined;
    if (!isRecord(wave) || !isRecord(wave.lanes))
      throw new FlowError(
        "complete requires a finalized current-head required review proof",
      );
    const allFindings = new Set<string>();
    for (const lane of Object.entries(wave.lanes)) {
      const laneState = lane[1];
      if (!isRecord(laneState))
        throw new FlowError(
          "complete requires an untampered current-head required review proof",
        );
      const receipt = receipts.find(
        (item) => item.receipt_id === laneState.receipt_id,
      );
      if (
        !receipt ||
        !hasClearReviewReceipt(receipt) ||
        receipt.wave_id !== wave.wave_id ||
        receipt.lane !== lane[0]
      )
        throw new FlowError(
          "complete requires an untampered current-head required review proof",
        );
      assertReviewReceiptIntegrity(
        ledger,
        String(wave.wave_id),
        lane[0],
        laneState,
        receipt,
        owner.repo,
      );
      for (const fingerprint of receipt.finding_fingerprints as string[])
        allFindings.add(fingerprint);
    }
    assertReviewSynthesisIntegrity(
      ledger,
      wave,
      new Set(Object.keys(wave.lanes)),
      allFindings,
    );
  }
  if (!PR_BOUND_FLOW_TYPES.has(flowType)) return;
  if (!nonemptyString(review.pr_ref))
    throw new FlowError("complete requires a bound live PR");
  const mergeReceipts = receipts.filter(
    (receipt) => receipt.kind === "post-merge",
  );
  if (mergeReceipts.length !== 1)
    throw new FlowError(
      "complete requires exactly one post-merge receipt for the bound PR",
    );
  const storedMerge = mergeReceipts[0]!;
  const merge = normalizePostMergeEvidence({
    pr_ref: storedMerge.pr_ref,
    head_sha: storedMerge.head_sha,
    base_sha: storedMerge.base_sha,
    merge_sha: storedMerge.merge_sha,
    merged_at: storedMerge.merged_at,
    finality: storedMerge.finality,
  });
  if (merge.pr_ref !== review.pr_ref)
    throw new FlowError(
      "complete requires a post-merge receipt for the bound PR",
    );
  if (!owner.repo)
    throw new FlowError("complete requires a repository-bound merged PR");
  const livePr = readLivePullRequest(owner.repo, String(review.pr_ref));
  const binding = bindingForLedger(livePr.binding);
  const storedBinding = ledger.repository_binding;
  if (
    !isRecord(storedBinding) ||
    storedBinding.provider !== binding.provider ||
    storedBinding.host !== binding.host ||
    storedBinding.full_name !== binding.full_name
  )
    throw new FlowError(
      "complete requires a post-merge receipt matching the repository binding",
    );
  const live = livePr.facts;
  if (
    live.state !== "MERGED" ||
    live.base_sha !== merge.base_sha ||
    live.head_sha !== merge.head_sha ||
    live.merge_sha !== merge.merge_sha ||
    live.merged_at !== merge.merged_at
  )
    throw new FlowError(
      "complete requires a post-merge receipt matching live merge facts",
    );
  validatePostMergeReleasePolicy(
    merge,
    livePr.binding,
    live as unknown as Record<string, unknown>,
  );
  const manifest = ledger.acceptance_manifest;
  if (!manifest)
    throw new FlowError(
      "owner-action blocker: acceptance manifest is required before Flow Complete",
    );
  const required = normalizeAcceptanceManifest(manifest).items.filter(
    (item) => item.phase !== "pre_merge",
  );
  const rawRecords = ledger.phase_acceptance_evidence;
  if (!Array.isArray(rawRecords))
    throw new FlowError(
      "owner-action blocker: post-merge acceptance evidence is malformed",
    );
  const records: Record<string, unknown>[] = [];
  for (const record of rawRecords) {
    if (!isRecord(record))
      throw new FlowError(
        "owner-action blocker: post-merge acceptance evidence is malformed",
      );
    records.push(record);
  }
  const allEvidence: AcceptanceEvidence[] = [];
  for (const record of records) {
    if (record.kind !== "acceptance" || typeof record.phase !== "string")
      throw new FlowError(
        "owner-action blocker: post-merge acceptance evidence is malformed",
      );
    const recordMergeSha = normalizeSha(record.merge_sha, "merge_sha");
    if (recordMergeSha !== merge.merge_sha)
      throw new FlowError(
        "owner-action blocker: post-merge acceptance evidence must bind the merge SHA",
      );
    const evidence = normalizeAcceptanceEvidence(record.acceptance_evidence);
    if (
      !evidence.length ||
      evidence.some((item) => item.phase !== record.phase)
    )
      throw new FlowError(
        "owner-action blocker: post-merge acceptance evidence is malformed",
      );
    validateAcceptanceEvidence(manifest, evidence, {
      mergeSha: merge.merge_sha,
      allowPostMerge: true,
      ...(record.deployment_identity === null
        ? {}
        : { deploymentIdentity: record.deployment_identity }),
    });
    allEvidence.push(...evidence);
  }
  assertAcceptanceAssertionsComplete(
    manifest,
    allEvidence,
    required.map((item) => item.id),
  );
}
