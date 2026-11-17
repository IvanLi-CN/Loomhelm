import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  defaultRegistryDir,
  PortRegistry,
} from "@loomhelm/runtime-core/modules/workspace/port_registry";
import type { WorkerDiagnostic } from "../lib/worker-diagnostics";
import {
  exportGatewayRecovery,
  gatewayDemoPages,
  gatewayDemoResponse,
} from "./export-gateway-recovery";

// A login-free, ledger-free demo of the production Gateway response renderer.
const repoRoot = resolve(import.meta.dir, "../../..");
const scopeId = `loomhelm--${createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}--gateway-recovery`;
const service = "gateway-recovery-demo";
const registry = new PortRegistry(defaultRegistryDir());
const diagnostic: WorkerDiagnostic = {
  diagnostic_id: "diag-6a65efb9-9ecd-404c-8af8-87f9c414ec17",
  run_id: "demo-recovery",
  worker_key: `schema-2/contract-3@${"e9d34f23".repeat(8)}`,
  worker_generation: "unknown-generation",
  stage: "worker_select",
  error_code: "RUN_WORKER_UNAVAILABLE",
  safe_summary: "Viewer worker temporarily unavailable",
  retry_count: 3,
  state: "degraded",
  retryable: false,
  reconnect_required: true,
  first_seen_at: "2026-11-17T03:52:57.867Z",
  last_seen_at: "2026-11-17T03:53:14.536Z",
  recovered_at: null,
};
const exportIndex = process.argv.indexOf("--export");
if (exportIndex >= 0 || process.argv.includes("--build-demo")) {
  const destination =
    exportIndex >= 0
      ? process.argv[exportIndex + 1]
      : resolve(repoRoot, "dist/gateway-recovery-demo");
  if (!destination) throw new Error("--export requires a new output directory");
  console.log(
    JSON.stringify(exportGatewayRecovery(resolve(destination), diagnostic, exportIndex < 0)),
  );
  process.exit(0);
}
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};
const scene = option("--scenario", "ready");
const theme = option("--theme", "system");
const run = option("--run-id", "demo-recovery");
const wait = option("--wait-ms", scene === "ready" ? "0" : scene === "recover" ? "3000" : "10000");
if (!["ready", "cooldown", "recover"].includes(scene)) throw new Error("Unknown demo scenario");
if (!["light", "dark", "system"].includes(theme)) throw new Error("Unknown demo theme");
if (!Number.isFinite(Number(wait)) || Number(wait) < 0 || Number(wait) > 60000)
  throw new Error("--wait-ms must be between 0 and 60000");
if (run.length > 128) throw new Error("--run-id is limited to 128 characters");
const pages = gatewayDemoPages(diagnostic);
const allocation = await registry.allocate({
  scopeId,
  service,
  project: "loomhelm",
  repoRoot,
  worktreePath: repoRoot,
});
const port = Number(allocation.port);
const server = await registry.claimAndRun({ scopeId, service, port, pid: process.pid }, () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => gatewayDemoResponse(request, pages),
  }),
);
const url = new URL(`http://127.0.0.1:${port}/runs/demo-recovery/`);
url.search = new URLSearchParams({
  demo: "gateway-recovery",
  d_state: scene,
  d_theme: theme,
  d_run_id: run,
  d_wait_ms: wait,
  plan: "example",
  tab: "timeline",
}).toString();
url.hash = "task-one";
const heartbeat = setInterval(
  () =>
    void registry.heartbeat({ scopeId, service, port, pid: process.pid, expectedPid: process.pid }),
  60_000,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  try {
    // Release while still listening: the registry sweeps stopped listeners before fencing ownership.
    await registry.releaseService(scopeId, service, undefined, undefined, {
      port,
      pid: process.pid,
    });
  } finally {
    await server.stop(true);
  }
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(
  JSON.stringify({
    port,
    scope: scopeId,
    pid: process.pid,
    source: repoRoot,
    scenario: scene,
    url: url.href,
    runtime: "browser-mock",
  }),
);
