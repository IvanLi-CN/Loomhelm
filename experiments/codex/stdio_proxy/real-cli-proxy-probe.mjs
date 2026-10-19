#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? "/private/tmp/loomhelm-r01-codex-test");
const runDir = join(root, `real-cli-${Date.now()}-${randomBytes(4).toString("hex")}`);
const socketPath = resolve(args.socket ?? join(root, "r01-proxy.sock"));
const workspace = resolve(args.workspace ?? join(runDir, "workspace"));
const evidencePath = resolve(args.evidence ?? join(runDir, "evidence.json"));
const stageManifest = args.stageManifest ? resolve(args.stageManifest) : null;
const manifest = stageManifest ? await readManifest(stageManifest) : {};
const wrapper = resolve(args.wrapper ?? manifest.wrapper_path ?? "");
const realCli = resolve(args.realCli ?? manifest.real_cli_path ?? "");
const timeoutMs = Number(args.timeoutMs ?? 180_000);
const events = [];
const refs = new Map();
const startedAt = new Date().toISOString();
let child = null;
let bridge = null;
let desktop = null;
let childExit = null;
let identityChallenge = null;
let threadId = null;
let sessionId = null;
let activeTurnId = null;
let wrapperPid = null;
let childPid = null;
let timeoutHandle = null;

class ProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
  }
}

class JsonEndpoint {
  constructor(name, input, output) {
    this.name = name;
    this.input = input;
    this.output = output;
    this.buffer = "";
    this.messages = [];
    this.pending = new Map();
    this.waiters = [];
    this.sequence = 0;
    this.closed = false;
    input.on("data", (chunk) => this.consume(String(chunk)));
    input.on("close", () => this.markClosed());
    input.on("end", () => this.markClosed());
    input.on("error", (error) => {
      record("endpoint_error", { client: name, error: error.message });
      this.markClosed();
    });
  }

  mark() {
    return this.messages.length;
  }

  request(method, params) {
    const id = `r01-${this.name}-${++this.sequence}`;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(idKey(id), { resolve: resolveResponse, reject: rejectResponse, method });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  send(message) {
    if (this.closed) throw new ProbeError("endpoint_closed", `${this.name} endpoint is closed`);
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate, after, durationMs = 15_000) {
    for (let index = after; index < this.messages.length; index += 1) {
      if (predicate(this.messages[index])) return Promise.resolve({ message: this.messages[index], index });
    }
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = { predicate, after, resolve: resolveMessage, reject: rejectMessage };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        rejectMessage(new ProbeError("event_timeout", `${this.name} did not receive the expected event`));
      }, durationMs);
      waiter.timer = timer;
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.destroy?.();
    this.output.destroy?.();
    for (const pending of this.pending.values()) pending.reject(new ProbeError("endpoint_closed", `${this.name} endpoint closed`));
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new ProbeError("endpoint_closed", `${this.name} endpoint closed`));
    }
    this.waiters = [];
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
        record("non_json_output", { client: this.name });
        continue;
      }
      this.handle(message);
    }
  }

  handle(message) {
    const index = this.messages.push(message) - 1;
    if (message.method && isIdentityChallenge(message.method)) {
      identityChallenge = message.method;
      record("identity_challenge", { client: this.name, method: message.method });
    }
    const pending = message.id === undefined ? null : this.pending.get(idKey(message.id));
    if (pending) {
      this.pending.delete(idKey(message.id));
      pending.resolve(message);
    }
    for (const waiter of [...this.waiters]) {
      if (index >= waiter.after && waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve({ message, index });
      }
    }
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
  }
}

