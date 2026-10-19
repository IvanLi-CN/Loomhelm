#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const workspace = resolve(args.workspace ?? "/private/tmp/loomhelm-r01-codex-test");
const binary = args.binary ?? process.env.CODEX_CLI_PATH ?? "codex";
const evidencePath = args.evidence ? resolve(args.evidence) : null;
const events = [];
const refs = new Map();
const binaryVersion = readVersion(binary);
const startedAt = new Date().toISOString();
let child = null;
let responseBuffer = "";
let requestId = 0;
let activeTurnRequestId = null;
let threadId = null;
let sessionId = null;
let turnId = null;
let phase = "accept";
let connection = "initial";
let commandApprovalObserved = false;
let acceptedCommandCompleted = false;
let declinedCommandCompleted = false;
let interruptRequestSent = false;
let interruptedTurnObserved = false;
let reconciliationObserved = false;
let finished = false;
let timedOut = false;
let timeoutHandle = null;

await mkdir(workspace, { recursive: true });
record("probe_started", {
  transport: "stdio",
  binary: basename(binary),
  binaryVersion,
  model: "gpt-5.6-luna",
  effort: "max",
  workspace: "<TEST_WORKSPACE>",
  scenarios: ["approval_accept", "approval_decline", "interrupt", "disconnect_restart_reconcile"],
});

connect("initial");

timeoutHandle = setTimeout(() => {
  timedOut = true;
  record("probe_timeout", { phase, connection, threadRef: ref("thread", threadId), turnRef: ref("turn", turnId) });
  terminateChild();
}, args.timeoutMs ?? 180_000);

await new Promise((resolveExit) => {
  globalThis.resolveExit = resolveExit;
});
clearTimeout(timeoutHandle);

const result = {
  result: !timedOut && commandApprovalObserved && acceptedCommandCompleted && declinedCommandCompleted && interruptedTurnObserved && reconciliationObserved ? "passed" : "failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  transport: "stdio",
  binary: basename(binary),
  binaryVersion,
  model: "gpt-5.6-luna",
  effort: "max",
  workspace: "<TEST_WORKSPACE>",
  threadRef: ref("thread", threadId),
  sessionRef: ref("session", sessionId),
  turnRef: ref("turn", turnId),
  checks: {
    approvalRequestObserved: commandApprovalObserved,
    approvalAcceptedCommandCompleted: acceptedCommandCompleted,
    approvalDeclinedCommandCompleted: declinedCommandCompleted,
    interruptCompleted: interruptedTurnObserved,
    disconnectRestartReconciled: reconciliationObserved,
  },
  events,
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (evidencePath) {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, serialized, "utf8");
}
process.stdout.write(serialized);
process.exitCode = result.result === "passed" ? 0 : 1;

function connect(kind) {
  connection = kind;
  requestId = 0;
  activeTurnRequestId = null;
  responseBuffer = "";
  const env = { ...process.env };
  delete env.CODEX_CI;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", consumeOutput);
  child.stderr.on("data", () => record("stderr_observed", { connection }));
  child.on("error", (error) => record("process_error", { connection, name: error.name }));
  child.on("close", (code, signal) => {
    record("process_exit", { connection, code, signal });
    if (connection === "initial" && !finished) {
      record("disconnect_observed", { threadRef: ref("thread", threadId), turnRef: ref("turn", turnId) });
      setTimeout(() => connect("restarted"), 250);
      return;
    }
    if (connection === "restarted" && !finished) finish();
  });
  send({
    id: nextRequestId(),
    method: "initialize",
    params: {
      clientInfo: {
        name: "loomhelm_r01_control_probe",
        title: "Loomhelm R01 Control Probe",
        version: "0.1.0",
      },
    },
  });
}

function consumeOutput(chunk) {
  responseBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = responseBuffer.indexOf("\n")) >= 0) {
    const line = responseBuffer.slice(0, newlineIndex);
    responseBuffer = responseBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      record("non_json_output", { connection });
      continue;
    }
    handleMessage(message);
  }
}

