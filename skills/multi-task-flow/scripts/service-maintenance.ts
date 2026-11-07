import { Runtime } from "../../bin/modules/core/runtime";
import {
  compatibilityReport,
  requireReport,
  type DowngradeApproval,
} from "./service-compatibility";
import {
  chmodSync,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withExclusiveLockAsync } from "../../bin/modules/flow/storage";
import {
  PortRegistry,
  defaultRegistryDir,
  processAlive,
} from "../../bin/modules/workspace/port_registry";
import {
  renameNoReplace,
  readRegularNoFollow,
  writeExclusiveNoFollow,
} from "../../bin/modules/visual/secure_io";
import { ensureDirectory, readRegular } from "./store";
import { ServiceState } from "./service-state";
import { ServiceAuth } from "./service-auth";
import { verifyRelease, releaseFiles } from "./service-release";
import { requireCondition } from "./errors";
import { type ReleaseManifest } from "./service-contract";
import { serviceStatus } from "./service-lifecycle";
import {
  unloadUserService,
  writeLaunchdDefinition,
  startUserService,
} from "./service-launchd";

export function stageRelease(
  state: ServiceState,
  source: string,
): ReleaseManifest {
  const manifest = verifyRelease(source);
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
  for (const name of [...Object.keys(manifest.files), "manifest.json"])
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
  chmodSync(join(staging, "viewer"), 0o700);
  verifyRelease(staging);
  renameNoReplace(staging, target, state.paths.root);
  return manifest;
}
export function checkDataCompatibility(
  state: ServiceState,
  manifest: ReleaseManifest,
  approval?: DowngradeApproval,
): void {
  requireReport(compatibilityReport(state, manifest), approval);
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
  control = nativeServiceControl,
  approval?: DowngradeApproval,
) {
  state.initialize();
  return withExclusiveLockAsync(join(state.paths.state, "startup.lock"), () =>
    withExclusiveLockAsync(
      join(state.paths.data, ".maintenance.lock"),
      async () => {
        const old = state.config();
        const selected = rollback ? old.previous_build : null;
        requireCondition(
          !rollback || selected,
          "NO_PREVIOUS_BUILD",
          "No previous build is available",
        );
        const manifest = rollback
          ? verifyRelease(join(state.paths.releases, selected!))
          : stageRelease(state, resolve(source));
        checkDataCompatibility(state, manifest, approval);
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
            30_000,
          );
          control.start(state);
          for (let index = 0; index < 100; index++) {
            try {
              await control.status(state);
              state.release("maintenance");
              return { build_id: manifest.build_id, changed: true };
            } catch {
              await Runtime.sleep(100);
            }
          }
          throw new Error("New build did not become healthy");
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
          if (wasRunning) {
            state.renew(
              {
                id: "maintenance",
                kind: "agent",
                thread_id: null,
                run_id: null,
              },
              30_000,
            );
            control.start(state);
            let recovered = false;
            for (let index = 0; index < 100; index++) {
              try {
                await control.status(state);
                recovered = true;
                break;
              } catch {
                await Runtime.sleep(100);
              }
            }
            state.release("maintenance");
            requireCondition(
              recovered,
              "ROLLBACK_HEALTH_FAILED",
              "Previous build restored but not healthy; inspect service doctor",
            );
          }
          throw error;
        }
      },
    ),
  );
}
