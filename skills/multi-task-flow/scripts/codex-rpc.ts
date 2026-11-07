import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
type JsonRecord = Record<string, unknown>;
export function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
export function socketPath(): string | null {
  const configured = (process.env.LOOMHELM_CODEX_APP_SERVER_SOCKET ?? process.env.CODEX_APP_SERVER_SOCKET)?.trim();
  if (configured) return configured;
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const candidate = join(root, "app-server-control", "app-server-control.sock");
  return existsSync(candidate) ? candidate : null;
}
export function timeoutMs(): number {
  const value = Number(
    process.env.MULTI_TASK_FLOW_CODEX_AGENT_TIMEOUT_MS ?? 30_000,
  );
  return Number.isFinite(value) && value >= 1_000 && value <= 300_000
    ? value
    : 30_000;
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
    if (n > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("WebSocket frame is too large");
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
): Promise<{ socket: Socket; buffer: Buffer }> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Codex app-server socket connection timed out")),
      timeoutMs(),
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  let header = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Codex app-server WebSocket handshake timed out")),
      timeoutMs(),
    );
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const boundary = header.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      const response = header.subarray(0, boundary + 4).toString("utf8");
      const expected = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      if (
        !response.startsWith("HTTP/1.1 101") ||
        !response
          .toLowerCase()
          .includes(`sec-websocket-accept: ${expected.toLowerCase()}`)
      ) {
        reject(new Error("Codex app-server WebSocket handshake was rejected"));
        return;
      }
      header = header.subarray(boundary + 4);
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return { socket, buffer: header };
}

export async function rpc(
  socket: Socket,
  buffer: { value: Buffer },
  id: number | string,
  method: string,
  params: JsonRecord,
): Promise<JsonRecord> {
  socket.write(
    websocketFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Codex app-server timed out waiting for ${method}`)),
      timeoutMs(),
    );
    const onData = (chunk: Buffer) => {
      buffer.value = Buffer.concat([buffer.value, chunk]);
      while (true) {
        const frame = framePayload(buffer.value);
        if (!frame) return;
        buffer.value = buffer.value.subarray(frame.consumed);
        if (frame.opcode === 8) {
          clearTimeout(timer);
          socket.off("data", onData);
          reject(new Error("Codex app-server closed the WebSocket"));
          return;
        }
        const response = parseRpc(frame.payload);
        if (!response || response.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(response);
        return;
      }
    };
    socket.on("data", onData);
  });
}

export async function startTurnAndWait(
  socket: Socket,
  buffer: { value: Buffer },
  params: JsonRecord,
  threadId: string,
): Promise<JsonRecord> {
  const requestId = 3;
  socket.write(
    websocketFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "turn/start",
        params,
      }),
    ),
  );
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      socket.off("data", onData);
      reject(
        new Error("Codex app-server timed out waiting for turn completion"),
      );
    }, timeoutMs());
    let response: JsonRecord | undefined;
    let completed = false;
    const finish = () => {
      if (!response || !completed) return;
      clearTimeout(deadline);
      socket.off("data", onData);
      resolve(response);
    };
    const onData = (chunk: Buffer) => {
      buffer.value = Buffer.concat([buffer.value, chunk]);
      while (true) {
        const frame = framePayload(buffer.value);
        if (!frame) return;
        buffer.value = buffer.value.subarray(frame.consumed);
        if (frame.opcode === 8) {
          clearTimeout(deadline);
          socket.off("data", onData);
          reject(new Error("Codex app-server closed the WebSocket"));
          return;
        }
        const message = parseRpc(frame.payload);
        if (!message) continue;
        if (message.id === requestId) {
          response = message;
          if (message.error) {
            clearTimeout(deadline);
            socket.off("data", onData);
            reject(
              new Error(
                String(record(message.error)?.message ?? "turn/start rejected"),
              ),
            );
            return;
          }
          finish();
          continue;
        }
        if (message.method !== "turn/completed") continue;
        const notification = record(message.params);
        if (notification?.threadId !== threadId) continue;
        const status = record(notification.turn)?.status;
        if (status === "completed") completed = true;
        else if (status === "failed" || status === "interrupted") {
          clearTimeout(deadline);
          socket.off("data", onData);
          reject(new Error(`turn ended with status ${status}`));
          return;
        }
        finish();
      }
    };
    socket.on("data", onData);
    onData(Buffer.alloc(0));
  });
}
