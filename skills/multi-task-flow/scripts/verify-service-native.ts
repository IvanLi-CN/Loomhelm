import { serviceStatus } from "./service-lifecycle";
import { ServiceAuth } from "./service-auth";
import { compatibilityReport } from "./service-compatibility";
import { maintenanceCheck, maintenanceApply } from "./ledger-maintenance";
// CI-only empirical acceptance: every target is an isolated user service.
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { servicePaths } from "./service-paths";
import { ServiceState } from "./service-state";
import {
  buildId,
  verifyRelease,
  releaseFiles,
  digest,
} from "./service-release";
import { installRelease, switchRelease } from "./service-maintenance";
import { unloadUserService, launchdTarget } from "./service-launchd";
import { fixtureRun } from "../tests/service-fixture";

if (process.platform !== "darwin")
  throw new Error("Native acceptance requires macOS");
const bundle = resolve(process.argv[2]!);
const evidence = resolve(process.argv[3]!);
const root = realpathSync(
  mkdtempSync(join(realpathSync(tmpdir()), "mtf-native-")),
);
const env = {
  ...process.env,
  MULTI_TASK_FLOW_PROFILE: "test",
  MULTI_TASK_FLOW_ROOT: root,
  BUN_OPTIONS: "",
  NODE_OPTIONS: "",
};
const state = new ServiceState(servicePaths(env));
const card: Record<string, unknown> = {
  candidate_sha: Bun.spawnSync(["git", "rev-parse", "HEAD"])
    .stdout.toString()
    .trim(),
  root,
  platform: `${process.platform}-${process.arch}`,
  scenarios: [],
};
const scenarios = card.scenarios as string[];
const call = async (command: string, run = "first") => {
  const process = Bun.spawn([join(bundle, "viewer"), command, "--input", "-"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(
    JSON.stringify({ run_id: run, thread_id: "native-ci", api_version: 1 }),
  );
  process.stdin.end();
  const output = await new Response(process.stdout).text();
  const error = await new Response(process.stderr).text();
  if (await process.exited) throw new Error(`${command}: ${error}`);
  return JSON.parse(output).result;
};
async function waitFor(predicate: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
}
function cloneBundle(
  source: string,
  target: string,
  patch: object,
  broken = false,
) {
  mkdirSync(join(target, "dist"), { recursive: true });
  for (const file of releaseFiles)
    copyFileSync(join(source, file), join(target, file));
  const { build_id, ...manifest } = verifyRelease(source);
  if (broken) {
    writeFileSync(join(target, "viewer"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(target, "viewer"), 0o700);
    manifest.files.viewer = digest(readFileSync(join(target, "viewer")));
  }
  const body = { ...manifest, ...patch };
  writeFileSync(
    join(target, "manifest.json"),
    JSON.stringify({ ...body, build_id: buildId(body) }),
  );
}
async function verifyMigrationRollback() {
  const isolated = new ServiceState(
    servicePaths({
      ...env,
      MULTI_TASK_FLOW_ROOT: join(root, "migration-instance"),
    }),
  );
  const old = join(root, "old-contract-bundle");
  cloneBundle(bundle, old, {
    readable: ["schema-2/contract-1"],
    writable: ["schema-2/contract-1"],
    service_version: "0.0.0-legacy-ci",
  });
  try {
    await installRelease(isolated, old);
    const item = fixtureRun(isolated.paths.data, "migration-run");
    writeFileSync(
      item.store.ledgerPath,
      JSON.stringify({ ...item.run, contract_version: 1 }),
    );
    const manifest = verifyRelease(bundle);
    const report = compatibilityReport(isolated, manifest);
    await switchRelease(isolated, bundle, false, undefined, {
      report_digest: report.report_digest,
      approval_ref: "ci-owner-approved-downgrade",
      maintenance_thread_id: "native-ci",
    });
    const op = { run_id: "migration-run", action: "contract" };
    const check = maintenanceCheck(isolated, op);
    await maintenanceApply(isolated, {
      ...op,
      expected_owner_thread_id: check.owner_thread_id,
      expected_revision: check.revision,
      expected_ledger_sha256: check.ledger_sha256,
      operation_digest: check.operation_digest,
      request_id: "native-contract-migration",
      maintenance_thread_id: "native-ci",
      approval_ref: "ci-owner-approved-migration",
      reason: "Synthetic acceptance",
      writers_paused: true,
    });
    try {
      await switchRelease(isolated, "", true);
      throw new Error("Incompatible rollback accepted");
    } catch (error: any) {
      if (error.code !== "INCOMPATIBLE_RELEASE") throw error;
    }
    scenarios.push(
      "migration after compatible viewer upgrade preserves owner and blocks unreadable rollback",
    );
  } finally {
    unloadUserService(isolated);
  }
}
try {
  const installed = await installRelease(state, bundle);
  state.saveConfig({ ...state.config(), agent_ttl_ms: 60_000 });
  fixtureRun(state.paths.data, "first");
  fixtureRun(state.paths.data, "second");
  const legacy = fixtureRun(state.paths.data, "legacy");
  writeFileSync(
    legacy.store.ledgerPath,
    JSON.stringify({ ...legacy.run, contract_version: 1 }),
  );
  const legacyBytes = readFileSync(legacy.store.ledgerPath, "utf8");
  card.label = state.paths.label;
  card.target = launchdTarget(state);
  card.port = installed.port;
  card.initial_build_id = installed.build_id;
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      call("ensure", index % 2 ? "first" : "second"),
    ),
  );
  if (new Set(results.map((result) => result.pid)).size !== 1)
    throw new Error("Concurrent ensure created different processes");
  card.initial_pid = results[0].pid;
  scenarios.push("concurrent ensure and detached command survival");
  await call("release", "first");
  if (
    state.runtime().leases.length !== 1 ||
    state.runtime().phase !== "running"
  )
    throw new Error("Release affected another run");
  scenarios.push("independent run leases");
  process.kill(results[0].pid, "SIGKILL");
  await Bun.sleep(500);
  const recovered = await call("ensure", "second");
  if (
    recovered.pid === results[0].pid ||
    recovered.generation === results[0].generation
  )
    throw new Error("Crash recovery reused identity");
  card.recovered_pid = recovered.pid;
  scenarios.push("next ensure recovers crashed daemon");
  const expiry = state.runtime().leases[0]!.expires_at;
  const next = join(root, "upgrade-bundle");
  mkdirSync(join(next, "dist"), { recursive: true });
  for (const file of releaseFiles)
    copyFileSync(join(bundle, file), join(next, file));
  const { build_id, ...manifest } = verifyRelease(bundle);
  const upgraded = { ...manifest, service_version: "0.0.1-ci" };
  writeFileSync(
    join(next, "manifest.json"),
    JSON.stringify({ ...upgraded, build_id: buildId(upgraded) }),
  );
  await switchRelease(state, next);
  card.upgraded_build_id = state.config().current_build;
  if (readFileSync(legacy.store.ledgerPath, "utf8") !== legacyBytes)
    throw new Error("Upgrade rewrote legacy data");
  const runtime = state.runtime();
  const response = await fetch(
    `http://127.0.0.1:${installed.port}/api/v1/runs`,
    {
      headers: {
        authorization: "Bearer " + new ServiceAuth(state).credential(),
      },
    },
  );
  if (
    !response.ok ||
    ((await response.json()) as any).runs.some((run: any) => run.error)
  )
    throw new Error("Mixed-contract runs are unreadable");
  scenarios.push(
    "old read-only ledger and mixed contracts upgrade without data writes",
  );
  const rejected = join(root, "unreadable-bundle");
  cloneBundle(next, rejected, { readable: ["schema-2/contract-2"] });
  try {
    await switchRelease(state, rejected);
    throw new Error("Unreadable upgrade was accepted");
  } catch (error: any) {
    if (error.code !== "INCOMPATIBLE_RELEASE") throw error;
  }
  if (state.runtime().pid !== runtime.pid)
    throw new Error("Preflight stopped the old process");
  scenarios.push("unreadable upgrade rejected before stopping the process");
  const broken = join(root, "broken-bundle");
  cloneBundle(next, broken, { service_version: "0.0.2-ci" }, true);
  try {
    await switchRelease(state, broken);
    throw new Error("Broken build was accepted");
  } catch (error) {
    if (state.config().current_build !== card.upgraded_build_id) throw error;
  }
  if (state.runtime().leases[0]?.expires_at !== expiry)
    throw new Error("Health recovery changed lease expiry");
  await serviceStatus(state);
  scenarios.push(
    "failed real build health restores healthy previous build and exact lease deadline",
  );
  if (state.runtime().leases[0]?.expires_at !== expiry)
    throw new Error("Upgrade changed original lease expiry");
  await switchRelease(state, "", true);
  if (
    state.config().current_build !== build_id ||
    state.runtime().leases[0]?.expires_at !== expiry
  )
    throw new Error("Rollback changed build identity or lease expiry");
  scenarios.push("live upgrade and rollback preserve original lease deadlines");
  await verifyMigrationRollback();
  card.preserved_lease_expiry = expiry;
  state.saveConfig({ ...state.config(), agent_ttl_ms: 1000 });
  const idleExpiry = (await call("renew", "second")).expires_at;
  await waitFor(
    () => state.runtime().phase === "stopped",
    "lease expiry shuts down daemon",
  );
  if (Date.now() < idleExpiry) throw new Error("Exited before lease expiry");
  scenarios.push("idle TTL exit without autostart");
  card.result = "passed";
} catch (error) {
  card.runtime = state.runtime();
  const failure = join(state.paths.state, "startup-failure.json");
  if (existsSync(failure))
    card.startup_failure = JSON.parse(readFileSync(failure, "utf8"));
  const info = Bun.spawnSync(["/bin/launchctl", "print", launchdTarget(state)]);
  card.launchd_diagnostic = info.stdout.toString().slice(0, 16000);
  card.result = "failed";
  card.error = String(error);
  throw error;
} finally {
  unloadUserService(state);
  writeFileSync(evidence, JSON.stringify(card, null, 2) + "\n");
}
