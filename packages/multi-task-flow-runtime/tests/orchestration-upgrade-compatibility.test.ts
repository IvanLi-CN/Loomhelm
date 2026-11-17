import { expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { upgradeOrchestration } from "../lib/orchestration-upgrade";
import { fixtureRun, serviceFixture } from "./service-fixture";

// Supply an unpacked, dependency-installed published CLI. No registry access or production paths are used by this test.
const oldCli = process.env.MULTI_TASK_FLOW_HISTORICAL_CLI;
test.skipIf(!oldCli)(
  "actual 0.2.53 reader, flow writer and binding-only maintenance writer reject the atomic barrier",
  async () => {
    const cli = resolve(oldCli!);
    const version = Bun.spawnSync([process.execPath, cli, "--version"]);
    expect(version.exitCode).toBe(0);
    const info = JSON.parse(version.stdout.toString());
    expect(info.version).toBe("0.2.53");
    const source = {
      package_name: info.package_name,
      package_version: info.version,
      build_id: info.build_id,
      source_sha: info.source_sha,
      compatibility_line: info.compatibility_line,
      ledger_contract: info.contracts.ledger,
      api_contract: info.contracts.api,
      frontend_contract: info.contracts.frontend,
      viewer_contract: info.contracts.viewer,
    };
    const target = {
      ...source,
      package_version: "0.2.56",
      build_id: "b".repeat(64),
      ledger_contract: 4,
    };
    const { state } = serviceFixture();
    state.saveConfig({
      schema_version: 1,
      port: 49152,
      registry_dir: join(state.paths.root, "registry"),
      current_build: source.build_id,
      previous_build: null,
      agent_ttl_ms: 3600000,
    });
    const { store } = fixtureRun(state.paths.data, "old-cli-run", 3);
    mkdirSync(join(store.runPath, "runtime"));
    const bindingPath = join(store.runPath, "runtime", "viewer-binding.json");
    writeFileSync(
      bindingPath,
      JSON.stringify({
        schema_version: 1,
        run_id: "old-cli-run",
        ...source,
        revision: 0,
        request_id: "trusted-fixture-binding",
        updated_at: new Date().toISOString(),
      }),
    );
    const request = {
      run_id: "old-cli-run",
      actor: { role: "main", thread_id: store.read().control.owner_thread_id },
    };
    const run = (command: string, input: unknown) => {
      const child = Bun.spawnSync([process.execPath, cli, "flow", command, "--input", "-"], {
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: state.paths.data },
      });
      return { exit: child.exitCode, output: JSON.parse(child.stdout.toString()) };
    };
    expect(run("show", request).exit).toBe(0);
    // Stop at the first authoritative published state, rather than testing only the completed upgrade.
    expect(() =>
      upgradeOrchestration(store, target, target, {
        withQuiescentRun: (_ledger, action) => action(),
        afterStage(phase) {
          if (phase === "prepared") throw new Error("published barrier");
        },
      }),
    ).toThrow("published barrier");
    const ledgerBefore = store.readRaw(),
      bindingBefore = readFileSync(bindingPath, "utf8");
    for (const result of [
      run("show", request),
      run("task-update", {
        ...request,
        request_id: "old-writer",
        expected_revision: store.read().revision,
        payload: {},
      }),
    ]) {
      expect(result.exit).not.toBe(0);
      expect(result.output.code).toBe("INCOMPATIBLE_LEDGER");
    }
    const resourceRoot = join(dirname(cli), "../resources/skills/multi-task-flow");
    const maintenancePath = resolve(resourceRoot, "lib/service-maintenance.ts");
    const original = await import(maintenancePath);
    mock.module(maintenancePath, () => ({
      ...original,
      resolvePackageTarget: () => ({
        package_name: source.package_name,
        version: "0.2.57",
        build_id: "c".repeat(64),
        source_sha: source.source_sha,
        compatibility_line: source.compatibility_line,
        skill_version: "2.7.11",
        tarball_digest: null,
        contracts: { ledger: 4, api: 1, frontend: 1, viewer: 5, service: "1" },
      }),
    }));
    const { serviceCommand } = await import(resolve(resourceRoot, "scripts/service.ts"));
    await expect(
      serviceCommand(
        "orchestration-upgrade",
        { run_id: "old-cli-run", target: "0.2.57", mode: "normal" },
        state,
      ),
    ).rejects.toMatchObject({ code: "VIEWER_BINDING_INVALID" });
    expect(store.readRaw()).toBe(ledgerBefore);
    expect(readFileSync(bindingPath, "utf8")).toBe(bindingBefore);
  },
);
