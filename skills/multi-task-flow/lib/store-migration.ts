import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ContractError, requireCondition } from "../lib/errors";
import {
  readRegularNoFollow,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
  type DirectoryIdentity,
} from "../../bin/modules/visual/secure_io";
import {
  TASK_EXECUTION_POLICY_FIELDS,
  taskExecutionPolicyDeclarationGaps,
  validateLedger,
  validateTaskExecutionPolicies,
  type Ledger,
} from "../lib/schema";
import { requireLedgerCompatibility } from "../lib/service-contract";
import { versionEnvelope } from "../lib/contract";
import { contract3MigrationCandidate } from "../lib/atomic-orchestration";

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
export type MigrationRequestIdentity = {
  request_id: string;
  command: "migrate" | "ledger-maintenance-apply";
  canonical_input: string;
  source_ledger_sha256?: string;
};

export function migrationContentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function migrationBackupName(
  command: MigrationRequestIdentity["command"],
  requestId: string,
): string {
  return command === "migrate"
    ? `ledger.migration-v1-${requestId}.json`
    : `ledger.maintenance-${requestId}.json`;
}

function readMigrationRequestIdentity(
  context: LockedLedgerMigrationContext,
  identityPath: string,
): Partial<MigrationRequestIdentity> {
  try {
    const parsed: unknown = JSON.parse(
      readRegularNoFollow(
        identityPath,
        context.rootPath,
        undefined,
        Number.MAX_SAFE_INTEGER,
        context.runIdentity,
      ).toString("utf8"),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<MigrationRequestIdentity>)
      : {};
  } catch {
    throw new ContractError(
      "MIGRATION_CONFLICT",
      "Migration backup request identity is unreadable",
      3,
    );
  }
}

function migrationIdentityContent(
  requestIdentity: MigrationRequestIdentity,
  sourceDigest: string,
): string {
  return JSON.stringify({ ...requestIdentity, source_ledger_sha256: sourceDigest }) + "\n";
}

function requireMatchingMigrationRequestIdentity(
  context: LockedLedgerMigrationContext,
  identityPath: string,
  requestIdentity: MigrationRequestIdentity,
  sourceDigest?: string,
  requireSourceDigest = false,
): void {
  requireCondition(
    existsSync(identityPath),
    "MIGRATION_CONFLICT",
    "Migration backup request identity is missing",
    3,
  );
  const existingIdentity = readMigrationRequestIdentity(context, identityPath);
  requireCondition(
    existingIdentity.request_id === requestIdentity.request_id &&
      existingIdentity.command === requestIdentity.command &&
      existingIdentity.canonical_input === requestIdentity.canonical_input,
    "MIGRATION_CONFLICT",
    "Migration backup belongs to a different request",
    3,
  );
  if (requireSourceDigest)
    requireCondition(
      typeof existingIdentity.source_ledger_sha256 === "string",
      "MIGRATION_CONFLICT",
      "Historical migration replay lacks a source digest; explicit recovery is required",
      3,
    );
  if (sourceDigest !== undefined && existingIdentity.source_ledger_sha256 !== undefined)
    requireCondition(
      existingIdentity.source_ledger_sha256 === sourceDigest,
      "MIGRATION_CONFLICT",
      "Migration backup source content changed",
      3,
    );
}

function validateMigrationBackupContent(content: string): void {
  try {
    validateLedger(JSON.parse(content));
  } catch {
    throw new ContractError(
      "MIGRATION_CONFLICT",
      "Migration backup is invalid",
      3,
    );
  }
}

