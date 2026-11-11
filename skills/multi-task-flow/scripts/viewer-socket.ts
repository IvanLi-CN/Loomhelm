import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { z } from "zod";
import {
  viewerWorkerKeySchema,
  type ViewerWorkerRequestContext,
} from "./viewer-runtime";

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_500;

const requestFrame = z
  .object({
    type: z.literal("request"),
    id: z.string().min(1),
    method: z.string().regex(/^[A-Z]+$/),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()),
    body: z.string().optional(),
    worker_key: z.string().min(1),
    generation: z.string().min(1),
    run_id: z.string().min(1),
  })
  .strict();

const responseFrame = z
  .object({
    type: z.literal("response"),
    id: z.string().min(1),
    status: z.number().int().min(100).max(599),
    status_text: z.string(),
    headers: z.record(z.string(), z.string()),
  })
  .strict();

const chunkFrame = z
  .object({
    type: z.literal("chunk"),
    id: z.string().min(1),
    data: z.string(),
  })
  .strict();

const endFrame = z
  .object({ type: z.literal("end"), id: z.string().min(1) })
  .strict();

const errorFrame = z
  .object({
    type: z.literal("error"),
    id: z.string().min(1).optional(),
    code: z.string().min(1),
  })
  .strict();

type Frame =
  | z.infer<typeof requestFrame>
  | z.infer<typeof responseFrame>
  | z.infer<typeof chunkFrame>
  | z.infer<typeof endFrame>
  | z.infer<typeof errorFrame>;

export type UnixViewerWorkerServerOptions = {
  socketPath: string;
  workerKey: string;
  generation: string;
  handle(
    request: Request,
    context: ViewerWorkerRequestContext & { generation: string },
  ): Response | Promise<Response>;
  maxFrameBytes?: number;
};

export type UnixViewerWorkerServer = {
  readonly socketPath: string;
  readonly workerKey: string;
  readonly generation: string;
  stop(): Promise<void>;
};

export type UnixViewerWorkerClientOptions = {
  socketPath: string;
  workerKey: string;
  generation: string;
  id?: string;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
};

function requireIdentity(value: string, label: string): string {
  if (!value || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value;
}

function maxFrameBytes(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 1_024 ||
    value > 64 * 1024 * 1024
  )
    return DEFAULT_MAX_FRAME_BYTES;
  return value;
}

/** Derive a short socket name so macOS' Unix path limit is not exceeded. */
export function viewerWorkerSocketPath(
  directory: string,
  workerKey: string,
  generation: string,
): string {
  requireIdentity(workerKey, "worker key");
  requireIdentity(generation, "worker generation");
  if (!isAbsolute(directory)) throw new Error("socket directory must be absolute");
  const identity = createHash("sha256")
    .update(workerKey)
    .update("\0")
    .update(generation)
    .digest("hex")
    .slice(0, 40);
  return `${directory}/worker-${identity}.sock`;
}

function assertPrivateSocketDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error("socket path must be absolute");
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw new Error("socket directory must be a regular directory");
  if (realpathSync(directory) !== directory)
    throw new Error("socket directory must be canonical");
  if ((directoryStat.mode & 0o077) !== 0)
    throw new Error("socket directory must be private");
}

function prepareSocketPath(path: string): void {
  assertPrivateSocketDirectory(path);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink())
    throw new Error("socket path is occupied by a non-socket");
  unlinkSync(path);
}

function encodeFrame(frame: Frame, maximum: number): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.byteLength > maximum) throw new Error("viewer socket frame is too large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function writeFrame(socket: Socket, frame: Frame, maximum: number): void {
  if (!socket.destroyed) socket.write(encodeFrame(frame, maximum));
}

class FrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maximum: number) {}

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > this.maximum) throw new Error("viewer socket frame is too large");
      if (this.buffer.byteLength < length + 4) break;
      const body = this.buffer.subarray(4, length + 4).toString("utf8");
      this.buffer = this.buffer.subarray(length + 4);
      frames.push(JSON.parse(body) as Frame);
    }
    return frames;
  }
}

function requestFromFrame(frame: z.infer<typeof requestFrame>): Request {
  const body = frame.body === undefined ? undefined : Buffer.from(frame.body, "base64");
  return new Request(frame.url, {
    method: frame.method,
    headers: frame.headers,
    ...(body === undefined || frame.method === "GET" || frame.method === "HEAD"
      ? {}
      : { body }),
  });
}

async function serveRequest(
  socket: Socket,
  frame: z.infer<typeof requestFrame>,
  options: UnixViewerWorkerServerOptions,
  maximum: number,
): Promise<void> {
  if (frame.worker_key !== options.workerKey)
    throw new Error("viewer worker key mismatch");
  if (frame.generation !== options.generation)
    throw new Error("viewer worker generation mismatch");
  const request = requestFromFrame(frame);
  const response = await options.handle(request, {
    runId: frame.run_id,
    workerKey: frame.worker_key,
    generation: frame.generation,
  });
  writeFrame(
    socket,
    {
      type: "response",
      id: frame.id,
      status: response.status,
      status_text: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    },
    maximum,
  );
  if (!response.body) {
    writeFrame(socket, { type: "end", id: frame.id }, maximum);
    return;
  }
  const reader = response.body.getReader();
  try {
    while (!socket.destroyed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      writeFrame(
        socket,
        { type: "chunk", id: frame.id, data: Buffer.from(chunk.value).toString("base64") },
        maximum,
      );
    }
  } finally {
    reader.releaseLock();
  }
  if (!socket.destroyed) writeFrame(socket, { type: "end", id: frame.id }, maximum);
}