try {
  await validatePaths();
  await prepareRunDirectories();
  record("probe_started", {
    transport: "stdio_proxy",
    wrapper: "<RETAINED_WRAPPER>",
    wrapperSha256: await sha256File(wrapper),
    realCli: "<BUNDLED_REAL_CLI>",
    realCliSha256: await sha256File(realCli),
    realCliVersion: readVersion(realCli),
    sourceSha: manifest.source_sha ?? null,
    model: "gpt-5.6-luna",
    effort: "max",
    workspace: "<TEST_WORKSPACE>",
  });

  child = spawnProxy();
  wrapperPid = child.pid;
  const childExitPromise = waitForChildExit(child);
  timeoutHandle = setTimeout(() => {
    record("probe_timeout", { threadRef: ref("thread", threadId), turnRef: ref("turn", activeTurnId) });
    terminateProxy();
  }, timeoutMs);

  desktop = new JsonEndpoint("desktop", child.stdout, child.stdin);
  const desktopInit = await desktop.request("initialize", {
    clientInfo: {
      name: "loomhelm_r01_stdio_proxy_probe",
      title: "Loomhelm R01 stdio proxy probe",
      version: "0.1.0",
    },
  });
  assertResult(desktopInit, "Desktop initialize");
  record("desktop_initialize_completed", {
    userAgent: sanitizeUserAgent(desktopInit.result?.userAgent),
    platform: desktopInit.result?.platformOs ?? null,
    codexHome: "<CODEX_HOME>",
  });
  desktop.notify("initialized", {});

  await waitForPath(socketPath, 5_000);
  bridge = await connectBridge(socketPath);
  const bridgeInit = await bridge.request("initialize", {
    clientInfo: {
      name: "loomhelm_r01_stdio_bridge_probe",
      title: "Loomhelm R01 bridge logical client",
      version: "0.1.0",
    },
  });
  assertError(bridgeInit, -32002, "bridge initialize ownership");
  record("bridge_initialize_rejected_as_desktop_owned", { code: bridgeInit.error.code });

  const modelResponse = await bridge.request("model/list", {});
  assertResult(modelResponse, "bridge model/list");
  const models = modelResponse.result?.data ?? modelResponse.result?.models ?? [];
  const luna = models.find((model) => model.id === "gpt-5.6-luna");
  if (!luna || !luna.supportedReasoningEfforts?.some((item) => item.reasoningEffort === "max")) {
    throw new ProbeError("model_constraint_failed", "gpt-5.6-luna with max effort was not advertised");
  }
  record("bridge_capabilities_observed", {
    modelCount: models.length,
    modelFound: true,
    supportedEfforts: luna.supportedReasoningEfforts.map((item) => item.reasoningEffort),
  });

  const desktopThreadMark = desktop.mark();
  const bridgeThreadMark = bridge.mark();
  const threadResponse = await desktop.request("thread/start", {
    model: "gpt-5.6-luna",
    cwd: workspace,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
    serviceName: "loomhelm_r01_stdio_proxy_probe",
  });
  assertResult(threadResponse, "Desktop thread/start");
  threadId = threadResponse.result?.thread?.id ?? null;
  sessionId = threadResponse.result?.thread?.sessionId ?? threadId;
  if (!threadId) throw new ProbeError("missing_thread_id", "thread/start returned no thread id");
  record("thread_created", { threadRef: ref("thread", threadId), sessionRef: ref("session", sessionId) });
  const [desktopThreadEvent, bridgeThreadEvent] = await Promise.all([
    desktop.waitFor((message) => message.method === "thread/started", desktopThreadMark),
    bridge.waitFor((message) => message.method === "thread/started", bridgeThreadMark),
  ]);
  assertSameRef("thread_started_broadcast", desktopThreadEvent.message.params?.thread?.id, bridgeThreadEvent.message.params?.thread?.id);
  record("same_thread_event_seen_by_both_clients", {
    desktopThreadRef: ref("thread", desktopThreadEvent.message.params?.thread?.id),
    bridgeThreadRef: ref("thread", bridgeThreadEvent.message.params?.thread?.id),
    wrapperPid,
    childPid: await findPinnedChildPid(wrapperPid, realCli),
  });
  childPid = await findPinnedChildPid(wrapperPid, realCli);

  await runApprovalTurn("accept", "/usr/bin/printf R01_PROXY_APPROVED", "accept", false);
  await runApprovalTurn("decline", "/usr/bin/printf R01_PROXY_DECLINED", "decline", true);

  await runDisconnectSteerInterruptScenario();

  record("probe_completed", {
    sameChildPid: childPid === (await findPinnedChildPid(wrapperPid, realCli)),
    threadRef: ref("thread", threadId),
    sessionRef: ref("session", sessionId),
  });
  terminateProxy();
  childExit = await childExitPromise;
} catch (error) {
  const probeError = normalizeError(error);
  record("probe_failed", { code: probeError.code, message: redact(probeError.message) });
  terminateProxy();
  if (child) childExit = await waitForExitOrTimeout(child, 5_000);
} finally {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  bridge?.close();
}

