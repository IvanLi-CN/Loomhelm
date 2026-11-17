import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createDirectoryNoFollow,
  readRegularNoFollow,
  renameNoReplace,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import { z } from "zod";
import { requireCondition } from "./errors";
import { callerIdentity, identityOf, runIdentity, sameRunIdentity } from "./orchestration-identity";
import { validateLedger } from "./schema";
import { type LedgerStore, withExclusiveLock } from "./store";
import { viewerBindingSchema } from "./viewer-binding";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const markerSchema = z
  .object({
    invocation_id: uuid,
    identity: runIdentity,
    state: z.enum(["running", "stopped"]),
    schema_version: z.literal(2).optional(),
  })
  .strict();
const eventBase = { schema_version: z.literal(1), invocation_id: uuid };
const startSchema = z
  .object({
    ...eventBase,
    type: z.literal("start"),
    command: z.string().min(1),
    input_digest: hash,
    identity: runIdentity,
    run_id: z.string(),
    revision: z.number().int().nonnegative(),
    actor: z.unknown(),
    process: z.object({
      pid: z.number().int().positive(),
      supervision_token: z.string().nullable(),
    }),
    at: z.string().datetime(),
  })
  .strict();
const resourceSchema = z
  .object({
    ...eventBase,
    type: z.literal("resource_intent"),
    resource_id: uuid,
    kind: z.string().min(1),
    reference: z.unknown(),
    at: z.string().datetime(),
  })
  .strict();
