import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkerDiagnosticStore, workerDiagnosticFromError } from "../lib/worker-diagnostics";
import { serviceFixture } from "./service-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function input(runId = "demo") {
  return workerDiagnosticFromError({
    run_id: runId,
    worker_key: "schema-2@release-a",
    worker_generation: "generation-a",
    stage: "socket_connect",
    retry_count: 1,
    retryable: true,
    reconnect_required: true,
    error: new Error("socket timed out at /private/secret.sock"),
  });
}

test("worker diagnostics persist safely and recover across store instances", () => {
  const fixture = serviceFixture(); roots.push(fixture.root);
  const first = new WorkerDiagnosticStore(fixture.state.paths);
  const recorded = first.record(input());
  expect(recorded.diagnostic_id).toMatch(/^diag-/);
  expect(recorded).toMatchObject({ error_code: "WORKER_SOCKET_TIMEOUT", state: "observed" });
  expect(readFileSync(join(fixture.state.paths.state, "worker-diagnostics.json"), "utf8")).not.toContain("secret.sock");
  const second = new WorkerDiagnosticStore(fixture.state.paths);
  expect(second.get("demo")?.diagnostic_id).toBe(recorded.diagnostic_id);
  expect(second.recover("demo")?.state).toBe("recovered");
  expect(second.get("demo")?.recovered_at).not.toBeNull();
});

test("worker diagnostics sweep removes expired and missing runs", () => {
  const fixture = serviceFixture(); roots.push(fixture.root);
  const now = new Date("2026-01-08T00:00:00Z");
  const store = new WorkerDiagnosticStore(fixture.state.paths, () => now);
  store.record(input("expired"));
  expect(store.sweep(Date.parse("2026-01-16T00:00:00Z"), () => false)).toBe(1);
  expect(store.get("expired")).toBeNull();
  expect(existsSync(join(fixture.state.paths.state, "worker-diagnostics.json"))).toBe(true);
});
