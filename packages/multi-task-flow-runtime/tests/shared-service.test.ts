import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PortRegistry } from "@loomhelm/runtime-core/modules/workspace/port_registry";
import { ContractError } from "../lib/errors";
import { ServiceAuth } from "../lib/service-auth";
import { listRuns, selectAssets, startSharedViewer } from "../lib/service-http";
import { importRun } from "../lib/service-import";
import { runDaemon, serviceStatus } from "../lib/service-lifecycle";
import {
  installRelease,
  nativeServiceControl,
  switchRelease,
  upgradePackageReleaseAndStart,
} from "../lib/service-maintenance";
import { buildId, verifyRelease } from "../lib/service-release";
import { LedgerStore } from "../lib/store";
import { writeViewerBinding } from "../lib/viewer-binding";
import { serviceCommand } from "../scripts/service";
import {
  bindHistoricalFixture,
  fixtureLegacyRelease,
  fixtureRelease,
  fixtureRun,
  serviceFixture,
} from "./service-fixture";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startSharedViewer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const value = serviceFixture();
  roots.push(value.root);
  return value;
}
test("one-time login persists sessions and explicit rotation revokes them", () => {
  const { state } = fixture();
  const auth = new ServiceAuth(state);
  const credential = auth.credential();
  const ticket = auth.ticket("/runs/example/");
  const result = auth.exchange(ticket);
  expect(result.target).toBe("/runs/example/");
  expect(() => auth.exchange(ticket)).toThrow();
  const request = new Request("http://127.0.0.1/", {
    headers: { cookie: result.cookie.split(";")[0]! },
  });
  expect(new ServiceAuth(state).authorize(request)?.kind).toBe("browser");
  expect(new ServiceAuth(state).credential()).toBe(credential);
  auth.rotate();
  expect(auth.authorize(request)).toBeNull();
});
test("service login emits browser-ready target tickets", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  mkdirSync(join(root, "registry"), { recursive: true });
  state.saveConfig({
    schema_version: 1,
    port,
    registry_dir: join(root, "registry"),
    current_build: release.manifest.build_id,
    previous_build: null,
    agent_ttl_ms: 60_000,
  });
  let daemon: Awaited<ReturnType<typeof runDaemon>> | undefined;
  try {
    daemon = await runDaemon(state, {
      manifest: release.manifest,
      assetsDir: join(release.source, "skills/multi-task-flow/dist"),
      revision: () => "test",
    });
    const check = async (input: { run_id?: string }, target: string) => {
      const result = (await serviceCommand("login", input, state)) as {
        login_url: string;
        expires_in_seconds: number;
        single_use: boolean;
      };
      const url = new URL(result.login_url);
      expect(url.origin).toBe(`http://127.0.0.1:${port}`);
      expect(url.pathname).toBe(target);
      expect(url.hash).toBe("");
      expect(url.searchParams.getAll("ticket")).toHaveLength(1);
      expect(url.searchParams.get("ticket")).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result).toMatchObject({ expires_in_seconds: 60, single_use: true });
      expect(new ServiceAuth(state).exchange(url.searchParams.get("ticket")!, target).target).toBe(
        target,
      );
    };
    await check({}, "/");
    await check({ run_id: "demo.run" }, "/runs/demo.run/");
  } finally {
    await daemon?.stop();
  }
});
test("multi-run routing has one listener and isolated worker streams", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data, "first");
  bindHistoricalFixture(state, "first", release.manifest);
  fixtureRun(state.paths.data, "second");
  bindHistoricalFixture(state, "second", release.manifest);
  const viewer = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const credential = new ServiceAuth(state).credential();
  const headers = { authorization: "Bearer " + credential };
  expect((await fetch(base + "/api/v1/runs")).status).toBe(401);
  const runs = (await (await fetch(base + "/api/v1/runs", { headers })).json()) as {
    runs: unknown[];
  };
  expect(runs.runs).toHaveLength(2);
  const view = await fetch(base + "/runs/first/api/view", { headers });
  expect(view.status).toBe(200);
  expect((await fetch(base + "/api/v1/runs/second/view", { headers })).status).toBe(200);
  const stream = await fetch(base + "/api/v1/runs/first/events", { headers });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(
    (
      await fetch(base + "/api/v1/lease", {
        method: "POST",
        headers: { ...headers, origin: "https://foreign.example" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});
test("run service projection exposes the runtime identity used by the version details surface", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data, "runtime-identity");
  bindHistoricalFixture(state, "runtime-identity", release.manifest);
  const viewer = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const headers = { authorization: "Bearer " + new ServiceAuth(state).credential() };
  const response = await fetch(base + "/runs/runtime-identity/api/service", { headers });
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    runtime: { static_viewer: { source: string }; daemon: { service_contract: string | null } };
  };
  expect(value.runtime.static_viewer.source).toBe("unknown");
  expect(value.runtime.daemon.service_contract).toBe(release.manifest.service_version);
});
test("run service projection follows a historical Worker binding", async () => {
  const { root, state } = fixture();
  const previous = fixtureRelease(root, "previous");
  const current = fixtureRelease(root, "current");
  mkdirSync(state.paths.releases, { recursive: true });
  cpSync(previous.source, join(state.paths.releases, previous.manifest.build_id), {
    recursive: true,
  });
  state.saveConfig({
    schema_version: 1,
    port: 49152,
    registry_dir: join(root, "registry"),
    current_build: current.manifest.build_id,
    previous_build: previous.manifest.build_id,
    agent_ttl_ms: 60_000,
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.0.0-current",
    compatibility_line: "compat-v1",
    skill_version: current.manifest.skill_version,
    service_contract: current.manifest.service_version,
    ledger_contract: current.manifest.ledger_contract ?? 3,
    api_contract: current.manifest.api_versions[0]!,
    frontend_contract: current.manifest.frontend_contracts[0]!,
    viewer_contract: current.manifest.viewer_contract,
    source_sha: current.manifest.source_sha,
    artifact_build_id: current.manifest.build_id,
  });
  fixtureRun(state.paths.data, "historical-runtime");
  writeViewerBinding(state, {
    schema_version: 1,
    run_id: "historical-runtime",
    package_name: "@loomhelm/multi-task-flow",
    package_version: previous.manifest.service_version,
    build_id: previous.manifest.build_id,
    source_sha: previous.manifest.source_sha,
    compatibility_line: "compat-v1",
    ledger_contract: previous.manifest.ledger_contract ?? 2,
    api_contract: previous.manifest.api_versions[0]!,
    frontend_contract: previous.manifest.frontend_contracts[0]!,
    viewer_contract: previous.manifest.viewer_contract,
    revision: 0,
    request_id: "test-historical-binding",
    updated_at: new Date().toISOString(),
  });
  const viewer = await startSharedViewer(
    state,
    current.manifest,
    join(current.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const response = await fetch(
    `http://127.0.0.1:${viewer.port}/runs/historical-runtime/api/service`,
    { headers: { authorization: "Bearer " + new ServiceAuth(state).credential() } },
  );
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    runtime: { static_viewer: Record<string, unknown>; daemon: Record<string, unknown> };
  };
  expect(value.runtime.static_viewer).toMatchObject({
    source: "package",
    package_version: previous.manifest.service_version,
    build_id: previous.manifest.build_id,
    source_sha: previous.manifest.source_sha,
    skill_version: previous.manifest.skill_version,
  });
  expect(value.runtime.daemon).toMatchObject({
    package_version: "0.0.0-current",
    build_id: current.manifest.build_id,
    source_sha: current.manifest.source_sha,
  });
});
test("schema-1 historical bindings remain diagnostic-only and cannot start a Worker", async () => {
  const { root, state } = fixture();
  const current = fixtureRelease(root, "current");
  const legacy = fixtureLegacyRelease(root);
  const legacyManifest = verifyRelease(legacy.source);
  mkdirSync(state.paths.releases, { recursive: true });
  cpSync(legacy.source, join(state.paths.releases, legacyManifest.build_id), { recursive: true });
  state.saveConfig({
    schema_version: 1,
    port: 49152,
    registry_dir: join(root, "registry"),
    current_build: current.manifest.build_id,
    previous_build: legacyManifest.build_id,
    agent_ttl_ms: 60_000,
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.0.0-current",
    compatibility_line: "compat-v1",
    skill_version: current.manifest.skill_version,
    service_contract: "1",
    ledger_contract: current.manifest.ledger_contract ?? 3,
    api_contract: current.manifest.api_versions[0]!,
    frontend_contract: current.manifest.frontend_contracts[0]!,
    viewer_contract: current.manifest.viewer_contract,
    source_sha: current.manifest.source_sha,
    artifact_build_id: current.manifest.build_id,
  });
  fixtureRun(state.paths.data, "historical-legacy");
  writeViewerBinding(state, {
    schema_version: 1,
    run_id: "historical-legacy",
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.41",
    build_id: legacyManifest.build_id,
    source_sha: legacyManifest.source_sha,
    compatibility_line: "compat-v1",
    ledger_contract: legacyManifest.ledger_contract ?? 2,
    api_contract: legacyManifest.api_versions[0]!,
    frontend_contract: legacyManifest.frontend_contracts[0]!,
    viewer_contract: legacyManifest.viewer_contract,
    revision: 0,
    request_id: "test-legacy-binding",
    updated_at: new Date().toISOString(),
  });
  const viewer = await startSharedViewer(
    state,
    current.manifest,
    join(current.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const response = await fetch(
    `http://127.0.0.1:${viewer.port}/runs/historical-legacy/api/service`,
    { headers: { authorization: "Bearer " + new ServiceAuth(state).credential() } },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "VIEWER_BINDING_RELEASE_UNSUPPORTED" });
});
test("run service projection follows custom assets over a historical binding", async () => {
  const { root, state } = fixture();
  const previous = fixtureRelease(root, "previous");
  const current = fixtureRelease(root, "current");
  mkdirSync(state.paths.releases, { recursive: true });
  cpSync(previous.source, join(state.paths.releases, previous.manifest.build_id), {
    recursive: true,
  });
  state.saveConfig({
    schema_version: 1,
    port: 49152,
    registry_dir: join(root, "registry"),
    current_build: current.manifest.build_id,
    previous_build: previous.manifest.build_id,
    agent_ttl_ms: 60_000,
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.0.0-current",
    compatibility_line: "compat-v1",
    skill_version: current.manifest.skill_version,
    service_contract: current.manifest.service_version,
    ledger_contract: current.manifest.ledger_contract ?? 3,
    api_contract: current.manifest.api_versions[0]!,
    frontend_contract: current.manifest.frontend_contracts[0]!,
    viewer_contract: current.manifest.viewer_contract,
    source_sha: current.manifest.source_sha,
    artifact_build_id: current.manifest.build_id,
  });
  const { store } = fixtureRun(state.paths.data, "historical-custom");
  writeViewerBinding(state, {
    schema_version: 1,
    run_id: "historical-custom",
    package_name: "@loomhelm/multi-task-flow",
    package_version: previous.manifest.service_version,
    build_id: previous.manifest.build_id,
    source_sha: previous.manifest.source_sha,
    compatibility_line: "compat-v1",
    ledger_contract: previous.manifest.ledger_contract ?? 2,
    api_contract: previous.manifest.api_versions[0]!,
    frontend_contract: previous.manifest.frontend_contracts[0]!,
    viewer_contract: previous.manifest.viewer_contract,
    revision: 0,
    request_id: "test-historical-custom-binding",
    updated_at: new Date().toISOString(),
  });
  const custom = join(store.runPath, "view");
  mkdirSync(custom);
  cpSync(join(current.source, "skills/multi-task-flow/dist"), custom, { recursive: true });
  writeFileSync(
    join(custom, "index.html"),
    "<!-- custom-view-marker -->\n" +
      readFileSync(join(current.source, "skills/multi-task-flow/dist/index.html"), "utf8"),
  );
  writeFileSync(
    join(custom, "view.manifest.json"),
    JSON.stringify({ api_version: 1, frontend_contract: 1 }),
  );
  const viewer = await startSharedViewer(
    state,
    current.manifest,
    join(current.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const response = await fetch(
    `http://127.0.0.1:${viewer.port}/runs/historical-custom/api/service`,
    { headers: { authorization: "Bearer " + new ServiceAuth(state).credential() } },
  );
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    runtime: { static_viewer: Record<string, unknown> };
  };
  expect(value.runtime.static_viewer).toMatchObject({
    source: "custom-view",
    package_name: null,
    build_id: null,
  });
  const page = await fetch(`http://127.0.0.1:${viewer.port}/runs/historical-custom/`, {
    headers: { authorization: "Bearer " + new ServiceAuth(state).credential() },
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("custom-view-marker");
});
test("one worker serves consecutive contract-3 run pages", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data, "contract3-first", 3);
  bindHistoricalFixture(state, "contract3-first", release.manifest);
  fixtureRun(state.paths.data, "contract3-second", 3);
  bindHistoricalFixture(state, "contract3-second", release.manifest);
  const viewer = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const headers = { authorization: "Bearer " + new ServiceAuth(state).credential() };
  const responses = await Promise.all([
    fetch(base + "/runs/contract3-first/api/view", { headers }),
    fetch(base + "/runs/contract3-second/api/view", { headers }),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  for (const response of responses)
    expect((await response.json()).view.orchestration.contract_version).toBe(3);
});
test("target tickets authenticate on the run route and recover safely", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data);
  const viewer = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const noFollow = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, redirect: "manual" });
  const targetLocation = (response: Response) => {
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!, base);
    return url.pathname + url.search;
  };
  const ticket = new ServiceAuth(state).ticket("/runs/demo-run/");
  const response = await noFollow(base + "/runs/demo-run/?ticket=" + encodeURIComponent(ticket));
  expect(response.status).toBe(302);
  expect(targetLocation(response)).toBe("/runs/demo-run/");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const replay = await noFollow(base + "/runs/demo-run/?ticket=" + encodeURIComponent(ticket));
  expect(replay.status).toBe(302);
  const failedLocation = targetLocation(replay);
  expect(new URL(failedLocation, base).pathname).toBe("/auth/failed");
  const failedPage = await noFollow(base + failedLocation);
  expect(failedPage.status).toBe(401);
  expect(await failedPage.text()).toContain("一次性登录入口已过期或已使用。");
  const recovered = await noFollow(base + failedLocation, { headers: { cookie } });
  expect(recovered.status).toBe(302);
  expect(targetLocation(recovered)).toBe("/runs/demo-run/");
  const stale = await noFollow(base + "/runs/demo-run/?ticket=stale-ticket", {
    headers: { cookie },
  });
  expect(stale.status).toBe(302);
  expect(targetLocation(stale)).toBe("/runs/demo-run/");
  const retainedTicket = new ServiceAuth(state).ticket("/runs/demo-run/");
  const retained = await noFollow(
    base + "/runs/demo-run/?ticket=" + encodeURIComponent(retainedTicket),
    { headers: { cookie } },
  );
  expect(retained.status).toBe(302);
  expect(targetLocation(retained)).toBe("/runs/demo-run/");
  expect(
    (await noFollow(base + "/runs/demo-run/?ticket=" + encodeURIComponent(retainedTicket))).status,
  ).toBe(302);
  const viewTicket = new ServiceAuth(state).ticket("/runs/demo-run/");
  const withView = await noFollow(
    base +
      "/runs/demo-run/?selected=task%3AC2&detail=1&tab=actual&ticket=" +
      encodeURIComponent(viewTicket),
  );
  expect(withView.status).toBe(302);
  expect(targetLocation(withView)).toBe("/runs/demo-run/?selected=task%3AC2&detail=1&tab=actual");
  for (const path of ["/login", "/login.js", "/resume-task.js", "/api/v1/login"])
    expect((await noFollow(base + path)).status).toBe(404);
  for (const value of [
    "https://evil.test/runs/demo-run/",
    "http://user:pass@127.0.0.1/runs/demo-run/",
    "/login",
  ]) {
    const invalid = await noFollow(base + "/auth/failed?redirect=" + encodeURIComponent(value));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("location")).toBeNull();
  }
});