export function verifyMigrationBackup(
  context: LockedLedgerMigrationContext,
  backup: unknown,
  requestIdentity: MigrationRequestIdentity,
  expectedSourceDigest?: string,
  requireSourceDigest = false,
): void {
  const expectedBackup = migrationBackupName(
    requestIdentity.command,
    requestIdentity.request_id,
  );
  requireCondition(
    backup === expectedBackup,
    "MIGRATION_CONFLICT",
    "Migration backup identity is invalid",
    3,
  );
  const backupPath = join(context.runPath, expectedBackup);
  requireCondition(
    existsSync(backupPath),
    "MIGRATION_CONFLICT",
    "Migration backup is missing",
    3,
  );
  const backupContent = readRegularNoFollow(
    backupPath,
    context.rootPath,
    undefined,
    Number.MAX_SAFE_INTEGER,
    context.runIdentity,
  ).toString("utf8");
  const actualSourceDigest = migrationContentDigest(backupContent);
  if (expectedSourceDigest !== undefined)
    requireCondition(
      actualSourceDigest === expectedSourceDigest,
      "MIGRATION_CONFLICT",
      "Migration backup source content changed",
      3,
    );
  validateMigrationBackupContent(backupContent);
  const identityPath = `${backupPath}.request.json`;
  if (existsSync(identityPath))
    requireMatchingMigrationRequestIdentity(
      context,
      identityPath,
      requestIdentity,
      actualSourceDigest,
      requireSourceDigest,
    );
  else {
    requireCondition(
      !requireSourceDigest,
      "MIGRATION_CONFLICT",
      "Historical migration replay lacks a request identity; explicit recovery is required",
      3,
    );
    writeExclusiveNoFollow(
      identityPath,
      migrationIdentityContent(requestIdentity, actualSourceDigest),
      context.rootPath,
      context.runIdentity,
    );
    syncDirectoryNoFollow(context.runPath, context.rootPath, context.runIdentity);
  }
}

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
  const historicalPolicyGaps = taskExecutionPolicyDeclarationGaps(raw);
  requireCondition(
    !(raw?.schema_version === 2 &&
      raw?.contract_version === 2 &&
      historicalPolicyGaps.length > 0),
    "HISTORICAL_LEDGER_READ_ONLY",
    "schema2/contract2 ledger with incomplete task execution policies requires explicit maintenance",
    4,
  );
  if (
    raw?.schema_version === 2 &&
    raw?.contract_version === 2 &&
    historicalPolicyGaps.length === 0
  ) {
    try {
      validateTaskExecutionPolicies(raw.tasks ?? []);
    } catch (error) {
      if (error instanceof ContractError)
        throw new ContractError(
          "HISTORICAL_LEDGER_READ_ONLY",
          "Historical task execution policies are semantically invalid; explicit recovery is required",
          4,
        );
      throw error;
    }
  }
  if (raw?.schema_version === 2 && raw?.contract_version === 2) {
    const current = validateLedger(raw);
    const prior = current.requests.find((item) => item.request_id === request.request_id);
    if (prior) {
      verifyMigrationBackup(context, (prior.result as any).backup, { request_id: request.request_id, command: "migrate", canonical_input: request.canonical_input }, (prior.result as any).source_ledger_sha256, true);
      return { ok: true, code: "REPLAYED", revision: prior.committed_revision, result: prior.result };
    }
    requireCondition(current.revision === request.expected_revision, "REVISION_CONFLICT", "Ledger version changed", 3);
    const candidate = contract3MigrationCandidate(raw);
    candidate.revision += 1;
    candidate.updated_at = new Date().toISOString();
    const backup = migrationBackupName("migrate", request.request_id);
    const result = { run_id: request.run_id, source_schema_version: 2, schema_version: 2, contract_version: 3, revision: candidate.revision, backup, source_ledger_sha256: migrationContentDigest(oldContent) };
    candidate.requests.push({ request_id: request.request_id, command: "migrate", canonical_input: request.canonical_input, result, committed_revision: candidate.revision });
    validateLedger(candidate);
    commitMigration(context, oldContent, candidate, backup, { request_id: request.request_id, command: "migrate", canonical_input: request.canonical_input });
    return { ok: true, code: "APPLIED", revision: candidate.revision, result };
  }
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
    const priorResult = prior.result as Record<string, unknown>;
    verifyMigrationBackup(
      context,
      priorResult.backup,
      {
        request_id: request.request_id,
        command: "migrate",
        canonical_input: request.canonical_input,
      },
      typeof priorResult.source_ledger_sha256 === "string"
        ? priorResult.source_ledger_sha256
        : undefined,
      true,
    );
    return {
      ok: true,
      code: "REPLAYED",
      revision: prior.committed_revision,
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
  const backup = migrationBackupName("migrate", request.request_id);
  const result = {
    run_id: request.run_id,
    source_schema_version: 1,
    schema_version: 2,
    contract_version: 2,
    revision: candidate.revision,
    backup,
    source_ledger_sha256: migrationContentDigest(oldContent),
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
  commitMigration(context, oldContent, candidate, backup, {
    request_id: request.request_id,
    command: "migrate",
    canonical_input: request.canonical_input,
  });
  return { ok: true, code: "APPLIED", revision: candidate.revision, result };
}

export function contractMigrationCandidate(
  raw: any,
  options: { allowHistoricalTaskExecutionPolicies?: boolean } = {},
): Ledger {
  const retiredReviews = Number(raw?.__retired_child_reviews ?? 0);
  const historicalPolicyGaps = taskExecutionPolicyDeclarationGaps(raw);
  const legacyContract =
    raw?.schema_version === 1 ||
    (raw?.schema_version === 2 &&
      (raw?.contract_version === 1 || retiredReviews > 0));
  const historicalPolicyMigration =
    options.allowHistoricalTaskExecutionPolicies === true &&
    raw?.schema_version === 2 &&
    raw?.contract_version === 2 &&
    historicalPolicyGaps.length > 0;
  if (
    options.allowHistoricalTaskExecutionPolicies === true &&
    raw?.schema_version === 2 &&
    raw?.contract_version === 2 &&
    historicalPolicyGaps.length === 0
  ) {
    try {
      validateTaskExecutionPolicies(raw.tasks ?? []);
    } catch (error) {
      if (error instanceof ContractError)
        throw new ContractError(
          "HISTORICAL_LEDGER_READ_ONLY",
          "Historical task execution policies are semantically invalid; explicit recovery is required",
          4,
        );
      throw error;
    }
  }
  if (historicalPolicyMigration) {
    const partialPolicy = historicalPolicyGaps.find(
      (gap) => gap.missing_fields.length !== TASK_EXECUTION_POLICY_FIELDS.length,
    );
    requireCondition(
      !partialPolicy,
      "TASK_EXECUTION_POLICY_INCOMPLETE",
      `${partialPolicy?.task_id ?? "task"}: 任务执行归属、对话策略和交付策略必须全部缺失或全部声明`,
      3,
    );
  }
  requireCondition(
    legacyContract || historicalPolicyMigration,
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
  validateTaskExecutionPolicies(candidate.tasks);
  return validateLedger(candidate);
}

export function contractV3MigrationCandidate(raw: any): Ledger {
  requireCondition(
    raw?.schema_version === 2 && raw?.contract_version === 2,
    "MIGRATION_NOT_NEEDED",
    "Only schema-2/contract-2 ledgers can migrate to contract-3",
    4,
  );
  requireLedgerCompatibility(raw, "read");
  const candidate = structuredClone(validateLedger(raw));
  candidate.contract_version = 3;
  candidate.version = versionEnvelope;
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
  requestIdentity: MigrationRequestIdentity,
): void {
  validateLedger(candidate);
  const nextContent = JSON.stringify(candidate, null, 2) + "\n";
  const backupPath = join(context.runPath, backup);
  const identityPath = `${backupPath}.request.json`;
  const sourceDigest = migrationContentDigest(oldContent);
  const identityContent = migrationIdentityContent(requestIdentity, sourceDigest);
  requireCondition(
    backup === migrationBackupName(requestIdentity.command, requestIdentity.request_id),
    "MIGRATION_CONFLICT",
    "Migration backup identity is invalid",
    3,
  );
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
    if (existsSync(identityPath))
      requireMatchingMigrationRequestIdentity(
        context,
        identityPath,
        requestIdentity,
        sourceDigest,
      );
    else {
      writeExclusiveNoFollow(
        identityPath,
        identityContent,
        context.rootPath,
        context.runIdentity,
      );
      syncDirectoryNoFollow(context.runPath, context.rootPath, context.runIdentity);
      context.onStage?.("migration_backup_identity_recovered");
    }
  } else {
    if (existsSync(identityPath))
      requireMatchingMigrationRequestIdentity(
        context,
        identityPath,
        requestIdentity,
        sourceDigest,
      );
    else {
      writeExclusiveNoFollow(
        identityPath,
        identityContent,
        context.rootPath,
        context.runIdentity,
      );
      syncDirectoryNoFollow(context.runPath, context.rootPath, context.runIdentity);
    }
    context.onStage?.("migration_backup_identity_committed");
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
