import { existsSync } from "node:fs";
import { join } from "node:path";
import { ContractError, requireCondition } from "../lib/errors";
import {
  readRegularNoFollow,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
  type DirectoryIdentity,
} from "../../bin/modules/visual/secure_io";
import { validateLedger, type Ledger } from "../lib/schema";
import { requireLedgerCompatibility } from "../lib/service-contract";
import { versionEnvelope } from "../lib/contract";

export type LedgerMigrationRequest = {
  run_id: string;
  actor: { role: string; thread_id: string };
  request_id: string;
  expected_revision: number;
  canonical_input: string;
};

export type LockedLedgerMigrationContext = {
  rootPath: string;
  runPath: string;
  ledgerPath: string;
  runIdentity: DirectoryIdentity;
  onStage: ((stage: string) => void) | undefined;
};

const migrationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const unknownLifecycle = {
  workspace_ready: "unknown" as const,
  pr_created: "unknown" as const,
  pr_merged: "unknown" as const,
  closed: "unknown" as const,
};

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function migrationCanonicalInput(
  runId: string,
  actor: { role: string; thread_id: string },
): string {
  return stable({
    run_id: runId,
    actor,
    command: "migrate",
    payload: {},
  });
}

export function migrateLocked(
  context: LockedLedgerMigrationContext,
  request: LedgerMigrationRequest,
): unknown {
  requireCondition(
    migrationIdPattern.test(request.request_id),
    "INVALID_ID",
    "Invalid identifier",
  );
  const oldContent = readRegularNoFollow(
    context.ledgerPath,
    context.rootPath,
    undefined,
    Number.MAX_SAFE_INTEGER,
    context.runIdentity,
  ).toString("utf8");
  let raw: any;
  try {
    raw = JSON.parse(oldContent);
  } catch {
    throw new ContractError(
      "LEDGER_UNREADABLE",
      "Ledger is unreadable; explicit recovery is required",
      5,
    );
  }
  requireCondition(
    raw?.orchestration_id === request.run_id,
    "RUN_MISMATCH",
    "Request refers to another run",
    3,
  );
  requireCondition(
    request.actor.role === "main" &&
      raw?.control?.ownership === "bound" &&
      raw?.control?.owner_thread_id === request.actor.thread_id,
    "FORBIDDEN",
    "Only the bound main conversation can migrate an orchestration",
    3,
  );
  // Schema-1 ledgers predate the contract discriminator. Treat them as the
  // legacy read-only shape even when a hand-written fixture retained a newer
  // discriminator field; the explicit migration is the boundary that
  // normalizes them into contract-2.
  if (raw?.schema_version !== 1) requireLedgerCompatibility(raw, "read");

  const retiredReviews = Array.isArray(raw?.facts)
    ? raw.facts.filter((item: any) => item?.kind === "child_review").length
    : 0;
  const migrationRaw = retireChildReviews(raw);
  migrationRaw.__retired_child_reviews = retiredReviews;
  const validatedMigrationRaw = structuredClone(migrationRaw);
  delete validatedMigrationRaw.__retired_child_reviews;
  let current: Ledger;
  try {
    current = validateLedger(validatedMigrationRaw);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(
      "LEDGER_UNREADABLE",
      "Ledger is invalid; explicit recovery is required",
      5,
    );
  }
  const prior = current.requests.find(
    (item) => item.request_id === request.request_id,
  );
  if (prior) {
    requireCondition(
      prior.command === "migrate" &&
        prior.canonical_input === request.canonical_input,
      "ID_CONFLICT",
      "Request ID has different content",
      3,
    );
    return {
      ok: true,
      code: "REPLAYED",
      revision: current.revision,
      result: prior.result,
    };
  }
  requireCondition(
    raw?.schema_version === 1 ||
      (raw?.schema_version === 2 &&
        (raw?.contract_version === 1 || retiredReviews > 0)),
    "UNSUPPORTED_SCHEMA",
    "Only legacy and contract-1 ledgers can be explicitly migrated",
    4,
  );
  requireCondition(
    raw.schema_version === 1 || raw.contract_version === 1,
    "MIGRATION_NOT_NEEDED",
    "Ledger is already on the current contract; no migration is needed",
    4,
  );
  requireCondition(
    current.revision === request.expected_revision,
    "REVISION_CONFLICT",
    "Ledger version changed",
    3,
  );

  const candidate = contractMigrationCandidate(migrationRaw);
  candidate.revision += 1;
  candidate.updated_at = new Date().toISOString();
  const backup = `ledger.migration-v1-${request.request_id}.json`;
  const result = {
    run_id: request.run_id,
    source_schema_version: 1,
    schema_version: 2,
    contract_version: 2,
    revision: candidate.revision,
    backup,
    retired_child_review_count: retiredReviews,
  };
  candidate.requests.push({
    request_id: request.request_id,
    command: "migrate",
    canonical_input: request.canonical_input,
    result,
    committed_revision: candidate.revision,
  });
  validateLedger(candidate);
  commitMigration(context, oldContent, candidate, backup);
  return { ok: true, code: "APPLIED", revision: candidate.revision, result };
}

