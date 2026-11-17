import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeParams, initializeScope } from "./invocation-initialize-recovery";
import { digest, invocationSignal, registerInvocationResource } from "./invocation-journal";
import { nativeOperation } from "./native-operation-context";

const transports = new WeakMap<Socket, { id: string | null; requests: number }>();

type JsonRecord = Record<string, unknown>;
export function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
export function socketPath(): string | null {
  const configured = (
    process.env.LOOMHELM_CODEX_APP_SERVER_SOCKET ?? process.env.CODEX_APP_SERVER_SOCKET
  )?.trim();
  if (configured) return configured;
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const candidate = join(root, "app-server-control", "app-server-control.sock");
  return existsSync(candidate) ? candidate : null;
}
export function timeoutMs(): number {
  const value = Number(process.env.MULTI_TASK_FLOW_CODEX_AGENT_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value >= 1_000 && value <= 300_000 ? value : 30_000;
}
export function websocketFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1)
    masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}
export function framePayload(
  buffer: Buffer,
): { payload: Buffer; consumed: number; opcode: number } | null {
  if (buffer.length < 2) return null;
  const code = buffer[1]! & 0x7f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let offset = 2;
  let length = code;
  if (code === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (code === 127) {
    if (buffer.length < 10) return null;
    const n = buffer.readBigUInt64BE(2);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
    length = Number(n);
    offset = 10;
  }
  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const start = offset + maskOffset;
  const payload = Buffer.from(buffer.subarray(start, start + length));
  if (mask)
    for (let index = 0; index < payload.length; index += 1)
      payload[index] = payload[index]! ^ mask[index % 4]!;
  return { payload, consumed: start + length, opcode: buffer[0]! & 0x0f };
}
export function parseRpc(value: Buffer): JsonRecord | null {
  try {
    return record(JSON.parse(value.toString("utf8")));
  } catch {
    return null;
  }
}

export async function connectSocket(
  path: string,
  connectionTimeoutMs = timeoutMs(),
): Promise<{ socket: Socket; buffer: Buffer }> {
  const transport = registerInvocationResource("codex-transport", { path_digest: digest(path) });
  const socket = createConnection(path);
  transports.set(socket, { id: transport.id, requests: 0 });
  const signal = invocationSignal();
  const stop = () => socket.destroy();
  signal?.addEventListener("abort", stop, { once: true });
  socket.once("close", () => {
    signal?.removeEventListener("abort", stop);
    transport.end({ local_transport_closed: true });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => onError(new Error("Codex app-server closed before connection"));
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(
        () => onError(new Error("Codex app-server socket connection timed out")),
        connectionTimeoutMs,
      );
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    const key = randomBytes(16).toString("base64");
    socket.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    let header = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () =>
        onError(new Error("Codex app-server closed during WebSocket handshake"));
      const timer = setTimeout(
        () => onError(new Error("Codex app-server WebSocket handshake timed out")),
        connectionTimeoutMs,
      );
      const onData = (chunk: Buffer) => {
        header = Buffer.concat([header, chunk]);
        const boundary = header.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        cleanup();
        const response = header.subarray(0, boundary + 4).toString("utf8");
        const expected = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        if (
          !response.startsWith("HTTP/1.1 101") ||
          !response.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)
        ) {
          reject(new Error("Codex app-server WebSocket handshake was rejected"));
          return;
        }
        header = header.subarray(boundary + 4);
        resolve();
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    return { socket, buffer: header };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function rpc(
  socket: Socket,
  buffer: { value: Buffer },
  id: number | string,
  method: string,
  params: JsonRecord,
  options: { timeoutMs?: number } = {},
): Promise<JsonRecord> {
  const transport = transports.get(socket);
  const connectionInitialize =
    !!transport &&
    transport.requests === 0 &&
    id === 1 &&
    method === "initialize" &&
    digest(params) === digest(initializeParams);
  if (transport) transport.requests++;
  const resource = registerInvocationResource("codex-request", {
    id,
    method,
    params_digest: digest(params),
    thread_id: params.threadId ?? null,
    attempt_id: params.clientUserMessageId ?? null,
    ...(transport?.id ? { transport_id: transport.id } : {}),
    ...(connectionInitialize ? { effect_scope: initializeScope } : {}),
    ...(nativeOperation() ? { operation: nativeOperation() } : {}),
  });
  try {
    return await new Promise<JsonRecord>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const fail = (error: Error) => {
        cleanup();
        if (connectionInitialize) socket.destroy();
        reject(error);
      };
      const onClose = () => fail(new Error("Codex app-server closed the WebSocket"));
      const onError = (error: Error) => fail(error);
      const timer = setTimeout(
        () => fail(new Error(`Codex app-server timed out waiting for ${method}`)),
        options.timeoutMs ?? timeoutMs(),
      );
      const onData = (chunk: Buffer) => {
        try {
          buffer.value = Buffer.concat([buffer.value, chunk]);
          let matched: JsonRecord | undefined;
          while (true) {
            const frame = framePayload(buffer.value);
            if (!frame) break;
            buffer.value = buffer.value.subarray(frame.consumed);
            if (frame.opcode === 8) {
              onClose();
              return;
            }
            const parsed = parseRpc(frame.payload);
            if (parsed?.id === id) matched = parsed;
          }
          if (!matched) return;
          cleanup();
          resource.end({ id, method, response_digest: digest(matched) });
          resolve(matched);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.once("error", onError);
      socket.write(websocketFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      onData(Buffer.alloc(0));
    });
  } catch (error) {
    resource.unknown();
    throw error;
  }
}

export async function startTurnAndWait(
  socket: Socket,
  buffer: { value: Buffer },
  params: JsonRecord,
  threadId: string,
): Promise<JsonRecord> {
  const requestId = 3;
  const resource = registerInvocationResource("codex-turn", {
    thread_id: threadId,
    request_id: requestId,
    params_digest: digest(params),
    attempt_id: params.clientUserMessageId ?? null,
  });
  try {
    return await new Promise<JsonRecord>((resolve, reject) => {
      let response: JsonRecord | undefined;
      const terminals = new Map<string, JsonRecord>();
      const cleanup = () => {
        clearTimeout(deadline);
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => fail(new Error("Codex app-server closed before turn completion"));
      const onError = (error: Error) => fail(error);
      const deadline = setTimeout(
        () => fail(new Error("Codex app-server timed out waiting for turn completion")),
        timeoutMs(),
      );
      const finish = () => {
        const turnId = record(record(response?.result)?.turn)?.id;
        if (typeof turnId !== "string") return;
        const terminal = terminals.get(turnId);
        if (!terminal || !response) return;
        const status = record(terminal.turn)?.status;
        if (!["completed", "failed", "interrupted"].includes(String(status))) return;
        cleanup();
        resource.end({
          thread_id: threadId,
          turn_id: turnId,
          status,
          response_digest: digest(response),
          terminal_digest: digest(terminal),
        });
        if (status === "completed") resolve(response);
        else reject(new Error(`turn ended with status ${status}`));
      };
      const onData = (chunk: Buffer) => {
        try {
          buffer.value = Buffer.concat([buffer.value, chunk]);
          while (true) {
            const frame = framePayload(buffer.value);
            if (!frame) break;
            buffer.value = buffer.value.subarray(frame.consumed);
            if (frame.opcode === 8) {
              onClose();
              return;
            }
            const message = parseRpc(frame.payload);
            if (!message) continue;
            if (message.id === requestId) {
              response = message;
              if (message.error) {
                resource.end({
                  thread_id: threadId,
                  rejected: true,
                  response_digest: digest(message),
                });
                fail(new Error(String(record(message.error)?.message ?? "turn/start rejected")));
                return;
              }
            } else if (message.method === "turn/completed") {
              const notification = record(message.params);
              const turnId = record(notification?.turn)?.id;
              if (notification?.threadId === threadId && typeof turnId === "string")
                terminals.set(turnId, notification!);
            }
          }
          finish();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.once("error", onError);
      socket.write(
        websocketFrame(
          JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "turn/start", params }),
        ),
      );
      onData(Buffer.alloc(0));
    });
  } catch (error) {
    resource.unknown();
    throw error;
  }
}
