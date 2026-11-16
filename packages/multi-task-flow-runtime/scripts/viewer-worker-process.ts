import { join } from "node:path";
import { createRunDashboard } from "../lib/server";
import { selectAssets } from "../lib/service-http";
import { parseViewerRoute } from "./viewer-gateway";
import { startUnixViewerWorkerServer } from "./viewer-socket";

const socketPath = process.env.MTF_WORKER_SOCKET;
const workerKey = process.env.MTF_WORKER_KEY;
const generation = process.env.MTF_WORKER_GENERATION;
const dataRoot = process.env.MTF_WORKER_DATA_ROOT;
const workerPort = Number(process.env.MTF_WORKER_PORT ?? 0);
const assetsRoot = process.env.MTF_WORKER_ASSETS ?? join(import.meta.dir, "../dist");
if (
  !socketPath ||
  !workerKey ||
  !generation ||
  !dataRoot ||
  !Number.isInteger(workerPort) ||
  workerPort <= 0
)
  throw new Error("worker process configuration is incomplete");
const resources = new Map<string, ReturnType<typeof createRunDashboard>>();
function getRun(runId: string) {
  const existing = resources.get(runId);
  if (existing) return existing;
  const selectedAssets = selectAssets(dataRoot!, runId, assetsRoot);
  const run = createRunDashboard({
    root: dataRoot!,
    runId,
    port: workerPort,
    assetsDir: selectedAssets.path,
  });
  resources.set(runId, run);
  return run;
}

const server = await startUnixViewerWorkerServer({
  socketPath,
  workerKey,
  generation,
  handle: async (request, context) => {
    const route = parseViewerRoute(new URL(request.url));
    if (!route || route.runId !== context.runId)
      throw new Error("viewer worker route identity mismatch");
    const path =
      new URL(request.url).pathname.startsWith("/api/v1/") && !route.path.startsWith("/api/")
        ? "/api" + route.path
        : route.path;
    return getRun(context.runId).handle(request, { timeout() {} }, path);
  },
});

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