export async function startUnixViewerWorkerServer(
  options: UnixViewerWorkerServerOptions,
): Promise<UnixViewerWorkerServer> {
  viewerWorkerKeySchema.parse(options.workerKey);
  requireIdentity(options.generation, "worker generation");
  const maximum = maxFrameBytes(options.maxFrameBytes);
  prepareSocketPath(options.socketPath);
  const server: Server = createServer((socket) => {
    const decoder = new FrameDecoder(maximum);
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const value of frames) {
        if (handled) {
          socket.destroy();
          return;
        }
        const parsed = requestFrame.safeParse(value);
        if (!parsed.success) {
          writeFrame(socket, { type: "error", code: "INVALID_REQUEST" }, maximum);
          socket.end();
          return;
        }
        handled = true;
        void serveRequest(socket, parsed.data, options, maximum).catch(() => {
          if (!socket.destroyed)
            writeFrame(socket, { type: "error", id: parsed.data.id, code: "WORKER_REQUEST_FAILED" }, maximum);
          socket.destroy();
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });
  chmodSync(options.socketPath, 0o600);
  let stopped = false;
  return {
    socketPath: options.socketPath,
    workerKey: options.workerKey,
    generation: options.generation,
    async stop() {
      if (stopped) return;
      stopped = true;
      server.close();
      await once(server, "close").catch(() => undefined);
      if (existsSync(options.socketPath)) {
        const stat = lstatSync(options.socketPath);
        if (stat.isSocket() && !stat.isSymbolicLink()) unlinkSync(options.socketPath);
      }
    },
  };
}

export function connectUnixViewerWorker(
  options: UnixViewerWorkerClientOptions,
  request: Request,
  context: ViewerWorkerRequestContext & { generation?: string },
): Promise<Response> {
  viewerWorkerKeySchema.parse(options.workerKey);
  requireIdentity(options.generation, "worker generation");
  if (context.workerKey !== options.workerKey)
    return Promise.reject(new Error("viewer worker key mismatch"));
  if (context.generation && context.generation !== options.generation)
    return Promise.reject(new Error("viewer worker generation mismatch"));
  const maximum = maxFrameBytes(options.maxFrameBytes);
  const id = options.id ?? randomUUID();
  const connectTimeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(connectTimeout) || connectTimeout <= 0)
    return Promise.reject(new Error("viewer socket connect timeout is invalid"));
  return new Promise<Response>(async (resolve, reject) => {
    let socket: Socket | undefined;
    let responseStarted = false;
    let settled = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const decoder = new FrameDecoder(maximum);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket?.destroy();
        reject(new Error("viewer worker socket connection timed out"));
      }
    }, connectTimeout);
    const fail = (error: Error) => {
      clearTimeout(timer);
      if (responseStarted) {
        controller?.error(error);
        return;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel(reason) {
        socket?.destroy(reason instanceof Error ? reason : undefined);
      },
    });
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer()).toString("base64");
    socket = createConnection({ path: options.socketPath });
    socket.once("connect", () => {
      writeFrame(
        socket!,
        {
          type: "request",
          id,
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers.entries()),
          ...(body === undefined ? {} : { body }),
          worker_key: options.workerKey,
          generation: options.generation,
          run_id: context.runId,
        },
        maximum,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("invalid viewer socket frame"));
        socket?.destroy();
        return;
      }
      for (const value of frames) {
        const response = responseFrame.safeParse(value);
        if (response.success) {
          if (response.data.id !== id || responseStarted) {
            fail(new Error("viewer worker response identity mismatch"));
            socket?.destroy();
            return;
          }
          responseStarted = true;
          clearTimeout(timer);
          resolve(
            new Response(stream, {
              status: response.data.status,
              statusText: response.data.status_text,
              headers: response.data.headers,
            }),
          );
          continue;
        }
        const chunkFrameValue = chunkFrame.safeParse(value);
        if (chunkFrameValue.success) {
          if (chunkFrameValue.data.id !== id || !responseStarted) {
            fail(new Error("viewer worker chunk identity mismatch"));
            socket?.destroy();
            return;
          }
          controller?.enqueue(Buffer.from(chunkFrameValue.data.data, "base64"));
          continue;
        }
        const end = endFrame.safeParse(value);
        if (end.success) {
          if (end.data.id !== id || !responseStarted) {
            fail(new Error("viewer worker end identity mismatch"));
            socket?.destroy();
            return;
          }
          settled = true;
          controller?.close();
          socket?.end();
          continue;
        }
        const errorFrameValue = errorFrame.safeParse(value);
        if (errorFrameValue.success) {
          fail(new Error(errorFrameValue.data.code));
          socket?.destroy();
          return;
        }
        fail(new Error("invalid viewer worker response"));
        socket?.destroy();
        return;
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      if (responseStarted && !settled) fail(new Error("viewer worker socket closed"));
      else if (!responseStarted && !settled) fail(new Error("viewer worker socket closed"));
    });
  });
}
