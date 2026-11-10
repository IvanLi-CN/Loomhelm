import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PortRegistry } from "../../bin/modules/workspace/port_registry";
import { LedgerStore } from "../lib/store";
import { ServiceAuth } from "../lib/service-auth";
import { startSharedViewer, listRuns, selectAssets } from "../lib/service-http";
import { installRelease, switchRelease, nativeServiceControl } from "../lib/service-maintenance";
import { verifyRelease } from "../lib/service-release";
import { importRun } from "../lib/service-import";
import { serviceFixture, fixtureRelease, fixtureRun } from "./service-fixture";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startSharedViewer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() { const value = serviceFixture(); roots.push(value.root); return value; }
test("one-time login persists sessions and explicit rotation revokes them", () => {
  const { state } = fixture(); const auth = new ServiceAuth(state);
  const credential = auth.credential();
  const ticket = auth.ticket("/runs/example/");
  const result = auth.exchange(ticket);
  expect(result.target).toBe("/runs/example/");
  expect(() => auth.exchange(ticket)).toThrow();
  const request = new Request("http://127.0.0.1/", { headers: { cookie: result.cookie.split(";")[0]! } });
  expect(new ServiceAuth(state).authorize(request)?.kind).toBe("browser");
  expect(new ServiceAuth(state).credential()).toBe(credential);
  auth.rotate(); expect(auth.authorize(request)).toBeNull();
});
test("multi-run routing has one listener, authenticated APIs and lazy watchers", async () => {
  const { root, state } = fixture(); const release = fixtureRelease(root);
  fixtureRun(state.paths.data, "first"); fixtureRun(state.paths.data, "second");
  const viewer = await startSharedViewer(state, release.manifest, join(release.source, "skills/multi-task-flow/dist"), 0); servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const credential = new ServiceAuth(state).credential();
  const headers = { authorization: "Bearer " + credential };
  expect((await fetch(base + "/api/v1/runs")).status).toBe(401);
  const runs = await (await fetch(base + "/api/v1/runs", { headers })).json() as { runs: unknown[] };
  expect(runs.runs).toHaveLength(2); expect(viewer.watcherCount).toBe(0);
  const view = await fetch(base + "/runs/first/api/view", { headers }); expect(view.status).toBe(200);
  expect((await fetch(base + "/api/v1/runs/second/view", { headers })).status).toBe(200);
  expect(viewer.watcherCount).toBe(0);
  const stream = await fetch(base + "/api/v1/runs/first/events", { headers });
  expect(viewer.watcherCount).toBe(1);
  const reader = stream.body!.getReader(); await reader.read(); await reader.cancel();
  for (let attempt = 0; attempt < 20 && viewer.watcherCount; attempt++) await Bun.sleep(25);
  expect(viewer.watcherCount).toBe(0);
  expect((await fetch(base + "/api/v1/lease", { method: "POST", headers: { ...headers, origin: "https://foreign.example" }, body: "{}" })).status).toBe(403);
});
test("browser login, CSRF checks and credential-free resource links", async () => {
  const { root, state } = fixture(); const release = fixtureRelease(root); fixtureRun(state.paths.data);
  const viewer = await startSharedViewer(state, release.manifest, join(release.source, "skills/multi-task-flow/dist"), 0); servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const ticket = new ServiceAuth(state).ticket();
  const exchange = () => fetch(base + "/api/v1/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  const response = await exchange(); expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect((await exchange()).status).toBe(401);
  expect((await fetch(base + "/api/v1/lease", { method: "POST", headers: { cookie } })).status).toBe(403);
  expect((await fetch(base + "/api/v1/lease", { method: "POST", headers: { cookie, origin: base } })).status).toBe(200);
  const page = await (await fetch(base + "/runs/demo-run/", { headers: { cookie } })).text();
  expect(page).toContain("/service-client.js"); expect(page).not.toContain(ticket);
  expect((await fetch(base + "/runs/demo-run/api/document/../../state/auth.json", { headers: { cookie } })).status).not.toBe(200);
});
test("legacy-view uses the previous viewer as an isolated read-only fallback", async () => {
  const { root, state } = fixture();
  const previous = fixtureRelease(root, "previous", { readOnly: true });
  const installed = await installRelease(state, previous.source);
  const target = fixtureRelease(root, "target");
  const { store } = fixtureRun(state.paths.data, "demo-run");
  const before = readFileSync(store.ledgerPath);
  state.saveConfig({ ...state.config(), current_build: target.manifest.build_id, previous_build: installed.build_id });
  const viewer = await startSharedViewer(state, target.manifest, join(target.source, "skills/multi-task-flow/dist"), 0); servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const headers = { authorization: "Bearer " + new ServiceAuth(state).credential() };
  const response = await fetch(base + "/api/v1/runs/demo-run/legacy-view", { headers });
  expect(response.status).toBe(200);
  const body = await response.json() as { read_only: boolean; run_id: string; fallback_build_id: string; view: { orchestration: { id: string; revision: number } } };
  expect(body).toMatchObject({ read_only: true, run_id: "demo-run", fallback_build_id: installed.build_id });
  expect(body.view.orchestration).toEqual({ id: "demo-run", revision: 18 });
  expect(readFileSync(store.ledgerPath)).toEqual(before);
  expect((await fetch(base + "/api/v1/runs/demo-run/legacy-view", { method: "POST", headers })).status).not.toBe(200);
});
test("custom views require declared compatibility and malformed runs do not break discovery", () => {
  const { root, state } = fixture(); const { store } = fixtureRun(state.paths.data);
  const custom = join(store.runPath, "view"); mkdirSync(custom);
  expect(selectAssets(state.paths.data, "demo-run", root).warning).not.toBeNull();
  writeFileSync(join(custom, "view.manifest.json"), JSON.stringify({ api_version: 1, frontend_contract: 1 }));
  expect(selectAssets(state.paths.data, "demo-run", root).path).toBe(custom);
  mkdirSync(join(state.paths.data, "runs", "broken"));
  const runs = listRuns(state.paths.data); expect(runs.total).toBe(2);
  expect(runs.runs.find(run => run.id === "broken")).toHaveProperty("error");
});
test("install persists a fixed port without starting a process and rejects corrupt bundles", async () => {
  const { root, state } = fixture(); const bundle = fixtureRelease(root);
  const result = await installRelease(state, bundle.source);
  expect(result.started).toBe(false); expect(state.config().port).toBe(result.port);
  expect(state.runtime().phase).toBe("stopped");
  expect(readFileSync(join(state.paths.config, "viewer.plist"), "utf8")).toContain("<key>RunAtLoad</key><false/>");
  writeFileSync(join(bundle.source, "skills/multi-task-flow/dist/app.js"), "corrupt");
  expect(() => verifyRelease(bundle.source)).toThrow("checksum");
});
test("code health failure restores config and preserves leases without touching ledger", async () => {
  const { root, state } = fixture(); const bundle = fixtureRelease(root);
  await installRelease(state, bundle.source); const previous = state.config();
  const next = fixtureRelease(root, "next"); const { store } = fixtureRun(state.paths.data);
  const bytes = readFileSync(store.ledgerPath, "utf8");
  state.renew({ id: "agent:x:y", kind: "agent", run_id: "y", thread_id: "x" }, 60_000);
  const deadline = state.runtime().leases[0]!.expires_at;
  let healthCalls = 0;
  const control = { ...nativeServiceControl, startupTimeoutMs: 25, unload: () => {}, start: () => {}, status: async () => { healthCalls++; throw new Error("unhealthy"); } };
  // Deterministic failure exercises the same switch code without OS service mutation.
  await expect(switchRelease(state, next.source, false, control)).rejects.toThrow("healthy");
  expect(healthCalls).toBeGreaterThan(0); expect(state.config()).toEqual(previous);
  expect(state.runtime().leases[0]!.expires_at).toBe(deadline);
  expect(readFileSync(store.ledgerPath, "utf8")).toBe(bytes);
}, 20_000);
test("maintenance lease covers the readiness window and startup failure removes only that lease", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  state.renew({ id: "existing-agent", kind: "agent", run_id: null, thread_id: null }, 180_000);
  const before = state.runtime().leases;
  const control = {
    ...nativeServiceControl,
    unload: () => {},
    start: () => {
      expect(state.runtime().leases.find(lease => lease.id === "maintenance")!.expires_at).toBeGreaterThan(Date.now() + 60_000);
      throw new Error("controlled startup failure");
    },
  };
  await expect(switchRelease(state, fixtureRelease(root, "lease-window").source, false, control)).rejects.toThrow("controlled startup failure");
  expect(state.runtime().leases).toEqual(before);
});
for (const recover of [false, true]) test(`slow native ${recover ? "recovery" : "startup"} renews maintenance coverage without extending users`, async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  const original = state.config().current_build;
  state.renew({ id: "agent:slow:run", kind: "agent", run_id: "run", thread_id: "slow" }, 180_000);
  const before = state.runtime().leases;
  state.transaction(runtime => { runtime.phase = "running"; runtime.pid = process.pid; runtime.generation = "slow-test"; });
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let starts = 0;
  let remaining = 0;
  const control = {
    unload: () => state.transaction(runtime => { runtime.phase = "stopped"; runtime.pid = null; }),
    start: () => {
      starts++;
      now += 75_000;
      if (recover && starts === 1) throw new Error("controlled slow startup failure");
      state.transaction(runtime => { runtime.phase = "running"; runtime.pid = process.pid; });
    },
    status: async () => {
      if (starts > 0) remaining = state.runtime().leases.find(lease => lease.id === "maintenance")!.expires_at - now;
      return { ok: true, build_id: state.config().current_build, source_sha: "a".repeat(40), compatibility: { api_versions: [1] }, generation: "slow-test", pid: process.pid, port: state.config().port };
    },
  };
  try {
    const operation = switchRelease(state, fixtureRelease(root, `slow-${recover}`).source, false, control);
    if (recover) await expect(operation).rejects.toThrow("controlled slow startup failure");
    else await operation;
    expect(starts).toBe(recover ? 2 : 1);
    expect(remaining).toBe(90_000);
    expect(state.runtime().leases).toEqual(before);
    expect(state.config().current_build === original).toBe(recover);
  } finally { clock.mockRestore(); }
});
test("failed recovery unload still releases the maintenance lease without extending users", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  state.renew({ id: "existing-agent", kind: "agent", run_id: null, thread_id: null }, 180_000);
  const before = state.runtime().leases;
  let unloads = 0;
  const control = {
    ...nativeServiceControl,
    unload: () => { if (++unloads > 1) throw new Error("controlled unload failure"); },
    start: () => { throw new Error("controlled startup failure"); },
  };
  await expect(switchRelease(state, fixtureRelease(root, "unload-failure").source, false, control)).rejects.toThrow("controlled unload failure");
  expect(state.runtime().leases).toEqual(before);
});
test("import seals old writes, retains backup and is idempotent", async () => {
  const { root, state } = fixture(); await installRelease(state, fixtureRelease(root).source);
  const source = join(root, "legacy"); const { store } = fixtureRun(source);
  const imported = importRun(state, source, "demo-run");
  expect(existsSync(join(imported.backup, "ledger.json"))).toBe(true);
  expect(() => store.update(() => {})).toThrow();
  expect(importRun(state, source, "demo-run").already_imported).toBe(true);
  expect(imported.url).toMatch(/\/runs\/demo-run\/$/);
});
test("import rejects conflicting IDs and symlinks before changing the source", async () => {
  const { root, state } = fixture(); await installRelease(state, fixtureRelease(root).source);
  const source = join(root, "legacy"); const { store } = fixtureRun(source);
  const target = fixtureRun(state.paths.data).store;
  target.update(ledger => { ledger.revision++; });
  expect(() => importRun(state, source, "demo-run")).toThrow("different content");
  expect(existsSync(store.ledgerPath)).toBe(true);
  const another = fixtureRun(source, "symlinked").store;
  symlinkSync(store.ledgerPath, join(another.runPath, "unsafe"));
  expect(() => importRun(state, source, "symlinked")).toThrow("symlinks");
  expect(existsSync(another.ledgerPath)).toBe(true);
});
test("interrupted sealed-source migration resumes without restoring over new data", async () => {
  const { root, state } = fixture(); await installRelease(state, fixtureRelease(root).source);
  const source = join(root, "interrupted"); fixtureRun(source);
  expect(() => importRun(state, source, "demo-run", stage => { if (stage === "source_sealed") throw new Error("injected interruption"); })).toThrow("injected interruption");
  expect(existsSync(join(source, "runs", "demo-run", "ledger.json"))).toBe(false);
  const resumed = importRun(state, source, "demo-run");
  expect(resumed.already_imported).toBe(true);
  // Target is authoritative and may advance after migration.
  const target = new LedgerStore(state.paths.data, "demo-run");
  target.update(ledger => { ledger.revision++; });
  expect(importRun(state, source, "demo-run").already_imported).toBe(true);
});
test("fixed user port can restart offline without overwriting an active PID", async () => {
  const { state } = fixture();
  let listening = false;
  const registry = new PortRegistry(join(state.paths.state, "registry-regression"), { portListening: () => listening });
  const allocated = await registry.allocate({ scopeId: state.paths.scope, service: "viewer", project: "multi-task-flow", repoRoot: "", branch: "", worktreePath: "" });
  const port = Number(allocated.port);
  await registry.releaseService(state.paths.scope, "viewer");
  await registry.register({ scopeId: state.paths.scope, service: "viewer", port, expectedPid: null, createIfMissing: true });
  try {
    listening = true;
    await expect(registry.claimAndRun({ scopeId: state.paths.scope, service: "viewer", port, pid: process.pid }, () => { throw new Error("must not bind an occupied port"); })).rejects.toThrow("LISTENing");
    listening = false;
    await registry.claimAndRun({ scopeId: state.paths.scope, service: "viewer", port, pid: process.pid }, () => {
      listening = true;
    });
    await expect(registry.register({ scopeId: state.paths.scope, service: "viewer", port, expectedPid: null, createIfMissing: true })).rejects.toThrow("pid no longer matches");
    await expect(registry.releaseService(state.paths.scope, "viewer", 24, 10, { port, pid: null })).rejects.toThrow("pid no longer matches");
    await registry.releaseService(state.paths.scope, "viewer", 24, 10, { port, pid: process.pid });
  } finally { listening = false; }
});
test("failed live upgrade verifies the recovered old build and retains exact deadlines", async () => {
  const { root, state } = fixture(); await installRelease(state, fixtureRelease(root).source);
  const original = state.config().current_build;
  state.renew({ id: "agent:live:run", kind: "agent", run_id: "run", thread_id: "live" }, 90_000);
  state.transaction(runtime => { runtime.phase = "running"; runtime.pid = process.pid; runtime.generation = "live-test"; });
  const deadline = state.runtime().leases[0]!.expires_at;
  let restoredChecks = 0;
  const control = {
    startupTimeoutMs: 25,
    unload: () => state.transaction(runtime => { runtime.phase = "stopped"; runtime.pid = null; }),
    start: () => state.transaction(runtime => { runtime.phase = "running"; runtime.pid = process.pid; }),
    status: async () => {
      if (state.config().current_build !== original) throw new Error("new build unhealthy");
      restoredChecks++;
      return { ok: true, build_id: original, source_sha: "a".repeat(40), compatibility: { api_versions: [1] }, generation: "live-test", pid: process.pid, port: state.config().port };
    },
  };
  await expect(switchRelease(state, fixtureRelease(root, "unhealthy-live").source, false, control)).rejects.toThrow("healthy");
  expect(restoredChecks).toBe(2);
  expect(state.config().current_build).toBe(original);
  expect(state.runtime().leases).toHaveLength(1);
  expect(state.runtime().leases[0]!.expires_at).toBe(deadline);
}, 20_000);
test("future ledger contracts are refused before read or write", () => {
  const { state } = fixture(); const { store } = fixtureRun(state.paths.data);
  const ledger = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  ledger.contract_version = 99; writeFileSync(store.ledgerPath, JSON.stringify(ledger));
  const bytes = readFileSync(store.ledgerPath, "utf8");
  expect(() => store.read()).toThrow("not supported");
  expect(() => store.update(value => { value.revision++; })).toThrow("not supported");
  expect(readFileSync(store.ledgerPath, "utf8")).toBe(bytes);
});


test("launchd definition preserves the installing caller PATH without assuming tool locations", async () => {
  const { writeLaunchdDefinition } = await import("../lib/service-launchd");
  const { readFileSync } = await import("node:fs");
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  const previous = process.env.PATH;
  try {
    process.env.PATH = "/caller/tools&extensions:/usr/bin";
    const xml = readFileSync(writeLaunchdDefinition(state), "utf8");
    expect(xml).toContain("<key>PATH</key><string>/caller/tools&amp;extensions:/usr/bin</string>");
    expect(xml).not.toContain("<string>/usr/bin:/bin</string>");
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});
