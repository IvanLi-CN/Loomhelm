#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SOURCE_SHA = "36d4fc371a983ea0921e03091318eecf033d4355";
const EXPECTED_WRAPPER_SHA = "6ea84b92f5a208202489b217ecdfd27c087d76684b821b25a17c39c37014ca1e";
const EXPECTED_REAL_CLI_SHA = "1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe";
const EXPECTED_REAL_CLI_VERSION = "codex-cli 0.163.0-alpha.10.2";
const EXPECTED_MODEL = "gpt-5.6-luna";
const EXPECTED_EFFORT = "max";
const DEFAULT_TIMEOUT_MS = 45_000;
const OWNER_BOUND_METHODS = new Set([
  "userVerification",
  "mcpServer/tool/call",
]);
const PROXY_CONTROL_KEYS = [
  "LOOMHELM_STDIO_PROXY_REAL_CLI",
  "LOOMHELM_STDIO_PROXY_SOCKET",
  "LOOMHELM_STDIO_PROXY_BRIDGE_QUEUE",
];

export class AttachError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachError";
    this.code = code;
  }
}

export class AttachClient {
  constructor(socket, { timeoutMs = DEFAULT_TIMEOUT_MS, name = "bridge" } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.name = name;
    this.buffer = "";
    this.messages = [];
    this.pending = new Map();
    this.waiters = [];
    this.sequence = 0;
    this.closed = false;
    this.ownerBoundMessages = [];
    this.ownerBoundRequests = [];
    this.sentMethods = [];
    this.fatalError = null;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("error", (error) => this.markClosed(new AttachError("socket_error", error.message)));
    socket.on("close", () => this.markClosed(new AttachError("socket_closed", `${this.name} socket closed`)));
  }

  mark() {
    return this.messages.length;
  }

  request(method, params) {
    const id = `loomhelm-attach-${++this.sequence}`;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(String(id), { resolve: resolveResponse, reject: rejectResponse, method });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  waitFor(predicate, after = 0, timeoutMs = this.timeoutMs) {
    this.throwIfFatal();
    for (let index = after; index < this.messages.length; index += 1) {
      if (predicate(this.messages[index])) return Promise.resolve({ message: this.messages[index], index });
    }
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = { predicate, after, resolve: resolveMessage, reject: rejectMessage };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        rejectMessage(new AttachError("event_timeout", `${this.name} did not receive the expected event`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.closed) return;
    this.markClosed(new AttachError("bridge_closed", `${this.name} bridge closed by driver`));
    this.socket.destroy();
  }

  send(message) {
    if (this.closed) throw new AttachError("socket_closed", `${this.name} socket is closed`);
    if (message.method) this.sentMethods.push(message.method);
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  consume(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.markClosed(new AttachError("invalid_json", `${this.name} emitted a non-JSON frame`));
        return;
      }
      this.handle(message);
    }
  }

  handle(message) {
    const index = this.messages.push(message) - 1;
    if (message.method && isOwnerBoundMethod(message.method)) {
      this.ownerBoundMessages.push(message.method);
      if (message.id !== undefined) {
        this.ownerBoundRequests.push(message.method);
        this.setFatal(new AttachError("owner_bound_callback_on_bridge", `${message.method} appeared as a bridge request`));
      }
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        pending.resolve(message);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (index < waiter.after || !waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve({ message, index });
    }
  }

  markClosed(error) {
    if (this.closed) return;
    this.closed = true;
    const finalError = this.fatalError ?? error;
    for (const pending of this.pending.values()) pending.reject(finalError);
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(finalError);
    }
    this.waiters = [];
  }

  setFatal(error) {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  throwIfFatal() {
    if (this.fatalError) throw this.fatalError;
  }
}

export async function connectExistingSocket(socketPath, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolveClient, rejectClient) => {
    const socket = connect(socketPath);
    const onError = (error) => rejectClient(new AttachError("socket_connect_failed", error.message));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolveClient(new AttachClient(socket, { timeoutMs }));
    });
  });
}

export function hashRef(kind, value) {
  if (value === null || value === undefined) return null;
  return `${kind}:${createHash("sha256").update(String(value)).digest("hex").slice(0, 20)}`;
}

