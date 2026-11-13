import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servicePaths, orchestrationRoot } from "../lib/service-paths";
import { requireApi, requireLedgerCompatibility } from "../lib/service-contract";
import { ServiceState } from "../lib/service-state";
import { serviceCommand } from "../scripts/service";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "mtf-contract-")));
  roots.push(root);
  return new ServiceState(servicePaths({ MULTI_TASK_FLOW_PROFILE: "test", MULTI_TASK_FLOW_ROOT: root }));
}
test("production root and identity are independent of CODEX_HOME", () => {
  expect(servicePaths({ CODEX_HOME: "/one" })).toEqual(servicePaths({ CODEX_HOME: "/two" }));
  expect(orchestrationRoot({})).toEndWith("/.local/share/multi-task-flow/data");
  expect(() => servicePaths({ MULTI_TASK_FLOW_ROOT: "/test" })).toThrow();
  expect(() => servicePaths({ MULTI_TASK_FLOW_PROFILE: "test" })).toThrow();
});
test("test instances have separate roots and service identities", () => {
  const a = fixture(), b = fixture();
  expect(a.paths.label).not.toBe(b.paths.label);
  expect(a.paths.scope).not.toBe(servicePaths({}).scope);
});
test("compatibility rejects future data instead of migrating it", () => {
  requireLedgerCompatibility({ schema_version: 1 });
  requireLedgerCompatibility({ schema_version: 1, contract_version: 1 });
  requireLedgerCompatibility({ schema_version: 2, contract_version: 2 }, "write");
  expect(() => requireLedgerCompatibility({ schema_version: 2, contract_version: 1 }, "write")).toThrow("explicit migration");
  expect(() => requireLedgerCompatibility({ schema_version: 1 }, "write")).toThrow();
  expect(() => requireLedgerCompatibility({ schema_version: 2 })).toThrow("explicit migration");
  expect(() => requireLedgerCompatibility({ schema_version: 1, contract_version: 2 }, "write")).toThrow();
  expect(() => requireApi(2)).toThrow("explicit maintenance");
});
test("schema2 contract2 ledgers without task policy fields are read-only", () => {
  requireLedgerCompatibility({ schema_version: 2, contract_version: 2, tasks: [] }, "write");
  expect(() => requireLedgerCompatibility({ schema_version: 2, contract_version: 2, tasks: [{ id: "legacy" }] }, "write")).toThrow("read-only");
  requireLedgerCompatibility({ schema_version: 2, contract_version: 2, tasks: [{ execution_owner: null, conversation_policy: null, delivery_policy: null }] }, "write");
});
test("schema2 contract2 ledgers with incomplete declared task policies stay read-only", () => {
  let error: any;
  try {
    requireLedgerCompatibility({
      schema_version: 2,
      contract_version: 2,
      tasks: [{ execution_owner: "main", conversation_policy: null, delivery_policy: null }],
    }, "write");
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "TASK_EXECUTION_POLICY_INCOMPLETE" });
});
test("leases are idempotent and preserve independent owners and deadlines", () => {
  const state = fixture();
  const agent = { id: "agent:thread:run", kind: "agent" as const, thread_id: "thread", run_id: "run" };
  state.renew(agent, 3_600_000, 10);
  state.renew(agent, 3_600_000, 20);
  state.renewBrowser("session", 30);
  expect(state.runtime().leases).toHaveLength(2);
  expect(state.runtime().leases[0]!.expires_at).toBe(3_600_020);
  const reopened = new ServiceState(state.paths);
  expect(reopened.runtime()).toEqual(state.runtime());
  state.release(agent.id);
  expect(state.runtime().leases[0]!.kind).toBe("browser");
});
test("expiry fences generations and refuses renewals during exit", () => {
  const state = fixture();
  state.transaction(runtime => { runtime.phase = "running"; runtime.pid = process.pid; runtime.generation = "current"; });
  state.renewBrowser("session", 0);
  expect(state.expire("current", 299_999)).toBe(false);
  expect(state.expire("current", 300_000)).toBe(true);
  expect(() => state.renewBrowser("next")).toThrow("stopping");
  expect(() => state.expire("old")).toThrow("replaced");
  state.stopped("old");
  expect(state.runtime().phase).toBe("stopping");
  state.stopped("current");
  expect(state.runtime().phase).toBe("stopped");
});