function handleMessage(message) {
  if (message.error) {
    record("rpc_error", {
      connection,
      requestId: message.id ?? null,
      code: message.error.code,
      message: message.error.message,
    });
  }
  if (message.id === 1 && message.result) {
    record("initialize_completed", {
      connection,
      userAgent: sanitizeUserAgent(message.result.userAgent),
      platform: message.result.platformOs,
      codexHome: "<CODEX_HOME>",
    });
    send({ method: "initialized", params: {} });
    if (connection === "initial") {
      send({
        id: nextRequestId(),
        method: "thread/start",
        params: {
          model: "gpt-5.6-luna",
          cwd: workspace,
          approvalPolicy: "untrusted",
          sandbox: "workspace-write",
          serviceName: "loomhelm_r01_control_probe",
        },
      });
    } else {
      send({
        id: nextRequestId(),
        method: "thread/resume",
        params: { threadId, excludeTurns: true },
      });
    }
    return;
  }
  if (connection === "initial" && message.id === 2 && message.result?.thread) {
    threadId = message.result.thread.id;
    sessionId = message.result.thread.sessionId ?? threadId;
    record("thread_created", { threadRef: ref("thread", threadId), sessionRef: ref("session", sessionId) });
    startTurn("accept");
    return;
  }
  if (connection === "restarted" && message.id === 2 && message.result?.thread) {
    const sameThread = message.result.thread.id === threadId;
    reconciliationObserved = sameThread;
    record("thread_resumed_after_restart", {
      threadRef: ref("thread", message.result.thread.id),
      sameThread,
      runtimeStatus: message.result.thread.status ?? null,
    });
    send({
      id: nextRequestId(),
      method: "thread/turns/list",
      params: { threadId, limit: 20, itemsView: "summary" },
    });
    return;
  }
  if (connection === "restarted" && message.id === 3) {
    const turns = message.result?.data ?? message.result?.turns ?? [];
    record("turn_history_reconciled", {
      threadRef: ref("thread", threadId),
      turnCount: turns.length,
      statuses: turns.map((turn) => turn.status ?? null),
    });
    terminateChild();
    return;
  }
  if (connection !== "initial") return;
  if (message.id === activeTurnRequestId && message.result?.turn) {
    turnId = message.result.turn.id;
    record("turn_started", { phase, threadRef: ref("thread", threadId), turnRef: ref("turn", turnId), status: message.result.turn.status });
    return;
  }
  if (message.method === "item/commandExecution/requestApproval") {
    commandApprovalObserved = true;
    record("approval_requested", {
      phase,
      requestId: message.id ?? null,
      threadRef: ref("thread", message.params?.threadId),
      turnRef: ref("turn", message.params?.turnId),
      commandDigest: digest(message.params?.command ?? ""),
      availableDecisionCount: message.params?.availableDecisions?.length ?? null,
    });
    const decision = phase === "deny" ? "decline" : "accept";
    send({ id: message.id, result: { decision } });
    record("approval_decision_sent", { phase, decision });
    if (phase === "interrupt") {
      setTimeout(() => {
        if (!interruptRequestSent && !finished) {
          interruptRequestSent = true;
          send({
            id: nextRequestId(),
            method: "turn/interrupt",
            params: { threadId, turnId },
          });
          record("interrupt_requested", { threadRef: ref("thread", threadId), turnRef: ref("turn", turnId) });
        }
      }, 400);
    }
    return;
  }
  if (message.method === "item/completed" && message.params?.item?.type === "commandExecution") {
    const status = message.params.item.status ?? null;
    record("command_completed", { phase, status });
    if (phase === "accept" && status === "completed") acceptedCommandCompleted = true;
    if (phase === "deny" && status === "declined") declinedCommandCompleted = true;
    return;
  }
  if (message.method === "turn/completed") {
    const status = message.params?.turn?.status ?? null;
    record("turn_completed", { phase, status, threadRef: ref("thread", threadId), turnRef: ref("turn", turnId) });
    if (phase === "accept") {
      startTurn("deny");
    } else if (phase === "deny") {
      startTurn("interrupt");
    } else if (phase === "interrupt") {
      interruptedTurnObserved = status === "interrupted";
      terminateChild();
    }
  }
}

function startTurn(nextPhase) {
  phase = nextPhase;
  const textByPhase = {
    accept: "Run exactly this harmless command in the test workspace: /usr/bin/printf R01_APPROVED. Do not use any other tool. After it completes, reply exactly R01_APPROVAL_OK.",
    deny: "Run exactly this harmless command in the test workspace: /usr/bin/printf R01_DENIED. Do not use any other tool. After it completes, reply exactly R01_DENIAL_OK.",
    interrupt: "Run exactly this harmless command in the test workspace: /bin/sleep 30. Do not use any other tool. After it completes, reply exactly R01_INTERRUPT_OK.",
  };
  turnId = null;
  activeTurnRequestId = nextRequestId();
  send({
    id: activeTurnRequestId,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: textByPhase[nextPhase] }],
      model: "gpt-5.6-luna",
      effort: "max",
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
    },
  });
  record("turn_requested", { phase, threadRef: ref("thread", threadId) });
}

function send(message) {
  child?.stdin.write(`${JSON.stringify(message)}\n`);
}

function terminateChild() {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
}

function finish() {
  if (finished) return;
  finished = true;
  globalThis.resolveExit?.();
}

function record(type, fields) {
  events.push({ type, at: new Date().toISOString(), connection, ...fields });
}

function ref(kind, value) {
  if (!value) return null;
  const key = `${kind}:${value}`;
  if (!refs.has(key)) refs.set(key, `${kind}-${digest(value)}`);
  return refs.get(key);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function nextRequestId() {
  requestId += 1;
  return requestId;
}

function readVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return (result.stdout || result.stderr || "unknown").trim().split(/\s+/).at(-1) || "unknown";
}

function sanitizeUserAgent(value) {
  return String(value ?? "unknown").replace(/\([^)]*\)/g, "(<platform>)");
}

function basename(value) {
  return value.split("/").at(-1) || value;
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
