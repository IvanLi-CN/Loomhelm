import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Runtime } from "@loomhelm/runtime-core/modules/core/runtime";
import { withExclusiveLockAsync } from "@loomhelm/runtime-core/modules/flow/storage";
import {
  readRegularNoFollow,
  renameNoReplace,
  writeExclusiveNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import {
  defaultRegistryDir,
  PortRegistry,
  processAlive,
} from "@loomhelm/runtime-core/modules/workspace/port_registry";
import { ContractError, requireCondition } from "../lib/errors";
import { ServiceAuth } from "../lib/service-auth";
import {
  compatibilityReport,
  type DowngradeApproval,
  requireReport,
} from "../lib/service-compatibility";
import type { ReleaseManifest, ServiceConfig } from "../lib/service-contract";
import {
  startUserService,
  unloadUserService,
  writeLaunchdDefinition,
} from "../lib/service-launchd";
import {
  SERVICE_STARTUP_TIMEOUT_MS,
  serviceStatus,
  waitForServiceHealth,
} from "../lib/service-lifecycle";
import { requireSourceRelease, verifyRelease } from "../lib/service-release";
import type { ServiceState } from "../lib/service-state";
import { ensureDirectory, readRegular, writeAtomic } from "../lib/store";

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
  requireCondition(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "INVALID_PACKAGE_VERSION",
    "Package version must be an exact SemVer",
  );
  const result = Runtime.spawnSync(
    [
      process.execPath,
      "x",
      "--bun",
      "--package",
      `${PACKAGE_NAME}@${version}`,
      "multi-task-flow",
      "--version",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
  );
  requireCondition(
    result.exitCode === 0,
    "PACKAGE_RESOLUTION_FAILED",
    "Unable to resolve the exact Dashboard package",
  );
  let identity: PackageIdentity;
  try {
    identity = JSON.parse(result.stdout.toString("utf8")) as PackageIdentity;
  } catch {
    throw new ContractError(
      "PACKAGE_IDENTITY_INVALID",
      "Resolved package did not return a valid identity",
    );
  }
  requireCondition(
    identity.package_name === PACKAGE_NAME && identity.version === version,
    "PACKAGE_IDENTITY_MISMATCH",
    "Resolved package identity does not match the requested version",
  );
  requireCondition(
    /^[a-f0-9]{64}$/.test(identity.build_id) && /^[a-f0-9]{40}$/.test(identity.source_sha),
    "PACKAGE_IDENTITY_INVALID",
    "Resolved package identity is incomplete",
  );
  requireCondition(
    /^compat-v\d+$/.test(identity.compatibility_line),
    "PACKAGE_IDENTITY_INVALID",
    "Resolved package compatibility line is invalid",
  );
  const metadataResult = Runtime.spawnSync(
    [process.execPath, "pm", "view", `${PACKAGE_NAME}@${version}`, "--json"],
    { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
  );
  requireCondition(
    metadataResult.exitCode === 0,
    "PACKAGE_METADATA_FAILED",
    "Unable to verify registry metadata for the exact Dashboard package",
  );
  try {
    const metadata = JSON.parse(metadataResult.stdout.toString("utf8")) as {
      dist?: { integrity?: unknown };
    };
    const integrity = metadata.dist?.integrity;
    requireCondition(
      typeof integrity === "string" && integrity.startsWith("sha512-"),
      "PACKAGE_INTEGRITY_INVALID",
      "Registry metadata did not provide a valid tarball integrity",
    );
    identity.package_integrity = integrity;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(
      "PACKAGE_METADATA_INVALID",
      "Registry metadata for the exact Dashboard package is invalid",
    );
  }
  return identity;
}

export function resolvePackageTarget(target: string): PackageIdentity {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) return resolvePackageIdentity(target);
  const result = Runtime.spawnSync(
    [process.execPath, "pm", "view", `${PACKAGE_NAME}@${target}`, "version", "--json"],
    { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
  );
  requireCondition(
    result.exitCode === 0,
    "PACKAGE_RESOLUTION_FAILED",
    "Unable to resolve the requested package tag",
  );
  let version: unknown;
  try {
    version = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    version = undefined;
  }
  const resolved = Array.isArray(version) ? version[0] : version;
  requireCondition(
    typeof resolved === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(resolved),
    "PACKAGE_RESOLUTION_FAILED",
    "Package tag did not resolve to an exact SemVer",
  );
  return resolvePackageIdentity(resolved);
}

function packageConfig(
  old: ServiceConfig | null,
  identity: PackageIdentity,
  registryDir: string,
): ServiceConfig {
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
    ledger_contract: identity.contracts.ledger,
    api_contract: identity.contracts.api,
    frontend_contract: identity.contracts.frontend,
    viewer_contract: identity.contracts.viewer,
    source_sha: identity.source_sha,
    artifact_build_id: identity.build_id,
  };
}

export function assertPackageUpgradeCompatible(old: ServiceConfig, next: PackageIdentity): void {
  if (!old.package_name) return;
  requireCondition(
    old.package_name === PACKAGE_NAME,
    "INCOMPATIBLE_RELEASE",
    "The installed service is not a supported package profile",
  );
  requireCondition(
    old.compatibility_line === next.compatibility_line,
    "INCOMPATIBLE_RELEASE",
    "Package compatibility line changed; explicit migration is required",
  );
  requireCondition(
    !old.service_contract || old.service_contract === next.contracts.service,
    "INCOMPATIBLE_RELEASE",
    "Package service contract changed; explicit migration is required",
  );
  requireCondition(
    old.ledger_contract === undefined || old.ledger_contract === next.contracts.ledger,
    "INCOMPATIBLE_RELEASE",
    "Package ledger contract changed; explicit migration is required",
  );
  requireCondition(
    old.api_contract === undefined || old.api_contract === next.contracts.api,
    "INCOMPATIBLE_RELEASE",
    "Package API contract changed; explicit migration is required",
  );
  requireCondition(
    old.frontend_contract === undefined || old.frontend_contract === next.contracts.frontend,
    "INCOMPATIBLE_RELEASE",
    "Package frontend contract changed; explicit migration is required",
  );
  requireCondition(
    old.viewer_contract === undefined || old.viewer_contract === next.contracts.viewer,
    "INCOMPATIBLE_RELEASE",
    "Package viewer contract changed; explicit migration is required",
  );
}

export async function installPackageRelease(
  state: ServiceState,
  version: string,
  registryDir?: string,
) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), async () => {
    requireCondition(
      !existsSync(join(state.paths.config, "service.json")),
      "ALREADY_INSTALLED",
      "Use explicit upgrade for an existing installation",
    );
    const identity = resolvePackageIdentity(version);
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
    try {
      state.saveConfig({ ...packageConfig(null, identity, directory), port: Number(result.port) });
      new ServiceAuth(state).initialize();
      writeLaunchdDefinition(state);
      return {
        package_name: PACKAGE_NAME,
        version: identity.version,
        build_id: identity.build_id,
        port: Number(result.port),
        root: state.paths.root,
        started: false,
      };
    } finally {
      await registry.releaseService(state.paths.scope, "viewer");
    }
  });
}

