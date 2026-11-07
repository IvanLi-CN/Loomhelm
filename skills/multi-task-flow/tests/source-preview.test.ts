import { expect, test } from "bun:test";
import { join } from "node:path";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { startSharedViewer } from "../scripts/service-http";
import { ServiceAuth } from "../scripts/service-auth";
import { ServiceState } from "../scripts/service-state";
import { servicePaths } from "../scripts/service-paths";
import { runDaemon } from "../scripts/service-lifecycle";
import { serviceFixture, fixtureRelease, fixtureLegacyRelease, fixtureRun } from "./service-fixture";

test.each([
  ["default", []],
  ["idle archive", ["--scenario", "agent-idle-archive"]],
  ["single delivery unit", ["--single-delivery-unit"]],
] as const)("source preview %s starts through the daemon lifecycle", async (_name, args) => {
  const { root } = serviceFixture();
  for (const name of ["home", "codex", "tmp", "cache"]) mkdirSync(join(root, name));
  const child = Bun.spawn([process.execPath, "--no-install", join(import.meta.dir, "../scripts/preview-source.ts"), ...args], {
    cwd: root,
    env: { ...process.env, HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"), BUN_INSTALL_CACHE_DIR: join(root, "cache") },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const readiness = (async () => {
      let text = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Preview exited before readiness: " + await stderr);
        text += decoder.decode(chunk.value, { stream: true });
        const lines = text.split("\n");
        text = lines.pop()!;
        for (const line of lines) {
          if (line.startsWith('{"mode":"source-preview"')) return JSON.parse(line);
        }
      }
    })();
    const ready = await Promise.race([readiness, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Preview startup timed out")), 20000);
    })]);
    const url = new URL(ready.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect((await fetch(url.origin + "/api/v1/runs")).status).toBe(401);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    const forceStop = setTimeout(() => child.kill("SIGKILL"), 5000);
    await child.exited;
    clearTimeout(forceStop);
    await reader.cancel();
    await stderr;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("daemon preview exceptions cannot start an installed profile or a legacy installed package", async () => {
  const { root, state } = serviceFixture();
  const release = fixtureLegacyRelease(root);
  await expect(runDaemon(new ServiceState(servicePaths({})), {
    manifest: release.manifest, assetsDir: join(release.source, "dist"), revision: () => "source",
  })).rejects.toThrow("isolated service profile");
  cpSync(release.source, join(state.paths.releases, release.manifest.build_id), { recursive: true });
  state.saveConfig({ schema_version: 1, port: 12000, registry_dir: join(root, "registry"), current_build: release.manifest.build_id, previous_build: null, agent_ttl_ms: 60000 });
  await expect(runDaemon(state)).rejects.toThrow("diagnostic-only");
});

test("source reload uses production authentication and is absent in ordinary viewers", async () => {
  const { root, state } = serviceFixture();
  const release = fixtureRelease(root);
  fixtureRun(state.paths.data);
  let revision = "first";
  const source = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
    () => revision,
  );
  const ordinary = await startSharedViewer(
    state,
    release.manifest,
    join(release.source, "skills/multi-task-flow/dist"),
    0,
  );
  const headers = {
    authorization: "Bearer " + new ServiceAuth(state).credential(),
  };
  const base = `http://127.0.0.1:${source.port}`;
  try {
    expect((await fetch(base + "/api/v1/source")).status).toBe(401);
    expect(
      await (await fetch(base + "/api/v1/source", { headers })).json(),
    ).toEqual({ revision: "first" });
    revision = "second";
    expect(
      await (await fetch(base + "/api/v1/source", { headers })).json(),
    ).toEqual({ revision: "second" });
    expect(
      await (await fetch(base + "/runs/demo-run/", { headers })).text(),
    ).toContain("/source-client.js");
    expect(
      (
        await fetch(`http://127.0.0.1:${ordinary.port}/api/v1/source`, {
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      await (
        await fetch(`http://127.0.0.1:${ordinary.port}/runs/demo-run/`, {
          headers,
        })
      ).text(),
    ).not.toContain("/source-client.js");
    expect(
      (
        await fetch(base + "/api/v1/source", {
          headers: { ...headers, origin: "https://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await source.stop();
    await ordinary.stop();
  }
});

test("installed production profile rejects source reload overrides", () => {
  const { root } = serviceFixture();
  const release = fixtureRelease(root);
  const state = new ServiceState(servicePaths({}));
  expect(() =>
    startSharedViewer(
      state,
      release.manifest,
      join(release.source, "skills/multi-task-flow/dist"),
      0,
      () => "source",
    ),
  ).toThrow("isolated profile");
});

test("isolated profile cookies coexist without replacing the installed viewer cookie", () => {
  const first = new ServiceAuth(serviceFixture().state);
  const second = new ServiceAuth(serviceFixture().state);
  const firstCookie = first.exchange(first.ticket()).cookie.split(";")[0]!;
  const secondCookie = second.exchange(second.ticket()).cookie.split(";")[0]!;
  expect(firstCookie.split("=")[0]).not.toBe(secondCookie.split("=")[0]);
  expect(firstCookie.startsWith("mtf_session=")).toBe(false);
  const request = new Request("http://127.0.0.1/", {
    headers: {
      cookie: `mtf_session=production-cookie; ${firstCookie}; ${secondCookie}`,
    },
  });
  expect(first.authorize(request)?.kind).toBe("browser");
  expect(second.authorize(request)?.kind).toBe("browser");
});

test("source fixture uses domain names consistently in run identity and references", async () => {
  const {
    createViewerValidationLedger,
    viewerValidationId,
    viewerValidationName,
  } = await import("../examples/orchestration-viewer");
  const run = createViewerValidationLedger();
  expect(run.orchestration_id).toBe(viewerValidationId);
  expect(run.active_plan_id).toBe("viewer-validation-plan");
  expect(run.groups.some((group) => group.title === viewerValidationName)).toBe(
    true,
  );
  expect(JSON.stringify(run)).not.toContain('"orchestration-sample"');
  expect(JSON.stringify(run)).not.toContain('"sample/multi-task-flow"');
  expect(JSON.stringify(run)).not.toContain('"plan-1"');
});

test("installed profile rejects synthetic conversation observers", () => {
  const { root } = serviceFixture();
  const release = fixtureRelease(root);
  expect(() => startSharedViewer(
    new ServiceState(servicePaths({})), release.manifest, join(release.source, "skills/multi-task-flow/dist"),
    0, undefined, undefined,
    async () => ({ request: async () => ({ data: [] }), close() {} }),
  )).toThrow("isolated profile");
});

test("isolated single-unit preview projects synthetic conversations through the shared viewer", async () => {
  const { createSingleDeliveryUnitLedger } = await import("../examples/single-delivery-unit/ledger");
  const { singleDeliveryUnitObserver } = await import("../examples/single-delivery-unit/outputs");
  const { LedgerStore } = await import("../scripts/store");
  const { root, state } = serviceFixture();
  const release = fixtureRelease(root);
  const ledger = createSingleDeliveryUnitLedger();
  new LedgerStore(state.paths.data, ledger.orchestration_id).create(ledger);
  const viewer = await startSharedViewer(state, release.manifest, join(release.source, "skills/multi-task-flow/dist"), 0, () => "mock", "Mock", singleDeliveryUnitObserver(ledger));
  const headers = { authorization: "Bearer " + new ServiceAuth(state).credential() };
  const base = `http://127.0.0.1:${viewer.port}/runs/${ledger.orchestration_id}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = (await fetch(base + "/api/events", { headers })).body!.getReader();
    await reader.read();
    let result: any;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await (await fetch(base + "/api/view", { headers })).json();
      if (result.view?.tasks.find((task: any) => task.id === "container")?.latest_agent_output.state === "available") break;
      await Bun.sleep(10);
    }
    const task = result.view.tasks.find((task: any) => task.id === "container");
    expect(task.latest_agent_output.text).toContain("健康检查");
    expect(task.latest_agent_output.thread_id).toBe("mock-thread-container");
    expect(result.view.groups[0].atoms.filter((atom: any) => atom.status === "completed")).toHaveLength(2);
    expect(result.view.warnings).toEqual([]);
  } finally {
    await reader?.cancel();
    await viewer.stop();
  }
});