export async function runAttachScenario(args, overrides = {}) {
  const config = await loadConfig(args);
  const deps = {
    inspectProcessIdentity: overrides.inspectProcessIdentity ?? inspectProcessIdentity,
    connectExistingSocket: overrides.connectExistingSocket ?? connectExistingSocket,
  };
  const evidence = {
    formatVersion: 1,
    result: "failed",
    scenario: config.scenario,
    scope: "desktop_attach_only",
    startedAt: new Date().toISOString(),
    candidate: {
      sourceSha: config.manifest.source_sha,
      wrapperSha256: config.manifest.wrapper_sha256,
      realCliSha256: config.manifest.real_cli_sha256,
      realCliVersion: config.manifest.real_cli_version,
      manifest: config.manifestPath,
      wrapper: config.wrapper,
      realCli: config.realCli,
    },
    socket: hashRef("socket", config.socket),
    workspace: hashRef("workspace", config.workspace),
    marker: hashRef("marker", config.marker),
    events: [],
  };
  let client = null;
  try {
    const identity = await deps.inspectProcessIdentity(config);
    record(evidence, "process_identity_verified", {
      desktopPid: hashRef("pid", identity.desktop.pid),
      wrapperPid: hashRef("pid", identity.wrapper.pid),
      childPid: hashRef("pid", identity.child.pid),
      socketMode: identity.socketMode,
      workspaceMode: identity.workspaceMode,
    });
    client = await deps.connectExistingSocket(config.socket, config.timeoutMs, config);
    const model = await client.request("model/list", {});
    assertSuccess(model, "model/list");
    assertModelCapability(model);
    record(evidence, "desktop_ready_model_capability", { model: EXPECTED_MODEL, effort: EXPECTED_EFFORT });

    if (config.scenario === "preflight") {
      record(evidence, "attach_only_preflight_complete", { initializeSent: client.sentMethods.includes("initialize") });
      if (client.sentMethods.includes("initialize")) throw new AttachError("initialize_sent", "attach driver sent initialize");
    } else {
      let threadId = config.threadId;
      if (config.scenario === "create-thread") {
        threadId = await createDedicatedThread(client, config, evidence);
      } else {
        if (!threadId) throw new AttachError("thread_required", "an exact thread file or thread id is required");
        await validateExistingThread(client, config, threadId, evidence);
      }
      if (config.scenario !== "create-thread") {
        await runScenario(config, client, threadId, evidence, deps);
      }
    }
    const finalIdentity = await deps.inspectProcessIdentity(config);
    if (finalIdentity.child.pid !== identity.child.pid || finalIdentity.wrapper.pid !== identity.wrapper.pid) {
      throw new AttachError("process_identity_changed", "Desktop, wrapper or real CLI identity changed during the scenario");
    }
    if (client.sentMethods.includes("initialize")) throw new AttachError("initialize_sent", "attach driver sent initialize");
    record(evidence, "attach_only_identity_rechecked", {
      desktopPid: hashRef("pid", finalIdentity.desktop.pid),
      wrapperPid: hashRef("pid", finalIdentity.wrapper.pid),
      childPid: hashRef("pid", finalIdentity.child.pid),
    });
    evidence.result = "passed";
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code.startsWith("plugin_")) evidence.result = "inconclusive";
    evidence.error = { code: normalized.code, message: normalized.code };
    record(evidence, "attach_only_failed", { code: normalized.code });
  } finally {
    client?.close();
    evidence.finishedAt = new Date().toISOString();
    if (config.evidencePath) await writeEvidence(config.evidencePath, evidence);
  }
  return evidence;
}