async function upgradePackageReleaseLocked(state: ServiceState, version: string) {
  const old = state.config();
  const identity = resolvePackageIdentity(version);
  requireCondition(
    old.package_version !== version || old.package_name !== PACKAGE_NAME,
    "ALREADY_CURRENT",
    "The requested package version is already installed",
  );
  assertPackageUpgradeCompatible(old, identity);
  const oldPlistPath = join(state.paths.config, "viewer.plist");
  const oldPlist = existsSync(oldPlistPath) ? readFileSync(oldPlistPath, "utf8") : null;
  const wasRunning = state.runtime().phase === "running";
  const nextConfig = { ...packageConfig(old, identity, old.registry_dir), port: old.port };
  try {
    state.saveConfig(nextConfig);
    writeLaunchdDefinition(state);
    unloadUserService(state);
    state.transaction((runtime) => {
      runtime.phase = "stopped";
      runtime.pid = null;
    });
    return {
      package_name: PACKAGE_NAME,
      version: identity.version,
      build_id: identity.build_id,
      port: old.port,
      root: state.paths.root,
      started: false,
    };
  } catch (error) {
    state.saveConfig(old);
    if (oldPlist !== null) writeAtomic(oldPlistPath, oldPlist);
    if (wasRunning) {
      try {
        startUserService(state);
      } catch {
        /* Preserve the original failure and runtime evidence. */
      }
    }
    throw error;
  }
}

