import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FlowError,
  isRecord,
  isoNow,
  normalizeSha,
  stableHash,
} from "./common";
import {
  normalizeAcceptanceEvidence,
  normalizeDeploymentIdentity,
  validateAcceptanceEvidence,
} from "./acceptance";
import {
  normalizePostMergeEvidence,
  validatePostMergeReleasePolicy,
} from "./state";
import { bindingForLedger, readLivePullRequest } from "../hosting/pull-request";
import type { FlowLedger } from "./ledger";

export function recordPostMerge(
  ledger: FlowLedger,
  evidence: unknown,
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError(
      "post-merge receipt requires a repository-bound ledger",
    );
  const normalized =
    typeof evidence === "string"
      ? normalizePostMergeEvidence(
          JSON.parse(readFileSync(resolve(ledger.repo, evidence), "utf8")),
        )
      : normalizePostMergeEvidence(evidence);
  const current = ledger.read();
  const currentReview = isRecord(current.review) ? current.review : {};
  if (currentReview.pr_ref !== normalized.pr_ref)
    throw new FlowError("post-merge receipt PR does not match the bound PR");
  const live = readLivePullRequest(ledger.repo, String(normalized.pr_ref));
  if (
    live.facts.state !== "MERGED" ||
    live.facts.base_sha !== normalized.base_sha ||
    live.facts.head_sha !== normalized.head_sha ||
    live.facts.merge_sha !== normalized.merge_sha ||
    live.facts.merged_at !== normalized.merged_at
  )
    throw new FlowError(
      "post-merge head/base/merge facts changed; refresh and retry",
    );
  validatePostMergeReleasePolicy(
    normalized,
    live.binding,
    live.facts as unknown as Record<string, unknown>,
  );
  return ledger.activeUpdate((current) => {
    const review = current.review as Record<string, unknown>;
    if (review.pr_ref !== normalized.pr_ref)
      throw new FlowError("post-merge receipt PR does not match the bound PR");
    const existingBinding = current.repository_binding;
    const binding = bindingForLedger(live.binding);
    if (
      isRecord(existingBinding) &&
      (existingBinding.provider !== binding.provider ||
        existingBinding.host !== binding.host ||
        existingBinding.full_name !== binding.full_name)
    )
      throw new FlowError(
        "post-merge receipt repository binding does not match the ledger",
      );
    current.repository_binding = binding;
    current.provider_facts = { pr: live.facts };
    const inputsChanged =
      review.pr_base_sha !== normalized.base_sha ||
      review.pr_head_sha !== normalized.head_sha ||
      current.base_sha !== normalized.base_sha ||
      current.head_sha !== normalized.head_sha;
    if (inputsChanged) {
      const previousBase = current.base_sha;
      const previousHead = current.head_sha;
      current.base_sha = normalized.base_sha;
      current.head_sha = normalized.head_sha;
      review.pr_base_sha = normalized.base_sha;
      review.pr_head_sha = normalized.head_sha;
      current.events = [
        ...(Array.isArray(current.events) ? current.events : []),
        {
          type: "post_merge_binding_inputs_recovered",
          pr_ref: normalized.pr_ref,
          from_base_sha: previousBase,
          to_base_sha: normalized.base_sha,
          from_head_sha: previousHead,
          to_head_sha: normalized.head_sha,
          at: isoNow(),
        },
      ];
    }
    const identity = stableHash([
      "post-merge",
      normalized.pr_ref,
      normalized.base_sha,
      normalized.head_sha,
      normalized.merge_sha,
    ]);
    const receipt: Record<string, unknown> = {
      receipt_id: stableHash([
        current.run_id,
        identity,
        (current.receipts as unknown[]).length,
      ]),
      identity,
      kind: "post-merge",
      ...normalized,
      recorded_at: isoNow(),
    };
    const existing = (current.receipts as Record<string, unknown>[]).find(
      (item) => item.identity === receipt.identity,
    );
    if (existing) {
      if (
        existing.pr_ref !== receipt.pr_ref ||
        existing.base_sha !== receipt.base_sha ||
        existing.head_sha !== receipt.head_sha ||
        existing.merge_sha !== receipt.merge_sha ||
        existing.merged_at !== receipt.merged_at ||
        stableHash(existing.finality) !== stableHash(receipt.finality)
      )
        throw new FlowError(
          "post-merge receipt is immutable for this merge identity",
        );
      return { reused: true, receipt: existing };
    }
    (current.receipts as unknown[]).push(receipt);
    current.events = [
      ...(Array.isArray(current.events) ? current.events : []),
      {
        type: "post_merge_recorded",
        receipt_id: receipt.receipt_id,
        pr_ref: receipt.pr_ref,
        merge_sha: receipt.merge_sha,
        at: isoNow(),
      },
    ];
    return { reused: false, receipt };
  });
}