test("browser session keeps CSRF checks and credential-free resource links", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data);
  bindHistoricalFixture(state, "demo-run", release.manifest);
  const viewer = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const ticket = new ServiceAuth(state).ticket("/runs/demo-run/");
  const response = await fetch(base + "/runs/demo-run/?ticket=" + encodeURIComponent(ticket), {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await fetch(base + "/api/v1/lease", { method: "POST", headers: { cookie } })).status,
  ).toBe(403);
  expect(
    (await fetch(base + "/api/v1/lease", { method: "POST", headers: { cookie, origin: base } }))
      .status,
  ).toBe(200);
  const page = await (await fetch(base + "/runs/demo-run/", { headers: { cookie } })).text();
  expect(page).toContain("/service-client.js");
  expect(page).not.toContain(ticket);
  expect(
    (
      await fetch(base + "/runs/demo-run/api/document/../../state/auth.json", {
        headers: { cookie },
      })
    ).status,
  ).not.toBe(200);
});

test("worker diagnostics are run-scoped and browser reconnect issues a fresh ticket", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data, "diagnostic-run");
  const viewer = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const loginTicket = new ServiceAuth(state).ticket("/runs/diagnostic-run/");
  const login = await fetch(
    base + "/runs/diagnostic-run/?ticket=" + encodeURIComponent(loginTicket),
    { redirect: "manual" },
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const diagnostics = await fetch(
    base + "/runs/diagnostic-run/api/diagnostics/worker?run_id=diagnostic-run",
    { headers: { cookie } },
  );
  expect(diagnostics.status).toBe(200);
  expect(await diagnostics.json()).toEqual({ diagnostic: null });
  const reconnect = await fetch(
    base + "/api/v1/reconnect?target=" + encodeURIComponent("/runs/diagnostic-run/?tab=atomic"),
    { method: "POST", headers: { cookie, origin: base } },
  );
  expect(reconnect.status).toBe(200);
  const value = (await reconnect.json()) as { login_url: string; single_use: boolean };
  expect(value.single_use).toBe(true);
  expect(new URL(value.login_url).searchParams.get("ticket")).toMatch(/^[A-Za-z0-9_-]+$/);
  const unauthenticated = await fetch(
    base + "/api/v1/reconnect?target=" + encodeURIComponent("/runs/diagnostic-run/?tab=atomic"),
    { method: "POST" },
  );
  expect(unauthenticated.status).toBe(401);
});
test("legacy-view uses the previous viewer as an isolated read-only fallback", async () => {
  const { root, state } = fixture();
  const previous = fixtureRelease(root, "previous", { readOnly: true });
  const installed = await installRelease(state, previous.source);
  const target = fixtureRelease(root, "target");
  const { store } = fixtureRun(state.paths.data, "demo-run");
  const before = readFileSync(store.ledgerPath);
  state.saveConfig({
    ...state.config(),
    current_build: target.manifest.build_id,
    previous_build: installed.build_id,
  });
  const viewer = await startSharedViewer(
    state,
    target.manifest,
    join(target.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const base = `http://127.0.0.1:${viewer.port}`;
  const headers = { authorization: "Bearer " + new ServiceAuth(state).credential() };
  const response = await fetch(base + "/api/v1/runs/demo-run/legacy-view", { headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    read_only: boolean;
    run_id: string;
    fallback_build_id: string;
    view: { orchestration: { id: string; revision: number } };
  };
  expect(body).toMatchObject({
    read_only: true,
    run_id: "demo-run",
    fallback_build_id: installed.build_id,
  });
  expect(body.view.orchestration).toEqual({ id: "demo-run", revision: 18 });
  expect(readFileSync(store.ledgerPath)).toEqual(before);
  expect(
    (await fetch(base + "/api/v1/runs/demo-run/legacy-view", { method: "POST", headers })).status,
  ).not.toBe(200);
});
test("custom views require declared compatibility and malformed runs do not break discovery", () => {
  const { root, state } = fixture();
  const { store } = fixtureRun(state.paths.data);
  const custom = join(store.runPath, "view");
  mkdirSync(custom);
  expect(selectAssets(state.paths.data, "demo-run", root).warning).not.toBeNull();
  writeFileSync(
    join(custom, "view.manifest.json"),
    JSON.stringify({ api_version: 1, frontend_contract: 1 }),
  );
  expect(selectAssets(state.paths.data, "demo-run", root).path).toBe(custom);
  mkdirSync(join(state.paths.data, "runs", "broken"));
  const runs = listRuns(state.paths.data);
  expect(runs.total).toBe(2);
  expect(runs.runs.find((run) => run.id === "broken")).toHaveProperty("error");
});
test("install persists a fixed port without starting a process and rejects corrupt bundles", async () => {
  const { root, state } = fixture();
  const bundle = fixtureRelease(root);
  const result = await installRelease(state, bundle.source);
  expect(result.started).toBe(false);
  expect(state.config().port).toBe(result.port);
  expect(state.runtime().phase).toBe("stopped");
  expect(readFileSync(join(state.paths.config, "viewer.plist"), "utf8")).toContain(
    "<key>RunAtLoad</key><false/>",
  );
  writeFileSync(join(bundle.source, "skills/multi-task-flow/dist/app.js"), "corrupt");
  expect(() => verifyRelease(bundle.source)).toThrow("checksum");
});
test("code health failure restores config and preserves leases without touching ledger", async () => {
  const { root, state } = fixture();
  const bundle = fixtureRelease(root);
  await installRelease(state, bundle.source);
  const previous = state.config();
  const next = fixtureRelease(root, "next");
  const { store } = fixtureRun(state.paths.data);
  const bytes = readFileSync(store.ledgerPath, "utf8");
  state.renew({ id: "agent:x:y", kind: "agent", run_id: "y", thread_id: "x" }, 60_000);
  const deadline = state.runtime().leases[0]!.expires_at;
  let healthCalls = 0;
  const control = {
    ...nativeServiceControl,
    startupTimeoutMs: 25,
    unload: () => {},
    start: () => {},
    status: async () => {
      healthCalls++;
      throw new Error("unhealthy");
    },
  };
  // Deterministic failure exercises the same switch code without OS service mutation.
  await expect(switchRelease(state, next.source, false, control)).rejects.toThrow("healthy");
  expect(healthCalls).toBeGreaterThan(0);
  expect(state.config()).toEqual(previous);
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
      expect(
        state.runtime().leases.find((lease) => lease.id === "maintenance")!.expires_at,
      ).toBeGreaterThan(Date.now() + 60_000);
      throw new Error("controlled startup failure");
    },
  };
  await expect(
    switchRelease(state, fixtureRelease(root, "lease-window").source, false, control),
  ).rejects.toThrow("controlled startup failure");
  expect(state.runtime().leases).toEqual(before);
});

test("package upgrade waits for delayed target readiness before declaring success", async () => {
  const { root, state } = fixture();
  const oldBuild = "a".repeat(64);
  const targetBuild = "b".repeat(64);
  const oldSource = "c".repeat(40);
  const targetSource = "d".repeat(40);
  const writePackageConfig = (version: string, build: string, source: string) => {
    state.saveConfig({
      schema_version: 1,
      port: 49153,
      registry_dir: join(root, "registry"),
      current_build: build,
      previous_build: null,
      agent_ttl_ms: 60_000,
      package_name: "@loomhelm/multi-task-flow",
      package_version: version,
      compatibility_line: "compat-v1",
      skill_version: "0.0.0",
      service_contract: "1",
      source_sha: source,
      artifact_build_id: build,
    });
  };
  writePackageConfig("1.0.0", oldBuild, oldSource);
  state.renew({ id: "agent:existing", kind: "agent", run_id: "run", thread_id: "thread" }, 180_000);
  const existingDeadline = state.runtime().leases[0]!.expires_at;
  let healthChecks = 0;
  let startChecksMaintenanceLease = false;
  let maintenanceDeadline = 0;
  const control = {
    upgrade: async (_state: typeof state, version: string) => {
      const target = version === "2.0.0";
      writePackageConfig(
        version,
        target ? targetBuild : oldBuild,
        target ? targetSource : oldSource,
      );
      return {
        package_name: "@loomhelm/multi-task-flow",
        version,
        build_id: target ? targetBuild : oldBuild,
        port: 49153,
        root,
        started: false,
      };
    },
    start: () => {
      const lease = state.runtime().leases.find((item) => item.id === "maintenance");
      startChecksMaintenanceLease = Boolean(lease);
      maintenanceDeadline = lease?.expires_at ?? 0;
    },
    status: async () => {
      healthChecks++;
      if (healthChecks === 1) throw new ContractError("SERVICE_UNAVAILABLE", "probe unavailable");
      return {
        ok: true,
        build_id: targetBuild,
        source_sha: targetSource,
        compatibility: { api_versions: [1] },
        generation: "target-generation",
        pid: process.pid,
        port: 49153,
        package_name: "@loomhelm/multi-task-flow",
        package_version: "2.0.0",
      };
    },
    waitForHealth: async <T>(check: () => Promise<T>) => {
      try {
        return await check();
      } catch {
        return await check();
      }
    },
    startupTimeoutMs: 25,
  } as any;

  const result = await (upgradePackageReleaseAndStart as any)(state, "2.0.0", control);
  expect(result.started).toBe(true);
  expect(healthChecks).toBe(2);
  expect(startChecksMaintenanceLease).toBe(true);
  expect(maintenanceDeadline).toBeGreaterThan(Date.now() + 25);
  expect(state.runtime().leases).toHaveLength(1);
  expect(state.runtime().leases[0]!.expires_at).toBe(existingDeadline);
});

test("package upgrades serialize readiness and rollback under the startup lock", async () => {
  const { root, state } = fixture();
  const builds = new Map([
    ["1.0.0", "a".repeat(64)],
    ["2.0.0", "b".repeat(64)],
    ["3.0.0", "c".repeat(64)],
  ]);
  const sources = new Map([
    ["1.0.0", "a".repeat(40)],
    ["2.0.0", "b".repeat(40)],
    ["3.0.0", "c".repeat(40)],
  ]);
  const writePackageConfig = (version: string) => {
    state.saveConfig({
      schema_version: 1,
      port: 49156,
      registry_dir: join(root, "registry"),
      current_build: builds.get(version)!,
      previous_build: null,
      agent_ttl_ms: 60_000,
      package_name: "@loomhelm/multi-task-flow",
      package_version: version,
      compatibility_line: "compat-v1",
      skill_version: "0.0.0",
      service_contract: "1",
      source_sha: sources.get(version)!,
      artifact_build_id: builds.get(version)!,
    });
  };
  writePackageConfig("1.0.0");
  let active = 0;
  let maxActive = 0;
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      return await work();
    } finally {
      active--;
    }
  };
  const control = {
    upgrade: async (_state: typeof state, version: string) =>
      track(async () => {
        await Bun.sleep(15);
        writePackageConfig(version);
        return {
          package_name: "@loomhelm/multi-task-flow",
          version,
          build_id: builds.get(version)!,
          port: 49156,
          root,
          started: false,
        };
      }),
    start: () => {},
    status: async () => ({
      ok: true,
      build_id: state.config().current_build,
      source_sha: state.config().source_sha!,
      compatibility: { api_versions: [1] },
      generation: "generation",
      pid: process.pid,
      port: 49156,
      package_name: "@loomhelm/multi-task-flow",
      package_version: state.config().package_version,
    }),
    waitForHealth: async <T>(check: () => Promise<T>) =>
      track(async () => {
        await Bun.sleep(15);
        return check();
      }),
    startupTimeoutMs: 100,
  } as any;

  const results = await Promise.all([
    (upgradePackageReleaseAndStart as any)(state, "2.0.0", control),
    (upgradePackageReleaseAndStart as any)(state, "3.0.0", control),
  ]);
  expect(maxActive).toBe(1);
  expect(results.map((result: { version: string }) => result.version).sort()).toEqual([
    "2.0.0",
    "3.0.0",
  ]);
  expect(state.config().package_version).toBe("3.0.0");
});

