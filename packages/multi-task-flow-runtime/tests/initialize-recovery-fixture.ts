import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { append, digest, markerPath } from "../lib/invocation-events";
import {
  initializeParams,
  auditedInitializeSource as source,
} from "../lib/invocation-initialize-recovery";
import { inspectInvocation, readMarker } from "../lib/invocation-journal";
import { upgradeOrchestration } from "../lib/orchestration-upgrade";
import { fixtureRun, serviceFixture } from "./service-fixture";

export const repairIdentity = {
  ...source,
  package_version: "0.6.0",
  build_id: "b".repeat(64),
  source_sha: "b".repeat(40),
};
export function initializeFixture() {
  const { state } = serviceFixture();
  const { store } = fixtureRun(state.paths.data, "initialize-run", 3);
  mkdirSync(join(store.runPath, "runtime"));
  const original = { ...source, package_version: "0.3.0", ledger_contract: 3 };
  writeFileSync(
    join(store.runPath, "runtime", "viewer-binding.json"),
    JSON.stringify({
      schema_version: 2,
      run_id: "initialize-run",
      ...original,
      revision: 0,
      request_id: "fixture",
      updated_at: new Date().toISOString(),
    }),
  );
  upgradeOrchestration(store, source, source, {});
  process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(repairIdentity);
  return store;
}
export function interruptedInitialize(store: ReturnType<typeof initializeFixture>) {
  const id = randomUUID();
  const transport = randomUUID();
  const request = randomUUID();
  const start = {
    schema_version: 1,
    invocation_id: id,
    type: "start",
    command: "unknown",
    input_digest: digest({}),
    identity: source,
    actor: null,
    run_id: "initialize-run",
    revision: store.read().revision,
    process: { pid: 1234, supervision_token: null },
    at: new Date().toISOString(),
  };
  append(store, id, "start", start);
  const intent = {
    schema_version: 1,
    invocation_id: id,
    type: "resource_intent",
    resource_id: transport,
    kind: "codex-transport",
    reference: { path_digest: digest("fixture.sock") },
    at: new Date().toISOString(),
  };
  append(store, id, `resource-${transport}`, intent);
  append(store, id, `resource-${transport}-terminal`, {
    type: "resource_terminal",
    resource_id: transport,
    intent_digest: digest(intent),
    evidence: { local_transport_closed: true },
  });
  append(store, id, `resource-${request}`, {
    type: "resource_intent",
    resource_id: request,
    kind: "codex-request",
    reference: {
      id: 1,
      method: "initialize",
      params_digest: digest(initializeParams),
      thread_id: null,
      attempt_id: null,
    },
    at: new Date().toISOString(),
  });
  append(store, id, "execution-finished", {
    type: "execution_finished",
    start_digest: digest(start),
    outcome: "succeeded",
    output_delivery: "unobserved",
    at: new Date().toISOString(),
  });
  writeFileSync(
    markerPath(store),
    JSON.stringify({ schema_version: 2, invocation_id: id, identity: source, state: "running" }),
  );
  return { id, transport, request };
}
export function recoveryRequest(store: ReturnType<typeof initializeFixture>) {
  const inspected = inspectInvocation(store)!;
  return {
    run_id: "initialize-run",
    actor: { role: "main", thread_id: store.read().control.owner_thread_id },
    request_id: "repair-initialize",
    expected_revision: store.read().revision,
    payload: {
      invocation_id: inspected.invocation_id,
      marker_digest: digest(readMarker(store)),
      evidence_refs: inspected.evidence_refs ?? [],
    },
  };
}
