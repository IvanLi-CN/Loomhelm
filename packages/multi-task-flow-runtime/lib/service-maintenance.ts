import { Runtime } from "../../../skills/bin/modules/core/runtime";
import {
  compatibilityReport,
  requireReport,
  type DowngradeApproval,
} from "../lib/service-compatibility";
import {
  chmodSync,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../lib/errors";
import { withExclusiveLockAsync } from "../../../skills/bin/modules/flow/storage";
import {
  PortRegistry,
  defaultRegistryDir,
  processAlive,
} from "../../../skills/bin/modules/workspace/port_registry";
import {
  renameNoReplace,
  readRegularNoFollow,
  writeExclusiveNoFollow,
} from "../../../skills/bin/modules/visual/secure_io";
import { ensureDirectory, readRegular } from "../lib/store";
import { ServiceState } from "../lib/service-state";
import { ServiceAuth } from "../lib/service-auth";
import { verifyRelease, requireSourceRelease } from "../lib/service-release";
import { requireCondition } from "../lib/errors";
import { type ReleaseManifest } from "../lib/service-contract";
import type { ServiceConfig } from "../lib/service-contract";
import { serviceStatus, SERVICE_STARTUP_TIMEOUT_MS, waitForServiceHealth } from "../lib/service-lifecycle";
import {
  unloadUserService,
  writeLaunchdDefinition,
  startUserService,
} from "../lib/service-launchd";

export const PACKAGE_NAME = "@loomhelm/multi-task-flow";
export interface PackageIdentity {
  package_name: string;
  version: string;
  source_sha: string;
  compatibility_line: string;
  skill_version: string;
  build_id: string;
  tarball_digest: string | null;
  package_integrity?: string;
  contracts: { ledger: number; api: number; frontend: number; viewer: number; service: string };
}

export function resolvePackageIdentity(version: string): PackageIdentity {
  requireCondition(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), "INVALID_PACKAGE_VERSION", "Package version must be an exact SemVer");
  const result = Runtime.spawnSync([
    process.execPath, "x", "--bun", "--package", `${PACKAGE_NAME}@${version}`,
    "multi-task-flow", "--version",
  ], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  requireCondition(result.exitCode === 0, "PACKAGE_RESOLUTION_FAILED", "Unable to resolve the exact Dashboard package");
  let identity: PackageIdentity;
  try { identity = JSON.parse(result.stdout.toString("utf8")) as PackageIdentity; }
  catch { throw new ContractError("PACKAGE_IDENTITY_INVALID", "Resolved package did not return a valid identity"); }
  requireCondition(identity.package_name === PACKAGE_NAME && identity.version === version, "PACKAGE_IDENTITY_MISMATCH", "Resolved package identity does not match the requested version");
  requireCondition(/^[a-f0-9]{64}$/.test(identity.build_id) && /^[a-f0-9]{40}$/.test(identity.source_sha), "PACKAGE_IDENTITY_INVALID", "Resolved package identity is incomplete");
  requireCondition(/^compat-v\d+$/.test(identity.compatibility_line), "PACKAGE_IDENTITY_INVALID", "Resolved package compatibility line is invalid");
  const metadataResult = Runtime.spawnSync([process.execPath, "pm", "view", `${PACKAGE_NAME}@${version}`, "--json"], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  requireCondition(metadataResult.exitCode === 0, "PACKAGE_METADATA_FAILED", "Unable to verify registry metadata for the exact Dashboard package");
  try {
    const metadata = JSON.parse(metadataResult.stdout.toString("utf8")) as { dist?: { integrity?: unknown } };
    const integrity = metadata.dist?.integrity;
    requireCondition(typeof integrity === "string" && integrity.startsWith("sha512-"), "PACKAGE_INTEGRITY_INVALID", "Registry metadata did not provide a valid tarball integrity");
    identity.package_integrity = integrity;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("PACKAGE_METADATA_INVALID", "Registry metadata for the exact Dashboard package is invalid");
  }
  return identity;
}

function packageConfig(old: ServiceConfig | null, identity: PackageIdentity, registryDir: string): ServiceConfig {
  return {
    schema_version: 1,
    port: old?.port ?? 0,
    registry_dir: registryDir,
    current_build: identity.build_id,
    previous_build: old?.current_build ?? null,
    agent_ttl_ms: old?.agent_ttl_ms ?? 3_600_000,
    package_name: identity.package_name,
    package_version: identity.version,
    ...(identity.package_integrity ? { package_integrity: identity.package_integrity } : {}),
    compatibility_line: identity.compatibility_line,
    skill_version: identity.skill_version,
    service_contract: identity.contracts.service,
    source_sha: identity.source_sha,
    artifact_build_id: identity.build_id,
  };
}

export async function installPackageRelease(state: ServiceState, version: string, registryDir?: string) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), async () => {
    requireCondition(!existsSync(join(state.paths.config, "service.json")), "ALREADY_INSTALLED", "Use explicit upgrade for an existing installation");
    const identity = resolvePackageIdentity(version);
    const directory = registryDir ? resolve(registryDir) : state.paths.isolated ? join(state.paths.state, "port-registry") : defaultRegistryDir();
    const registry = new PortRegistry(directory);
    const result = await registry.allocate({ scopeId: state.paths.scope, service: "viewer", project: "multi-task-flow", repoRoot: "", branch: "", worktreePath: "" });
    try {
      state.saveConfig({ ...packageConfig(null, identity, directory), port: Number(result.port) });
      new ServiceAuth(state).initialize();
      writeLaunchdDefinition(state);
      return { package_name: PACKAGE_NAME, version: identity.version, build_id: identity.build_id, port: Number(result.port), root: state.paths.root, started: false };
    } finally { await registry.releaseService(state.paths.scope, "viewer"); }
  });
}