export function contractMigrationCandidate(raw: any): Ledger {
  const retiredReviews = Number(raw?.__retired_child_reviews ?? 0);
  requireCondition(
    raw?.schema_version === 1 ||
      (raw?.schema_version === 2 &&
        (raw?.contract_version === 1 || retiredReviews > 0)),
    "MIGRATION_NOT_NEEDED",
    "Only legacy and contract-1 ledgers can migrate",
    4,
  );
  if (raw.schema_version !== 1) requireLedgerCompatibility(raw, "read");
  const candidateInput = structuredClone(raw);
  delete candidateInput.__retired_child_reviews;
  const current = validateLedger(candidateInput);
  const candidate = structuredClone(current);
  candidate.schema_version = 2;
  candidate.source_schema_version =
    raw.schema_version === 1 ? 1 : current.source_schema_version;
  candidate.contract_version = 2;
  candidate.version = versionEnvelope;
  // Lifecycle stages absent from v1 remain unknown. Migration does not turn
  // runtime state, PRs, or facts into new lifecycle evidence.
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  candidate.groups = candidate.groups.map((group, index) =>
    rawGroups[index]?.lifecycle
      ? group
      : { ...group, lifecycle: structuredClone(unknownLifecycle) },
  );
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  candidate.tasks = candidate.tasks.map((task, index) =>
    rawTasks[index]?.lifecycle
      ? task
      : { ...task, lifecycle: structuredClone(unknownLifecycle) },
  );
  return validateLedger(candidate);
}

function retireChildReviews(raw: any): any {
  const copy = structuredClone(raw);
  if (Array.isArray(copy.facts))
    copy.facts = copy.facts.filter((item: any) => item?.kind !== "child_review");
  return copy;
}

export function commitMigration(
  context: LockedLedgerMigrationContext,
  oldContent: string,
  candidate: Ledger,
  backup: string,
): void {
  validateLedger(candidate);
  const nextContent = JSON.stringify(candidate, null, 2) + "\n";
  const backupPath = join(context.runPath, backup);
  if (existsSync(backupPath)) {
    const existingBackup = readRegularNoFollow(
      backupPath,
      context.rootPath,
      undefined,
      Number.MAX_SAFE_INTEGER,
      context.runIdentity,
    ).toString("utf8");
    requireCondition(
      existingBackup === oldContent,
      "MIGRATION_CONFLICT",
      "Migration backup already contains different content",
      3,
    );
  } else {
    writeExclusiveNoFollow(
      backupPath,
      oldContent,
      context.rootPath,
      context.runIdentity,
    );
  }
  syncDirectoryNoFollow(context.runPath, context.rootPath, context.runIdentity);
  context.onStage?.("migration_backup_committed");
  writeAtomicNoFollow(
    context.ledgerPath,
    nextContent,
    context.rootPath,
    () => context.onStage?.("migration_candidate_synced"),
    context.runIdentity,
  );
  syncDirectoryNoFollow(context.runPath, context.rootPath, context.runIdentity);
  context.onStage?.("migration_committed");
}