async function loadConfig(args) {
  const scenario = args.scenario ?? "preflight";
  const allowedScenarios = new Set([
    "preflight",
    "create-thread",
    "send",
    "approval-accept",
    "approval-decline",
    "steer-interrupt",
    "disconnect-reconcile",
    "plugin-readonly",
  ]);
  if (!allowedScenarios.has(scenario)) throw new AttachError("scenario_invalid", `unsupported scenario: ${scenario}`);
  const manifestPath = requiredPath(args.manifest, "manifest");
  const manifest = await readKeyValueFile(manifestPath);
  if (manifest.source_sha !== EXPECTED_SOURCE_SHA) throw new AttachError("manifest_source_mismatch", "manifest source SHA is not the retained candidate");
  if (manifest.wrapper_sha256 !== EXPECTED_WRAPPER_SHA) throw new AttachError("manifest_wrapper_digest_mismatch", "manifest wrapper SHA is not the retained candidate");
  if (manifest.real_cli_sha256 !== EXPECTED_REAL_CLI_SHA) throw new AttachError("manifest_cli_digest_mismatch", "manifest CLI SHA is not the pinned bundled CLI");
  if (manifest.real_cli_version !== EXPECTED_REAL_CLI_VERSION) throw new AttachError("manifest_cli_version_mismatch", "manifest CLI version is not the pinned bundled CLI");
  const wrapper = resolve(requiredValue(manifest.wrapper_path, "wrapper_path"));
  const realCli = resolve(requiredValue(manifest.real_cli_path, "real_cli_path"));
  const socket = requiredPath(args.socket, "socket");
  if (socket.length > 90) throw new AttachError("socket_path_too_long", "socket path exceeds the bounded macOS Unix socket length");
  const workspace = requiredPath(args.workspace, "workspace");
  const marker = args.marker ?? "";
  if (!/^LOOMHELM_R01_[A-Z0-9_]{1,64}$/.test(marker)) throw new AttachError("marker_invalid", "marker must be a bounded LOOMHELM_R01_ token");
  const timeoutMs = boundedTimeout(args.timeoutMs);
  const desktopExecutable = resolve(args.desktopExecutable ?? "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT");
  const evidencePath = args.evidence ? resolve(args.evidence) : null;
  if (evidencePath && await pathExists(evidencePath)) throw new AttachError("evidence_exists", "evidence path already exists");
  const threadFile = args.threadFile ? resolve(args.threadFile) : null;
  if (scenario === "create-thread" && !threadFile) throw new AttachError("thread_file_required", "create-thread requires --thread-file");
  if (scenario !== "preflight" && scenario !== "create-thread" && !args.threadId && !threadFile) {
    throw new AttachError("thread_required", "this scenario requires --thread-id or --thread-file");
  }
  if (scenario === "create-thread" && args.threadId) throw new AttachError("thread_id_conflict", "create-thread does not accept an existing thread id");
  if (scenario === "create-thread" && await pathExists(threadFile)) throw new AttachError("thread_file_exists", "refusing to overwrite the dedicated thread file");
  const threadId = scenario === "create-thread" ? null : args.threadId ?? (threadFile ? await readThreadId(threadFile, workspace, marker) : null);
  if (scenario !== "preflight" && scenario !== "create-thread" && !threadId) throw new AttachError("thread_required", "thread identity is missing");
  const pluginServer = args.pluginServer ?? "codex_app";
  const pluginTool = args.pluginTool ?? null;
  if (scenario === "plugin-readonly" && pluginServer !== "codex_app") throw new AttachError("plugin_server_invalid", "plugin-readonly is bound to the codex_app server");
  if (scenario === "plugin-readonly" && (!pluginTool || !/^[A-Za-z0-9_.-]{1,128}$/.test(pluginTool))) throw new AttachError("plugin_tool_required", "plugin-readonly requires the owner-selected read-only catalog tool name");
  await validateManifestFiles(manifestPath, wrapper, realCli, manifest);
  await validatePrivateDirectory(workspace, "workspace");
  if (threadFile) await validatePrivateDirectory(dirname(threadFile), "thread file parent");
  if (evidencePath) await validatePrivateDirectory(dirname(evidencePath), "evidence parent");
  return {
    scenario,
    manifestPath,
    manifest,
    wrapper,
    realCli,
    socket,
    workspace,
    marker,
    timeoutMs,
    desktopExecutable,
    evidencePath,
    threadFile,
    threadId,
    desktopPid: optionalPid(args.desktopPid, "desktop-pid"),
    wrapperPid: optionalPid(args.wrapperPid, "wrapper-pid"),
    childPid: optionalPid(args.childPid, "child-pid"),
    pluginServer,
    pluginTool,
  };
}

async function validateManifestFiles(manifestPath, wrapper, realCli, manifest) {
  const manifestInfo = await stat(manifestPath);
  if (!manifestInfo.isFile() || (manifestInfo.mode & 0o777) !== 0o600) throw new AttachError("manifest_permissions", "manifest must be a mode-0600 regular file");
  await assertExecutable(wrapper, "retained wrapper");
  await assertExecutable(realCli, "pinned real CLI");
  if (await sha256File(wrapper) !== manifest.wrapper_sha256) throw new AttachError("wrapper_digest_mismatch", "retained wrapper does not match manifest");
  if (await sha256File(realCli) !== manifest.real_cli_sha256) throw new AttachError("cli_digest_mismatch", "pinned real CLI does not match manifest");
}

async function inspectProcessIdentity(config) {
  const socketInfo = await stat(config.socket).catch(() => null);
  if (!socketInfo?.isSocket() || (socketInfo.mode & 0o777) !== 0o600) throw new AttachError("socket_permissions", "the exact bridge path is not a mode-0600 Unix socket");
  const socketParent = await stat(dirname(config.socket));
  if (!socketParent.isDirectory() || (socketParent.mode & 0o777) !== 0o700) throw new AttachError("socket_parent_permissions", "the bridge socket parent is not a mode-0700 directory");
  const rows = readProcessRows();
  const desktops = rows.filter((row) => row.path === config.desktopExecutable);
  const desktop = chooseProcess(desktops, config.desktopPid, "Desktop");
  const wrappers = rows.filter((row) => row.ppid === desktop.pid && row.path === config.wrapper);
  const wrapper = chooseProcess(wrappers, config.wrapperPid, "retained wrapper child");
  const children = rows.filter((row) => row.ppid === wrapper.pid && row.path === config.realCli);
  const child = chooseProcess(children, config.childPid, "pinned real CLI child");
  assertProcessEnvironment(wrapper.pid, {
    CODEX_CLI_PATH: config.wrapper,
    CODEX_APP_SERVER_FORCE_CLI: "1",
    LOOMHELM_STDIO_PROXY_REAL_CLI: config.realCli,
    LOOMHELM_STDIO_PROXY_SOCKET: config.socket,
  }, "wrapper");
  assertProcessEnvironment(child.pid, { CODEX_CLI_PATH: config.realCli }, "real CLI child");
  const childEnv = readProcessEnvironment(child.pid);
  for (const key of PROXY_CONTROL_KEYS) {
    if (Object.hasOwn(childEnv, key)) throw new AttachError("proxy_environment_leak", `${key} leaked into the real CLI child`);
  }
  const childCwd = readProcessCwd(child.pid);
  if (childCwd !== config.workspace) throw new AttachError("child_cwd_mismatch", "real CLI child cwd does not match the exact test workspace");
  return {
    desktop,
    wrapper,
    child,
    socketMode: (socketInfo.mode & 0o777).toString(8).padStart(3, "0"),
    workspaceMode: (await stat(config.workspace)).mode & 0o777,
  };
}

