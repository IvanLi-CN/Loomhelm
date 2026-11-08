import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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


test("schema2/contract2 ledgers without idle or archive diagnostics remain readable", async () => {
  const { createDemoLedger } = await import("../examples/orchestration-viewer/ledger");
  const { validateLedger } = await import("../scripts/schema");
  const ledger = JSON.parse(JSON.stringify(createDemoLedger()));
  ledger.contract_version = 2;
  for (const task of ledger.tasks) delete task.agent_resume_state;
  for (const resource of ledger.resources) for (const key of ["archive_policy", "error", "last_attempt_at", "operation_id"]) delete resource[key];
  expect(validateLedger(ledger).schema_version).toBe(2);
  expect(validateLedger(ledger).contract_version).toBe(2);
  expect(() => requireLedgerCompatibility(ledger)).not.toThrow();
});

test("viewer labels use the Loomhelm namespace and maintenance retires the matching legacy profile", async () => {
  const { unloadUserService } = await import("../scripts/service-launchd");
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
  const { startUserService } = await import("../scripts/service-launchd");
  const state = fixture();
  mkdirSync(state.paths.config, { recursive: true });
  writeFileSync(join(state.paths.config, "viewer.plist"), '<key>Label</key><string>cn.ivan.multi-task-flow.viewer</string>');
  expect(() => startUserService(state)).toThrow("explicit upgrade");
});

test.skipIf(process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || !process.env.LOOMHELM_VIEWER_LABEL_BEFORE || !process.env.LOOMHELM_VIEWER_LABEL_AFTER)("native launchd label transition preserves port and retires legacy registration", async () => {
  const { installRelease, switchRelease, nativeServiceControl } = await import("../scripts/service-maintenance");
  const { writeLaunchdDefinition, startUserService, unloadUserService, launchdDomain, launchctl } = await import("../scripts/service-launchd");
  const { serviceStatus } = await import("../scripts/service-lifecycle");
  const { processAlive } = await import("../../bin/modules/workspace/port_registry");
  const state = fixture();
  // Cleanup must wait for the actual launchd child, not just test completion.
  roots.splice(roots.indexOf(state.paths.root), 1);
  const legacyLabel = state.paths.label.replace("cc.ivanli.loomhelm.multi-task-flow.viewer", "cn.ivan.multi-task-flow.viewer");
  const legacyState = new ServiceState({ ...state.paths, label: legacyLabel });
  const domain = launchdDomain();
  const stderr = join(state.paths.logs, "native-startup-stderr.log");
  const startWithDiagnostics = (instance: ServiceState) => {
    const plist = join(instance.paths.config, "viewer.plist");
    writeFileSync(plist, readFileSync(plist, "utf8").replace(
      "<key>StandardErrorPath</key><string>/dev/null</string>",
      `<key>StandardErrorPath</key><string>${stderr}</string>`,
    ));
    startUserService(instance);
  };
  try {
    const installed = await installRelease(state, process.env.LOOMHELM_VIEWER_LABEL_BEFORE!);
    state.renew({ id: "native-label", kind: "agent", run_id: null, thread_id: null }, 180_000);
    // Reproduce the legacy registration independently of program build identity.
    writeLaunchdDefinition(legacyState);
    startWithDiagnostics(legacyState);
    let healthy = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await serviceStatus(state); healthy = true; break; } catch { await Bun.sleep(100); }
    }
    expect(healthy).toBe(true);
    const previousPid = state.runtime().pid;
    expect(launchctl(["print", `${domain}/${legacyLabel}`], true)).toBe(true);
    await switchRelease(state, process.env.LOOMHELM_VIEWER_LABEL_AFTER!, false, {
      ...nativeServiceControl,
      start: startWithDiagnostics,
    });
    await serviceStatus(state);
    expect(state.config().port).toBe(installed.port);
    expect(state.config().current_build).not.toBe(installed.build_id);
    expect(state.runtime().pid).not.toBe(previousPid);
    expect(launchctl(["print", `${domain}/${legacyLabel}`], true)).toBe(false);
    expect(launchctl(["print", `${domain}/${state.paths.label}`], true)).toBe(true);
  } catch (error) {
    // Only this disposable CI instance is inspected; never print credentials or environment.
    const runtime = state.runtime();
    console.error("native label diagnostics", JSON.stringify({ phase: runtime.phase, pid: runtime.pid }));
    for (const label of [legacyLabel, state.paths.label]) {
      const result = Bun.spawnSync(["/bin/launchctl", "print", `${domain}/${label}`]);
      const text = result.stdout.toString();
      console.error("native launchd diagnostics", label, text.split("\n").filter(line => /^\s*(state|pid|runs|last exit code|last terminating signal) =/.test(line)).join("\n"));
      const pid = text.match(/^\s*pid = (\d+)$/m)?.[1];
      if (pid) console.error("native process diagnostics", Bun.spawnSync(["/bin/ps", "-p", pid, "-o", "pid=,ppid=,etime=,comm="]).stdout.toString());
    }
    for (const path of [stderr, join(state.paths.state, "startup-failure.json"), join(state.paths.logs, "viewer.jsonl")]) {
      if (existsSync(path)) console.error(path, readFileSync(path, "utf8").slice(-8000));
    }
    throw error;
  } finally {
    const pid = state.runtime().pid;
    unloadUserService(state);
    for (let attempt = 0; pid && processAlive(pid) && attempt < 200; attempt++) await Bun.sleep(100);
    if (pid && processAlive(pid)) throw new Error(`Isolated viewer did not stop; retained ${state.paths.root}`);
    rmSync(state.paths.root, { recursive: true, force: true });
  }
}, 120_000);
