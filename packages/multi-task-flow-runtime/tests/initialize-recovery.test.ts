import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { append, digest, readEvent } from "../lib/invocation-events";
import {
  inspectInvocation,
  inspectRecoveryInvocation,
  reconcileInvocation,
} from "../lib/invocation-journal";
import {
  initializeFixture,
  interruptedInitialize,
  recoveryRequest,
} from "./initialize-recovery-fixture";

const previous = process.env.LOOMHELM_CALLER_IDENTITY;
afterEach(() => {
  if (previous === undefined) delete process.env.LOOMHELM_CALLER_IDENTITY;
  else process.env.LOOMHELM_CALLER_IDENTITY = previous;
});

test("audited initialize recovers using derived proof without fabricating RPC terminal or changing ledger", () => {
  const store = initializeFixture();
  const { id, request } = interruptedInitialize(store);
  const before = store.readRaw();
  const result = inspectRecoveryInvocation(store, recoveryRequest(store).actor);
  expect(result.invocation).toMatchObject({
    quiescent: false,
    recovery: { eligible: true, receipt_valid: false },
  });
  const input = recoveryRequest(store);
  expect(input.payload.evidence_refs).toHaveLength(5);
  expect(() =>
    reconcileInvocation(store, { ...input, payload: { ...input.payload, evidence_refs: [] } }),
  ).toThrow("Evidence digests");
  const reconciled = reconcileInvocation(store, input);
  expect(inspectInvocation(store)?.quiescent).toBe(true);
  expect(reconcileInvocation(store, input)).toEqual(reconciled);
  expect(readEvent(store, id, `resource-${request}-terminal`)).toBeNull();
  expect(readEvent(store, id, "initialize-recovery")).toMatchObject({
    outcome: "unconfirmed_connection_closed",
    rule: "closed-initialize-v1",
  });
  expect(store.readRaw()).toBe(before);
});

test("unknown business effects and incomplete or changed historical evidence fail closed", () => {
  for (const mutation of [
    "method",
    "params",
    "extra",
    "transport",
    "finished",
    "source",
    "start",
    "orphan",
  ] as const) {
    const store = initializeFixture();
    const { id, transport, request } = interruptedInitialize(store);
    const path = (name: string) =>
      join(store.runPath, "runtime", "invocations", id, name + ".json");
    const edit = (name: string, fn: (value: any) => void) => {
      const v = JSON.parse(readFileSync(path(name), "utf8"));
      fn(v);
      writeFileSync(path(name), JSON.stringify(v));
    };
    if (mutation === "method")
      edit(`resource-${request}`, (v) => {
        v.reference.method = "thread/archive";
      });
    if (mutation === "params")
      edit(`resource-${request}`, (v) => {
        v.reference.params_digest = digest({ capabilities: { experimentalApi: true } });
      });
    if (mutation === "extra") {
      const extra = randomUUID();
      append(store, id, `resource-${extra}`, {
        type: "resource_intent",
        resource_id: extra,
        kind: "codex-turn",
        reference: {},
        at: new Date().toISOString(),
      });
    }
    if (mutation === "transport") unlinkSync(path(`resource-${transport}-terminal`));
    if (mutation === "finished") unlinkSync(path("execution-finished"));
    if (mutation === "source")
      edit("start", (v) => {
        v.identity.source_sha = "c".repeat(40);
      });
    if (mutation === "start")
      edit("start", (v) => {
        v.run_id = "other";
      });
    if (mutation === "orphan") writeFileSync(path("unexpected"), "{}");
    expect(inspectInvocation(store)?.quiescent).toBe(false);
    expect(() => reconcileInvocation(store, recoveryRequest(store))).toThrow();
  }
});

test("recovery resumes after each publication boundary and rejects tampering after a successful reconciliation", () => {
  for (const boundary of ["derived", "reconcile", "stopped"] as const) {
    const store = initializeFixture();
    const { id, transport } = interruptedInitialize(store);
    const input = recoveryRequest(store);
    const result = reconcileInvocation(store, input);
    const path = (name: string) =>
      join(store.runPath, "runtime", "invocations", id, name + ".json");
    if (boundary !== "stopped") unlinkSync(path("stopped"));
    if (boundary === "derived") unlinkSync(path("reconcile"));
    const markerPath = join(store.runPath, "runtime", "call.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, JSON.stringify({ ...marker, state: "running" }));
    expect(reconcileInvocation(store, input)).toEqual(result);
    expect(inspectInvocation(store)?.quiescent).toBe(true);
    unlinkSync(path(`resource-${transport}-terminal`));
    expect(inspectInvocation(store)?.quiescent).toBe(false);
    expect(() => reconcileInvocation(store, input)).toThrow();
  }
});

test("reconcile refuses stale marker/revision and another main before writing recovery proof", () => {
  for (const change of ["marker", "revision", "actor"] as const) {
    const store = initializeFixture();
    const { id } = interruptedInitialize(store);
    const input = recoveryRequest(store);
    if (change === "marker") input.payload.marker_digest = "0".repeat(64);
    if (change === "revision") input.expected_revision++;
    if (change === "actor") input.actor.thread_id = "another-main";
    expect(() => reconcileInvocation(store, input)).toThrow();
    expect(readEvent(store, id, "initialize-recovery")).toBeNull();
    expect(inspectInvocation(store)?.quiescent).toBe(false);
  }
});
