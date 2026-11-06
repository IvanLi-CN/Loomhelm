import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FlowError, deepClone, isoNow, isRecord, stableHash } from "./common";
import { normalizeAcceptanceManifest } from "./acceptance";
import { requireCleanCurrentHead } from "./git";
import { normalizeLedger, initialLedger } from "./state";
import { recordLegacyConvergence } from "./ledger-convergence";
import { bindingForLedger, readLivePullRequest } from "../hosting/pull-request";
import type { FlowLedger } from "./ledger";

export function initFlow(
  ledger: FlowLedger,
  runId: string | undefined,
  flowType: string,
  baseSha: string,
  headSha: string,
  prRef?: string,
  manifestFile?: string,
): Record<string, unknown> {
  const manifest = manifestFile ? loadManifest(ledger, manifestFile) : null;
  const normalizedPrRef = prRef?.trim() || undefined;
  if (
    normalizedPrRef &&
    !/^(?:PR#\d+|[^\s/]+\/[^\s#]+#\d+|https?:\/\/[^\s]+\/pulls?\/\d+)$/.test(
      normalizedPrRef,
    )
  )
    throw new FlowError("flow initialization PR ref is invalid");
  return ledger.withLifecycleLock(
    () =>
      ledger.withLock(() => {
        if (existsSync(ledger.activePath)) {
          const raw = ledger.readRaw();
          const current = normalizeLedger(deepClone(raw));
          if (current.state === "active") {
            const currentPr = (current.review as Record<string, unknown>)
              .pr_ref;
            if (
              current.flow_type !== flowType ||
              current.base_sha !== baseSha ||
              current.head_sha !== headSha ||
              (runId && current.run_id !== runId) ||
              (normalizedPrRef && currentPr !== normalizedPrRef) ||
              (manifest &&
                stableHash(current.acceptance_manifest) !==
                  stableHash(manifest))
            )
              throw new FlowError("active flow receipt identity mismatch");
            return current;
          }
          const rawBytes = readFileSync(ledger.activePath);
          ledger.archiveRaw(
            typeof raw.run_id === "string" ? raw.run_id : "",
            rawBytes,
          );
        }
        const candidateRunId = runId ?? randomUUID();
        if (existsSync(ledger.archivePath(candidateRunId)))
          throw new FlowError(`run_id is already archived: ${candidateRunId}`);
        const candidate = initialLedger(
          candidateRunId,
          flowType,
          baseSha,
          headSha,
          manifest,
          normalizedPrRef,
        );
        ledger.write(candidate);
        return candidate;
      }),
    0,
  );
}

export function registerAcceptanceManifest(
  ledger: FlowLedger,
  file: string,
): Record<string, unknown> {
  const manifest = loadManifest(ledger, file);
  return ledger.activeUpdate((current) => {
    if (current.acceptance_manifest) {
      if (stableHash(current.acceptance_manifest) !== stableHash(manifest))
        throw new FlowError("acceptance manifest is immutable once registered");
      return {
        reused: true,
        acceptance_manifest: current.acceptance_manifest,
      };
    }
    current.acceptance_manifest = manifest;
    return { reused: false, acceptance_manifest: manifest };
  });
}

export function bindPr(
  ledger: FlowLedger,
  prRef: string,
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError("PR binding requires a repository-bound ledger");
  const normalized = prRef.trim();
  if (
    !/^(?:PR#\d+|[^\s/]+\/[^\s#]+#\d+|https?:\/\/[^\s]+\/pulls?\/\d+)$/.test(
      normalized,
    )
  )
    throw new FlowError("PR binding ref is invalid");
  const [head] = requireCleanCurrentHead(ledger.repo);
  const live = readLivePullRequest(ledger.repo, normalized);
  if (live.facts.state !== "OPEN" || live.facts.head_sha !== head)
    throw new FlowError("bind-pr requires live PR base and head facts");
  return ledger.activeUpdate((current) => {
    const [lockedHead] = requireCleanCurrentHead(ledger.repo!);
    const lockedLive = readLivePullRequest(ledger.repo!, normalized);
    if (
      lockedHead !== head ||
      lockedLive.facts.state !== "OPEN" ||
      lockedLive.facts.head_sha !== head ||
      lockedLive.facts.base_sha !== live.facts.base_sha
    )
      throw new FlowError("PR binding facts changed; refresh and retry");
    const review = current.review as Record<string, unknown>;
    if (review.pr_ref && review.pr_ref !== normalized)
      throw new FlowError("PR binding ref does not match the active PR");
    review.pr_ref = normalized;
    review.pr_head_sha = live.facts.head_sha;
    review.pr_base_sha = live.facts.base_sha;
    review.pr_bound_at ??= isoNow();
    current.repository_binding = bindingForLedger(live.binding);
    current.provider_facts = { pr: live.facts };
    if (current.base_sha !== live.facts.base_sha || current.head_sha !== head) {
      const previousBase = current.base_sha;
      const previousHead = current.head_sha;
      current.base_sha = live.facts.base_sha;
      current.head_sha = head;
      current.events = [
        ...(Array.isArray(current.events) ? current.events : []),
        {
          type: "pr_binding_inputs_advanced",
          from_base_sha: previousBase,
          to_base_sha: live.facts.base_sha,
          from_head_sha: previousHead,
          to_head_sha: head,
          pr_ref: normalized,
          at: isoNow(),
        },
      ];
    }
    current.events = [
      ...(current.events as unknown[]),
      {
        type: "pr_bound",
        pr_ref: normalized,
        base_sha: current.base_sha,
        head_sha: head,
        at: isoNow(),
      },
    ];
    return { pr_ref: normalized, facts: current.provider_facts };
  });
}

export function recordConvergence(
  ledger: FlowLedger,
  blockers: string[],
): Record<string, unknown> {
  return ledger.withLifecycleLock(
    () =>
      ledger.withLock(() => {
        const raw = ledger.readRaw();
        const storedVersion =
          typeof raw.schema_version === "number" ? raw.schema_version : 1;
        const current = normalizeLedger(deepClone(raw));
        if (current.state !== "active")
          throw new FlowError(
            `flow receipt ledger is terminal: ${String(current.state)}`,
          );
        const review = isRecord(current.review) ? current.review : {};
        if (
          (Array.isArray(review.epochs) && review.epochs.length > 0) ||
          (storedVersion >= 7 && !current.legacy_compatibility)
        )
          throw new FlowError(
            "review convergence is wave-bound; use review-wave finalize instead",
          );
        const result = recordLegacyConvergence(current, blockers);
        current.updated_at = isoNow();
        ledger.write(current);
        return result;
      }),
    0,
  );
}

function loadManifest(
  ledger: FlowLedger,
  file: string,
): Record<string, unknown> {
  const path = resolve(ledger.repo ?? process.cwd(), file);
  if (!existsSync(path))
    throw new FlowError("acceptance manifest file does not exist");
  return normalizeAcceptanceManifest(
    JSON.parse(readFileSync(path, "utf8")),
  ) as unknown as Record<string, unknown>;
}
