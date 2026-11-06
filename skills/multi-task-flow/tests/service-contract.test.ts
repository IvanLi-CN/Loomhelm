import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servicePaths, orchestrationRoot } from "../scripts/service-paths";
import { requireApi, requireLedgerCompatibility } from "../scripts/service-contract";
import { ServiceState } from "../scripts/service-state";

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