const result = {
  result: events.some((event) => event.type === "probe_completed") ? "passed" : "failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  transport: "stdio_proxy",
  sourceSha: manifest.source_sha ?? null,
  wrapperSha256: await safeSha(wrapper),
  realCliSha256: await safeSha(realCli),
  realCliVersion: safeVersion(realCli),
  model: "gpt-5.6-luna",
  effort: "max",
  workspace: "<TEST_WORKSPACE>",
  socket: "<PRIVATE_PROXY_SOCKET>",
  wrapperPid,
  childPid,
  threadRef: ref("thread", threadId),
  sessionRef: ref("session", sessionId),
  childExit,
  identityChallenge,
  checks: summarizeChecks(events),
  events,
};
await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...result, evidence: "<EVIDENCE_JSON>" }, null, 2)}\n`);
process.exitCode = result.result === "passed" ? 0 : 1;

async function runApprovalTurn(phase, command, decision, sendLateDesktopResponse) {
  activeTurnId = null;
  const desktopMark = desktop.mark();
  const bridgeMark = bridge.mark();
  const turnPromise = desktop.request("turn/start", turnParams(command));
  const [desktopApproval, bridgeApproval] = await Promise.all([
    desktop.waitFor(isCommandApproval, desktopMark),
    bridge.waitFor(isCommandApproval, bridgeMark),
  ]);
  assertCommandApproval(desktopApproval.message, command, phase, "desktop");
  assertCommandApproval(bridgeApproval.message, command, phase, "bridge");
  record("approval_broadcast_seen", {
    phase,
    desktopRequestRef: ref("request", desktopApproval.message.id),
    bridgeRequestRef: ref("request", bridgeApproval.message.id),
    commandDigest: digest(command),
  });

  if (decision === "accept") {
    desktop.respond(desktopApproval.message.id, { decision });
  } else {
    bridge.respond(bridgeApproval.message.id, { decision });
    await sleep(100);
    if (sendLateDesktopResponse) desktop.respond(desktopApproval.message.id, { decision: "accept" });
  }
  record("approval_decision_arbitrated", { phase, decision, winner: decision === "accept" ? "desktop" : "bridge" });

  const turnResponse = await turnPromise;
  assertResult(turnResponse, `${phase} turn/start`);
  activeTurnId = turnResponse.result?.turn?.id ?? activeTurnId;
  if (!activeTurnId) {
    const started = await desktop.waitFor((message) => message.method === "turn/started", desktopMark);
    activeTurnId = started.message.params?.turn?.id ?? null;
  }
  const [desktopCompleted, bridgeCompleted, desktopItem] = await Promise.all([
    desktop.waitFor((message) => message.method === "turn/completed", desktopMark),
    bridge.waitFor((message) => message.method === "turn/completed", bridgeMark),
    desktop.waitFor(isCommandCompleted, desktopMark),
  ]);
  const desktopStatus = desktopItem.message.params?.item?.status ?? null;
  const turnStatus = desktopCompleted.message.params?.turn?.status ?? null;
  if (phase === "accept" && desktopStatus !== "completed") {
    throw new ProbeError("accepted_command_status", `accepted command status was ${desktopStatus}`);
  }
  if (phase === "decline" && desktopStatus !== "declined") {
    throw new ProbeError("declined_command_status", `declined command status was ${desktopStatus}`);
  }
  if (turnStatus !== "completed") throw new ProbeError("approval_turn_status", `${phase} turn status was ${turnStatus}`);
  assertSameRef("approval_turn_broadcast", desktopCompleted.message.params?.turn?.id, bridgeCompleted.message.params?.turn?.id);
  record("approval_turn_completed", {
    phase,
    commandDigest: digest(command),
    commandStatus: desktopStatus,
    turnStatus,
    turnRef: ref("turn", desktopCompleted.message.params?.turn?.id),
  });
}

async function runDisconnectSteerInterruptScenario() {
  activeTurnId = null;
  const desktopMark = desktop.mark();
  const bridgeMark = bridge.mark();
  const turnPromise = desktop.request("turn/start", turnParams("/bin/sleep 30"));
  const [desktopApproval, bridgeApproval] = await Promise.all([
    desktop.waitFor(isCommandApproval, desktopMark),
    bridge.waitFor(isCommandApproval, bridgeMark),
  ]);
  assertCommandApproval(desktopApproval.message, "/bin/sleep 30", "disconnect", "desktop");
  assertCommandApproval(bridgeApproval.message, "/bin/sleep 30", "disconnect", "bridge");
  record("pending_approval_observed_before_bridge_disconnect", {
    desktopRequestRef: ref("request", desktopApproval.message.id),
    bridgeRequestRef: ref("request", bridgeApproval.message.id),
    commandDigest: digest("/bin/sleep 30"),
  });
  bridge.close();
  bridge = null;
  await sleep(200);
  const childBeforeReconnect = await findPinnedChildPid(wrapperPid, realCli);
  desktop.respond(desktopApproval.message.id, { decision: "accept" });
  const turnResponse = await turnPromise;
  assertResult(turnResponse, "disconnect turn/start");
  activeTurnId = turnResponse.result?.turn?.id ?? activeTurnId;
  if (!activeTurnId) throw new ProbeError("missing_interrupt_turn_id", "long turn returned no turn id");
  record("desktop_reconciled_pending_approval_after_bridge_disconnect", {
    sameChildPid: childBeforeReconnect === (await findPinnedChildPid(wrapperPid, realCli)),
    turnRef: ref("turn", activeTurnId),
  });

  bridge = await connectBridge(socketPath);
  const modelAfterReconnect = await bridge.request("model/list", {});
  assertResult(modelAfterReconnect, "reconnected bridge model/list");
  const history = await bridge.request("thread/turns/list", {
    threadId,
    limit: 20,
    itemsView: "summary",
  });
  assertResult(history, "reconnected bridge thread/turns/list");
  const turns = history.result?.data ?? history.result?.turns ?? [];
  record("bridge_reconnected_and_reconciled", {
    sameChildPid: childBeforeReconnect === (await findPinnedChildPid(wrapperPid, realCli)),
    sameThreadRef: ref("thread", threadId),
    observedTurnCount: turns.length,
    observedTurnStatuses: turns.map((turn) => turn.status ?? null),
  });

  const steerResponse = await bridge.request("turn/steer", {
    threadId,
    expectedTurnId: activeTurnId,
    input: [{ type: "text", text: "Stop the running command and reply exactly R01_STEER_OK." }],
  });
  assertResult(steerResponse, "bridge turn/steer");
  const steeredTurnId = steerResponse.result?.turnId ?? null;
  if (!steeredTurnId) throw new ProbeError("missing_steer_turn_id", "turn/steer returned no turn id");
  record("real_turn_steer_accepted", {
    requestRef: ref("request", steerResponse.id),
    expectedTurnRef: ref("turn", activeTurnId),
    responseTurnRef: ref("turn", steeredTurnId),
  });

  const desktopInterruptMark = desktop.mark();
  const bridgeInterruptMark = bridge.mark();
  const interruptResponse = await bridge.request("turn/interrupt", { threadId, turnId: steeredTurnId });
  assertResult(interruptResponse, "bridge turn/interrupt");
  const [desktopCompleted, bridgeCompleted] = await Promise.all([
    desktop.waitFor((message) => message.method === "turn/completed", desktopInterruptMark),
    bridge.waitFor((message) => message.method === "turn/completed", bridgeInterruptMark),
  ]);
  const desktopStatus = desktopCompleted.message.params?.turn?.status ?? null;
  const bridgeStatus = bridgeCompleted.message.params?.turn?.status ?? null;
  if (desktopStatus !== "interrupted" || bridgeStatus !== "interrupted") {
    throw new ProbeError("interrupt_status", `Desktop=${desktopStatus}, bridge=${bridgeStatus}`);
  }
  assertSameRef("interrupt_turn_broadcast", desktopCompleted.message.params?.turn?.id, bridgeCompleted.message.params?.turn?.id);
  record("real_turn_interrupt_completed", {
    turnRef: ref("turn", desktopCompleted.message.params?.turn?.id),
    desktopStatus,
    bridgeStatus,
  });
}

function spawnProxy() {
  const env = { ...process.env };
  delete env.CODEX_CI;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  env.CODEX_CLI_PATH = wrapper;
  env.CODEX_APP_SERVER_FORCE_CLI = "1";
  env.LOOMHELM_STDIO_PROXY_REAL_CLI = realCli;
  env.LOOMHELM_STDIO_PROXY_SOCKET = socketPath;
  env.LOOMHELM_STDIO_PROXY_BRIDGE_QUEUE = "16";
  const childProcess = spawn(wrapper, ["app-server", "--listen", "stdio://"], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stderr.on("data", () => record("stderr_observed", {}));
  childProcess.on("error", (error) => record("process_error", { name: error.name }));
  return childProcess;
}

function waitForChildExit(process) {
  return new Promise((resolveExit) => process.once("close", (code, signal) => resolveExit({ code, signal })));
}

async function waitForExitOrTimeout(process, durationMs) {
  return Promise.race([waitForChildExit(process), sleep(durationMs).then(() => ({ code: null, signal: "timeout" }))]);
}

function terminateProxy() {
  if (child && !child.killed) child.kill("SIGTERM");
}

async function validatePaths() {
  if (!wrapper || !realCli) throw new ProbeError("missing_candidate_path", "wrapper and real CLI paths are required");
  await assertExecutable(wrapper, "retained wrapper");
  await assertExecutable(realCli, "bundled real CLI");
  if (manifest.wrapper_sha256 && (await sha256File(wrapper)) !== manifest.wrapper_sha256) {
    throw new ProbeError("wrapper_digest_mismatch", "retained wrapper digest does not match the manifest");
  }
  if (manifest.real_cli_sha256 && (await sha256File(realCli)) !== manifest.real_cli_sha256) {
    throw new ProbeError("real_cli_digest_mismatch", "bundled real CLI digest does not match the manifest");
  }
  if (!socketPath.startsWith(`${root}/`) || dirname(socketPath) !== root) {
    throw new ProbeError("socket_scope_invalid", "proxy socket must be a direct child of the private probe root");
  }
  if (socketPath.length > 90) throw new ProbeError("socket_path_too_long", "proxy socket path exceeds the probe bound");
}

async function prepareRunDirectories() {
  await ensurePrivateDirectory(root);
  await mkdir(runDir, { mode: 0o700 });
  await chmod(runDir, 0o700);
  await mkdir(workspace, { mode: 0o700, recursive: true });
  await chmod(workspace, 0o700);
  if (await pathExists(socketPath)) throw new ProbeError("stale_socket", "the dedicated proxy socket path already exists");
}

async function ensurePrivateDirectory(path) {
  if (!(await pathExists(path))) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
    return;
  }
  const info = await stat(path);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new ProbeError("private_directory_invalid", "the probe root must be an existing 0700 directory");
  }
}

async function assertExecutable(path, label) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new ProbeError("executable_invalid", `${label} is not an executable regular file`);
}

async function connectBridge(path) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connect(path);
    const onError = (error) => rejectSocket(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      socket.setEncoding("utf8");
      resolveSocket(new JsonEndpoint("bridge", socket, socket));
    });
  });
}

function turnParams(command) {
  return {
    threadId,
    input: [{ type: "text", text: `Run exactly this harmless command in the test workspace: ${command}. Do not use any other tool. After it completes, reply exactly R01_PROXY_OK.` }],
    model: "gpt-5.6-luna",
    effort: "max",
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
  };
}

function isCommandApproval(message) {
  return message.method === "item/commandExecution/requestApproval";
}

function isCommandCompleted(message) {
  return message.method === "item/completed" && message.params?.item?.type === "commandExecution";
}

function assertCommandApproval(message, command, phase, client) {
  if (!isCommandApproval(message)) throw new ProbeError("approval_method", `${client} did not receive command approval`);
  const commandValue = message.params?.command;
  if (commandValue && digest(commandValue) !== digest(command) && !String(commandValue).includes(command)) {
    throw new ProbeError("approval_command_mismatch", `${phase} approval command did not match the harmless fixture`);
  }
}

function assertResult(message, operation) {
  if (identityChallenge) throw new ProbeError("identity_challenge", `identity challenge observed during ${operation}`);
  if (!message?.result || message.error) {
    throw new ProbeError("rpc_error", `${operation} failed: ${message?.error?.message ?? "missing result"}`);
  }
}

function assertError(message, code, operation) {
  if (!message?.error || message.error.code !== code) {
    throw new ProbeError("unexpected_rpc_result", `${operation} returned an unexpected response`);
  }
}

function assertSameRef(label, left, right) {
  if (!left || !right || left !== right) throw new ProbeError("broadcast_identity_mismatch", `${label} did not preserve the same identity`);
}

async function findPinnedChildPid(parentPid, path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "";
    for (const line of rows.split("\n")) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 3 && columns[1] === String(parentPid) && columns[2] === path) return Number(columns[0]);
    }
    await sleep(50);
  }
  throw new ProbeError("real_cli_child_not_observed", "the wrapper did not expose the exact bundled CLI as its child");
}

async function waitForPath(path, durationMs) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return;
    await sleep(25);
  }
  throw new ProbeError("path_timeout", `timed out waiting for ${path}`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function safeSha(path) {
  try {
    return await sha256File(path);
  } catch {
    return null;
  }
}

function readVersion(path) {
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  return (result.stdout || result.stderr || "unknown").trim().split(/\s+/).slice(-1)[0] || "unknown";
}

function safeVersion(path) {
  try {
    return readVersion(path);
  } catch {
    return "unknown";
  }
}

async function readManifest(path) {
  const content = await readFile(path, "utf8");
  return Object.fromEntries(content.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function summarizeChecks(observedEvents) {
  const types = new Set(observedEvents.map((event) => event.type));
  return {
    exactCliIdentity: types.has("probe_started"),
    desktopInitialize: types.has("desktop_initialize_completed"),
    bridgeCapabilities: types.has("bridge_capabilities_observed"),
    sameThreadBroadcast: types.has("same_thread_event_seen_by_both_clients"),
    approvalAccept: observedEvents.some((event) => event.type === "approval_turn_completed" && event.phase === "accept"),
    approvalDecline: observedEvents.some((event) => event.type === "approval_turn_completed" && event.phase === "decline"),
    pendingApprovalReconciled: types.has("desktop_reconciled_pending_approval_after_bridge_disconnect"),
    bridgeReconnect: types.has("bridge_reconnected_and_reconciled"),
    turnSteer: types.has("real_turn_steer_accepted"),
    turnInterrupt: types.has("real_turn_interrupt_completed"),
  };
}

function record(type, fields = {}) {
  events.push({ type, at: new Date().toISOString(), ...fields });
}

function ref(kind, value) {
  if (value === undefined || value === null) return null;
  const key = `${kind}:${String(value)}`;
  if (!refs.has(key)) refs.set(key, `${kind}-${digest(value)}`);
  return refs.get(key);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function idKey(value) {
  return `${typeof value}:${String(value)}`;
}

function sanitizeUserAgent(value) {
  return String(value ?? "unknown").replace(/\([^)]*\)/g, "(<platform>)");
}

function isIdentityChallenge(method) {
  return /userVerification|account\/(login|authenticate)|auth\/(login|challenge)/i.test(method);
}

function redact(value) {
  return String(value).replaceAll(root, "<TEST_ROOT>").replaceAll(workspace, "<TEST_WORKSPACE>").replaceAll(wrapper, "<RETAINED_WRAPPER>").replaceAll(realCli, "<BUNDLED_REAL_CLI>");
}

function normalizeError(error) {
  if (error instanceof ProbeError) return error;
  return new ProbeError("probe_exception", error?.message ?? String(error));
}

function sleep(durationMs) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const name = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[name] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return parsed;
}