async function createDedicatedThread(client, config, evidence) {
  const mark = client.mark();
  const response = await client.request("thread/start", {
    model: EXPECTED_MODEL,
    cwd: config.workspace,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
    runtimeWorkspaceRoots: [config.workspace],
    serviceName: "loomhelm-r01-desktop-attach",
  });
  assertSuccess(response, "thread/start");
  const thread = response.result?.thread;
  const threadId = thread?.id;
  if (!threadId || thread.cwd !== config.workspace) throw new AttachError("thread_identity_mismatch", "thread/start did not return the exact test workspace");
  const started = await client.waitFor((message) => message.method === "thread/started" && message.params?.thread?.id === threadId, mark);
  if (!started.message.params?.thread?.cwd || started.message.params.thread.cwd !== config.workspace) throw new AttachError("thread_started_workspace_mismatch", "thread/started did not preserve the exact workspace");
  await writeThreadFile(config.threadFile, {
    format_version: 1,
    thread_id: threadId,
    workspace: config.workspace,
    created_by: "attach-driver",
    marker_prefix: config.marker,
    source_sha: config.manifest.source_sha,
  });
  record(evidence, "dedicated_thread_created", { threadRef: hashRef("thread", threadId), threadFile: config.threadFile, workspace: hashRef("workspace", config.workspace) });
  return threadId;
}

async function validateExistingThread(client, config, threadId, evidence) {
  const response = await client.request("thread/read", { threadId, includeTurns: false });
  assertSuccess(response, "thread/read");
  const thread = response.result?.thread;
  if (!thread || thread.id !== threadId) throw new AttachError("thread_identity_mismatch", "thread/read returned a different thread identity");
  if (thread.cwd !== config.workspace) throw new AttachError("thread_workspace_mismatch", "thread/read returned a different cwd");
  if (thread.canAcceptDirectInput === false) throw new AttachError("thread_not_input_ready", "thread cannot accept direct input");
  record(evidence, "exact_thread_validated", { threadRef: hashRef("thread", threadId), workspace: hashRef("workspace", thread.cwd) });
}

async function runScenario(config, client, threadId, evidence, deps) {
  if (config.scenario === "send") {
    await runSimpleTurn(config, client, threadId, evidence, `Reply exactly ${config.marker}_SEND_OK and do not use tools.`);
    return;
  }
  if (config.scenario === "approval-accept" || config.scenario === "approval-decline") {
    await runApprovalTurn(config, client, threadId, evidence, config.scenario === "approval-accept" ? "accept" : "decline");
    return;
  }
  if (config.scenario === "steer-interrupt") {
    await runSteerInterrupt(config, client, threadId, evidence);
    return;
  }
  if (config.scenario === "disconnect-reconcile") {
    await runDisconnectReconcile(config, client, threadId, evidence, deps);
    return;
  }
  if (config.scenario === "plugin-readonly") {
    await runPluginReadonly(config, client, threadId, evidence);
    return;
  }
  throw new AttachError("scenario_unhandled", `scenario ${config.scenario} was not handled`);
}

async function runSimpleTurn(config, client, threadId, evidence, text) {
  const mark = client.mark();
  const responsePromise = client.request("turn/start", turnParams(config, threadId, text));
  const turnId = await waitForTurnStarted(client, mark, threadId);
  const completed = await waitForTurnCompleted(client, mark, threadId, turnId);
  const response = await responsePromise;
  assertTurnResponse(response, threadId, turnId, "turn/start");
  if (completed.message.params.turn.status !== "completed") throw new AttachError("turn_not_completed", "send turn did not complete");
  record(evidence, "send_turn_completed", { threadRef: hashRef("thread", threadId), turnRef: hashRef("turn", turnId), status: completed.message.params.turn.status });
}

