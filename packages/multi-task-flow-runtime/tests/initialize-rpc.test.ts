import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { connectSocket, framePayload, rpc } from "../lib/codex-rpc";
import { directory, readEvent, readMarker } from "../lib/invocation-events";
import { initializeParams } from "../lib/invocation-initialize-recovery";
import { executeInvocation, inspectInvocation } from "../lib/invocation-journal";
import { withNativeOperation } from "../lib/native-operation-context";
import { initializeFixture } from "./initialize-recovery-fixture";

const previous = process.env.LOOMHELM_CALLER_IDENTITY;
afterEach(() => {
  if (previous === undefined) delete process.env.LOOMHELM_CALLER_IDENTITY;
  else process.env.LOOMHELM_CALLER_IDENTITY = previous;
});

async function scenario(
  mode:
    | "success"
    | "close"
    | "error"
    | "timeout"
    | "business"
    | "concurrent"
    | "archive"
    | "unarchive",
) {
  const store = initializeFixture();
  const path = join(store.rootPath, "rpc.sock");
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let ready = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buffer.toString())![1]!.trim();
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        ready = true;
      }
      while (true) {
        const frame = framePayload(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        const call = JSON.parse(frame.payload.toString());
        if (mode === "timeout") continue;
        if (mode === "error") {
          socket.destroy(new Error("fixture transport failure"));
          return;
        }
        if (
          mode === "close" ||
          mode === "concurrent" ||
          (call.method !== "initialize" && mode !== "archive" && mode !== "unarchive")
        ) {
          socket.destroy();
          return;
        }
        const bytes = Buffer.from(JSON.stringify({ id: call.id, result: {} }));
        socket.write(Buffer.concat([Buffer.from([129, bytes.length]), bytes]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const action = async () => {
      const { socket, buffer: initial } = await connectSocket(path);
      try {
        const buffer = { value: initial };
        if (mode === "concurrent") {
          await Promise.all([
            rpc(socket, buffer, 1, "initialize", initializeParams, { timeoutMs: 100 }),
            rpc(
              socket,
              { value: Buffer.alloc(0) },
              2,
              "thread/archive",
              { threadId: "fixture" },
              { timeoutMs: 100 },
            ),
          ]);
        } else {
          await rpc(socket, buffer, 1, "initialize", initializeParams, { timeoutMs: 100 });
          if (mode === "business" || mode === "archive" || mode === "unarchive")
            await rpc(
              socket,
              buffer,
              2,
              mode === "unarchive" ? "thread/unarchive" : "thread/archive",
              { threadId: "fixture" },
              { timeoutMs: 100 },
            );
        }
      } finally {
        socket.destroy();
      }
    };
    const provenance = {
      id: "operation-fixture",
      source: mode === "unarchive" ? ("unarchive" as const) : ("archive" as const),
      task_id: "task-fixture",
    };
    const scoped = mode === "archive" || mode === "unarchive";
    const operation = executeInvocation(
      store,
      scoped ? `conversation-${mode}` : "fixture",
      {},
      () => (scoped ? withNativeOperation(provenance, action) : action()),
    );
    if (mode === "success" || scoped) await operation;
    else await expect(operation).rejects.toThrow();
    if (scoped) {
      const id = readMarker(store)!.invocation_id;
      const events = readdirSync(directory(store, id))
        .filter((file) => /^resource-[a-f0-9-]{36}\.json$/.test(file))
        .map((file) => readEvent(store, id, file.slice(0, -5)));
      const transport = events.find((event) => event.kind === "codex-transport");
      const requests = events.filter((event) => event.kind === "codex-request");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.reference.transport_id).toBe(transport.resource_id);
        expect(request.reference.operation).toEqual(provenance);
      }
      expect(
        requests.find((event) => event.reference.method === "initialize").reference.effect_scope,
      ).toBe("codex-initialize-connection-v1");
      expect(
        requests.find((event) => event.reference.method === `thread/${mode}`).reference
          .effect_scope,
      ).toBeUndefined();
      expect(readEvent(store, id, "start").command).toBe(`conversation-${mode}`);
    }
    return inspectInvocation(store);
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
test("exact initialize response, connection close, transport error and timeout all converge safely", async () => {
  for (const mode of ["success", "close", "error", "timeout"] as const) {
    const result = await scenario(mode);
    expect(result?.quiescent).toBe(true);
    if (mode !== "success")
      expect(result).toMatchObject({ recovery: { eligible: true, receipt_valid: true } });
  }
});

test("archive and unarchive request journals retain operation and transport provenance", async () => {
  for (const source of ["archive", "unarchive"] as const)
    expect((await scenario(source))?.quiescent).toBe(true);
});
test("unknown business RPC or another concurrent request cannot borrow initialize recovery", async () => {
  for (const mode of ["business", "concurrent"] as const)
    expect((await scenario(mode))?.quiescent).toBe(false);
});

test("failed socket connection clears handshake timers so a CLI child exits promptly", () => {
  const module = join(import.meta.dir, "../lib/codex-rpc.ts");
  const script = `const { connectSocket } = await import(${JSON.stringify(module)}); try { await connectSocket("/nonexistent-mtf-proof/socket", 5000); } catch { console.log("connection-failed"); }`;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { timeout: 1500 });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain("connection-failed");
});
