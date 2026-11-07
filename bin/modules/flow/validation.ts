import {
  canonicalJson,
  FlowError,
  TRANSIENT_VALIDATION_EXIT_CODES,
  isoNow,
  isRecord,
  stableHash,
} from "./common";
import {
  normalizeAcceptanceEvidence,
  validateAcceptanceEvidence,
  type AcceptanceEvidence,
} from "./acceptance";
import { normalizeInputPaths, validationProofKey } from "./validation-input";

export interface ValidationOptions {
  command: string;
  toolchainFingerprint: string;
  inputFingerprint: string;
  exitCode: number;
  logPath: string;
  kind?: "validation" | undefined;
  headSha?: string | undefined;
  durationSeconds?: number | undefined;
  knownLong?: boolean | undefined;
  retryStateFingerprint?: string | undefined;
  timedOut?: boolean | undefined;
  preflightOnly?: boolean | undefined;
  executionVerified?: boolean | undefined;
  observedTree?: string | undefined;
  postExecutionClean?: boolean | undefined;
  logSha256?: string | undefined;
  inputPaths?: string[] | undefined;
  acceptanceEvidence?: unknown;
}

export function recordValidationState(
  ledger: Record<string, unknown>,
  options: ValidationOptions,
  currentHead?: string,
): Record<string, unknown> {
  if (options.kind && options.kind !== "validation")
    throw new FlowError("validation receipts require kind=validation");
  const receipts = Array.isArray(ledger.receipts)
    ? (ledger.receipts as Record<string, unknown>[])
    : [];
  const rawRequestedHead = options.headSha ?? String(ledger.head_sha);
  const requestedHead = /^[0-9a-f]{40}$/i.test(rawRequestedHead)
    ? rawRequestedHead.toLowerCase()
    : rawRequestedHead;
  const paths = normalizeInputPaths(options.inputPaths ?? []);
  const evidence = normalizeAcceptanceEvidence(options.acceptanceEvidence);
  if (/^[0-9a-f]{40}$/i.test(requestedHead))
    for (const item of evidence)
      if (item.phase === "pre_merge" && !item.candidate_sha)
        item.candidate_sha = requestedHead.toLowerCase();
  validateAcceptanceEvidence(ledger.acceptance_manifest, evidence, {
    candidateSha: requestedHead,
  });
  const effectiveInputs = options.observedTree
    ? stableHash({
        declared_scope: options.inputFingerprint,
        git_tree: options.observedTree,
      })
    : options.inputFingerprint;
  const proofKey = validationProofKey(
    options.command,
    options.toolchainFingerprint,
    options.inputFingerprint,
    paths,
  );
  const identity = stableHash({
    proof_key: proofKey,
    effective_inputs: effectiveInputs,
    acceptance_evidence: evidence,
  });
  const passed = [...receipts].reverse().find(
    (receipt) =>
      receipt.kind === "validation" &&
      receipt.exit_code === 0 &&
      (receipt.proof_key === proofKey ||
        legacyValidationReceiptMatches(receipt, {
          command: options.command,
          toolchainFingerprint: options.toolchainFingerprint,
          inputFingerprint: options.inputFingerprint,
          inputPaths: paths,
          effectiveInputs,
          evidence,
        })) &&
      canonicalJson(receipt.acceptance_evidence ?? []) ===
        canonicalJson(evidence),
  );
  if (passed) {
    const reused =
      passed.head_sha === requestedHead
        ? passed
        : receipts.find(
            (receipt) =>
              receipt.kind === "attestation" &&
              receipt.source_receipt_id === passed.receipt_id &&
              receipt.head_sha === requestedHead,
          );
    if (reused) {
      (ledger.events as unknown[]).push({
        type: "reuse",
        receipt_id: reused.receipt_id,
        at: isoNow(),
      });
      return { reused: true, receipt: reused };
    }
  }
  const failed = receipts.filter(
    (receipt) =>
      receipt.kind === "validation" &&
      (receipt.identity === identity ||
        legacyValidationReceiptMatches(receipt, {
          command: options.command,
          toolchainFingerprint: options.toolchainFingerprint,
          inputFingerprint: options.inputFingerprint,
          inputPaths: paths,
          effectiveInputs,
          evidence,
        })) &&
      receipt.exit_code !== 0,
  );
  if (failed.length >= 2)
    throw new FlowError(
      "transient retry budget is exhausted for this identity",
    );
  if (
    failed.length &&
    !TRANSIENT_VALIDATION_EXIT_CODES.has(Number(failed.at(-1)?.exit_code))
  )
    throw new FlowError("validation failure is not classified as transient");
  if (
    failed.length &&
    (!options.retryStateFingerprint ||
      options.retryStateFingerprint === failed.at(-1)?.retry_state_fingerprint)
  )
    throw new FlowError(
      "transient retry requires an observable state change fingerprint",
    );
  const budget = Number(ledger.command_budget_seconds ?? 1800);
  const duration = options.durationSeconds ?? 0;
  if (duration > budget && !options.knownLong && !options.timedOut)
    throw new FlowError(`command exceeded the ${budget}-second hard budget`);
  if (options.preflightOnly)
    return {
      reused: false,
      ready: true,
      identity,
      proof_key: proofKey,
      attempt: failed.length + 1,
    };
  const receipt = {
    receipt_id: stableHash([ledger.run_id, identity, receipts.length]),
    identity,
    proof_key: proofKey,
    kind: "validation",
    head_sha: requestedHead,
    command: options.command,
    toolchain_fingerprint: options.toolchainFingerprint,
    declared_input_fingerprint: options.inputFingerprint,
    declared_input_paths: paths,
    input_fingerprint: effectiveInputs,
    exit_code: options.exitCode,
    log_path: options.logPath,
    log_sha256: options.logSha256 ?? null,
    duration_seconds: duration,
    known_long: options.knownLong ?? false,
    timed_out: options.timedOut ?? false,
    post_execution_clean: options.postExecutionClean ?? true,
    retry_state_fingerprint: options.retryStateFingerprint ?? null,
    acceptance_evidence: evidence,
    recorded_at: isoNow(),
  };
  receipts.push(receipt);
  ledger.receipts = receipts;
  const review = isRecord(ledger.review) ? ledger.review : {};
  const reviewStarted = Boolean(
    review.pr_ref ||
    review.active_wave_id ||
    review.active_epoch_id ||
    (Array.isArray(review.epochs) && review.epochs.length > 0),
  );
  const candidateHeadAdvanced = Boolean(
    options.executionVerified &&
    options.exitCode === 0 &&
    options.postExecutionClean !== false &&
    currentHead === requestedHead &&
    !reviewStarted &&
    ledger.head_sha !== requestedHead,
  );
  if (candidateHeadAdvanced) {
    const previousHead = ledger.head_sha;
    ledger.head_sha = requestedHead;
    (ledger.events as unknown[]).push({
      type: "candidate_head_advanced",
      from_head_sha: previousHead,
      to_head_sha: requestedHead,
      receipt_id: receipt.receipt_id,
      at: isoNow(),
    });
  }
  return {
    reused: false,
    retry: failed.length > 0,
    candidate_head_advanced: candidateHeadAdvanced,
    receipt,
  };
}

function legacyValidationReceiptMatches(
  receipt: Record<string, unknown>,
  expected: {
    command: string;
    toolchainFingerprint: string;
    inputFingerprint: string;
    inputPaths: string[];
    effectiveInputs: string;
    evidence: unknown;
  },
): boolean {
  if (
    receipt.kind !== "validation" ||
    receipt.command !== expected.command ||
    receipt.toolchain_fingerprint !== expected.toolchainFingerprint ||
    receipt.declared_input_fingerprint !== expected.inputFingerprint ||
    receipt.input_fingerprint !== expected.effectiveInputs ||
    canonicalJson(receipt.acceptance_evidence ?? []) !==
      canonicalJson(expected.evidence) ||
    !Array.isArray(receipt.declared_input_paths)
  )
    return false;
  try {
    return (
      canonicalJson(
        normalizeInputPaths(receipt.declared_input_paths as string[]),
      ) === canonicalJson(expected.inputPaths)
    );
  } catch {
    return false;
  }
}

export function validationIdentity(receipt: Record<string, unknown>): string {
  if (typeof receipt.identity !== "string")
    throw new FlowError("validation receipt identity is missing");
  return receipt.identity;
}