async function runApprovalTurn(config, client, threadId, evidence, decision) {
  const command = `/usr/bin/printf ${config.marker}_${decision.toUpperCase()}`;
  const mark = client.mark();
  const responsePromise = client.request("turn/start", turnParams(config, threadId, `Run exactly this harmless command: ${command}. Test marker ${config.marker}. Do not use any other tool. After it completes, reply exactly ${config.marker}_COMMAND_OK.`));
  const turnId = await waitForTurnStarted(client, mark, threadId);
  const approval = await waitForApproval(client, mark, threadId, turnId);
  assertApprovalCommand(approval.message, command);
  const approvalItemId = messageContext(approval.message).itemId;
  if (!approvalItemId) throw new AttachError("approval_item_identity_missing", "approval request did not identify an item");
  printOwnerAction(`Desktop owner must click ${decision} for the exact harmless command approval, then leave this terminal running.`);
  record(evidence, "approval_request_observed", { decisionExpected: decision, command: hashRef("command", command), requestRef: hashRef("request", approval.message.id) });
  const commandCompleted = await waitForItem(client, mark, "item/completed", threadId, turnId, approvalItemId, "commandExecution");
  const completed = await waitForTurnCompleted(client, mark, threadId, turnId);
  const response = await responsePromise;
  assertTurnResponse(response, threadId, turnId, "turn/start approval");
  const commandStatus = commandCompleted.message.params.item.status;
  const expectedStatus = decision === "accept" ? "completed" : "declined";
  if (commandStatus !== expectedStatus || completed.message.params.turn.status !== "completed") throw new AttachError("approval_result_mismatch", "Desktop approval result did not match the requested owner decision");
  client.respond(approval.message.id, { decision: decision === "accept" ? "decline" : "accept" });
  record(evidence, "owner_first_decision_completed", { decision, commandStatus, turnStatus: completed.message.params.turn.status, turnRef: hashRef("turn", turnId) });
  record(evidence, "late_duplicate_sent", { oppositeDecision: decision === "accept" ? "decline" : "accept", requestRef: hashRef("request", approval.message.id) });
  const historyBefore = client.mark();
  const history = await client.request("thread/turns/list", { threadId, limit: 20, itemsView: "summary" });
  assertSuccess(history, "thread/turns/list after late duplicate");
  await sleep(250);
  if (client.messages.slice(historyBefore).some((message) => message.method === "turn/started" || message.method === "turn/completed")) throw new AttachError("late_duplicate_side_effect", "late duplicate response produced a new turn event");
  record(evidence, "late_duplicate_reconciled", { turnCount: turnList(history).length, noNewTurnEvent: true });
}

async function runSteerInterrupt(config, client, threadId, evidence) {
  const command = "/bin/sleep 30";
  const mark = client.mark();
  const responsePromise = client.request("turn/start", turnParams(config, threadId, `Run exactly this harmless command: ${command}. Test marker ${config.marker}. Do not use any other tool.`));
  const turnId = await waitForTurnStarted(client, mark, threadId);
  const approval = await waitForApproval(client, mark, threadId, turnId);
  assertApprovalCommand(approval.message, command);
  const approvalItemId = messageContext(approval.message).itemId;
  if (!approvalItemId) throw new AttachError("approval_item_identity_missing", "approval request did not identify an item");
  printOwnerAction("Desktop owner must click accept for the exact harmless sleep command; the driver will steer and interrupt only after the command starts.");
  await waitForItem(client, mark, "item/started", threadId, turnId, approvalItemId, "commandExecution");
  const steer = await client.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: `Stop and reply exactly ${config.marker}_STEER_OK.` }] });
  assertTurnControlResponse(steer, threadId, turnId, "turn/steer");
  const interrupt = await client.request("turn/interrupt", { threadId, turnId });
  assertTurnControlResponse(interrupt, threadId, turnId, "turn/interrupt");
  const completed = await waitForTurnCompleted(client, mark, threadId, turnId);
  const response = await responsePromise;
  assertSuccess(response, "turn/start steer-interrupt");
  if (completed.message.params.turn.status !== "interrupted") throw new AttachError("interrupt_status_mismatch", "turn did not complete as interrupted");
  record(evidence, "steer_and_interrupt_completed", { turnRef: hashRef("turn", turnId), status: completed.message.params.turn.status, expectedTurnRef: hashRef("turn", turnId) });
}

