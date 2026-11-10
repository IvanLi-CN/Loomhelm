import type { ConnectObserver } from "../lib/conversation-output";
import { Runtime } from "../../bin/modules/core/runtime";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tryLockFile } from "../../bin/modules/core/security_file";
import { withExclusiveLockAsync } from "../../bin/modules/flow/storage";
import {
  PortRegistry,
  RegistryError,
  processAlive,
} from "../../bin/modules/workspace/port_registry";
import { ServiceState } from "../lib/service-state";
import { ServiceAuth } from "../lib/service-auth";
import { startSharedViewer, agentLease } from "../lib/service-http";
import { requireApi } from "../lib/service-contract";
import { startUserService } from "../lib/service-launchd";
import { verifyRelease, requireSourceRelease } from "../lib/service-release";
import { requireCondition, ContractError } from "../lib/errors";
import { serviceLog } from "../lib/service-log";

export const SERVICE_STARTUP_TIMEOUT_MS = 60_000;
export async function waitForServiceHealth<T>(check: () => Promise<T>, timeoutMs = SERVICE_STARTUP_TIMEOUT_MS): Promise<T> {
  requireCondition(Number.isFinite(timeoutMs) && timeoutMs > 0, "INVALID_TIMEOUT", "Startup timeout must be finite and positive");
  const deadline = performance.now() + timeoutMs;
  let failure: unknown;
  do {
    try { return await check(); } catch (error) { failure = error; }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await Runtime.sleep(Math.min(100, remaining));
  } while (performance.now() < deadline);
  throw failure;
}

export async function serviceStatus(state: ServiceState) {
  const config = state.config();
  const response = await fetch(
    `http://127.0.0.1:${config.port}/api/v1/status`,
    {
      headers: {
        authorization: "Bearer " + new ServiceAuth(state).credential(),
      },
      signal: AbortSignal.timeout(1500),
    },
  );
  requireCondition(
    response.ok,
    "SERVICE_UNAVAILABLE",
    "Viewer is unavailable or belongs to another instance",
  );
  const result = (await response.json()) as {
    ok: boolean;
    build_id: string;
    source_sha: string;
    compatibility: { api_versions: number[] };
    generation: string;
    pid: number;
    port: number;
  };
  const runtime = state.runtime();
  requireCondition(
    result.ok &&
      result.build_id === config.current_build &&
      result.generation === runtime.generation &&
      result.pid === runtime.pid &&
      result.port === config.port,
    "INSTANCE_MISMATCH",
    "Viewer health identity mismatch",
  );
  return result;
}
export async function ensureService(
  state: ServiceState,
  input: { run_id: string; thread_id: string; api_version: number },
  start = () => startUserService(state),
) {
  requireApi(input.api_version);
  requireCondition(
    existsSync(join(state.paths.config, "service.json")),
    "SERVICE_NOT_INSTALLED",
    "Viewer is not installed; use explicit service install maintenance",
  );
  state.initialize();
  const { discoverCandidate, switchRelease } = await import("../lib/service-maintenance");
  const candidate = discoverCandidate(state);
  if (candidate) {
    await switchRelease(state, join(state.paths.candidates, candidate.build_id));
  }
  return withExclusiveLockAsync(
    join(state.paths.state, "startup.lock"),
    async () => {
      const config = state.config();
      const manifest = verifyRelease(
        join(state.paths.releases, config.current_build),
      );
      requireSourceRelease(manifest);
      requireCondition(
        manifest.api_versions.includes(input.api_version),
        "INCOMPATIBLE_API",
        "Installed build requires explicit maintenance",
      );
      for (let attempt = 0; ; attempt++) {
        requireCondition(
          attempt < 100,
          "SERVICE_STOPPING",
          "Viewer did not finish stopping",
        );
        state.transaction((runtime) => {
          if (runtime.pid !== null && !processAlive(runtime.pid)) {
            runtime.phase = "stopped";
            runtime.pid = null;
          }
        });
        try {
          state.renew(
            agentLease({ ...input, api_version: 1 }),
            config.agent_ttl_ms,
          );
          break;
        } catch (error) {
          if (
            !(error instanceof ContractError) ||
            error.code !== "SERVICE_STOPPING"
          )
            throw error;
          await Runtime.sleep(100);
        }
      }
      try {
        const current = await serviceStatus(state);
        return {
          ...current,
          url: `http://127.0.0.1:${config.port}/runs/${encodeURIComponent(input.run_id)}/`,
        };
      } catch {}
      start();
      try {
        const current = await waitForServiceHealth(() => serviceStatus(state));
        return {
          ...current,
          url: `http://127.0.0.1:${config.port}/runs/${encodeURIComponent(input.run_id)}/`,
        };
      } catch {}
      throw new ContractError(
        "SERVICE_START_FAILED",
        "Viewer did not become healthy; use service doctor",
      );
    },
  );
}

