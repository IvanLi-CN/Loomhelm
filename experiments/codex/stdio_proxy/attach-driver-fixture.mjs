#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { AttachClient, AttachError, connectExistingSocket, runAttachScenario } from "./attach-driver.mjs";

const RETAINED_MANIFEST = "/private/tmp/loomhelm-r01-codex-test/proxy-candidate-36d4fc3/manifest.env";
const FAKE_IDENTITY = {
  desktop: { pid: 101 },
  wrapper: { pid: 102 },
  child: { pid: 103 },
  socketMode: "600",
  workspaceMode: 0o700,
};

async function main() {
  const root = await mkdtemp("/private/tmp/loomhelm-r01-attach-fixture-");
  await chmod(root, 0o700);
  try {
    const transportChecks = await runAttachClientFixture(root);
    const scenarioChecks = await runScenarioFixture(root);
    process.stdout.write(JSON.stringify({ result: "passed", transportChecks, scenarioChecks }, null, 2) + "\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runAttachClientFixture(root) {
  const socketPath = join(root, "transport.sock");
  let server;
  let connection;
  try {
    server = createServer((socket) => {
      connection = new SocketFixtureConnection(socket);
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
      connection.sendPassiveMcpStatus();
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      assert.equal(client.ownerBoundRequests.length, 0);
      connection.sendOwnerBoundRequest();
      await assert.rejects(async () => client.waitFor(() => false, client.mark(), 2_000), (error) => error instanceof AttachError && error.code === "owner_bound_callback_on_bridge");
      assert.equal(client.ownerBoundRequests.length, 1);
      assert.ok(!client.sentMethods.includes("initialize"));
      return { noInitialize: true, passiveMcpStatusAllowed: true, ownerBoundRequestRejected: true };
    } finally {
      client.close();
    }
  } finally {
    connection?.socket?.destroy();
    await new Promise((resolveClose) => server?.close(resolveClose));
  }
}

async function runScenarioFixture(root) {
  const workspace = join(root, "workspace");
  await mkdirPrivate(workspace);
  const marker = "LOOMHELM_R01_FIXTURE_SCENARIO";
  const inspection = () => Promise.resolve(FAKE_IDENTITY);

  const createThreadFile = join(root, "create-thread.json");
  const createEvidence = join(root, "create-thread-evidence.json");
  const createResult = await runAttachScenario({
    scenario: "create-thread",
    manifest: RETAINED_MANIFEST,
    socket: join(root, "create.sock"),
    workspace,
    marker,
    threadFile: createThreadFile,
    evidence: createEvidence,
  }, {
    inspectProcessIdentity: inspection,
    connectExistingSocket: (_socket, _timeout, config) => Promise.resolve(new ScenarioClient({ mode: "create-thread", workspace, threadId: "fixture-created-thread", config })),
  });
  assert.equal(createResult.result, "passed");
  assert.equal((await stat(createThreadFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(createThreadFile, "utf8")).thread_id, "fixture-created-thread");

  const conflictThreadFile = join(root, "conflict-thread.json");
  await writeFile(conflictThreadFile, "{}\n", { encoding: "utf8", mode: 0o600 });
  let conflictInspectionCalls = 0;
  await assert.rejects(runAttachScenario({
    scenario: "create-thread",
    manifest: RETAINED_MANIFEST,
    socket: join(root, "conflict.sock"),
    workspace,
    marker,
    threadFile: conflictThreadFile,
    evidence: join(root, "conflict-evidence.json"),
  }, {
    inspectProcessIdentity: () => {
      conflictInspectionCalls += 1;
      return Promise.resolve(FAKE_IDENTITY);
    },
    connectExistingSocket: () => {
      throw new Error("conflicting output must stop before transport");
    },
  }), (error) => error instanceof AttachError && error.code === "thread_file_exists");
  assert.equal(conflictInspectionCalls, 0);

  await assert.rejects(runAttachScenario({
    scenario: "create-thread",
    manifest: RETAINED_MANIFEST,
    socket: join(root, "id-conflict.sock"),
    workspace,
    marker,
    threadId: "fixture-existing-thread",
    threadFile: join(root, "id-conflict-thread.json"),
    evidence: join(root, "id-conflict-evidence.json"),
  }, {
    inspectProcessIdentity: inspection,
    connectExistingSocket: () => {
      throw new Error("thread id conflict must stop before transport");
    },
  }), (error) => error instanceof AttachError && error.code === "thread_id_conflict");

  await writeBoundThreadFile(join(root, "sleep-thread.json"), workspace, marker);
  const steerResult = await runAttachScenario({
    scenario: "steer-interrupt",
    manifest: RETAINED_MANIFEST,
    socket: join(root, "steer.sock"),
    workspace,
    marker,
    threadFile: join(root, "sleep-thread.json"),
    evidence: join(root, "steer-evidence.json"),
  }, {
    inspectProcessIdentity: inspection,
    connectExistingSocket: (_socket, _timeout, config) => Promise.resolve(new ScenarioClient({ mode: "steer-interrupt", workspace, threadId: "fixture-thread", config })),
  });
  assert.equal(steerResult.result, "passed");
  assert.equal(steerResult.events.find((event) => event.type === "steer_and_interrupt_completed")?.status, "interrupted");

  const disconnectThreadFile = join(root, "disconnect-thread.json");
  await writeBoundThreadFile(disconnectThreadFile, workspace, marker);
  let disconnectConnections = 0;
  const disconnectResult = await runAttachScenario({
    scenario: "disconnect-reconcile",
    manifest: RETAINED_MANIFEST,
    socket: join(root, "disconnect.sock"),
    workspace,
    marker,
    threadFile: disconnectThreadFile,
    evidence: join(root, "disconnect-evidence.json"),
  }, {
    inspectProcessIdentity: inspection,
    connectExistingSocket: (_socket, _timeout, config) => {
      disconnectConnections += 1;
      return Promise.resolve(new ScenarioClient({ mode: disconnectConnections === 1 ? "disconnect-first" : "disconnect-second", workspace, threadId: "fixture-thread", config }));
    },
  });
  assert.equal(disconnectResult.result, "passed");
  assert.equal(disconnectResult.events.find((event) => event.type === "desktop_pending_approval_reconciled_after_reconnect")?.commandStatus, "declined");

  const pluginChecks = {};
  for (const mode of ["unavailable", "error", "started-only", "wrong-server", "wrong-tool", "text-only", "success"]) {
    const pluginThreadFile = join(root, "plugin-" + mode + ".json");
    const pluginEvidence = join(root, "plugin-" + mode + ".json.evidence");
    await writeBoundThreadFile(pluginThreadFile, workspace, marker);
    const result = await runAttachScenario({
      scenario: "plugin-readonly",
      manifest: RETAINED_MANIFEST,
      socket: join(root, "plugin-" + mode + ".sock"),
      workspace,
      marker,
      threadFile: pluginThreadFile,
      pluginTool: "read_current_thread",
      evidence: pluginEvidence,
    }, {
      inspectProcessIdentity: inspection,
      connectExistingSocket: (_socket, _timeout, config) => Promise.resolve(new ScenarioClient({ mode: "plugin-" + mode, workspace, threadId: "fixture-thread", pluginTool: "read_current_thread", config })),
    });
    pluginChecks[mode] = { result: result.result, error: result.error?.code ?? null };
    if (mode === "success") {
      assert.equal(result.result, "passed");
    } else {
      assert.equal(result.result, "inconclusive");
      assert.match(result.error.code, /^plugin_/);
    }
  }

  return {
    createThreadOutput: true,
    createThreadConflictRejected: true,
    createThreadIdConflictRejected: true,
    sleepApprovalIdentityAndInterrupt: true,
    disconnectSleepApprovalReconciled: true,
    pluginChecks,
  };
}

class ScenarioClient {
  constructor({ mode, workspace, threadId = "fixture-thread", pluginTool = "read_current_thread", config }) {
    this.mode = mode;
    this.workspace = workspace;
    this.threadId = threadId;
    this.pluginTool = pluginTool;
    this.config = config;
    this.messages = [];
    this.sentMethods = [];
    this.ownerBoundRequests = [];
    this.waiters = [];
    this.sequence = 0;
    this.activeTurnId = mode.startsWith("disconnect-") ? "fixture-disconnect-turn" : null;
    this.activeItemId = mode.startsWith("disconnect-") ? "fixture-disconnect-item" : null;
    this.closed = false;
  }

  mark() {
    return this.messages.length;
  }

  request(method, params) {
    const id = "fixture-request-" + ++this.sequence;
    this.sentMethods.push(method);
    if (method === "model/list") return Promise.resolve({ jsonrpc: "2.0", id, result: { data: [{ id: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] } });
    if (method === "thread/read") return Promise.resolve({ jsonrpc: "2.0", id, result: { thread: { id: params.threadId, cwd: this.workspace, canAcceptDirectInput: true } } });
    if (method === "thread/start") {
      this.push({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: this.threadId, cwd: params.cwd } } });
      return Promise.resolve({ jsonrpc: "2.0", id, result: { thread: { id: this.threadId, cwd: params.cwd } } });
    }
    if (method === "turn/start") return this.startTurn(id, params);
    if (method === "turn/steer") return Promise.resolve({ jsonrpc: "2.0", id, result: { turnId: this.activeTurnId } });
    if (method === "turn/interrupt") {
      this.push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "unrelated-thread", turn: { id: "unrelated-turn", threadId: "unrelated-thread", status: "completed" } } });
      this.push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: this.threadId, turn: { id: this.activeTurnId, threadId: this.threadId, status: "interrupted" } } });
      return Promise.resolve({ jsonrpc: "2.0", id, result: { turnId: this.activeTurnId } });
    }
    if (method === "thread/turns/list") {
      if (this.mode === "disconnect-second") {
        setTimeout(() => {
          this.push({ jsonrpc: "2.0", method: "item/completed", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { id: this.activeItemId, type: "commandExecution", status: "declined" } } });
          this.push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: this.threadId, turn: { id: this.activeTurnId, threadId: this.threadId, status: "completed" } } });
        }, 0);
      }
      return Promise.resolve({ jsonrpc: "2.0", id, result: { data: [{ id: this.activeTurnId, status: "inProgress" }] } });
    }
    return Promise.resolve({ jsonrpc: "2.0", id, result: {} });
  }

  startTurn(id, params) {
    if (this.mode.startsWith("disconnect-")) this.activeTurnId = "fixture-disconnect-turn";
    else if (this.mode.startsWith("plugin-")) this.activeTurnId = "fixture-plugin-turn";
    else this.activeTurnId = "fixture-" + this.mode + "-turn";
    this.activeItemId = this.mode.startsWith("disconnect-") ? "fixture-disconnect-item" : "fixture-" + this.mode + "-item";
    this.push({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "unrelated-thread", turn: { id: "unrelated-turn", threadId: "unrelated-thread" } } });
    this.push({ jsonrpc: "2.0", method: "turn/started", params: { threadId: this.threadId, turn: { id: this.activeTurnId, threadId: this.threadId } } });
    if (this.mode === "steer-interrupt" || this.mode === "disconnect-first") {
      this.push({ jsonrpc: "2.0", method: "item/commandExecution/requestApproval", id: "unrelated-approval", params: { threadId: "unrelated-thread", turnId: "unrelated-turn", itemId: "unrelated-item", command: "/bin/sleep 30" } });
      this.push({ jsonrpc: "2.0", method: "item/commandExecution/requestApproval", id: "fixture-approval", params: { threadId: this.threadId, turnId: this.activeTurnId, itemId: this.activeItemId, command: "/bin/sleep 30" } });
      if (this.mode === "steer-interrupt") this.push({ jsonrpc: "2.0", method: "item/started", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { id: this.activeItemId, type: "commandExecution" } } });
    } else if (this.mode.startsWith("plugin-")) {
      this.push({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "unrelated-thread", turnId: "unrelated-turn", item: { id: "unrelated-item", type: "mcpToolCall", server: "codex_app", tool: this.pluginTool, status: "completed", result: { threadId: "unrelated-thread" } } } });
      this.push({ jsonrpc: "2.0", method: "mcpToolCall", params: { threadId: this.threadId, turnId: this.activeTurnId, status: "informational" } });
      const pluginServer = this.mode === "plugin-wrong-server" ? "other_server" : "codex_app";
      const pluginName = this.mode === "plugin-wrong-tool" ? "other_tool" : this.pluginTool;
      if (this.mode !== "plugin-unavailable" && this.mode !== "plugin-text-only") this.push({ jsonrpc: "2.0", method: "item/started", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { id: this.activeItemId, type: "mcpToolCall", server: pluginServer, tool: pluginName } } });
      if (this.mode === "plugin-error") this.push({ jsonrpc: "2.0", method: "item/completed", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { id: this.activeItemId, type: "mcpToolCall", server: pluginServer, tool: pluginName, status: "failed", error: { code: "fixture_error" } } } });
      if (["plugin-success", "plugin-wrong-server", "plugin-wrong-tool"].includes(this.mode)) this.push({ jsonrpc: "2.0", method: "item/completed", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { id: this.activeItemId, type: "mcpToolCall", server: pluginServer, tool: pluginName, status: "completed", result: { threadId: this.threadId } } } });
      if (this.mode === "plugin-unavailable") this.push({ jsonrpc: "2.0", method: "item/agentMessage", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { type: "agentMessage", text: this.config.marker + "_PLUGIN_TOOL_UNAVAILABLE" } } });
      if (this.mode === "plugin-text-only") this.push({ jsonrpc: "2.0", method: "item/agentMessage", params: { threadId: this.threadId, turnId: this.activeTurnId, item: { type: "agentMessage", text: this.config.marker + "_PLUGIN_TEXT_ONLY" } } });
    }
    if (this.mode.startsWith("plugin-")) this.push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: this.threadId, turn: { id: this.activeTurnId, threadId: this.threadId, status: "completed" } } });
    return Promise.resolve({ jsonrpc: "2.0", id, result: { turn: { id: this.activeTurnId, threadId: this.threadId } } });
  }

  respond(id, result) {
    this.lastResponse = { id, result };
  }

  close() {
    this.closed = true;
  }

  waitFor(predicate, after = 0, timeoutMs = 2_000) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    for (let index = after; index < this.messages.length; index += 1) {
      if (predicate(this.messages[index])) return Promise.resolve({ message: this.messages[index], index });
    }
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { predicate, after, resolve: resolveWait, reject: rejectWait };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        rejectWait(this.fatalError ?? new AttachError("fixture_event_timeout", "fixture event timeout"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  push(message) {
    const index = this.messages.push(message) - 1;
    if (message.method === "mcpServer/tool/call" && message.id !== undefined) {
      this.ownerBoundRequests.push(message.method);
      this.fatalError = new AttachError("owner_bound_callback_on_bridge", "fixture received an owner-bound request");
    }
    for (const waiter of [...this.waiters]) {
      if (index < waiter.after || !waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve({ message, index });
    }
  }
}

class SocketFixtureConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
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
      if (message.method === "model/list") this.reply(message.id, { data: [{ id: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] });
    }
  }

  reply(id, result) {
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  sendPassiveMcpStatus() {
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", method: "mcpToolCall", params: { status: "informational" } }) + "\n");
  }

  sendOwnerBoundRequest() {
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", id: "fixture-owner-bound", method: "mcpServer/tool/call", params: { server: "codex_app", tool: "read_current_thread", arguments: {} } }) + "\n");
  }
}

async function writeBoundThreadFile(path, workspace, marker) {
  await writeFile(path, JSON.stringify({ format_version: 1, thread_id: "fixture-thread", workspace, created_by: "attach-driver", marker_prefix: marker, source_sha: "36d4fc371a983ea0921e03091318eecf033d4355" }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function mkdirPrivate(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

await main();