async function runDisconnectReconcile(config, firstClient, threadId, evidence, deps) {
  const command = "/bin/sleep 30";
  const mark = firstClient.mark();
  const responsePromise = firstClient.request("turn/start", turnParams(config, threadId, `Run exactly this harmless command: ${command}. Test marker ${config.marker}. Do not use any other tool.`));
  const turnId = await waitForTurnStarted(firstClient, mark, threadId);
  const approval = await waitForApproval(firstClient, mark, threadId, turnId);
  assertApprovalCommand(approval.message, command);
  const approvalItemId = messageContext(approval.message).itemId;
  if (!approvalItemId) throw new AttachError("approval_item_identity_missing", "approval request did not identify an item");
  printOwnerAction("Leave the Desktop approval pending. The driver will close only its bridge socket, reconnect, then ask you to click decline in Desktop.");
  firstClient.close();
  await sleep(250);
  const identityAfterDisconnect = await deps.inspectProcessIdentity(config);
  record(evidence, "bridge_disconnected_without_child_restart", { childPid: hashRef("pid", identityAfterDisconnect.child.pid), threadRef: hashRef("thread", threadId), turnRef: hashRef("turn", turnId), requestRef: hashRef("request", approval.message.id) });
  await responsePromise.catch(() => undefined);
  const secondClient = await deps.connectExistingSocket(config.socket, config.timeoutMs, config);
  try {
    const model = await secondClient.request("model/list", {});
    assertSuccess(model, "reconnected model/list");
    const markAfterReconnect = secondClient.mark();
    const history = await secondClient.request("thread/turns/list", { threadId, limit: 20, itemsView: "summary" });
    assertSuccess(history, "reconnected thread/turns/list");
    record(evidence, "bridge_reconnected_and_reconciled", { threadRef: hashRef("thread", threadId), turnCount: turnList(history).length, childPid: hashRef("pid", identityAfterDisconnect.child.pid) });
    printOwnerAction("Desktop owner must now click decline for the still-pending exact harmless sleep approval.");
    const item = await waitForItem(secondClient, markAfterReconnect, "item/completed", threadId, turnId, approvalItemId, "commandExecution");
    const completed = await waitForTurnCompleted(secondClient, markAfterReconnect, threadId, turnId);
    if (item.message.params.item.status !== "declined" || completed.message.params.turn.status !== "completed") throw new AttachError("disconnect_reconcile_status", "Desktop did not reconcile the pending approval as declined");
    const finalIdentity = await deps.inspectProcessIdentity(config);
    if (finalIdentity.child.pid !== identityAfterDisconnect.child.pid) throw new AttachError("disconnect_child_changed", "child PID changed across bridge disconnect and reconnect");
    record(evidence, "desktop_pending_approval_reconciled_after_reconnect", { commandStatus: item.message.params.item.status, turnStatus: completed.message.params.turn.status, turnRef: hashRef("turn", completed.message.params.turn.id) });
  } finally {
    secondClient.close();
  }
}

async function runPluginReadonly(config, client, threadId, evidence) {
  const prompt = `Use the installed ChatGPT Codex app tool ${config.pluginTool} on server ${config.pluginServer} to read current thread/task metadata. Read only. Verify marker ${config.marker} in the current thread and return the current thread identity. Do not create, update, send, move, schedule, open panels, or invoke filesystem/network tools. If no read-only current-thread tool is available, reply exactly ${config.marker}_PLUGIN_TOOL_UNAVAILABLE.`;
  printOwnerAction("Desktop owner must manually handle any current-runtime codex_app/MCP callback and approve only the read-only current-thread lookup; the bridge will never answer an owner-bound callback.");
  const mark = client.mark();
  const responsePromise = client.request("turn/start", turnParams(config, threadId, prompt));
  const turnId = await waitForTurnStarted(client, mark, threadId);
  const completed = await waitForTurnCompleted(client, mark, threadId, turnId);
  const response = await responsePromise;
  assertTurnResponse(response, threadId, turnId, "turn/start plugin-readonly");
  if (completed.message.params.turn.status !== "completed") throw new AttachError("plugin_turn_status", "plugin read-only turn did not complete");
  const messages = client.messages.slice(mark).filter((message) => matchesTurn(message, threadId, turnId));
  const startedMcpItems = messages.filter((message) => message.method === "item/started" && message.params?.item?.type === "mcpToolCall");
  const completedMcpItems = messages.filter((message) => message.method === "item/completed" && message.params?.item?.type === "mcpToolCall");
  if (client.ownerBoundRequests?.length > 0) throw new AttachError("owner_bound_callback_on_bridge", "bridge received an owner-bound MCP request");
  const exactCompleted = completedMcpItems.filter((message) => message.params.item.server === config.pluginServer && message.params.item.tool === config.pluginTool);
  const successful = exactCompleted.find((message) => isSuccessfulPluginItem(message.params.item));
  if (successful) {
    record(evidence, "plugin_readonly_result", {
      threadRef: hashRef("thread", threadId),
      turnRef: hashRef("turn", turnId),
      itemRef: hashRef("item", messageContext(successful).itemId),
      server: config.pluginServer,
      tool: config.pluginTool,
      status: successful.params.item.status,
      ownerBoundCallbackOnBridge: false,
    });
    return;
  }
  if (exactCompleted.some((message) => message.params.item.status === "failed" || message.params.item.error)) throw new AttachError("plugin_tool_error", "the selected read-only plugin tool completed with an error");
  if (completedMcpItems.length > 0) throw new AttachError("plugin_tool_unsupported", "an MCP item completed, but not for the selected codex_app read-only tool");
  if (startedMcpItems.length > 0) throw new AttachError("plugin_tool_incomplete", "the selected plugin tool started without a successful completed item");
  if (messages.some((message) => messageContains(message, `${config.marker}_PLUGIN_TOOL_UNAVAILABLE`))) throw new AttachError("plugin_tool_unavailable", "Desktop reported that the selected read-only plugin tool is unavailable");
  throw new AttachError("plugin_tool_unavailable", "no completed structured result for the selected read-only plugin tool was observed");
}

