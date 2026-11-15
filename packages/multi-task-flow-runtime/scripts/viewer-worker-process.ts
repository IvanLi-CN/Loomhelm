import { startUnixViewerWorkerServer } from "./viewer-socket";

const socketPath = process.env.MTF_WORKER_SOCKET;
const workerKey = process.env.MTF_WORKER_KEY;
const generation = process.env.MTF_WORKER_GENERATION;
const bridgeUrl = process.env.MTF_WORKER_BRIDGE_URL;
const bridgeToken = process.env.MTF_WORKER_BRIDGE_TOKEN;
if (!socketPath || !workerKey || !generation || !bridgeUrl || !bridgeToken) throw new Error("worker process configuration is incomplete");

const server = await startUnixViewerWorkerServer({
  socketPath,
  workerKey,
  generation,
  handle: async (request, context) => {
    const headers = new Headers(request.headers);
    headers.set("x-mtf-worker-token", bridgeToken);
    headers.set("x-mtf-worker-run-id", context.runId);
    headers.set("x-mtf-worker-path", new URL(request.url).pathname + new URL(request.url).search);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
    return fetch(bridgeUrl, { method: request.method, headers, body, duplex: body ? "half" : undefined } as RequestInit);
  },
});

const stop = async () => { await server.stop(); process.exit(0); };
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
