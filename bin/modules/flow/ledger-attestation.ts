import {
  FlowError,
  isRecord,
  isoNow,
  normalizeSha,
  stableHash,
} from "./common";
import { gitCommit, requireCleanCurrentHead } from "./git";
import type { FlowLedger } from "./ledger";

export function recordAttestation(
  ledger: FlowLedger,
  sourceReceiptId: string,
  headSha: string,
  baseRef: string,
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError("attestation requires a repository-bound ledger");
  if (!sourceReceiptId.trim() || !headSha.trim() || !baseRef.trim())
    throw new FlowError(
      "attestation requires source receipt, head SHA, and base ref",
    );
  return ledger.withLifecycleLock(() =>
    ledger.activeUpdate((current) => {
      const review = isRecord(current.review) ? current.review : {};
      if (Array.isArray(review.epochs) && review.epochs.length)
        throw new FlowError(
          "current-head attestation cannot advance a wave-bound review ledger",
        );
      const receipts = Array.isArray(current.receipts)
        ? (current.receipts as Record<string, unknown>[])
        : [];
      const source = receipts.find(
        (receipt) => receipt.receipt_id === sourceReceiptId,
      );
      if (!source || source.exit_code !== 0 || !isAttestableKind(source.kind))
        throw new FlowError("source receipt is missing or did not pass");
      if (
        source.kind === "review" &&
        (source.evidence_valid !== true || source.review_clear !== true)
      )
        throw new FlowError("source review receipt is missing clear evidence");
      const origin =
        source.kind === "attestation"
          ? receipts.find(
              (receipt) =>
                receipt.receipt_id ===
                (source.origin_receipt_id ?? source.source_receipt_id),
            )
          : source;
      if (!origin || !isAttestableKind(origin.kind))
        throw new FlowError("attestation origin receipt is missing or invalid");
      if (
        origin.kind === "review" &&
        (origin.evidence_valid !== true || origin.review_clear !== true)
      )
        throw new FlowError("attestation origin review receipt is not clear");
      const currentBase = gitCommit(ledger.repo!, baseRef);
      if (currentBase !== current.base_sha)
        throw new FlowError("attestation base differs from the ledger base");
      const [targetHead] = requireCleanCurrentHead(ledger.repo!, headSha);
      const delta = ledger.classifyGitDelta(
        String(origin.head_sha),
        targetHead,
        true,
      );
      const classification = delta.classification as Record<string, unknown>;
      if (classification.reusable !== true)
        throw new FlowError(
          `delta is not eligible for current-head attestation: ${String(
            (classification.reasons as unknown[] | undefined)?.join(", "),
          )}`,
        );
      const paths = Array.isArray(delta.paths) ? (delta.paths as string[]) : [];
      if (origin.kind === "validation") {
        const declared = Array.isArray(origin.declared_input_paths)
          ? (origin.declared_input_paths as string[])
          : [];
        if (!declared.length)
          throw new FlowError(
            "validation attestation requires declared input paths",
          );
        const affected = paths.filter((path) =>
          declared.some((pattern) => globMatch(path, pattern)),
        );
        if (affected.length)
          throw new FlowError(
            `delta changes declared validation inputs: ${affected.join(", ")}`,
          );
      }
      const originReceiptId = String(origin.receipt_id ?? sourceReceiptId);
      const receiptId = stableHash([originReceiptId, targetHead, paths]);
      const existing = receipts.find(
        (receipt) => receipt.receipt_id === receiptId,
      );
      if (existing) return { reused: true, receipt: existing };
      const receipt: Record<string, unknown> = {
        receipt_id: receiptId,
        kind: "attestation",
        head_sha: normalizeSha(targetHead, "attestation head_sha"),
        source_receipt_id: originReceiptId,
        origin_receipt_id: originReceiptId,
        previous_receipt_id: sourceReceiptId,
        paths,
        classification,
        exit_code: 0,
        recorded_at: isoNow(),
      };
      if (origin.kind === "review")
        Object.assign(receipt, {
          source_kind: "review",
          source_proof_key: origin.proof_key ?? null,
          review_profile: origin.review_profile ?? null,
          base_sha: origin.base_sha ?? null,
          review_clear: origin.review_clear === true,
          finding_fingerprints: origin.finding_fingerprints ?? [],
        });
      receipts.push(receipt);
      current.receipts = receipts;
      current.head_sha = targetHead;
      current.events = [
        ...(Array.isArray(current.events) ? current.events : []),
        {
          type: "attestation_recorded",
          receipt_id: receiptId,
          source_receipt_id: originReceiptId,
          head_sha: targetHead,
          at: isoNow(),
        },
      ];
      return { reused: false, receipt };
    }),
  );
}

function isAttestableKind(
  value: unknown,
): value is "validation" | "review" | "attestation" {
  return (
    value === "validation" || value === "review" || value === "attestation"
  );
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${expression}$`).test(value);
}