export function recordPhaseAcceptance(
  ledger: FlowLedger,
  evidence: unknown,
  mergeSha: string,
  deploymentIdentity?: unknown,
): Record<string, unknown> {
  const normalized = normalizeAcceptanceEvidence(evidence);
  if (
    !normalized.length ||
    normalized.some((item) => item.phase === "pre_merge")
  )
    throw new FlowError(
      "phase acceptance requires post_merge or post_deploy evidence",
    );
  const normalizedMergeSha = normalizeSha(mergeSha, "merge_sha");
  const normalizedDeployment =
    deploymentIdentity === undefined
      ? undefined
      : normalizeDeploymentIdentity(deploymentIdentity, normalizedMergeSha);
  const phases = new Set(normalized.map((item) => item.phase));
  if (phases.size !== 1)
    throw new FlowError(
      "phase acceptance evidence must use one phase per record",
    );
  if (
    normalized[0]?.phase === "post_deploy" &&
    deploymentIdentity === undefined
  )
    throw new FlowError(
      "owner-action blocker: post_deploy acceptance requires deployment authorization",
    );
  if (normalized[0]?.phase === "post_merge" && deploymentIdentity !== undefined)
    throw new FlowError(
      "post_merge acceptance cannot carry deployment identity",
    );
  return ledger.activeUpdate((current) => {
    const merge = (current.receipts as Record<string, unknown>[]).find(
      (item) =>
        item.kind === "post-merge" && item.merge_sha === normalizedMergeSha,
    );
    if (!merge)
      throw new FlowError(
        "owner-action blocker: post-merge acceptance requires a Merge Receipt",
      );
    validateAcceptanceEvidence(current.acceptance_manifest, normalized, {
      mergeSha: normalizedMergeSha,
      deploymentIdentity: normalizedDeployment,
      allowPostMerge: true,
    });
    const phase = normalized[0]?.phase ?? "";
    const identity = stableHash([
      "phase-acceptance",
      phase,
      normalizedMergeSha,
      normalizedDeployment ?? null,
      normalized,
    ]);
    const record = {
      record_id: stableHash([
        current.run_id,
        identity,
        (current.phase_acceptance_evidence as unknown[]).length,
      ]),
      identity,
      kind: "acceptance",
      phase,
      merge_sha: normalizedMergeSha,
      deployment_identity: normalizedDeployment ?? null,
      acceptance_evidence: normalized,
      recorded_at: isoNow(),
    };
    const existing = (
      current.phase_acceptance_evidence as Record<string, unknown>[]
    ).find((item) => item.identity === record.identity);
    if (existing) return { reused: true, record: existing };
    (current.phase_acceptance_evidence as unknown[]).push(record);
    current.events = [
      ...(Array.isArray(current.events) ? current.events : []),
      {
        type: "phase_acceptance_recorded",
        record_id: record.record_id,
        phase,
        merge_sha: normalizedMergeSha,
        at: isoNow(),
      },
    ];
    return { reused: false, record };
  });
}