test("package upgrade restores the previous build when its startup lease cannot be established", async () => {
  const { root, state } = fixture();
  const oldBuild = "a".repeat(64);
  const targetBuild = "b".repeat(64);
  const oldSource = "c".repeat(40);
  const targetSource = "d".repeat(40);
  const writePackageConfig = (version: string) => {
    const target = version === "2.0.0";
    state.saveConfig({
      schema_version: 1,
      port: 49157,
      registry_dir: join(root, "registry"),
      current_build: target ? targetBuild : oldBuild,
      previous_build: null,
      agent_ttl_ms: 60_000,
      package_name: "@loomhelm/multi-task-flow",
      package_version: version,
      compatibility_line: "compat-v1",
      skill_version: "0.0.0",
      service_contract: "1",
      source_sha: target ? targetSource : oldSource,
      artifact_build_id: target ? targetBuild : oldBuild,
    });
  };
  writePackageConfig("1.0.0");
  state.transaction((runtime) => {
    runtime.phase = "stopping";
  });
  const control = {
    upgrade: async (_state: typeof state, version: string) => {
      writePackageConfig(version);
      if (version === "1.0.0")
        state.transaction((runtime) => {
          runtime.phase = "stopped";
          runtime.pid = null;
        });
      return {
        package_name: "@loomhelm/multi-task-flow",
        version,
        build_id: version === "2.0.0" ? targetBuild : oldBuild,
        port: 49157,
        root,
        started: false,
      };
    },
    start: () => {},
    status: async () => ({
      ok: true,
      build_id: oldBuild,
      source_sha: oldSource,
      compatibility: { api_versions: [1] },
      generation: "old-generation",
      pid: process.pid,
      port: 49157,
      package_name: "@loomhelm/multi-task-flow",
      package_version: "1.0.0",
    }),
    waitForHealth: async <T>(check: () => Promise<T>) => check(),
    startupTimeoutMs: 25,
  } as any;

  let error: unknown;
  try {
    await (upgradePackageReleaseAndStart as any)(state, "2.0.0", control);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    code: "GATEWAY_START_FAILED",
    details: {
      phase: "lease",
      target_version: "2.0.0",
      previous_version: "1.0.0",
      rollback_status: "restored",
    },
  });
  expect(state.config().package_version).toBe("1.0.0");
  expect(state.runtime().leases).toHaveLength(0);
});