function turnParams(config, threadId, text) {
  if (!text.includes(config.marker)) throw new AttachError("prompt_marker_missing", "turn prompt is not bound to the exact test marker");
  return {
    threadId,
    input: [{ type: "text", text }],
    model: EXPECTED_MODEL,
    effort: EXPECTED_EFFORT,
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [config.workspace], networkAccess: false },
  };
}

function assertApprovalCommand(message, command) {
  const observedCommand = message.params?.command;
  if (observedCommand !== command) throw new AttachError("approval_command_mismatch", "approval request did not contain the exact harmless command");
}

function isOwnerBoundMethod(method) {
  const normalized = String(method).toLowerCase();
  return OWNER_BOUND_METHODS.has(method) || normalized.includes("userverification") || normalized.includes("mcp") || normalized.includes("plugin") || normalized.startsWith("account/");
}

function assertSuccess(message, operation) {
  if (!message?.result || message.error) throw new AttachError("rpc_error", `${operation} failed: ${message?.error?.message ?? "missing result"}`);
}

function assertModelCapability(message) {
  const models = message.result?.data ?? message.result?.models ?? [];
  const model = models.find((candidate) => candidate.id === EXPECTED_MODEL);
  if (!model || !model.supportedReasoningEfforts?.some((effort) => effort.reasoningEffort === EXPECTED_EFFORT)) throw new AttachError("model_constraint_failed", "Desktop did not advertise the pinned model and max effort");
}

function chooseProcess(rows, expectedPid, label) {
  if (expectedPid !== null) {
    const exact = rows.find((row) => row.pid === expectedPid);
    if (!exact) throw new AttachError("process_identity_mismatch", `${label} PID did not match the expected executable chain`);
    return exact;
  }
  if (rows.length !== 1) throw new AttachError("process_identity_ambiguous", `expected exactly one ${label} process in the exact chain`);
  return rows[0];
}

function readProcessRows() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new AttachError("process_inspection_failed", "ps could not inspect the Desktop process tree");
  return result.stdout.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) return [];
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return [];
    return [{ pid, ppid, path: fields[2], command: fields.slice(2).join(" ") }];
  });
}

function readProcessEnvironment(pid) {
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) throw new AttachError("process_environment_unavailable", "ps could not inspect the exact process environment");
  const environment = {};
  const assignmentPattern = /(?:^|\s)([A-Z][A-Z0-9_]*)=([^\s]*)/g;
  for (const match of result.stdout.matchAll(assignmentPattern)) environment[match[1]] = match[2];
  return environment;
}

function assertProcessEnvironment(pid, expected, label) {
  const environment = readProcessEnvironment(pid);
  for (const [key, value] of Object.entries(expected)) {
    if (environment[key] !== value) throw new AttachError("process_environment_mismatch", `${label} does not contain the exact ${key} binding`);
  }
}

function readProcessCwd(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  if (result.status !== 0) throw new AttachError("process_cwd_unavailable", "lsof could not inspect the exact real CLI cwd");
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("n"));
  if (!line) throw new AttachError("process_cwd_unavailable", "exact real CLI cwd was not reported");
  return line.slice(1);
}

function record(evidence, type, fields = {}) {
  evidence.events.push({ type, ...fields });
}

function printOwnerAction(message) {
  process.stdout.write(`OWNER ACTION REQUIRED: ${message}\n`);
}

function messageContains(message, token) {
  return JSON.stringify(message).includes(token);
}

function turnList(message) {
  return message.result?.data ?? message.result?.turns ?? [];
}

function messageContext(message) {
  const params = message?.params ?? {};
  const thread = params.thread ?? {};
  const turn = params.turn ?? {};
  const item = params.item ?? {};
  return {
    threadId: params.threadId ?? thread.id ?? turn.threadId ?? item.threadId ?? item.turn?.threadId ?? null,
    turnId: params.turnId ?? turn.id ?? item.turnId ?? item.turn?.id ?? null,
    itemId: params.itemId ?? item.id ?? null,
  };
}

function matchesThread(message, threadId) {
  return messageContext(message).threadId === threadId;
}

function matchesTurn(message, threadId, turnId) {
  const context = messageContext(message);
  return context.threadId === threadId && context.turnId === turnId;
}

function matchesItem(message, threadId, turnId, itemId) {
  const context = messageContext(message);
  return context.threadId === threadId && context.turnId === turnId && context.itemId === itemId;
}

async function waitForTurnStarted(client, after, threadId) {
  const result = await client.waitFor((message) => message.method === "turn/started" && matchesThread(message, threadId) && messageContext(message).turnId, after);
  const turnId = messageContext(result.message).turnId;
  if (!turnId) throw new AttachError("turn_identity_missing", "turn/started did not identify an active turn");
  return turnId;
}

async function waitForTurnCompleted(client, after, threadId, turnId) {
  return client.waitFor((message) => message.method === "turn/completed" && matchesTurn(message, threadId, turnId), after);
}

