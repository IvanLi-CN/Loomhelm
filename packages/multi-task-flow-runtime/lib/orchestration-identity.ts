import { join } from "node:path";
import { readRegularNoFollow } from "@loomhelm/runtime-core/modules/visual/secure_io";
import { z } from "zod";
import { ContractError } from "./errors";
import { migrationAudit } from "./migration-audit";

export const runIdentity = z
  .object({
    package_name: z.literal("@loomhelm/multi-task-flow"),
    package_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    build_id: z.string().regex(/^[a-f0-9]{64}$/),
    source_sha: z.string().regex(/^[a-f0-9]{40}$/),
    compatibility_line: z.string().regex(/^compat-v\d+$/),
    ledger_contract: z.number().int().positive(),
    api_contract: z.number().int().positive(),
    frontend_contract: z.number().int().positive(),
    viewer_contract: z.number().int().positive(),
  })
  .strict();
export type RunIdentity = z.infer<typeof runIdentity>;
export function sameRunIdentity(left: unknown, right: unknown): boolean {
  const a = runIdentity.safeParse(left);
  const b = runIdentity.safeParse(right);
  return (
    a.success &&
    b.success &&
    Object.keys(a.data).every(
      (key) => a.data[key as keyof RunIdentity] === b.data[key as keyof RunIdentity],
    )
  );
}
export function requireRunIdentity(ledger: any, caller: RunIdentity): void {
  if (ledger.upgrade?.phase && ledger.upgrade.phase !== "completed")
    throw new ContractError("UPGRADE_INCOMPLETE", "Resume the registered orchestration upgrade", 4);
  if (!sameRunIdentity(ledger.runtime_identity, caller))
    throw new ContractError(
      "RUN_VERSION_MISMATCH",
      "Use the bound CLI or explicit orchestration upgrade",
      4,
    );
}
export const upgradeState = z
  .object({
    operation_id: z.string().min(1),
    requested_selector: z.string().min(1),
    source: runIdentity,
    target: runIdentity,
    source_revision: z.number().int().nonnegative(),
    source_directory: z.string().regex(/^\.upgrade-[a-f0-9-]{36}$/),
    source_binding_revision: z.number().int().nonnegative(),
    source_binding_digest: z.string().regex(/^[a-f0-9]{64}$/),
    source_digest: z.string().regex(/^[a-f0-9]{64}$/),
    backup: z.string().regex(/^upgrade-[a-f0-9]{64}\.json$/),
    phase: z.enum(["prepared", "migrated", "binding_switched", "completed"]),
    migration_audit: migrationAudit.optional(),
  })
  .strict();

/** Extract only identity fields from a sidecar that also carries its own revision. */
export function identityOf(value: Record<string, unknown>): unknown {
  return Object.fromEntries(Object.keys(runIdentity.shape).map((key) => [key, value[key]]));
}
export function callerIdentity(): RunIdentity {
  const serialized = process.env.LOOMHELM_CALLER_IDENTITY;
  if (!serialized)
    throw new ContractError("CALLER_IDENTITY_UNAVAILABLE", "Use a verified packaged CLI", 4);
  return runIdentity.parse(JSON.parse(serialized));
}

export function requireRunBinding(
  root: string,
  runId: string,
  ledger: any,
  caller: RunIdentity,
): void {
  requireRunIdentity(ledger, caller);
  let binding: any;
  try {
    binding = JSON.parse(
      readRegularNoFollow(
        join(root, "runs", runId, "runtime", "viewer-binding.json"),
        root,
      ).toString("utf8"),
    );
  } catch {
    throw new ContractError(
      "RUN_VERSION_MISMATCH",
      "Run binding is missing; use orchestration compatibility-check",
      4,
    );
  }
  if (
    binding.schema_version !== 2 ||
    binding.run_id !== runId ||
    !sameRunIdentity(identityOf(binding), caller)
  )
    throw new ContractError(
      "RUN_VERSION_MISMATCH",
      "Use the bound CLI or orchestration upgrade --run-id " + runId,
      4,
    );
}