test("package upgrade reports a safe timeout after restoring the previous build", async () => {
  const { root, state } = fixture();
  const oldBuild = "a".repeat(64);
  const targetBuild = "b".repeat(64);
  const oldSource = "c".repeat(40);
  const targetSource = "d".repeat(40);
  const writePackageConfig = (version: string, build: string, source: string) => {
    state.saveConfig({
      schema_version: 1,
      port: 49154,
      registry_dir: join(root, "registry"),
      current_build: build,
      previous_build: null,
      agent_ttl_ms: 60_000,
      package_name: "@loomhelm/multi-task-flow",
      package_version: version,
      compatibility_line: "compat-v1",
      skill_version: "0.0.0",
      service_contract: "1",
      source_sha: source,
      artifact_build_id: build,
    });
  };
  writePackageConfig("1.0.0", oldBuild, oldSource);
  const control = {
    upgrade: async (_state: typeof state, version: string) => {
      const target = version === "2.0.0";
      writePackageConfig(
        version,
        target ? targetBuild : oldBuild,
        target ? targetSource : oldSource,
      );
      return {
        package_name: "@loomhelm/multi-task-flow",
        version,
        build_id: target ? targetBuild : oldBuild,
        port: 49154,
        root,
        started: false,
      };
    },
    start: () => {},
    status: async () => {
      if (state.config().package_version === "2.0.0")
        throw new ContractError("SERVICE_UNAVAILABLE", "secret health detail");
      return {
        ok: true,
        build_id: oldBuild,
        source_sha: oldSource,
        compatibility: { api_versions: [1] },
        generation: "old-generation",
        pid: process.pid,
        port: 49154,
        package_name: "@loomhelm/multi-task-flow",
        package_version: "1.0.0",
      };
    },
    waitForHealth: async <T>(check: () => Promise<T>) => check(),
    startupTimeoutMs: 25,
  } as any;

  let error: unknown;
  try {
    await (upgradePackageReleaseAndStart as any)(state, "2.0.0", control);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    code: "GATEWAY_HEALTH_TIMEOUT",
    details: {
      phase: "health",
      target_version: "2.0.0",
      previous_version: "1.0.0",
      last_health_code: "SERVICE_UNAVAILABLE",
      rollback_status: "restored",
    },
  });
  expect(JSON.stringify(error)).not.toContain("secret health detail");
  expect(state.config().package_version).toBe("1.0.0");
  expect(state.runtime().leases).toHaveLength(0);
});

