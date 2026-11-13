import { Runtime } from "../../bin/modules/core/runtime";
import { ViewerWorkerPool, type ViewerWorker, type ViewerWorkerKey } from "./viewer-runtime";

export type ViewerRoute = {
  runId: string;
  path: string;
  workerKey: ViewerWorkerKey;
};

export type ViewerGatewayOptions = {
  port: number;
  hostname?: string;
  singletonKey?: string;
  pool?: ViewerWorkerPool;
  workerFactory?: (key: ViewerWorkerKey) => ViewerWorker | Promise<ViewerWorker>;
  resolveRoute: (request: Request, runId: string) => ViewerRoute | Promise<ViewerRoute>;
  fetchPublic?: (request: Request, server: unknown) => Response | Promise<Response>;
};

export type SharedViewerGateway = {
  readonly port: number;
  readonly pool: ViewerWorkerPool;
  readonly references: number;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
};

type GatewayEntry = {
  gateway: SharedViewerGatewayImpl;
  references: number;
};

const gateways = new Map<string, GatewayEntry>();
const gatewayStarts = new Map<string, Promise<SharedViewerGatewayImpl>>();

function routePath(url: URL): { runId: string; path: string } | null {
  const match = url.pathname.match(/^\/(?:api\/v1\/)?runs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(\/.*)?$/);
  if (!match) return null;
  const path = "/" + (match[2] ?? "").replace(/^\/+/, "");
  return { runId: match[1]!, path: path === "/" ? "/" : path };
}

function releaseAfterBody(
  response: Response,
  release: () => void,
  onFailure?: () => void | Promise<unknown>,
): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        void Promise.resolve(onFailure?.()).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

class SharedViewerGatewayImpl implements SharedViewerGateway {
  private readonly server: { port?: number; stop(closeActive?: boolean): Promise<void> };
  private stopped = false;
  private refs = 1;

  private constructor(
    private readonly options: ViewerGatewayOptions,
    server: { port?: number; stop(closeActive?: boolean): Promise<void> },
    readonly pool: ViewerWorkerPool,
  ) {
    this.server = server;
  }

  static async create(options: ViewerGatewayOptions, pool: ViewerWorkerPool): Promise<SharedViewerGatewayImpl> {
    const server = await Runtime.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port,
      async fetch(request, currentServer) {
        const publicResponse = await options.fetchPublic?.(request, currentServer);
        if (publicResponse) return publicResponse;
        const route = routePath(new URL(request.url));
        if (!route) return new Response("Not found", { status: 404 });
        const resolved = await options.resolveRoute(request, route.runId);
        if (resolved.runId !== route.runId || resolved.path !== route.path)
          return new Response("Route identity mismatch", { status: 500 });
        const lease = await pool.acquire(resolved.workerKey);
        try {
          const response = await lease.worker.handle(request, currentServer, resolved.path, {
            runId: resolved.runId,
            workerKey: resolved.workerKey,
            generation: lease.generation,
          });
          return releaseAfterBody(
            response,
            lease.release,
            () => pool.invalidate(resolved.workerKey, lease.generation),
          );
        } catch (error) {
          lease.release();
          await pool.invalidate(resolved.workerKey, lease.generation);
          throw error;
        }
      },
    });
    return new SharedViewerGatewayImpl(options, server, pool);
  }

  get port(): number {
    return this.server.port!;
  }

  get references(): number {
    return this.refs;
  }

  retain(): void {
    if (this.stopped) throw new Error("viewer gateway is stopped");
    this.refs += 1;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.refs > 1) {
      this.refs -= 1;
      return;
    }
    await this.forceStop();
  }

  async forceStop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.options.singletonKey) gateways.delete(this.options.singletonKey);
    await this.server.stop(true);
    if (!this.options.pool) await this.pool.stop();
  }
}

/** Start or retain the one gateway associated with a singleton key. */
export async function startSharedViewerGateway(options: ViewerGatewayOptions): Promise<SharedViewerGateway> {
  const key = options.singletonKey;
  if (key) {
    const existing = gateways.get(key);
    if (existing) {
      existing.gateway.retain();
      existing.references += 1;
      return existing.gateway;
    }
    const pending = gatewayStarts.get(key);
    if (pending) {
      const gateway = await pending;
      gateway.retain();
      return gateway;
    }
  }
  const pool = options.pool ?? new ViewerWorkerPool({
    workerFactory: options.workerFactory ?? (async () => {
      throw new Error("A worker pool or worker factory is required");
    }),
  });
  const creating = SharedViewerGatewayImpl.create(options, pool);
  if (key) gatewayStarts.set(key, creating);
  let gateway: SharedViewerGatewayImpl;
  try {
    gateway = await creating;
  } finally {
    if (key && gatewayStarts.get(key) === creating) gatewayStarts.delete(key);
  }
  if (key) gateways.set(key, { gateway, references: 1 });
  return gateway;
}

export function activeViewerGateways(): number {
  return gateways.size;
}

export function clearViewerGatewayRegistry(): void {
  gateways.clear();
  gatewayStarts.clear();
}

export { routePath as parseViewerRoute };