export async function upgradePackageRelease(state: ServiceState, version: string) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), async () => {
    const old = state.config();
    const identity = resolvePackageIdentity(version);
    requireCondition(old.package_version !== version || old.package_name !== PACKAGE_NAME, "ALREADY_CURRENT", "The requested package version is already installed");
    unloadUserService(state);
    state.transaction((runtime) => { runtime.phase = "stopped"; runtime.pid = null; });
    state.saveConfig({ ...packageConfig(old, identity, old.registry_dir), port: old.port });
    writeLaunchdDefinition(state);
    return { package_name: PACKAGE_NAME, version: identity.version, build_id: identity.build_id, port: old.port, root: state.paths.root, started: false };
  });
}

export function stageRelease(
  state: ServiceState,
  source: string,
): ReleaseManifest {
  const manifest = verifyRelease(source);
  requireSourceRelease(manifest);
  requireCondition(
    manifest.platform === `${process.platform}-${process.arch}`,
    "INCOMPATIBLE_PLATFORM",
    "Release does not match this platform",
  );
  const target = join(state.paths.releases, manifest.build_id);
  if (existsSync(target)) {
    verifyRelease(target);
    return manifest;
  }
  const staging = join(state.paths.releases, `.stage-${randomUUID()}`);
  ensureDirectory(join(staging, "dist"));
  for (const name of [...Object.keys(manifest.files), "manifest.json"]) {
    ensureDirectory(dirname(join(staging,name)));
    writeExclusiveNoFollow(
      join(staging, name),
      readRegularNoFollow(
        join(source, name),
        source,
        undefined,
        256 * 1024 * 1024,
      ),
      staging,
    );
  }
  chmodSync(join(staging, "viewer"), 0o700);
  verifyRelease(staging);
  renameNoReplace(staging, target, state.paths.root);
  return manifest;
}
export function checkDataCompatibility(
  state: ServiceState,
  manifest: ReleaseManifest,
  approval?: DowngradeApproval,
  strictTargetReadable = false,
): void {
  const report = compatibilityReport(state, manifest);
  requireReport(report, approval);
  if (strictTargetReadable && report.runs.some((run) => !run.target_readable))
    throw new ContractError("INCOMPATIBLE_RELEASE", "Rollback target cannot read every retained run", 2);
}

function versionKey(value: string): number[] {
  return value.replace(/^[^0-9]*/, "").split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
}

export function discoverCandidate(state: ServiceState): ReleaseManifest | null {
  if (!existsSync(state.paths.candidates)) return null;
  const candidates = readdirSync(state.paths.candidates, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(state.paths.candidates, entry.name))
    .map((path) => { try { return verifyRelease(path); } catch { return null; } })
    .filter((manifest): manifest is ReleaseManifest => Boolean(manifest) && manifest!.schema_version === 2)
    .filter((manifest) => manifest.platform === `${process.platform}-${process.arch}`)
    .sort((left, right) => {
      const a = versionKey(right.service_version);
      const b = versionKey(left.service_version);
      for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
      return right.build_id.localeCompare(left.build_id);
    });
  const current = state.config().current_build;
  return candidates.find((manifest) => manifest.build_id !== current) ?? null;
}

