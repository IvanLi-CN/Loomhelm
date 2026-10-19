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
const startedAt = new Date().toISOString();
const clientVersion = readVersion(binary);
const idRefs = new Map();
let threadRef = null;
let sessionRef = null;
let turnRef = null;
let responseBuffer = "";
let requestId = 0;
let completed = false;
let timedOut = false;

await mkdir(workspace, { recursive: true });

record("probe_started", {
  transport: "stdio",
  binary: basename(binary),
  binaryVersion: clientVersion,
  model: "gpt-5.6-luna",
  effort: "max",
  workspace: "<TEST_WORKSPACE>",
});

const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
  cwd: workspace,
  env: withoutTaskOnlyFlags(process.env),
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => consumeOutput(chunk));
child.stderr.on("data", () => record("stderr_observed", {}));
child.on("error", (error) => record("process_error", { name: error.name }));

const processExit = new Promise((resolveExit) => {
  child.on("close", (code, signal) => {
    record("process_exit", { code, signal, threadRef, sessionRef, turnRef });
    resolveExit({ code, signal });
  });
});

send({
  id: nextRequestId(),
  method: "initialize",
  params: {
    clientInfo: {
      name: "loomhelm_r01_new_session_probe",
      title: "Loomhelm R01 New Session Probe",
      version: "0.1.0",
    },
  },
});

const timeout = setTimeout(() => {
  timedOut = true;
  record("probe_timeout", { threadRef, sessionRef, turnRef });
  child.kill("SIGTERM");
}, args.timeoutMs ?? 120_000);

const exit = await processExit;
clearTimeout(timeout);

const result = {
  result: completed && !timedOut ? "passed" : "failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  transport: "stdio",
  binary: basename(binary),
  binaryVersion: clientVersion,
  model: "gpt-5.6-luna",
  effort: "max",
  workspace: "<TEST_WORKSPACE>",
  threadRef,
  sessionRef,
  turnRef,
  processExit: exit,
  events,
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (evidencePath) {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, serialized, "utf8");
}
process.stdout.write(serialized);
process.exitCode = result.result === "passed" ? 0 : 1;

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
      record("non_json_output", {});
      continue;
    }
    handleMessage(message);
  }
}

function handleMessage(message) {
  const event = {
    method: message.method ?? null,
    requestId: message.id ?? null,
  };
  if (message.error) {
    event.error = { code: message.error.code, message: message.error.message };
  }
  if (message.id === 1 && message.result) {
    event.userAgent = sanitizeUserAgent(message.result.userAgent);
    event.platform = message.result.platformOs;
    event.codexHome = "<CODEX_HOME>";
    record("initialize_completed", event);
    send({ method: "initialized", params: {} });
    send({ id: nextRequestId(), method: "model/list", params: {} });
    return;
  }
  if (message.id === 2 && message.result) {
    const luna = (message.result.data ?? []).find((model) => model.id === "gpt-5.6-luna");
    event.modelFound = Boolean(luna);
    event.supportedEfforts = luna?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
    record("model_discovered", event);
    if (!luna?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === "max")) {
      record("model_constraint_failed", { model: "gpt-5.6-luna", effort: "max" });
      child.kill("SIGTERM");
      return;
    }
    send({
      id: nextRequestId(),
      method: "thread/start",
      params: {
        model: "gpt-5.6-luna",
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "loomhelm_r01_new_session_probe",
      },
    });
    return;
  }
  if (message.id === 3 && message.result?.thread) {
    threadRef = refFor("thread", message.result.thread.id);
    sessionRef = refFor("session", message.result.thread.sessionId ?? message.result.thread.id);
    record("thread_created", {
      ...event,
      threadRef,
      sessionRef,
      model: message.result.thread.modelProvider ?? "unknown",
    });
    send({
      id: nextRequestId(),
      method: "turn/start",
      params: {
        threadId: message.result.thread.id,
        input: [{ type: "text", text: "Reply with exactly R01_NEW_SESSION_OK and do not use tools." }],
        model: "gpt-5.6-luna",
        effort: "max",
      },
    });
    return;
  }
  if (message.id === 4 && message.result?.turn) {
    turnRef = refFor("turn", message.result.turn.id);
    record("turn_started", { ...event, threadRef, turnRef, status: message.result.turn.status });
    return;
  }
  if (message.method === "thread/started") {
    record("thread_started_event", { ...event, threadRef: refFor("thread", message.params?.thread?.id) });
    return;
  }
  if (message.method === "turn/started") {
    record("turn_started_event", {
      ...event,
      threadRef,
      turnRef: refFor("turn", message.params?.turn?.id),
    });
    return;
  }
  if (message.method === "item/agentMessage/delta") {
    const delta = String(message.params?.delta ?? "");
    record("agent_message_delta", { ...event, length: delta.length, digest: digest(delta) });
    return;
  }
  if (message.method === "turn/completed") {
    const status = message.params?.turn?.status ?? null;
    record("turn_completed", { ...event, threadRef, turnRef, status });
    completed = status === "completed";
    child.kill("SIGTERM");
  }
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function record(type, fields) {
  events.push({ type, at: new Date().toISOString(), ...fields });
}

function refFor(kind, value) {
  if (!value) return null;
  const key = `${kind}:${value}`;
  if (!idRefs.has(key)) idRefs.set(key, `${kind}-${digest(value)}`);
  return idRefs.get(key);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function readVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return (result.stdout || result.stderr || "unknown").trim().split(/\s+/).slice(-1)[0] || "unknown";
}

function nextRequestId() {
  requestId += 1;
  return requestId;
}

function sanitizeUserAgent(value) {
  return String(value ?? "unknown").replace(/\([^)]*\)/g, "(<platform>)");
}

function basename(value) {
  return value.split("/").at(-1) || value;
}

function withoutTaskOnlyFlags(environment) {
  const copy = { ...environment };
  delete copy.CODEX_CI;
  delete copy.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return copy;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const name = value.slice(2);
    parsed[camelCase(name)] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return parsed;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