test("package upgrade reports rollback failure without leaking native errors", async () => {
  const { root, state } = fixture();
  const writePackageConfig = (version: string) => {
    const build = version === "2.0.0" ? "b".repeat(64) : "a".repeat(64);
    state.saveConfig({
      schema_version: 1,
      port: 49155,
      registry_dir: join(root, "registry"),
      current_build: build,
      previous_build: null,
      agent_ttl_ms: 60_000,
      package_name: "@loomhelm/multi-task-flow",
      package_version: version,
      compatibility_line: "compat-v1",
      skill_version: "0.0.0",
      service_contract: "1",
      source_sha: version === "2.0.0" ? "d".repeat(40) : "c".repeat(40),
      artifact_build_id: build,
    });
  };
  writePackageConfig("1.0.0");
  const control = {
    upgrade: async (_state: typeof state, version: string) => {
      writePackageConfig(version);
      return {
        package_name: "@loomhelm/multi-task-flow",
        version,
        build_id: state.config().current_build,
        port: 49155,
        root,
        started: false,
      };
    },
    start: () => {},
    status: async () => {
      if (state.config().package_version === "2.0.0")
        throw new ContractError("SERVICE_IDENTITY_MISMATCH", "secret target identity detail");
      throw new ContractError("SERVICE_UNAVAILABLE", "secret rollback health detail");
    },
    waitForHealth: async <T>(check: () => Promise<T>) => check(),
    startupTimeoutMs: 25,
  } as any;

  let error: unknown;
  try {
    await (upgradePackageReleaseAndStart as any)(state, "2.0.0", control);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    code: "GATEWAY_ROLLBACK_FAILED",
    details: {
      phase: "rollback",
      upgrade_code: "GATEWAY_HEALTH_TIMEOUT",
      rollback_code: "GATEWAY_HEALTH_TIMEOUT",
      last_health_code: "SERVICE_IDENTITY_MISMATCH",
      upgrade_health_code: "SERVICE_IDENTITY_MISMATCH",
      rollback_health_code: "SERVICE_UNAVAILABLE",
      rollback_status: "failed",
    },
  });
  expect(JSON.stringify(error)).not.toContain("secret target identity detail");
  expect(JSON.stringify(error)).not.toContain("secret rollback health detail");
});

