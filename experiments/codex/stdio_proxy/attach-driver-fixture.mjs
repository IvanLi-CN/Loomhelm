#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachClient, AttachError, connectExistingSocket } from "./attach-driver.mjs";

async function main() {
const root = await mkdtemp(join(tmpdir(), "loomhelm-r01-attach-fixture-"));
await chmod(root, 0o700);
const socketPath = join(root, "bridge.sock");
let server;
let connection;

try {
  server = createServer((socket) => {
    connection = new FixtureConnection(socket);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  const client = await connectExistingSocket(socketPath, 2_000);
  try {
    const model = await client.request("model/list", {});
    assert.equal(model.result.data[0].id, "gpt-5.6-luna");
    assert.deepEqual(client.sentMethods, ["model/list"]);

    const threadMark = client.mark();
    const thread = await client.request("thread/start", {
      model: "gpt-5.6-luna",
      cwd: "/private/tmp/loomhelm-r01-fixture-workspace",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      runtimeWorkspaceRoots: ["/private/tmp/loomhelm-r01-fixture-workspace"],
      serviceName: "loomhelm-r01-attach-fixture",
    });
    assert.equal(thread.result.thread.id, "fixture-thread");
    await client.waitFor((message) => message.method === "thread/started", threadMark, 2_000);

    const turnMark = client.mark();
    const turn = client.request("turn/start", { threadId: "fixture-thread", input: [{ type: "text", text: "fixture" }] });
    const approval = await client.waitFor((message) => message.method === "item/commandExecution/requestApproval", turnMark, 2_000);
    assert.match(JSON.stringify(approval.message.params), /LOOMHELM_R01_FIXTURE/);
    const started = await client.waitFor((message) => message.method === "turn/started", turnMark, 2_000);
    const completed = await client.waitFor((message) => message.method === "turn/completed", turnMark, 2_000);
    assert.equal(started.message.params.turn.id, completed.message.params.turn.id);
    assert.equal((await turn).result.turn.id, "fixture-turn");
    client.respond(approval.message.id, { decision: "accept" });
    await new Promise((resolveResponse) => setTimeout(resolveResponse, 20));
    assert.equal(connection.clientResponses.at(-1).result.decision, "accept");

    const steer = await client.request("turn/steer", { threadId: "fixture-thread", expectedTurnId: "fixture-turn", input: [{ type: "text", text: "steer" }] });
    assert.equal(steer.result.turnId, "fixture-turn");
    const interrupt = await client.request("turn/interrupt", { threadId: "fixture-thread", turnId: "fixture-turn" });
    assert.equal(interrupt.result.turnId, "fixture-turn");

    connection.sendOwnerBoundRequest();
    await assert.rejects(async () => client.waitFor(() => false, client.mark(), 2_000), (error) => error instanceof AttachError && error.code === "owner_bound_callback_on_bridge");
    assert.equal(client.ownerBoundMessages.length, 1);
    assert.ok(!client.sentMethods.includes("initialize"));
  } finally {
    client.close();
  }
  const result = { result: "passed", socket: "<DISPOSABLE_FIXTURE_SOCKET>", checks: { noInitialize: true, exactThread: true, sameTurn: true, steer: true, interrupt: true, ownerBoundRejected: true } };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  connection?.socket?.destroy();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
}

class FixtureConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.responses = [];
    this.clientResponses = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.consume(chunk));
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      if (message.method === "initialize" || message.method === "initialized") throw new Error("fixture received forbidden initialization");
      if (!message.method && message.id !== undefined) {
        this.clientResponses.push(message);
        continue;
      }
      if (message.method === "model/list") this.reply(message.id, { data: [{ id: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] });
      if (message.method === "thread/start") {
        this.reply(message.id, { thread: { id: "fixture-thread", cwd: message.params.cwd } });
        this.notify("thread/started", { thread: { id: "fixture-thread", cwd: message.params.cwd } });
      }
      if (message.method === "turn/start") {
        this.reply(message.id, { turn: { id: "fixture-turn" } });
        this.notify("turn/started", { turn: { id: "fixture-turn" } });
        this.requestApproval();
        this.notify("item/started", { item: { type: "commandExecution", id: "fixture-item" } });
        this.notify("item/completed", { item: { type: "commandExecution", id: "fixture-item", status: "completed" } });
        this.notify("turn/completed", { turn: { id: "fixture-turn", status: "completed" } });
      }
      if (message.method === "turn/steer") this.reply(message.id, { turnId: "fixture-turn" });
      if (message.method === "turn/interrupt") this.reply(message.id, { turnId: "fixture-turn" });
      if (message.method === "thread/turns/list") this.reply(message.id, { data: [{ id: "fixture-turn", status: "completed" }] });
    }
  }

  reply(id, result) {
    this.responses.push({ id, result });
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  notify(method, params) {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  requestApproval() {
    this.notifyRequest("item/commandExecution/requestApproval", { command: "/usr/bin/printf LOOMHELM_R01_FIXTURE_ACCEPT" });
  }

  notifyRequest(method, params) {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "fixture-approval", method, params })}\n`);
  }

  sendOwnerBoundRequest() {
    this.notifyRequest("mcpServer/tool/call", { server: "codex_app", tool: "read_current_thread", arguments: {} });
  }
}

await main();