export async function upgradePackageRelease(state: ServiceState, version: string) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), () =>
    upgradePackageReleaseLocked(state, version),
  );
}

export interface PackageUpgradeControl {
  upgrade: typeof upgradePackageRelease;
  start: typeof startUserService;
  unload?: typeof unloadUserService;
  status: typeof serviceStatus;
  waitForHealth: typeof waitForServiceHealth;
  startupTimeoutMs?: number;
}

type GatewayFailureCode =
  | "GATEWAY_START_FAILED"
  | "GATEWAY_HEALTH_TIMEOUT"
  | "GATEWAY_ROLLBACK_FAILED";
type GatewayFailureDetails = {
  phase: "lease" | "start" | "health" | "rollback";
  target_version: string;
  previous_version: string | null;
  last_health_code: string | null;
  rollback_status: "not_attempted" | "restored" | "failed";
  upgrade_code?: string;
  upgrade_health_code?: string;
  rollback_code?: string;
  rollback_health_code?: string;
};

const PACKAGE_MAINTENANCE_LEASE_ID = "maintenance";
const PACKAGE_MAINTENANCE_LEASE_EXTRA_MS = 30_000;

function safeFailureCode(error: unknown): string {
  if (error instanceof ContractError && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "SERVICE_ERROR";
}

function gatewayFailure(
  code: GatewayFailureCode,
  message: string,
  details: GatewayFailureDetails,
): ContractError {
  return new ContractError(code, message, 2, details);
}

function renewPackageMaintenanceLease(state: ServiceState, timeoutMs: number): void {
  state.renew(
    { id: PACKAGE_MAINTENANCE_LEASE_ID, kind: "agent", thread_id: null, run_id: null },
    timeoutMs + PACKAGE_MAINTENANCE_LEASE_EXTRA_MS,
  );
}

async function startAndWaitForPackageGateway(
  state: ServiceState,
  control: PackageUpgradeControl,
  targetVersion: string,
  previousVersion: string | null,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof serviceStatus>>> {
  try {
    control.start(state);
    renewPackageMaintenanceLease(state, timeoutMs);
  } catch (error) {
    throw gatewayFailure("GATEWAY_START_FAILED", "Gateway did not start", {
      phase: "start",
      target_version: targetVersion,
      previous_version: previousVersion,
      last_health_code: safeFailureCode(error),
      rollback_status: "not_attempted",
    });
  }
  try {
    return await control.waitForHealth(() => control.status(state), timeoutMs);
  } catch (error) {
    throw gatewayFailure(
      "GATEWAY_HEALTH_TIMEOUT",
      "Gateway did not become healthy before the startup deadline",
      {
        phase: "health",
        target_version: targetVersion,
        previous_version: previousVersion,
        last_health_code: safeFailureCode(error),
        rollback_status: "not_attempted",
      },
    );
  }
}

async function rollbackPackageGateway(
  state: ServiceState,
  control: PackageUpgradeControl,
  previousVersion: string,
  timeoutMs: number,
  leaseHeld: boolean,
  onLeaseEstablished: () => void,
): Promise<void> {
  if (leaseHeld) renewPackageMaintenanceLease(state, timeoutMs);
  await control.upgrade(state, previousVersion);
  if (!leaseHeld) {
    renewPackageMaintenanceLease(state, timeoutMs);
    onLeaseEstablished();
  }
  await startAndWaitForPackageGateway(state, control, previousVersion, null, timeoutMs);
}

function gatewayRollbackFailure(
  failure: ContractError,
  rollbackError: unknown,
  targetVersion: string,
  previousVersion: string | null,
): ContractError {
  const rollbackDetails =
    rollbackError instanceof ContractError &&
    typeof rollbackError.details === "object" &&
    rollbackError.details !== null
      ? (rollbackError.details as Partial<GatewayFailureDetails>)
      : {};
  const failureDetails =
    typeof failure.details === "object" && failure.details !== null
      ? (failure.details as Partial<GatewayFailureDetails>)
      : {};
  return gatewayFailure(
    "GATEWAY_ROLLBACK_FAILED",
    "Gateway upgrade failed and the previous build could not be restored",
    {
      phase: "rollback",
      target_version: targetVersion,
      previous_version: previousVersion,
      last_health_code: failureDetails.last_health_code ?? null,
      rollback_status: "failed",
      upgrade_code: failure.code,
      upgrade_health_code: failureDetails.last_health_code,
      rollback_code: safeFailureCode(rollbackError),
      rollback_health_code: rollbackDetails.last_health_code,
    },
  );
}

export const packageUpgradeControl: PackageUpgradeControl = {
  upgrade: upgradePackageReleaseLocked,
  start: startUserService,
  unload: unloadUserService,
  status: serviceStatus,
  waitForHealth: waitForServiceHealth,
};

type PreviousGatewayProfile = {
  config: ServiceConfig;
  plist: string | null;
};

function restorePreviousGatewayProfile(state: ServiceState, profile: PreviousGatewayProfile): void {
  state.saveConfig(profile.config);
  const plistPath = join(state.paths.config, "viewer.plist");
  if (profile.plist === null) {
    if (existsSync(plistPath)) unlinkSync(plistPath);
  } else {
    writeAtomic(plistPath, profile.plist);
  }
  state.transaction((runtime) => {
    runtime.phase = "stopped";
    runtime.pid = null;
  });
}

async function rollbackSourceGateway(
  state: ServiceState,
  control: PackageUpgradeControl,
  profile: PreviousGatewayProfile,
  timeoutMs: number,
  leaseHeld: boolean,
  onLeaseEstablished: () => void,
): Promise<void> {
  if (leaseHeld) renewPackageMaintenanceLease(state, timeoutMs);
  control.unload?.(state);
  restorePreviousGatewayProfile(state, profile);
  if (!leaseHeld) {
    renewPackageMaintenanceLease(state, timeoutMs);
    onLeaseEstablished();
  }
  await startAndWaitForPackageGateway(state, control, "source", null, timeoutMs);
}

export async function upgradePackageReleaseAndStart(
  state: ServiceState,
  version: string,
  control: PackageUpgradeControl = packageUpgradeControl,
) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), async () => {
    const previousProfile: PreviousGatewayProfile = {
      config: state.config(),
      plist: (() => {
        const path = join(state.paths.config, "viewer.plist");
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      })(),
    };
    const oldVersion = previousProfile.config.package_version ?? null;
    const timeoutMs = control.startupTimeoutMs ?? SERVICE_STARTUP_TIMEOUT_MS;
    requireCondition(
      Number.isFinite(timeoutMs) && timeoutMs > 0,
      "INVALID_TIMEOUT",
      "Startup timeout must be finite and positive",
    );
    const result = await control.upgrade(state, version);
    let maintenanceLease = false;
    try {
      try {
        renewPackageMaintenanceLease(state, timeoutMs);
        maintenanceLease = true;
      } catch (error) {
        const failure = gatewayFailure(
          "GATEWAY_START_FAILED",
          "Gateway startup lease could not be established",
          {
            phase: "lease",
            target_version: version,
            previous_version: oldVersion,
            last_health_code: safeFailureCode(error),
            rollback_status: "not_attempted",
          },
        );
        try {
          if (oldVersion && oldVersion !== version) {
            await rollbackPackageGateway(state, control, oldVersion, timeoutMs, false, () => {
              maintenanceLease = true;
            });
          } else {
            await rollbackSourceGateway(state, control, previousProfile, timeoutMs, false, () => {
              maintenanceLease = true;
            });
          }
        } catch (rollbackError) {
          throw gatewayRollbackFailure(failure, rollbackError, version, oldVersion);
        }
        throw new ContractError(failure.code, failure.message, failure.exitCode, {
          ...(failure.details as GatewayFailureDetails),
          rollback_status: "restored",
        });
      }
      try {
        const health = await startAndWaitForPackageGateway(
          state,
          control,
          version,
          oldVersion,
          timeoutMs,
        );
        return { ...result, started: true, health };
      } catch (error) {
        const failure =
          error instanceof ContractError &&
          (error.code === "GATEWAY_START_FAILED" || error.code === "GATEWAY_HEALTH_TIMEOUT")
            ? error
            : gatewayFailure("GATEWAY_START_FAILED", "Gateway startup failed", {
                phase: "start",
                target_version: version,
                previous_version: oldVersion,
                last_health_code: safeFailureCode(error),
                rollback_status: "not_attempted",
              });
        try {
          if (oldVersion && oldVersion !== version) {
            await rollbackPackageGateway(state, control, oldVersion, timeoutMs, true, () => {});
          } else {
            await rollbackSourceGateway(state, control, previousProfile, timeoutMs, true, () => {});
          }
        } catch (rollbackError) {
          throw gatewayRollbackFailure(failure, rollbackError, version, oldVersion);
        }
        throw new ContractError(failure.code, failure.message, failure.exitCode, {
          ...(failure.details as GatewayFailureDetails),
          rollback_status: "restored",
        });
      }
    } finally {
      if (maintenanceLease) state.release(PACKAGE_MAINTENANCE_LEASE_ID);
    }
  });
}

