import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexThread } from "../scripts/codex-agent-api";

async function withControlServer(scenario: "success" | "mismatch" | "reject" | "timeout" | "missing-id", verify: (calls: any[], result: Awaited<ReturnType<typeof createCodexThread>>, completed: boolean) => void) {
  const dir = mkdtempSync(join(tmpdir(), "mtf-rpc-"));
  const path = join(dir, "rpc.sock");
  const calls: any[] = [];
  let completed = false;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const send = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const header = bytes.length < 126 ? Buffer.from([129, bytes.length]) : Buffer.from([129, 126, bytes.length >> 8, bytes.length & 255]);
      socket.write(Buffer.concat([header, bytes]));
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buffer.toString())![1]!.trim();
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      while (buffer.length >= 6) {
        let length = buffer[1]! & 127;
        let offset = 2;
        if (length === 126) { if (buffer.length < 8) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const bytes = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        buffer = buffer.subarray(offset + 4 + length);
        for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ mask[i % 4]!;
        const call = JSON.parse(bytes.toString()); calls.push(call);
        const result = call.method === "thread/start" ? { thread: scenario === "missing-id" ? {} : { id: "test-thread" }, model: scenario === "mismatch" ? "other-model" : "gpt-6.1-sol", reasoningEffort: "medium" } : call.method === "turn/start" ? { turn: { id: "test-turn" } } : {};
        if (call.method === "thread/start" && scenario === "timeout") continue;
        send(call.method === "thread/start" && scenario === "reject" ? { id: call.id, error: { message: "unsupported profile" } } : { id: call.id, result });
        if (call.method === "turn/start") setTimeout(() => {
          completed = true;
          send({ method: "turn/completed", params: { threadId: "test-thread", turn: { id: "test-turn", status: "completed" } } });
        }, 30);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const previous = process.env.CODEX_APP_SERVER_SOCKET;
  const previousTimeout = process.env.MULTI_TASK_FLOW_CODEX_AGENT_TIMEOUT_MS;
  process.env.MULTI_TASK_FLOW_CODEX_AGENT_TIMEOUT_MS = "1000";
  process.env.CODEX_APP_SERVER_SOCKET = path;
  try {
    const result = await createCodexThread({ title: "Test", prompt: "Reply OK", model: "gpt-6.1-sol", thinking: "medium" });
    verify(calls, result, completed);
  } finally {
    if (previousTimeout === undefined) delete process.env.MULTI_TASK_FLOW_CODEX_AGENT_TIMEOUT_MS;
    else process.env.MULTI_TASK_FLOW_CODEX_AGENT_TIMEOUT_MS = previousTimeout;
    if (previous === undefined) delete process.env.CODEX_APP_SERVER_SOCKET;
    else process.env.CODEX_APP_SERVER_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("creation sends the prompt separately, validates the returned profile and waits for persistence", async () => {
  await withControlServer("success", (calls, result, completed) => {
    expect(result.outcome).toBe("succeeded");
    expect(completed).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["initialize", "thread/start", "thread/name/set", "turn/start"]);
    expect(calls[1].params.config).toEqual({ model_reasoning_effort: "medium" });
    expect(calls[1].params.input).toBeUndefined();
    expect(calls[3].params.input).toEqual([{ type: "text", text: "Reply OK" }]);
    expect(calls[3].params.effort).toBe("medium");
    expect(calls[1].id).toBe(result.native_request_id);
  });
});

for (const scenario of ["mismatch", "reject", "timeout", "missing-id"] as const) {
  test(`creation preserves ${scenario} as evidence without unsafe retry`, async () => {
    await withControlServer(scenario, (calls, result) => {
      expect(result.outcome).toBe(scenario === "reject" ? "failed" : "unknown");
      expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
      expect(calls.some((call) => call.method === "turn/start")).toBe(false);
      if (scenario === "mismatch") expect(result.thread_id).toBe("test-thread");
    });
  });
}