async function waitForApproval(client, after, threadId, turnId) {
  return client.waitFor((message) => message.method === "item/commandExecution/requestApproval" && matchesTurn(message, threadId, turnId), after);
}

async function waitForItem(client, after, method, threadId, turnId, itemId, type) {
  return client.waitFor((message) => message.method === method && matchesItem(message, threadId, turnId, itemId) && message.params?.item?.type === type, after);
}

function assertTurnResponse(message, threadId, turnId, operation) {
  assertSuccess(message, operation);
  const returnedTurnId = message.result?.turn?.id ?? message.result?.turnId;
  if (returnedTurnId !== turnId) throw new AttachError("turn_identity_mismatch", `${operation} returned a different turn identity`);
  const returnedThreadId = message.result?.threadId ?? message.result?.turn?.threadId ?? message.result?.turn?.thread?.id;
  if (returnedThreadId && returnedThreadId !== threadId) throw new AttachError("turn_thread_mismatch", `${operation} returned a different thread identity`);
}

function assertTurnControlResponse(message, threadId, turnId, operation) {
  assertSuccess(message, operation);
  const returnedTurnId = message.result?.turn?.id ?? message.result?.turnId;
  if (returnedTurnId && returnedTurnId !== turnId) throw new AttachError("turn_identity_mismatch", `${operation} returned a different turn identity`);
  const returnedThreadId = message.result?.threadId ?? message.result?.turn?.threadId ?? message.result?.turn?.thread?.id;
  if (returnedThreadId && returnedThreadId !== threadId) throw new AttachError("turn_thread_mismatch", `${operation} returned a different thread identity`);
}

function isSuccessfulPluginItem(item) {
  return item.status === "completed" && !item.error && (Object.hasOwn(item, "result") || Object.hasOwn(item, "output") || Object.hasOwn(item, "content"));
}

async function writeThreadFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

async function readThreadId(path, workspace, marker) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || (info.mode & 0o777) !== 0o600) throw new AttachError("thread_file_permissions", "thread file must be an existing mode-0600 file");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new AttachError("thread_file_invalid", "thread file is not valid JSON");
  }
  if (parsed.workspace !== workspace || parsed.created_by !== "attach-driver" || parsed.marker_prefix !== marker || typeof parsed.thread_id !== "string" || !parsed.thread_id) {
    throw new AttachError("thread_file_mismatch", "thread file is not bound to the exact workspace and marker");
  }
  return parsed.thread_id;
}

async function validatePrivateDirectory(path, label) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory() || (info.mode & 0o777) !== 0o700) throw new AttachError("private_directory_invalid", `${label} must be an existing mode-0700 directory`);
}

async function assertExecutable(path, label) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new AttachError("executable_invalid", `${label} is not an executable regular file`);
}

async function readKeyValueFile(path) {
  const values = {};
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function requiredPath(value, label) {
  if (!value || !String(value).startsWith("/")) throw new AttachError("argument_invalid", `${label} must be an absolute path`);
  return resolve(value);
}

function requiredValue(value, label) {
  if (!value) throw new AttachError("manifest_invalid", `manifest is missing ${label}`);
  return value;
}

function optionalPid(value, label) {
  if (value === undefined) return null;
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 1) throw new AttachError("argument_invalid", `${label} must be a positive process id`);
  return pid;
}

function boundedTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) throw new AttachError("argument_invalid", "timeout must be between 1000 and 300000 milliseconds");
  return timeout;
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeError(error) {
  if (error instanceof AttachError) return error;
  return new AttachError("unexpected_error", error instanceof Error ? error.message : String(error));
}

function sleep(durationMs) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs));
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new AttachError("argument_invalid", `unexpected positional argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "help") return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AttachError("argument_invalid", `missing value for --${token.slice(2)}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function printUsage() {
  process.stdout.write(`Attach-only Desktop bridge driver\n\nRequired: --manifest PATH --socket PATH --workspace PATH --marker LOOMHELM_R01_*\nScenarios: preflight, create-thread, send, approval-accept, approval-decline, steer-interrupt, disconnect-reconcile, plugin-readonly\nThread scenarios: --thread-file PATH or --thread-id ID; create-thread requires a new --thread-file\nPlugin scenario: --plugin-tool OWNER_SELECTED_READ_ONLY_CODEX_APP_TOOL\nOptional: --desktop-pid PID --wrapper-pid PID --child-pid PID --evidence PATH --timeout-ms MS\nThe driver only dials an existing private socket; it never starts app-server or sends initialize.\n`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    const evidence = await runAttachScenario(args);
    process.stdout.write(`${JSON.stringify({ result: evidence.result, scenario: evidence.scenario, evidence: args.evidence ? resolve(args.evidence) : null, error: evidence.error?.code ?? null }, null, 2)}\n`);
    process.exitCode = evidence.result === "passed" ? 0 : 1;
  } catch (error) {
    const normalized = normalizeError(error);
    process.stderr.write(`attach-driver: ${normalized.code}: ${normalized.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