test("service status rejects a mismatched source identity", async () => {
  const { root, state } = fixture();
  const release = fixtureRelease(root);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  state.saveConfig({
    schema_version: 1,
    port,
    registry_dir: join(root, "registry"),
    current_build: release.manifest.build_id,
    previous_build: null,
    agent_ttl_ms: 60_000,
    source_sha: "b".repeat(40),
  });
  state.renew({ id: "agent:status", kind: "agent", run_id: "run", thread_id: "thread" }, 60_000);
  const daemon = await runDaemon(state, {
    manifest: release.manifest,
    assetsDir: join(release.source, "skills/multi-task-flow/dist"),
    revision: () => "source-mismatch",
  });
  try {
    await expect(serviceStatus(state)).rejects.toMatchObject({
      code: "SERVICE_IDENTITY_MISMATCH",
    });
  } finally {
    await daemon.stop();
  }
});

for (const recover of [false, true])
  test(`slow native ${recover ? "recovery" : "startup"} renews maintenance coverage without extending users`, async () => {
    const { root, state } = fixture();
    await installRelease(state, fixtureRelease(root).source);
    const original = state.config().current_build;
    state.renew({ id: "agent:slow:run", kind: "agent", run_id: "run", thread_id: "slow" }, 180_000);
    const before = state.runtime().leases;
    state.transaction((runtime) => {
      runtime.phase = "running";
      runtime.pid = process.pid;
      runtime.generation = "slow-test";
    });
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let starts = 0;
    let remaining = 0;
    const control = {
      unload: () =>
        state.transaction((runtime) => {
          runtime.phase = "stopped";
          runtime.pid = null;
        }),
      start: () => {
        starts++;
        now += 75_000;
        if (recover && starts === 1) throw new Error("controlled slow startup failure");
        state.transaction((runtime) => {
          runtime.phase = "running";
          runtime.pid = process.pid;
        });
      },
      status: async () => {
        if (starts > 0)
          remaining =
            state.runtime().leases.find((lease) => lease.id === "maintenance")!.expires_at - now;
        return {
          ok: true,
          build_id: state.config().current_build,
          source_sha: "a".repeat(40),
          compatibility: { api_versions: [1] },
          generation: "slow-test",
          pid: process.pid,
          port: state.config().port,
        };
      },
    };
    try {
      const operation = switchRelease(
        state,
        fixtureRelease(root, `slow-${recover}`).source,
        false,
        control,
      );
      if (recover) await expect(operation).rejects.toThrow("controlled slow startup failure");
      else await operation;
      expect(starts).toBe(recover ? 2 : 1);
      expect(remaining).toBe(90_000);
      expect(state.runtime().leases).toEqual(before);
      expect(state.config().current_build === original).toBe(recover);
    } finally {
      clock.mockRestore();
    }
  });