export function stageRelease(state: ServiceState, source: string): ReleaseManifest {
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
    ensureDirectory(dirname(join(staging, name)));
    writeExclusiveNoFollow(
      join(staging, name),
      readRegularNoFollow(join(source, name), source, undefined, 256 * 1024 * 1024),
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
    throw new ContractError(
      "INCOMPATIBLE_RELEASE",
      "Rollback target cannot read every retained run",
      2,
    );
}

function versionKey(value: string): number[] {
  return value
    .replace(/^[^0-9]*/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number(part) || 0);
}

export function discoverCandidate(state: ServiceState): ReleaseManifest | null {
  if (!existsSync(state.paths.candidates)) return null;
  const candidates = readdirSync(state.paths.candidates, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(state.paths.candidates, entry.name))
    .map((path) => {
      try {
        return verifyRelease(path);
      } catch {
        return null;
      }
    })
    .filter(
      (manifest): manifest is ReleaseManifest =>
        Boolean(manifest) && manifest!.schema_version === 2,
    )
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

export async function installRelease(state: ServiceState, source: string, registryDir?: string) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), async () => {
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
  });
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
    withExclusiveLockAsync(join(state.paths.data, ".maintenance.lock"), async () => {
      const old = state.config();
      const startupTimeoutMs = control.startupTimeoutMs ?? SERVICE_STARTUP_TIMEOUT_MS;
      requireCondition(
        Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0,
        "INVALID_TIMEOUT",
        "Startup timeout must be finite and positive",
      );
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
          active.leases = active.leases.filter((lease) => lease.id !== "maintenance");
        });
        // Recovery may restore old configuration, but cannot launch a legacy v1 package.
        const restartPrevious =
          wasRunning &&
          verifyRelease(join(state.paths.releases, old.current_build)).schema_version === 2;
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
    }),
  );
}