const terminalSchema = z
  .object({
    ...eventBase,
    type: z.literal("resource_terminal"),
    resource_id: uuid,
    intent_digest: hash,
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
const finishedSchema = z
  .object({
    ...eventBase,
    type: z.literal("execution_finished"),
    start_digest: hash,
    outcome: z.enum(["succeeded", "failed"]),
    output_delivery: z.literal("unobserved"),
    at: z.string().datetime(),
  })
  .strict();

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function markerPath(store: LedgerStore): string {
  return join(store.runPath, "runtime", "call.json");
}
export function readMarker(store: LedgerStore) {
  const path = markerPath(store);
  return existsSync(path)
    ? markerSchema.parse(JSON.parse(readRegularNoFollow(path, store.rootPath).toString("utf8")))
    : null;
}
function directory(store: LedgerStore, id: string): string {
  return join(store.runPath, "runtime", "invocations", uuid.parse(id));
}
function readEvent(store: LedgerStore, id: string, name: string): any {
  const path = join(directory(store, id), name + ".json");
  return existsSync(path)
    ? JSON.parse(readRegularNoFollow(path, store.rootPath).toString("utf8"))
    : null;
}
/** Sync privately before publishing an immutable event name. No event is overwritten. */
function append(store: LedgerStore, id: string, name: string, value: object): void {
  const dir = directory(store, id);
  for (const path of [
    join(store.runPath, "runtime"),
    join(store.runPath, "runtime", "invocations"),
    dir,
  ]) {
    if (!existsSync(path)) {
      createDirectoryNoFollow(path, store.rootPath);
      syncDirectoryNoFollow(join(path, ".."), store.rootPath);
    }
  }
  const staged = join(dir, ".event-" + randomUUID());
  writeExclusiveNoFollow(
    staged,
    JSON.stringify({ schema_version: 1, invocation_id: id, ...value }),
    store.rootPath,
  );
  renameNoReplace(staged, join(dir, name + ".json"), store.rootPath);
  syncDirectoryNoFollow(dir, store.rootPath);
}

/** One verifier serves inspection, normal finalization and recovery. A projection never establishes proof. */
function stopProof(store: LedgerStore, marker: z.infer<typeof markerSchema>) {
  const missing: string[] = [];
  const id = marker.invocation_id;
  const start = readEvent(store, id, "start");
  const validStart =
    startSchema.safeParse(start).success &&
    start.invocation_id === id &&
    start.run_id === basename(store.runPath) &&
    sameRunIdentity(start.identity, marker.identity);
  if (!validStart) missing.push("invocation_start");
  const finished = readEvent(store, id, "execution-finished");
  if (
    !finishedSchema.safeParse(finished).success ||
    finished.invocation_id !== id ||
    finished.start_digest !== digest(start)
  )
    missing.push("execution_finished");
  const resources: Record<string, string> = {};
  const dir = directory(store, id);
  if (existsSync(dir))
    for (const file of readdirSync(dir).sort()) {
      if (!/^resource-[a-f0-9-]{36}\.json$/.test(file)) continue;
      const resource = readEvent(store, id, file.slice(0, -5));
      const terminal = readEvent(store, id, file.slice(0, -5) + "-terminal");
      const resourceId = file.slice(9, -5);
      if (
        !resourceSchema.safeParse(resource).success ||
        resource.invocation_id !== id ||
        resource.resource_id !== resourceId ||
        !terminalSchema.safeParse(terminal).success ||
        terminal.invocation_id !== id ||
        terminal.resource_id !== resourceId ||
        terminal.intent_digest !== digest(resource)
      )
        missing.push("resource:" + resourceId);
      else resources[resourceId] = digest(terminal);
    }
  const receipt = {
    type: "stopped",
    start_digest: digest(start),
    identity_digest: digest(marker.identity),
    execution_digest: digest(finished),
    resources,
  };
  return { missing, receipt };
}
export function inspectInvocation(store: LedgerStore) {
  const marker = readMarker(store);
  if (!marker) return null;
  if (!marker.schema_version)
    return {
      invocation_id: marker.invocation_id,
      state: marker.state,
      quiescent: false,
      missing_evidence: ["historical_invocation_provenance"],
    };
  const proof = stopProof(store, marker);
  const stopped = readEvent(store, marker.invocation_id, "stopped");
  if (
    !stopped ||
    stopped.schema_version !== 1 ||
    stopped.invocation_id !== marker.invocation_id ||
    digest(stopped.proof ?? null) !== digest(proof.receipt)
  )
    proof.missing.push("safe_stop_receipt");
  return {
    invocation_id: marker.invocation_id,
    state: marker.state,
    quiescent: proof.missing.length === 0 && marker.state === "stopped",
    missing_evidence: proof.missing,
    marker_digest: digest(marker),
    evidence_refs: Object.values(proof.receipt.resources).sort(),
  };
}

type Invocation = {
  store: LedgerStore;
  id: string;
  controller: AbortController;
  pending: Set<string>;
  settled: Promise<void>[];
  accepting: boolean;
  journalFailed: boolean;
};
const active = new AsyncLocalStorage<Invocation>();
export function invocationSignal(): AbortSignal | undefined {
  return active.getStore()?.controller.signal;
}
export function registerInvocationResource(
  kind: string,
  reference: unknown,
): { end: (evidence: Record<string, unknown>) => void; unknown: () => void } {
  const current = active.getStore();
  if (!current) return { end: () => {}, unknown: () => {} };
  requireCondition(
    current.accepting,
    "INVOCATION_CLOSED",
    "Cannot start a resource after execution finished",
    4,
  );
  current.controller.signal.throwIfAborted();
  const id = randomUUID();
  append(current.store, current.id, "resource-" + id, {
    type: "resource_intent",
    resource_id: id,
    kind,
    reference,
    at: new Date().toISOString(),
  });
  current.pending.add(id);
  let settled!: () => void;
  current.settled.push(
    new Promise<void>((resolve) => {
      settled = resolve;
    }),
  );
  return {
    end(evidence) {
      requireCondition(
        current.pending.has(id),
        "INVOCATION_RESOURCE_CONFLICT",
        "Resource already closed",
        4,
      );
      try {
        append(current.store, current.id, "resource-" + id + "-terminal", {
          type: "resource_terminal",
          resource_id: id,
          intent_digest: digest(readEvent(current.store, current.id, "resource-" + id)),
          evidence,
        });
        current.pending.delete(id);
      } catch (error) {
        current.journalFailed = true;
        throw error;
      } finally {
        settled();
      }
    },
    unknown: settled,
  };
}
export function publishStopped(store: LedgerStore, id: string, identity: unknown): void {
  const marker = readMarker(store);
  requireCondition(
    marker?.invocation_id === id && sameRunIdentity(marker.identity, identity),
    "INVOCATION_STATE_CONFLICT",
    "Invocation projection identity changed",
    4,
  );
  const proof = stopProof(store, marker!);
  requireCondition(
    proof.missing.length === 0,
    "INVOCATION_EVIDENCE_REQUIRED",
    "Invocation resources or execution have no terminal evidence",
    4,
  );
  const existing = readEvent(store, id, "stopped");
  if (existing)
    requireCondition(
      existing.schema_version === 1 &&
        existing.invocation_id === id &&
        digest(existing.proof ?? null) === digest(proof.receipt),
      "INVOCATION_STATE_CONFLICT",
      "Stop evidence identity mismatch",
      4,
    );
  else append(store, id, "stopped", { proof: proof.receipt, at: new Date().toISOString() });
  writeAtomicNoFollow(
    markerPath(store),
    JSON.stringify({ ...marker, state: "stopped" }),
    store.rootPath,
  );
}
export async function executeInvocation<T>(
  store: LedgerStore,
  command: string,
  input: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const identity = callerIdentity();
  const id = uuid.parse(process.env.LOOMHELM_INVOCATION_ID ?? randomUUID());
  const current: Invocation = {
    store,
    id,
    controller: new AbortController(),
    pending: new Set(),
    settled: [],
    accepting: true,
    journalFailed: false,
  };
  const ledger = store.read();
  const start = {
    type: "start",
    command,
    input_digest: digest(input),
    actor: (input as any)?.actor ?? null,
    identity,
    revision: ledger.revision,
    run_id: ledger.orchestration_id,
    process: {
      pid: process.pid,
      supervision_token: process.env.CODEX_PROCESS_SUPERVISION_TOKEN ?? null,
    },
    at: new Date().toISOString(),
  };
  append(store, id, "start", start);
  writeAtomicNoFollow(
    markerPath(store),
    JSON.stringify({ schema_version: 2, invocation_id: id, identity, state: "running" }),
    store.rootPath,
  );
  const stop = () => {
    if (current.controller.signal.aborted) return;
    try {
      append(store, id, "stop-request", { type: "stop_requested", at: new Date().toISOString() });
    } catch {
      current.journalFailed = true;
    } finally {
      current.controller.abort();
    }
  };
  const message = (value: any) => {
    if (value?.type === "stop" && value.invocation_id === id) stop();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  process.on("message", message);
  process.on("disconnect", stop);
  for (const signal of signals) process.on(signal, stop);
  let outcome: "succeeded" | "failed" = "failed";
  try {
    const result = await active.run(current, action);
    outcome = "succeeded";
    return result;
  } finally {
    current.accepting = false;
    try {
      append(store, id, "execution-finished", {
        type: "execution_finished",
        start_digest: digest(readEvent(store, id, "start")),
        outcome,
        output_delivery: "unobserved",
        at: new Date().toISOString(),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(current.settled),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 200_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!current.journalFailed && current.pending.size === 0) {
        publishStopped(store, id, identity);
        if (process.env.LOOMHELM_INVOCATION_ID && process.connected)
          process.send?.({ type: "stopped", invocation_id: id });
      }
    } finally {
      process.off("message", message);
      process.off("disconnect", stop);
      for (const signal of signals) process.off(signal, stop);
      if (process.env.LOOMHELM_INVOCATION_ID && process.connected) process.disconnect?.();
    }
  }
}

/** Explicit historical boundary. Ordinary commands continue to require exact identity. Caller and source are frozen separately. */
export function recoverySource(
  store: LedgerStore,
  ledger: any,
  actor: { role: string; thread_id: string },
) {
  const executor = callerIdentity();
  const binding = viewerBindingSchema.parse(
    JSON.parse(
      readRegularNoFollow(
        join(store.runPath, "runtime", "viewer-binding.json"),
        store.rootPath,
      ).toString("utf8"),
    ),
  );
  const source = runIdentity.parse(ledger.runtime_identity ?? identityOf(binding));
  requireCondition(
    [3, 4, 5].includes(ledger.contract_version) &&
      ledger.schema_version === 2 &&
      source.ledger_contract === ledger.contract_version &&
      binding.schema_version === (ledger.contract_version === 5 ? 3 : 2) &&
      binding.run_id === ledger.orchestration_id &&
      sameRunIdentity(source, identityOf(binding)),
    "RUN_VERSION_MISMATCH",
    "Historical source and binding are inconsistent or unsupported",
    4,
  );
  requireCondition(
    !ledger.upgrade || ledger.upgrade.phase === "completed",
    "UPGRADE_INCOMPLETE",
    "Resume the frozen upgrade before invocation reconciliation",
    4,
  );
  requireCondition(
    executor.ledger_contract === 5 &&
      executor.compatibility_line === source.compatibility_line &&
      (sameRunIdentity(source, executor) ||
        Bun.semver.order(executor.package_version, source.package_version) > 0),
    "RUN_VERSION_MISMATCH",
    "Recovery requires a verified newer repair package on the same compatibility line",
    4,
  );
  requireCondition(
    ledger.control?.ownership === "bound" &&
      actor.role === "main" &&
      actor.thread_id === ledger.control.owner_thread_id,
    "ACTOR_MISMATCH",
    "Only the bound main may inspect or reconcile historical calls",
    3,
  );
  return { source, executor };
}
export function inspectRecoveryInvocation(
  store: LedgerStore,
  actor: { role: string; thread_id: string },
) {
  return store.withLock(() => {
    const ledger = validateLedger(store.readUnlocked());
    return {
      ok: true,
      code: "OK",
      revision: ledger.revision,
      ...recoverySource(store, ledger, actor),
      invocation: inspectInvocation(store),
    };
  });
}
export function reconcileInvocation(store: LedgerStore, input: unknown): unknown {
  const parsed = z
    .object({
      run_id: z.string(),
      actor: z.object({ role: z.literal("main"), thread_id: z.string() }).strict(),
      request_id: z.string().min(1).max(96),
      expected_revision: z.number().int().nonnegative(),
      payload: z
        .object({ invocation_id: uuid, marker_digest: hash, evidence_refs: z.array(hash).max(256) })
        .strict(),
    })
    .strict()
    .parse(input);
  return withExclusiveLock(join(store.runPath, "locks", "viewer-binding.lock"), () =>
    store.maintain((context) => {
      const ledger = validateLedger(
        JSON.parse(
          readRegularNoFollow(
            context.ledgerPath,
            context.rootPath,
            undefined,
            Number.MAX_SAFE_INTEGER,
            context.runIdentity,
          ).toString("utf8"),
        ),
      );
      const identities = recoverySource(store, ledger, parsed.actor);
      requireCondition(
        parsed.run_id === ledger.orchestration_id,
        "INVOCATION_STATE_CONFLICT",
        "Run identity changed",
        4,
      );
      const marker = readMarker(store);
      requireCondition(
        marker?.invocation_id === parsed.payload.invocation_id &&
          sameRunIdentity(marker.identity, identities.source),
        "INVOCATION_STATE_CONFLICT",
        "Invocation identity changed",
        4,
      );
      const prior = readEvent(store, marker!.invocation_id, "reconcile");
      if (prior) {
        requireCondition(
          prior.request_digest === digest(parsed) &&
            digest(prior.identities) === digest(identities),
          "REQUEST_CONFLICT",
          "Recovery request input or executor changed",
          4,
        );
        publishStopped(store, marker!.invocation_id, marker!.identity);
        return prior.result;
      }
      requireCondition(
        ledger.revision === parsed.expected_revision &&
          digest(marker) === parsed.payload.marker_digest,
        "REVISION_CONFLICT",
        "Ledger or invocation changed",
        4,
      );
      requireCondition(
        marker!.schema_version === 2,
        "INVOCATION_EVIDENCE_REQUIRED",
        "Historical invocation has no uniquely verifiable execution provenance",
        4,
      );
      const proof = stopProof(store, marker!);
      requireCondition(
        proof.missing.length === 0,
        "INVOCATION_EVIDENCE_REQUIRED",
        "Invocation has missing execution or native-call evidence",
        4,
      );
      const evidence = Object.values(proof.receipt.resources).sort();
      requireCondition(
        digest([...parsed.payload.evidence_refs].sort()) === digest(evidence),
        "INVOCATION_EVIDENCE_REQUIRED",
        "Evidence digests must match persisted resource receipts",
        4,
      );
      const result = {
        ok: true,
        code: "APPLIED",
        revision: ledger.revision,
        invocation_id: marker!.invocation_id,
      };
      append(store, marker!.invocation_id, "reconcile", {
        type: "reconciled",
        request_digest: digest(parsed),
        source_marker: marker,
        identities,
        evidence_refs: evidence,
        result,
      });
      publishStopped(store, marker!.invocation_id, marker!.identity);
      return result;
    }),
  );
}