test("schema2/contract2 ledgers without idle or archive diagnostics remain readable", async () => {
  const { createDemoLedger } = await import("../examples/orchestration-viewer/ledger");
  const { validateLedger } = await import("../lib/schema");
  const ledger = JSON.parse(JSON.stringify(createDemoLedger()));
  ledger.contract_version = 2;
  for (const task of ledger.tasks) delete task.agent_resume_state;
  for (const resource of ledger.resources) for (const key of ["archive_policy", "error", "last_attempt_at", "operation_id"]) delete resource[key];
  expect(validateLedger(ledger).schema_version).toBe(2);
  expect(validateLedger(ledger).contract_version).toBe(2);
  expect(() => requireLedgerCompatibility(ledger)).not.toThrow();
});

test("viewer reader commands validate and render without a mutation boundary", async () => {
  const { createDemoLedger } = await import("../examples/orchestration-viewer/ledger");
  const ledger = createDemoLedger();
  const checked = await serviceCommand("reader-check", { ledger });
  expect(checked).toMatchObject({ contract: "schema-2/contract-1", revision: ledger.revision });
  const rendered = await serviceCommand("read-only-view", { ledger });
  expect(rendered).toHaveProperty("view");
});

test("viewer labels use the Loomhelm namespace and maintenance retires the matching legacy profile", async () => {
  const { unloadUserService } = await import("../lib/service-launchd");
  expect(servicePaths({}).label).toBe("cc.ivanli.loomhelm.multi-task-flow.viewer");
  const state = fixture();
  expect(state.paths.label).toStartWith("cc.ivanli.loomhelm.multi-task-flow.viewer.");
  const calls: string[][] = [];
  const legacy = state.paths.label.replace("cc.ivanli.loomhelm.multi-task-flow.viewer", "cn.ivan.multi-task-flow.viewer");
  unloadUserService(state, (args) => { calls.push(args); return true; }, "gui/123");
  expect(calls).toEqual([
    ["print", `gui/123/${state.paths.label}`],
    ["bootout", `gui/123/${state.paths.label}`],
    ["print", `gui/123/${legacy}`],
    ["bootout", `gui/123/${legacy}`],
  ]);
  calls.length = 0;
  unloadUserService(state, (args) => { calls.push(args); return false; }, "gui/123");
  expect(calls.every(args => args[0] === "print")).toBe(true);
});

test("ordinary startup rejects the legacy plist before calling launchctl", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { startUserService } = await import("../lib/service-launchd");
  const state = fixture();
  mkdirSync(state.paths.config, { recursive: true });
  writeFileSync(join(state.paths.config, "viewer.plist"), '<key>Label</key><string>cn.ivan.multi-task-flow.viewer</string>');
  expect(() => startUserService(state)).toThrow("explicit upgrade");
});

test("readiness tolerates delayed health but stops at a finite elapsed-time budget", async () => {
  const { waitForServiceHealth } = await import("../lib/service-lifecycle");
  const started = performance.now();
  expect(await waitForServiceHealth(async () => {
    if (performance.now() - started < 20) throw new Error("still starting");
    return "healthy";
  }, 500)).toBe("healthy");
  const failure = new Error("unhealthy");
  const deadlineStarted = performance.now();
  await expect(waitForServiceHealth(async () => { throw failure; }, 25)).rejects.toBe(failure);
  expect(performance.now() - deadlineStarted).toBeLessThan(500);
  await expect(waitForServiceHealth(async () => "healthy", Infinity)).rejects.toThrow("finite");
});