test("failed recovery unload still releases the maintenance lease without extending users", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  state.renew({ id: "existing-agent", kind: "agent", run_id: null, thread_id: null }, 180_000);
  const before = state.runtime().leases;
  let unloads = 0;
  const control = {
    ...nativeServiceControl,
    unload: () => {
      if (++unloads > 1) throw new Error("controlled unload failure");
    },
    start: () => {
      throw new Error("controlled startup failure");
    },
  };
  await expect(
    switchRelease(state, fixtureRelease(root, "unload-failure").source, false, control),
  ).rejects.toThrow("controlled unload failure");
  expect(state.runtime().leases).toEqual(before);
});
test("import seals old writes, retains backup and is idempotent", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  const source = join(root, "legacy");
  const { store } = fixtureRun(source);
  const imported = importRun(state, source, "demo-run");
  expect(existsSync(join(imported.backup, "ledger.json"))).toBe(true);
  expect(() => store.update(() => {})).toThrow();
  expect(importRun(state, source, "demo-run").already_imported).toBe(true);
  expect(imported.url).toMatch(/\/runs\/demo-run\/$/);
});
test("import rejects conflicting IDs and symlinks before changing the source", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  const source = join(root, "legacy");
  const { store } = fixtureRun(source);
  const target = fixtureRun(state.paths.data).store;
  target.update((ledger) => {
    ledger.revision++;
  });
  expect(() => importRun(state, source, "demo-run")).toThrow("different content");
  expect(existsSync(store.ledgerPath)).toBe(true);
  const another = fixtureRun(source, "symlinked").store;
  symlinkSync(store.ledgerPath, join(another.runPath, "unsafe"));
  expect(() => importRun(state, source, "symlinked")).toThrow("symlinks");
  expect(existsSync(another.ledgerPath)).toBe(true);
});
test("interrupted sealed-source migration resumes without restoring over new data", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  const source = join(root, "interrupted");
  fixtureRun(source);
  expect(() =>
    importRun(state, source, "demo-run", (stage) => {
      if (stage === "source_sealed") throw new Error("injected interruption");
    }),
  ).toThrow("injected interruption");
  expect(existsSync(join(source, "runs", "demo-run", "ledger.json"))).toBe(false);
  const resumed = importRun(state, source, "demo-run");
  expect(resumed.already_imported).toBe(true);
  // Target is authoritative and may advance after migration.
  const target = new LedgerStore(state.paths.data, "demo-run");
  target.update((ledger) => {
    ledger.revision++;
  });
  expect(importRun(state, source, "demo-run").already_imported).toBe(true);
});
test("fixed user port can restart offline without overwriting an active PID", async () => {
  const { state } = fixture();
  let listening = false;
  const registry = new PortRegistry(join(state.paths.state, "registry-regression"), {
    portListening: () => listening,
  });
  const allocated = await registry.allocate({
    scopeId: state.paths.scope,
    service: "viewer",
    project: "multi-task-flow",
    repoRoot: "",
    branch: "",
    worktreePath: "",
  });
  const port = Number(allocated.port);
  await registry.releaseService(state.paths.scope, "viewer");
  await registry.register({
    scopeId: state.paths.scope,
    service: "viewer",
    port,
    expectedPid: null,
    createIfMissing: true,
  });
  try {
    listening = true;
    await expect(
      registry.claimAndRun(
        { scopeId: state.paths.scope, service: "viewer", port, pid: process.pid },
        () => {
          throw new Error("must not bind an occupied port");
        },
      ),
    ).rejects.toThrow("LISTENing");
    listening = false;
    await registry.claimAndRun(
      { scopeId: state.paths.scope, service: "viewer", port, pid: process.pid },
      () => {
        listening = true;
      },
    );
    await expect(
      registry.register({
        scopeId: state.paths.scope,
        service: "viewer",
        port,
        expectedPid: null,
        createIfMissing: true,
      }),
    ).rejects.toThrow("pid no longer matches");
    await expect(
      registry.releaseService(state.paths.scope, "viewer", 24, 10, { port, pid: null }),
    ).rejects.toThrow("pid no longer matches");
    await registry.releaseService(state.paths.scope, "viewer", 24, 10, { port, pid: process.pid });
  } finally {
    listening = false;
  }
});
test("failed live upgrade verifies the recovered old build and retains exact deadlines", async () => {
  const { root, state } = fixture();
  await installRelease(state, fixtureRelease(root).source);
  const original = state.config().current_build;
  state.renew({ id: "agent:live:run", kind: "agent", run_id: "run", thread_id: "live" }, 90_000);
  state.transaction((runtime) => {
    runtime.phase = "running";
    runtime.pid = process.pid;
    runtime.generation = "live-test";
  });
  const deadline = state.runtime().leases[0]!.expires_at;
  let restoredChecks = 0;
  const control = {
    startupTimeoutMs: 25,
    unload: () =>
      state.transaction((runtime) => {
        runtime.phase = "stopped";
        runtime.pid = null;
      }),
    start: () =>
      state.transaction((runtime) => {
        runtime.phase = "running";
        runtime.pid = process.pid;
      }),
    status: async () => {
      if (state.config().current_build !== original) throw new Error("new build unhealthy");
      restoredChecks++;
      return {
        ok: true,
        build_id: original,
        source_sha: "a".repeat(40),
        compatibility: { api_versions: [1] },
        generation: "live-test",
        pid: process.pid,
        port: state.config().port,
      };
    },
  };
  await expect(
    switchRelease(state, fixtureRelease(root, "unhealthy-live").source, false, control),
  ).rejects.toThrow("healthy");
  expect(restoredChecks).toBe(2);
  expect(state.config().current_build).toBe(original);
  expect(state.runtime().leases).toHaveLength(1);
  expect(state.runtime().leases[0]!.expires_at).toBe(deadline);
}, 20_000);
test("future ledger contracts are refused before read or write", () => {
  const { state } = fixture();
  const { store } = fixtureRun(state.paths.data);
  const ledger = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  ledger.contract_version = 99;
  writeFileSync(store.ledgerPath, JSON.stringify(ledger));
  const bytes = readFileSync(store.ledgerPath, "utf8");
  expect(() => store.read()).toThrow("not supported");
  expect(() =>
    store.update((value) => {
      value.revision++;
    }),
  ).toThrow("not supported");
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
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("package-backed launchd definition pins the exact npm package and keeps the service on demand", async () => {
  const { writeLaunchdDefinition } = await import("../lib/service-launchd");
  const { readFileSync } = await import("node:fs");
  const { root, state } = fixture();
  state.saveConfig({
    schema_version: 1,
    port: 61191,
    registry_dir: join(root, "registry"),
    current_build: "b".repeat(64),
    previous_build: null,
    agent_ttl_ms: 3_600_000,
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.12",
    compatibility_line: "compat-v1",
    skill_version: "2.7.7",
    service_contract: "1",
    source_sha: "c".repeat(40),
    artifact_build_id: "b".repeat(64),
  });
  const xml = readFileSync(writeLaunchdDefinition(state), "utf8");
  expect(xml).toContain("<string>x</string><string>--bun</string>");
  expect(xml).toContain(
    "<string>--package</string><string>@loomhelm/multi-task-flow@0.2.12</string>",
  );
  expect(xml).toContain(
    "<string>multi-task-flow</string><string>service</string><string>daemon</string>",
  );
  expect(xml).toContain("<key>RunAtLoad</key><false/>");
  expect(xml).toContain("<key>KeepAlive</key><false/>");
  expect(xml).not.toContain("releases");
});

test("daemon update hints expose only confirmed newer daemon candidates", async () => {
  const { writeAtomic } = await import("../lib/store");
  const { cachedDaemonUpdate } = await import("../lib/service-update");
  const { root, state } = fixture();
  state.saveConfig({
    schema_version: 1,
    port: 61192,
    registry_dir: join(root, "registry"),
    current_build: "d".repeat(64),
    previous_build: null,
    agent_ttl_ms: 3_600_000,
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.12",
    compatibility_line: "compat-v1",
    skill_version: "2.7.7",
    service_contract: "1",
    source_sha: "e".repeat(40),
    artifact_build_id: "d".repeat(64),
  });
  writeAtomic(
    join(state.paths.state, "daemon-update.json"),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      package_name: "@loomhelm/multi-task-flow",
      compatibility_line: "compat-v1",
      compatible_version: "0.2.13",
      latest_version: "0.2.14",
    }),
  );
  expect(cachedDaemonUpdate(state)).toEqual({
    kind: "daemon_update",
    message: "A newer Dashboard daemon is available",
    compatible_version: "0.2.13",
    latest_version: "0.2.14",
  });
});

