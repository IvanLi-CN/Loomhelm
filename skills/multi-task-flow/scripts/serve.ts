import { fileURLToPath } from "node:url";
import { Runtime } from "../../bin/modules/core/runtime";
import { homedir } from "node:os";
import { join } from "node:path";
import { ContractError, requireCondition } from "./errors";
import { defaultRoot, safeId } from "./store";
import { startDashboard } from "./server";
import {
  defaultRegistryDir,
  PortRegistry,
  RegistryError,
} from "../../bin/modules/workspace/port_registry";

const args = process.argv.slice(2);
function flag(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  requireCondition(
    !!value && !value.startsWith("--"),
    "INVALID_ARGUMENTS",
    `Missing ${name}`,
  );
  return value;
}

function optionalFlag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  requireCondition(
    !!value && !value.startsWith("--"),
    "INVALID_ARGUMENTS",
    `Missing ${name}`,
  );
  return value;
}

function registryJson(
  registry: string,
  command: string,
  options: string[],
  failureCode = "LEASE_OPERATION_FAILED",
): Record<string, unknown> {
  const result = Runtime.spawnSync(
    [process.execPath, "--no-install", registry, "--json", command, ...options],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = result.stderr.toString().trim();
  requireCondition(
    result.exitCode === 0,
    failureCode,
    stderr || `Port lease command failed: ${command}`,
    5,
  );
  try {
    return JSON.parse(result.stdout.toString());
  } catch {
    throw new ContractError(
      failureCode,
      `Port lease command returned invalid JSON: ${command}`,
      5,
    );
  }
}

let scope = "";
let service = "";
let port = 0;
let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let leaseRegistered = false;
let shutdownPromise: Promise<void> | undefined;

const registry = fileURLToPath(new URL('../../global-port-manager/scripts/port_registry.' + (import.meta.url.endsWith('.js') ? 'js' : 'ts'), import.meta.url));

async function shutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    let finalCode = exitCode;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (leaseRegistered) {
      try {
        registryJson(registry, "release-service", [
          "--scope-id",
          scope,
          "--service",
          service,
          "--port",
          String(port),
          "--pid",
          String(process.pid),
        ]);
      } catch {
        finalCode = 1;
      }
      leaseRegistered = false;
    }
    try {
      await dashboard?.stop();
    } catch {
      finalCode = 1;
    }
    dashboard = undefined;
    process.exitCode = finalCode;
  })();
  return shutdownPromise;
}

try {
  const runId = safeId(flag("--run"));
  scope = flag("--scope-id");
  service = flag("--service");
  port = Number(flag("--port"));
  const agentSession = optionalFlag("--agent-session");
  requireCondition(
    Number.isInteger(port) && port > 0 && port <= 65535,
    "INVALID_PORT",
    "An allocated port is required",
  );
  const root = process.env.TASK_ORCHESTRATION_DATA_ROOT ?? defaultRoot();
  const assetsDir = args.includes("--custom-view")
    ? join(root, "runs", runId, "view")
    : join(import.meta.dir, "..", "dist");
  const portRegistry = new PortRegistry(defaultRegistryDir());
  const activeDashboard = await portRegistry
    .claimAndRun(
      {
        scopeId: scope,
        service,
        port,
        pid: process.pid,
        ...(agentSession === undefined ? {} : { agentSession }),
      },
      async () => {
        const startedDashboard = await startDashboard({
          root,
          runId,
          port,
          assetsDir,
        });
        // Publish the cleanup handle before claim verification or persistence.
        dashboard = startedDashboard;
        return startedDashboard;
      },
    )
    .catch((error) => {
      if (error instanceof RegistryError)
        throw new ContractError("LEASE_UNAVAILABLE", error.message, 5);
      throw error;
    });
  dashboard = activeDashboard;
  leaseRegistered = true;
  const heartbeatLease = () => {
    const heartbeatOptions = [
      "--scope-id",
      scope,
      "--service",
      service,
      "--port",
      String(port),
      "--pid",
      String(process.pid),
      "--expected-pid",
      String(process.pid),
    ];
    if (agentSession) heartbeatOptions.push("--agent-session", agentSession);
    registryJson(registry, "heartbeat", heartbeatOptions);
  };
  try {
    heartbeatLease();
  } catch {
    throw new ContractError(
      "LEASE_HEARTBEAT_FAILED",
      "Port lease heartbeat failed",
      5,
    );
  }
  heartbeatTimer = setInterval(() => {
    if (shutdownPromise) return;
    try {
      heartbeatLease();
    } catch {
      console.error(
        JSON.stringify({
          ok: false,
          code: "LEASE_HEARTBEAT_FAILED",
          message: "Port lease heartbeat failed",
        }),
      );
      void shutdown(5);
    }
  }, 30_000);
  console.log(
    JSON.stringify({
      ok: true,
      url: `http://127.0.0.1:${activeDashboard.port}/s/${activeDashboard.token}/`,
      port: activeDashboard.port,
      scope_id: scope,
      service,
      agent_session_recorded: Boolean(agentSession),
    }),
  );
  const close = () => {
    void shutdown(0);
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (error) {
  const code = error instanceof ContractError ? error.code : "SERVER_ERROR";
  console.error(
    JSON.stringify({
      ok: false,
      code,
      message: error instanceof Error ? error.message : "Server failed",
    }),
  );
  await shutdown(error instanceof ContractError ? error.exitCode : 1);
}