export async function runDaemon(
  state: ServiceState,
  source?: {
    manifest: import("../lib/service-contract").ReleaseManifest;
    name?: string;
    assetsDir: string;
    revision: () => string;
    connectObserver?: ConnectObserver;
    demoHooks?: Pick<import("../lib/server-contract").DashboardOptions, "connectObserver" | "archiveProvider" | "getProfileCapabilities">;
  },
) {
  requireCondition(
    !source || state.paths.isolated,
    "INVALID_PROFILE",
    "Source preview requires an isolated service profile",
  );
  state.initialize();
  const config = state.config();
  const manifest =
    source?.manifest ??
    verifyRelease(join(state.paths.releases, config.current_build));
  // Isolated live-source previews use metadata, not an installed release package.
  // Installed services must still reject legacy executable bundles.
  if (!source) requireSourceRelease(manifest);
  const lifetime = tryLockFile(join(state.paths.state, "instance.lock"));
  requireCondition(
    lifetime,
    "SERVICE_ALREADY_RUNNING",
    "Another viewer instance is running",
  );
  const generation = randomUUID();
  const registry = new PortRegistry(config.registry_dir);
  let viewer: Awaited<ReturnType<typeof startSharedViewer>> | undefined;
  let reserved = false;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Diagnostics must not turn a recovered heartbeat into another outage.
  const log = (event: Parameters<typeof serviceLog>[1], details: Record<string, unknown> = {}) => {
    try { serviceLog(state.paths, event, generation, manifest.build_id, details); }
    catch { console.error("VIEWER_DIAGNOSTIC_WRITE_FAILED"); }
  };
  type ShutdownReason =
    | "requested"
    | "SIGTERM"
    | "SIGINT"
    | "leases_expired"
    | "lease_state_error"
    | "registry_heartbeat_error"
    | "startup_error";
  type ShutdownErrorCode = "REGISTRY_LOCK_TIMEOUT" | "INTERNAL_ERROR";
  const shutdown = (reason: ShutdownReason = "requested", errorCode?: ShutdownErrorCode) => {
    if (stopping) return stopping;
    const stopStartedAt = new Date().toISOString();
    stopping = (async () => {
      log("stopping", {stop_reason: reason, stop_started_at: stopStartedAt, ...(errorCode ? {error_code: errorCode} : {})});
      clearInterval(timer);
      clearInterval(heartbeat);
      try {
        state.transaction((runtime) => {
          if (runtime.generation === generation && runtime.pid === process.pid)
            runtime.phase = "stopping";
        });
        if (reserved)
          await registry
            .releaseService(state.paths.scope, "viewer", 24, 10, {
              port: config.port,
              pid: process.pid,
            })
            .catch(() => {
              process.exitCode = 1;
            });
        await viewer?.stop();
        state.stopped(generation);
        log("stopped", {
          stop_reason: reason,
          stop_started_at: stopStartedAt,
          stop_completed_at: new Date().toISOString(),
          ...(errorCode ? { error_code: errorCode } : {}),
          leases: state.runtime().leases.map((lease) => ({
            kind: lease.kind,
            run_id: lease.run_id,
            expires_at: lease.expires_at,
          })),
        });
      } finally {
        lifetime.release();
        process.removeListener("SIGTERM", terminate);
        process.removeListener("SIGINT", interrupt);
      }
    })();
    return stopping;
  };
  const terminate = () => { void shutdown("SIGTERM"); };
  const interrupt = () => { void shutdown("SIGINT"); };
  // Only this typed registry failure is known to be transient. Unknown errors
  // and ownership changes still fence the viewer immediately. No error message
  // enters logs: messages may contain private paths or command inputs.
  let heartbeatFailures = 0;
  const errorCode = (error: unknown) =>
    error instanceof RegistryError &&
    error.code === "REGISTRY_LOCK_TIMEOUT"
      ? "REGISTRY_LOCK_TIMEOUT" : "INTERNAL_ERROR";
  try {
    state.transaction((runtime) => {
      runtime.generation = generation;
      runtime.pid = process.pid;
      runtime.phase = "starting";
    });
    await registry.register({
      scopeId: state.paths.scope,
      service: "viewer",
      port: config.port,
      project: "multi-task-flow",
      expectedPid: null,
      createIfMissing: true,
    });
    reserved = true;
    await registry.claimAndRun(
      {
        scopeId: state.paths.scope,
        service: "viewer",
        port: config.port,
        pid: process.pid,
      },
      async () => {
        viewer = await startSharedViewer(
          state,
          manifest,
          source?.assetsDir ??
            join(state.paths.releases, config.current_build, "skills/multi-task-flow/dist"),
          config.port,
          source?.revision,
          source?.name,
          source ? { ...source.demoHooks, connectObserver: source.demoHooks?.connectObserver ?? source.connectObserver } : undefined,
          Boolean(source),
        );
        return viewer;
      },
    );
    log("started");
    state.transaction((runtime) => {
      requireCondition(
        runtime.generation === generation,
        "INSTANCE_REPLACED",
        "Viewer generation changed",
      );
      runtime.phase = "running";
    });
    timer = setInterval(() => {
      if (!stopping)
        try {
          if (state.expire(generation)) void shutdown("leases_expired");
        } catch (error) {
          void shutdown("lease_state_error", errorCode(error));
        }
    }, 1000);
    let heartbeating = false;
    heartbeat = setInterval(() => {
      if (stopping || heartbeating) return;
      heartbeating = true;
      void registry
        .heartbeat({
          scopeId: state.paths.scope,
          service: "viewer",
          port: config.port,
          pid: process.pid,
          expectedPid: process.pid,
        })
        .then(() => {
          if (stopping) return;
          if (heartbeatFailures) log("maintenance_recovered", { operation: "registry_heartbeat" });
          heartbeatFailures = 0;
        })
        .catch((error) => {
          if (stopping) return;
          const code = errorCode(error);
          heartbeatFailures++;
          if (code !== "REGISTRY_LOCK_TIMEOUT" || heartbeatFailures >= 3)
            return shutdown("registry_heartbeat_error", code);
          log("maintenance_failed", { operation: "registry_heartbeat", error_code: code, consecutive_failures: heartbeatFailures });
        })
        .finally(() => {
          heartbeating = false;
        });
    }, 30_000);
    process.once("SIGTERM", terminate);
    process.once("SIGINT", interrupt);
    return { generation, pid: process.pid, stop: () => shutdown() };
  } catch (error) {
    await shutdown("startup_error", errorCode(error));
    throw error;
  }
}
