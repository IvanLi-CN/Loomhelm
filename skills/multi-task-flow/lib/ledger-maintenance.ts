import { join } from "node:path";
import { z } from "zod";
import { readRegularNoFollow } from "../../bin/modules/visual/secure_io";
import { LedgerStore, safeId } from "../lib/store";
import { ServiceState } from "../lib/service-state";
import { digest, verifyRelease } from "../lib/service-release";
import { ledgerContract, requireLedgerCompatibility } from "../lib/service-contract";
import {
  stable,
  contractMigrationCandidate,
  commitMigration,
  type LockedLedgerMigrationContext,
} from "../lib/store-migration";
import {
  executionProfile,
  taskExecutionPolicyDeclarationGaps,
  TASK_EXECUTION_POLICY_FIELDS,
  validateLedger,
} from "../lib/schema";
import { migrateProfile } from "../lib/profile-migration";
import { ContractError, requireCondition } from "../lib/errors";
import { readCodexCapabilities } from "../lib/codex-agent-api";
import {
  validateProfileCapability,
  type ProfileCapabilities,
} from "../lib/execution-profile";

const text = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = text.refine((value) => {
  try {
    safeId(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid identifier");
const operation = z.object({
  run_id: id,
  action: z.enum(["contract", "execution-profile"]),
  execution_profile: executionProfile.optional(),
});
function validAction(value: { action: string; execution_profile?: unknown }) {
  return (
    (value.action === "execution-profile") ===
    (value.execution_profile !== undefined)
  );
}
export const maintenanceCheckSchema = operation
  .strict()
  .refine(validAction, "Only execution-profile requires execution_profile");
export const maintenanceApplySchema = operation
  .extend({
    expected_owner_thread_id: text,
    expected_revision: z.number().int().nonnegative(),
    expected_ledger_sha256: sha,
    operation_digest: sha,
    request_id: id,
    maintenance_thread_id: text,
    approval_ref: text,
    reason: text,
    writers_paused: z.literal(true),
  })
  .strict()
  .refine(validAction, "Only execution-profile requires execution_profile");
type Operation = z.infer<typeof maintenanceCheckSchema>;
type Apply = z.infer<typeof maintenanceApplySchema>;
function readRaw(state: ServiceState, runId: string) {
  const content = readRegularNoFollow(
    join(state.paths.data, "runs", safeId(runId), "ledger.json"),
    state.paths.root,
  ).toString("utf8");
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ContractError("LEDGER_UNREADABLE", "Ledger is unreadable", 5);
  }
  requireCondition(
    raw.orchestration_id === runId,
    "RUN_MISMATCH",
    "Request refers to another run",
    3,
  );
  validateLedger(raw);
  return { raw, content };
}
function installedManifest(state: ServiceState) {
  try {
    return verifyRelease(
      join(state.paths.releases, state.config().current_build),
    );
  } catch {
    throw new ContractError(
      "SERVICE_NOT_COMPATIBLE",
      "Install a verified viewer readable for source and target before migration",
      3,
    );
  }
}
function prepare(
  state: ServiceState,
  op: Operation,
  raw: any,
  content: string,
) {
  const ledger = validateLedger(raw);
  requireCondition(
    ledger.control.ownership === "bound" && ledger.control.owner_thread_id,
    "FORBIDDEN",
    "Maintenance requires an existing bound owner",
    3,
  );
  const taskExecutionPolicyGaps =
    op.action === "contract" ? taskExecutionPolicyDeclarationGaps(raw) : [];
  const candidate =
    op.action === "contract"
      ? contractMigrationCandidate(raw, {
          allowHistoricalTaskExecutionPolicies: true,
        })
      : structuredClone(ledger);
  if (op.action === "execution-profile") {
    requireLedgerCompatibility(raw, "write");
    migrateProfile(candidate, op.execution_profile);
  }
  const manifest = installedManifest(state);
  const pending = ledger.operations
    .filter((item) => item.status === "claimed" || item.status === "unknown")
    .map((item) => ({ id: item.id, status: item.status }));
  const body = {
    run_id: op.run_id,
    action: op.action,
    execution_profile: op.execution_profile ?? null,
    owner_thread_id: ledger.control.owner_thread_id,
    revision: ledger.revision,
    source_contract: ledgerContract(raw),
    ledger_sha256: digest(content),
    target_contract: ledgerContract(candidate),
    target_execution_profile: candidate.config.execution_profile ?? null,
    installed_build: manifest.build_id,
    source_readable: manifest.readable.includes(ledgerContract(raw)),
    target_readable: manifest.readable.includes(ledgerContract(candidate)),
    pending_operations: pending,
    task_execution_policy_migration: taskExecutionPolicyGaps.length
      ? {
          mode: "declare-null",
          fields: TASK_EXECUTION_POLICY_FIELDS.filter((field) =>
            taskExecutionPolicyGaps.some((gap) => gap.missing_fields.includes(field)),
          ),
          tasks: taskExecutionPolicyGaps,
        }
      : null,
  };
  return {
    candidate,
    report: { ...body, operation_digest: digest(stable(body)) },
  };
}
export function maintenanceCheck(state: ServiceState, input: unknown) {
  const op = maintenanceCheckSchema.parse(input);
  const { raw, content } = readRaw(state, op.run_id);
  return prepare(state, op, raw, content).report;
}
function replay(raw: any, request: Apply, canonical: string) {
  const prior = validateLedger(raw).requests.find(
    (item) => item.request_id === request.request_id,
  );
  if (!prior) return null;
  requireCondition(
    prior.command === "ledger-maintenance-apply" &&
      prior.canonical_input === canonical,
    "ID_CONFLICT",
    "Request ID has different content",
    3,
  );
  return {
    ok: true,
    code: "REPLAYED",
    revision: raw.revision,
    result: prior.result,
  };
}
export async function maintenanceApply(
  state: ServiceState,
  input: unknown,
  getCapabilities: () => Promise<ProfileCapabilities> = readCodexCapabilities,
  storeOverride?: LedgerStore,
) {
  const request = maintenanceApplySchema.parse(input);
  const canonical = stable(request);
  // Network capability lookup stays outside synchronous storage locks. Replays do not need app-server.
  const first = readRaw(state, request.run_id);
  const prior = replay(first.raw, request, canonical);
  if (prior) return prior;
  const capabilities =
    request.action === "execution-profile" ? await getCapabilities() : null;
  const store =
    storeOverride ?? new LedgerStore(state.paths.data, request.run_id);
  requireCondition(
    store.rootPath === state.paths.data &&
      store.runPath === join(state.paths.data, "runs", request.run_id),
    "RUN_MISMATCH",
    "Store identity mismatch",
  );
  return store.maintain((context: LockedLedgerMigrationContext) => {
    const { raw, content } = readRaw(state, request.run_id);
    const repeated = replay(raw, request, canonical);
    if (repeated) return repeated;
    requireCondition(
      raw.control?.owner_thread_id === request.expected_owner_thread_id &&
        raw.control?.ownership === "bound",
      "OWNER_CONFLICT",
      "Bound owner changed",
      3,
    );
    requireCondition(
      raw.revision === request.expected_revision,
      "REVISION_CONFLICT",
      "Ledger version changed",
      3,
    );
    requireCondition(
      digest(content) === request.expected_ledger_sha256,
      "LEDGER_CONFLICT",
      "Ledger content changed",
      3,
    );
    const { candidate, report } = prepare(state, request, raw, content);
    requireCondition(
      report.operation_digest === request.operation_digest,
      "STALE_MAINTENANCE_CHECK",
      "Maintenance operation or installed build changed",
      3,
    );
    if (report.pending_operations.length)
      throw new ContractError(
        "OPERATIONS_PENDING",
        "Reconcile unresolved operations before maintenance",
        3,
        report,
      );
    if (!report.source_readable || !report.target_readable)
      throw new ContractError(
        "SERVICE_NOT_COMPATIBLE",
        "Install a viewer readable for source and target before migration",
        3,
        report,
      );
    if (capabilities)
      validateProfileCapability(request.execution_profile!, capabilities);
    candidate.revision += 1;
    candidate.updated_at = new Date().toISOString();
    const backup = `ledger.maintenance-${request.request_id}.json`;
    const result = {
      ...report,
      revision: candidate.revision,
      backup,
      maintenance_thread_id: request.maintenance_thread_id,
      approval_ref: request.approval_ref,
      reason: request.reason,
      writers_paused: true,
    };
    candidate.requests.push({
      request_id: request.request_id,
      command: "ledger-maintenance-apply",
      canonical_input: canonical,
      result,
      committed_revision: candidate.revision,
    });
    commitMigration(context, content, candidate, backup);
    return { ok: true, code: "APPLIED", revision: candidate.revision, result };
  });
}
