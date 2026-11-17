import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const unresolvedCall = z
  .object({
    kind: z.enum(["notification", "operation", "recovery", "archive", "unarchive"]),
    object_id: z.string().min(1),
    attempt_id: z.string().nullable(),
    native_request_id: z.string().nullable(),
    thread_id: z.string().nullable(),
  })
  .strict();
export const migrationAudit = z
  .object({
    schema_version: z.literal(1),
    policy: z.literal("preserve-unresolved-v1"),
    validator_version: z.literal(1),
    source_contract: z.union([z.literal(3), z.literal(4), z.literal(5)]),
    source_revision: z.number().int().nonnegative(),
    source_digest: digest,
    source_binding_digest: digest,
    source_call_digest: digest.nullable(),
    business_digest: digest,
    unresolved_digest: digest,
    unresolved: z.array(unresolvedCall),
    writer_barrier: z.enum([
      "ledger-contract-5-and-binding-schema-2",
      "ledger-contract-5-and-binding-schema-3",
    ]),
    native_quiescence: z.literal("not_asserted"),
  })
  .strict();
export type MigrationAudit = z.infer<typeof migrationAudit>;
export const migrationDigest = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

/** Hash the stored representation, without normalizing or filling historical defaults. */
export function businessDigest(raw: any): string {
  const { contract_version, runtime_identity, upgrade, revision, updated_at, ...business } = raw;
  return migrationDigest(JSON.stringify(business));
}
export function unresolvedCalls(raw: any): z.infer<typeof unresolvedCall>[] {
  const calls: z.infer<typeof unresolvedCall>[] = [];
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  for (const notice of raw.notifications ?? []) {
    if ((notice.delivery_status ?? notice.status) !== "unknown") continue;
    calls.push({
      kind: "notification",
      object_id: notice.id,
      attempt_id: text(notice.last_attempt_id),
      native_request_id: null,
      thread_id: text(notice.recipient_thread_id),
    });
  }
  for (const op of raw.operations ?? []) {
    if (!["claimed", "unknown"].includes(op.status)) continue;
    calls.push({
      kind: "operation",
      object_id: op.id,
      attempt_id: null,
      native_request_id: text(op.request?.native_request_id),
      thread_id: text(op.request?.observed_thread_id),
    });
    const recovery = op.request?.initialization_recovery;
    if (recovery)
      calls.push({
        kind: "recovery",
        object_id: op.id,
        attempt_id: text(recovery.attempt_id),
        native_request_id: text(recovery.native_request_id),
        thread_id: text(recovery.thread_id),
      });
  }
  for (const resource of raw.resources ?? []) {
    if (!["archive_unknown", "unarchive_unknown"].includes(resource.status)) continue;
    calls.push({
      kind: resource.status === "archive_unknown" ? "archive" : "unarchive",
      object_id: resource.id,
      attempt_id: text(resource.operation_id),
      native_request_id: null,
      thread_id: text(resource.target),
    });
  }
  return calls.sort((a, b) => {
    const left = `${a.kind}\0${a.object_id}`,
      right = `${b.kind}\0${b.object_id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export type RetainedSource = {
  backup: string;
  ledger: string;
  binding: string;
  call: string | null;
};
/** Both read-only assessment and commit validate the same frozen audit against retained bytes. */
export function auditMatchesSource(raw: any, state: any, retained: RetainedSource): boolean {
  try {
    const audit = migrationAudit.parse(state.migration_audit);
    const backup = JSON.parse(retained.backup);
    const calls = unresolvedCalls(backup);
    const binding = JSON.parse(retained.binding);
    const matchesSource = (identity: any) =>
      identity && Object.keys(state.source).every((key) => identity[key] === state.source[key]);
    return (
      migrationDigest(retained.backup) === state.source_digest &&
      migrationDigest(retained.ledger) === state.source_digest &&
      migrationDigest(JSON.stringify(JSON.parse(retained.binding))) ===
        state.source_binding_digest &&
      matchesSource(binding) &&
      (backup.runtime_identity === undefined || matchesSource(backup.runtime_identity)) &&
      state.source.ledger_contract === backup.contract_version &&
      binding.run_id === backup.orchestration_id &&
      backup.orchestration_id === raw.orchestration_id &&
      binding.revision === state.source_binding_revision &&
      audit.source_contract === backup.contract_version &&
      audit.source_revision === state.source_revision &&
      audit.source_revision === backup.revision &&
      audit.source_digest === state.source_digest &&
      audit.source_binding_digest === state.source_binding_digest &&
      audit.business_digest === businessDigest(backup) &&
      audit.business_digest === businessDigest(raw) &&
      audit.unresolved_digest === migrationDigest(JSON.stringify(calls)) &&
      JSON.stringify(audit.unresolved) === JSON.stringify(calls) &&
      audit.source_call_digest === (retained.call === null ? null : migrationDigest(retained.call))
    );
  } catch {
    return false;
  }
}
