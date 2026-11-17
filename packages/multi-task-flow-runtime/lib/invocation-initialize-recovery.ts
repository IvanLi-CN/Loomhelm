import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import {
  digest,
  directory,
  finishedSchema,
  hash,
  readEvent,
  resourceSchema,
  startSchema,
  terminalSchema,
  uuid,
} from "./invocation-events";
import { callerIdentity, runIdentity, sameRunIdentity } from "./orchestration-identity";
import type { LedgerStore } from "./store";

export const initializeScope = "codex-initialize-connection-v1";
export const initializeParams = {
  clientInfo: { name: "multi-task-flow", version: "1" },
  capabilities: {},
};
export const initializeRule = "closed-initialize-v1";
/** Audited package identity, not a run or invocation exception. See the recovery audit. */
export const auditedInitializeSource = {
  package_name: "@loomhelm/multi-task-flow" as const,
  package_version: "0.5.0",
  build_id: "5519468bd9c8b25bcc1c01b659e76e8148757433ba134d2941067511d059dbce",
  source_sha: "699039788de4abfcb5eca1a89e873ee153a007e6",
  compatibility_line: "compat-v1",
  ledger_contract: 5,
  api_contract: 1,
  frontend_contract: 1,
  viewer_contract: 5,
};
const reference = z
  .object({
    id: z.literal(1),
    method: z.literal("initialize"),
    params_digest: z.literal(digest(initializeParams)),
    thread_id: z.null(),
    attempt_id: z.null(),
    transport_id: uuid.optional(),
    effect_scope: z.literal(initializeScope).optional(),
    operation: z
      .object({
        id: z.string().min(1),
        source: z.enum(["archive", "unarchive"]),
        task_id: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
const recoveryReceipt = z
  .object({
    schema_version: z.literal(1),
    invocation_id: uuid,
    type: z.literal("initialize_recovery"),
    rule: z.literal(initializeRule),
    outcome: z.literal("unconfirmed_connection_closed"),
    proof_digest: hash,
    source: runIdentity,
    executor: runIdentity,
    at: z.string().datetime(),
  })
  .strict();

/** No provider calls or writes: derive the exact capability proof again on every read. */
export function initializeRecovery(
  store: LedgerStore,
  marker: { invocation_id: string; identity: unknown },
) {
  const id = marker.invocation_id;
  const files = existsSync(directory(store, id)) ? readdirSync(directory(store, id)).sort() : [];
  const blocked = (reason: string) => ({
    eligible: false as const,
    rule: initializeRule,
    blockers: [reason],
    evidence_refs: [] as string[],
    proof_digest: null,
    receipt_valid: false,
  });
  const source = runIdentity.safeParse(marker.identity);
  if (
    !source.success ||
    ![5, 6].includes(source.data.ledger_contract) ||
    source.data.compatibility_line !== "compat-v1"
  )
    return blocked("unsupported_source");
  const start = readEvent(store, id, "start");
  const finished = readEvent(store, id, "execution-finished");
  if (
    !startSchema.safeParse(start).success ||
    start.invocation_id !== id ||
    start.run_id !== basename(store.runPath) ||
    !sameRunIdentity(start.identity, source.data)
  )
    return blocked("invocation_start");
  if (
    !finishedSchema.safeParse(finished).success ||
    finished.invocation_id !== id ||
    finished.start_digest !== digest(start)
  )
    return blocked("execution_finished");
  const resourceFiles = files.filter((file) => /^resource-[a-f0-9-]{36}\.json$/.test(file));
  if (resourceFiles.length !== 2) return blocked("requires_one_transport_and_one_initialize");
  const resources = resourceFiles.map((file) => readEvent(store, id, file.slice(0, -5)));
  if (
    resources.some(
      (r, i) =>
        !resourceSchema.safeParse(r).success ||
        r.invocation_id !== id ||
        resourceFiles[i] !== `resource-${r.resource_id}.json`,
    )
  )
    return blocked("invalid_resource");
  const transport = resources.find((r) => r.kind === "codex-transport");
  const request = resources.find((r) => r.kind === "codex-request");
  if (
    !transport ||
    !request ||
    !z.object({ path_digest: hash }).strict().safeParse(transport.reference).success
  )
    return blocked("unsupported_resource");
  const parsed = reference.safeParse(request.reference);
  if (!parsed.success) return blocked("not_exact_initialize");
  const legacy = sameRunIdentity(source.data, auditedInitializeSource);
  if (legacy) {
    if (
      parsed.data.transport_id ||
      parsed.data.effect_scope ||
      parsed.data.operation ||
      start.command !== "unknown" ||
      start.actor !== null ||
      start.input_digest !== digest({})
    )
      return blocked("legacy_provenance_mismatch");
  } else if (
    Bun.semver.order(source.data.package_version, auditedInitializeSource.package_version) <= 0 ||
    parsed.data.transport_id !== transport.resource_id ||
    parsed.data.effect_scope !== initializeScope
  )
    return blocked("transport_scope_unproven");
  const terminalName = `resource-${transport.resource_id}-terminal`;
  const terminal = readEvent(store, id, terminalName);
  if (
    !terminalSchema.safeParse(terminal).success ||
    terminal.invocation_id !== id ||
    terminal.resource_id !== transport.resource_id ||
    terminal.intent_digest !== digest(transport) ||
    !z
      .object({ local_transport_closed: z.literal(true) })
      .strict()
      .safeParse(terminal.evidence).success
  )
    return blocked("transport_not_closed");
  if (readEvent(store, id, `resource-${request.resource_id}-terminal`))
    return blocked("initialize_already_terminal");
  const allowed = new Set([
    "start.json",
    "execution-finished.json",
    "stop-request.json",
    "initialize-recovery.json",
    "reconcile.json",
    "stopped.json",
    ...resourceFiles,
    terminalName + ".json",
  ]);
  if (files.some((file) => !allowed.has(file) && !/^\.event-[a-f0-9-]{36}$/.test(file)))
    return blocked("unexpected_journal_entry");
  const evidence = {
    start: digest(start),
    finished: digest(finished),
    transport: digest(transport),
    request: digest(request),
    terminal: digest(terminal),
  };
  const proofDigest = digest({ rule: initializeRule, source: source.data, evidence });
  const persisted = recoveryReceipt.safeParse(readEvent(store, id, "initialize-recovery"));
  if (!legacy && !persisted.success && !sameRunIdentity(source.data, callerIdentity()))
    return blocked("unreviewed_historical_source");
  const valid =
    persisted.success &&
    persisted.data.invocation_id === id &&
    persisted.data.proof_digest === proofDigest &&
    sameRunIdentity(persisted.data.source, source.data) &&
    persisted.data.executor.compatibility_line === source.data.compatibility_line &&
    persisted.data.executor.ledger_contract >= source.data.ledger_contract &&
    (sameRunIdentity(persisted.data.executor, source.data) ||
      Bun.semver.order(persisted.data.executor.package_version, source.data.package_version) > 0);
  return {
    eligible: true as const,
    rule: initializeRule,
    blockers: [],
    evidence_refs: Object.values(evidence).sort(),
    proof_digest: proofDigest,
    receipt_valid: valid,
    resource_id: request.resource_id,
    receipt_digest: valid ? digest(persisted.data) : null,
  };
}

export function initializeRecoveryReceipt(
  marker: { invocation_id: string; identity: unknown },
  proofDigest: string,
) {
  return recoveryReceipt.parse({
    schema_version: 1,
    invocation_id: marker.invocation_id,
    type: "initialize_recovery",
    rule: initializeRule,
    outcome: "unconfirmed_connection_closed",
    proof_digest: proofDigest,
    source: marker.identity,
    executor: callerIdentity(),
    at: new Date().toISOString(),
  });
}