export async function installRelease(
  state: ServiceState,
  source: string,
  registryDir?: string,
) {
  state.initialize();
  return withExclusiveLockAsync(
    join(state.paths.state, "startup.lock"),
    async () => {
      requireCondition(
        !existsSync(join(state.paths.config, "service.json")),
        "ALREADY_INSTALLED",
        "Use explicit upgrade for an existing installation",
      );
      const manifest = stageRelease(state, resolve(source));
      checkDataCompatibility(state, manifest);
      const directory = registryDir
        ? resolve(registryDir)
        : state.paths.isolated
          ? join(state.paths.state, "port-registry")
          : defaultRegistryDir();
      const registry = new PortRegistry(directory);
      const result = await registry.allocate({
        scopeId: state.paths.scope,
        service: "viewer",
        project: "multi-task-flow",
        repoRoot: "",
        branch: "",
        worktreePath: "",
      });
      const port = Number(result.port);
      try {
        state.saveConfig({
          schema_version: 1,
          port,
          registry_dir: directory,
          current_build: manifest.build_id,
          previous_build: null,
          agent_ttl_ms: 3_600_000,
        });
        new ServiceAuth(state).initialize();
        writeLaunchdDefinition(state);
        return {
          build_id: manifest.build_id,
          port,
          root: state.paths.root,
          started: false,
        };
      } finally {
        await registry.releaseService(state.paths.scope, "viewer");
      }
    },
  );
}
export const nativeServiceControl = {
  unload: unloadUserService,
  start: startUserService,
  status: serviceStatus,
};
export async function switchRelease(
  state: ServiceState,
  source: string,
  rollback = false,
  control: typeof nativeServiceControl & { startupTimeoutMs?: number } = nativeServiceControl,
  approval?: DowngradeApproval,
) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), () =>
    withExclusiveLockAsync(
      join(state.paths.data, ".maintenance.lock"),
      async () => {
        const old = state.config();
        const startupTimeoutMs = control.startupTimeoutMs ?? SERVICE_STARTUP_TIMEOUT_MS;
        requireCondition(Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0, "INVALID_TIMEOUT", "Startup timeout must be finite and positive");
        const selected = rollback ? old.previous_build : null;
        requireCondition(
          !rollback || selected,
          "NO_PREVIOUS_BUILD",
          "No previous build is available",
        );
        const manifest = rollback
          ? verifyRelease(join(state.paths.releases, selected!))
          : stageRelease(state, resolve(source));
        requireSourceRelease(manifest);
        checkDataCompatibility(state, manifest, approval, rollback);
        if (manifest.build_id === old.current_build)
          return { build_id: manifest.build_id, changed: false };
        const runtime = state.runtime();
        const wasRunning = runtime.pid !== null && processAlive(runtime.pid);
        if (wasRunning) await control.status(state);
        control.unload(state);
        const waitStopped = async () => {
          for (let index = 0; index < 100; index++) {
            const active = state.runtime();
            if (active.pid === null || !processAlive(active.pid)) return;
            await Runtime.sleep(100);
          }
          throw new Error("Viewer did not stop; refusing build switch");
        };
        await waitStopped();
        try {
          state.saveConfig({
            ...old,
            current_build: manifest.build_id,
            previous_build: old.current_build,
          });
          writeLaunchdDefinition(state);
          // Health-check even an initially idle service, using one bounded
          // maintenance lease so installation never becomes permanent startup.
          state.transaction((active) => {
            active.phase = "stopped";
            active.pid = null;
          });
          state.renew(
            { id: "maintenance", kind: "agent", thread_id: null, run_id: null },
            startupTimeoutMs + 30_000,
          );
          control.start(state);
          // Native launchctl calls have their own bounded runtime. Refresh the
          // temporary lease so readiness receives its complete health window.
          state.renew(
            { id: "maintenance", kind: "agent", thread_id: null, run_id: null },
            startupTimeoutMs + 30_000,
          );
          try {
            await waitForServiceHealth(() => control.status(state), startupTimeoutMs);
          } catch {
            throw new Error("New build did not become healthy");
          }
          return { build_id: manifest.build_id, changed: true };
        } catch (error) {
          control.unload(state);
          await waitStopped();
          state.saveConfig(old);
          writeLaunchdDefinition(state);
          state.transaction((active) => {
            active.phase = "stopped";
            active.pid = null;
            active.leases = active.leases.filter(
              (lease) => lease.id !== "maintenance",
            );
          });
          // Recovery may restore old configuration, but cannot launch a legacy v1 package.
          const restartPrevious = wasRunning && verifyRelease(join(state.paths.releases, old.current_build)).schema_version === 2;
          if (restartPrevious) {
            state.renew(
              {
                id: "maintenance",
                kind: "agent",
                thread_id: null,
                run_id: null,
              },
              startupTimeoutMs + 30_000,
            );
            let recovered = false;
            try {
              control.start(state);
              state.renew(
                { id: "maintenance", kind: "agent", thread_id: null, run_id: null },
                startupTimeoutMs + 30_000,
              );
              await waitForServiceHealth(() => control.status(state), startupTimeoutMs);
              recovered = true;
            } catch {}
            requireCondition(
              recovered,
              "ROLLBACK_HEALTH_FAILED",
              "Previous build restored but not healthy; inspect service doctor",
            );
          }
          throw error;
        } finally {
          state.release("maintenance");
        }
      },
    ),
  );
}
