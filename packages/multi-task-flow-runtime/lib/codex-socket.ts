import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
export type JsonRecord = Record<string, unknown>;

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
export function websocketFrame(text: string | Buffer, opcode = 1): Buffer {
  const payload = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126)
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
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
): { payload: Buffer; consumed: number } | null {
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
  if (length > 64 * 1024 * 1024)
    throw new Error("WebSocket frame exceeds observer limit");
  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const start = offset + maskOffset;
  const payload = Buffer.from(buffer.subarray(start, start + length));
  if (mask)
    for (let index = 0; index < payload.length; index += 1)
      payload[index] = payload[index]! ^ mask[index % 4]!;
  return { payload, consumed: start + length };
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
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", connected);
        socket.off("error", failed);
        socket.off("close", ended);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const ended = () =>
        failed(new Error("Codex socket closed during connection"));
      const connected = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(
        () => failed(new Error("Codex socket connection timed out")),
        timeoutMs(),
      );
      socket.once("connect", connected);
      socket.once("error", failed);
      socket.once("close", ended);
    });
    const key = randomBytes(16).toString("base64");
    let header = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", failed);
        socket.off("close", ended);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const ended = () =>
        failed(new Error("Codex socket closed during handshake"));
      const onData = (chunk: Buffer) => {
        header = Buffer.concat([header, chunk]);
        const boundary = header.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (header.length > 16384)
            failed(new Error("Codex handshake headers too large"));
          return;
        }
        const response = header.subarray(0, boundary).toString("utf8");
        const expected = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        const accept = response
          .split("\r\n")
          .find((line) => /^sec-websocket-accept:/i.test(line))
          ?.split(":")
          .slice(1)
          .join(":")
          .trim();
        if (!response.startsWith("HTTP/1.1 101 ") || accept !== expected) {
          failed(
            new Error("Codex app-server WebSocket handshake was rejected"),
          );
          return;
        }
        header = header.subarray(boundary + 4);
        cleanup();
        resolve();
      };
      const timer = setTimeout(
        () =>
          failed(new Error("Codex app-server WebSocket handshake timed out")),
        timeoutMs(),
      );
      socket.on("data", onData);
      socket.once("error", failed);
      socket.once("close", ended);
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    return { socket, buffer: header };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