test("custom assets cannot select a different executable identity for a contract-4 run", async () => {
  const { root, state } = fixture();
  const previous = fixtureRelease(root, "bound-worker");
  const current = fixtureRelease(root, "gateway-worker");
  const { build_id: _oldBuild, ...body } = previous.manifest;
  const boundBody = { ...body, ledger_contract: 4 };
  const bound = { ...boundBody, build_id: buildId(boundBody) };
  writeFileSync(join(previous.source, "manifest.json"), JSON.stringify(bound));
  cpSync(previous.source, join(state.paths.releases, bound.build_id), { recursive: true });
  const { run } = fixtureRun(state.paths.data, "binding-seed", 3);
  const identity = {
    package_name: "@loomhelm/multi-task-flow",
    package_version: bound.service_version,
    build_id: bound.build_id,
    source_sha: bound.source_sha,
    compatibility_line: "compat-v1",
    ledger_contract: 4,
    api_contract: bound.api_versions[0]!,
    frontend_contract: bound.frontend_contracts[0]!,
    viewer_contract: bound.viewer_contract,
  };
  const store = new LedgerStore(state.paths.data, "bound-custom");
  store.create({
    ...run,
    orchestration_id: "bound-custom",
    contract_version: 4,
    runtime_identity: identity,
  });
  const custom = join(store.runPath, "view");
  mkdirSync(custom);
  cpSync(join(current.source, "skills/multi-task-flow/dist"), custom, { recursive: true });
  writeFileSync(
    join(custom, "view.manifest.json"),
    JSON.stringify({ api_version: 1, frontend_contract: 1 }),
  );
  const before = store.readRaw();
  const viewer = await startSharedViewer(
    state,
    current.manifest,
    join(current.source, "skills/multi-task-flow/dist"),
    0,
  );
  servers.push(viewer);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("fixture stops before starting the selected child");
  });
  try {
    const response = await fetch(`http://127.0.0.1:${viewer.port}/runs/bound-custom/api/view`, {
      headers: { authorization: "Bearer " + new ServiceAuth(state).credential() },
    });
    expect(response.status).toBe(503);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, options] = spawn.mock.calls[0]!;
    expect(command).toEqual([
      process.execPath,
      join(
        state.paths.releases,
        bound.build_id,
        "skills/multi-task-flow/scripts/viewer-worker-process.ts",
      ),
    ]);
    expect(JSON.parse((options as any).env.LOOMHELM_CALLER_IDENTITY)).toEqual(identity);
    expect(store.readRaw()).toBe(before);
  } finally {
    spawn.mockRestore();
  }
});
