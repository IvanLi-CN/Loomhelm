import { Runtime } from "./runtime";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readProcessTree } from "./process_tree";
export interface ProcessRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  passFds?: number[];
  timeoutMs?: number;
  terminationGraceMs?: number;
  returnOnSignal?: boolean;
  propagateParentSignal?: boolean;
  signal?: AbortSignal;
  outputSink?:
    | ((stream: "stdout" | "stderr", chunk: Uint8Array) => unknown)
    | undefined;
  maxCapturedOutputBytes?: number | undefined;
  /** Optional private control plane; never multiplex control into stdout. */
  onControlMessage?: (message: unknown) => void;
  onSpawn?: (control: {
    pid: number;
    send: (message: unknown) => void;
  }) => void;
  cooperativeStop?: () => Promise<void>;
  cooperativeStopTimeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type ParentSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface ProcessGroupIdentity {
  groupId: number;
  sessionId: string;
  token: string;
}

interface ProcessEntry extends ProcessGroupIdentity {
  pid: number;
}
function processEntryToken(entry: ProcessEntry): string {
  return `${entry.pid}:${entry.groupId}:${entry.sessionId}:${entry.token}`;
}
function readLinuxProcessEntry(pid: number): ProcessEntry | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return;
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const groupId = Number(fields[2]);
  const sessionId = fields[3];
  const startTime = fields[19];
  if (
    !Number.isInteger(groupId) ||
    sessionId === undefined ||
    startTime === undefined
  )
    return;
  return { pid, groupId, sessionId, token: startTime };
}
function readDarwinProcessEntry(pid: number): ProcessEntry | undefined {
  const output = execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=,pgid=,sess=,lstart="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const fields = output.split(/\s+/);
  if (fields.length < 5) return;
  const entryPid = Number(fields[0]);
  const groupId = Number(fields[1]);
  const sessionId = fields[2];
  if (
    !Number.isInteger(entryPid) ||
    !Number.isInteger(groupId) ||
    sessionId === undefined
  )
    return;
  return {
    pid: entryPid,
    groupId,
    sessionId,
    token: fields.slice(3).join(" "),
  };
}

function readProcessEntry(pid: number): ProcessEntry | undefined {
  try {
    return process.platform === "linux"
      ? readLinuxProcessEntry(pid)
      : readDarwinProcessEntry(pid);
  } catch {
    return;
  }
}

function readProcessGroupIdentity(
  pid: number,
): ProcessGroupIdentity | undefined {
  const entry = readProcessEntry(pid);
  return entry === undefined
    ? undefined
    : {
        groupId: entry.groupId,
        sessionId: entry.sessionId,
        token: processEntryToken(entry),
      };
}

function readProcessGroupMembers(identity: ProcessGroupIdentity): Set<string> {
  const members = new Set<string>();
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const entry = readProcessEntry(Number(name));
      if (
        entry?.groupId === identity.groupId &&
        entry.sessionId === identity.sessionId
      )
        members.add(processEntryToken(entry));
    }
    return members;
  }
  if (process.platform !== "darwin") return members;
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-axo", "pid=,pgid=,sess=,lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of output.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5) continue;
      const pid = Number(fields[0]);
      const groupId = Number(fields[1]);
      const sessionId = fields[2];
      if (
        !Number.isInteger(pid) ||
        !Number.isInteger(groupId) ||
        sessionId !== identity.sessionId ||
        groupId !== identity.groupId
      )
        continue;
      members.add(
        processEntryToken({
          pid,
          groupId,
          sessionId,
          token: fields.slice(3).join(" "),
        }),
      );
    }
  } catch {}
  return members;
}
export async function runProcess(
  request: ProcessRequest,
): Promise<ProcessResult> {
  if (request.signal?.aborted) throw new Error("process aborted");
  const cooperativeStopTimeoutMs = request.cooperativeStopTimeoutMs ?? 200_000;
  if (
    !Number.isInteger(cooperativeStopTimeoutMs) ||
    cooperativeStopTimeoutMs < 1 ||
    cooperativeStopTimeoutMs > 200_000
  )
    throw new Error("invalid_cooperative_stop_timeout");
  if (request.timeoutMs !== undefined && process.platform === "win32") {
    throw new Error("process_tree_timeout_unavailable");
  }
  const stdin =
    request.stdin === undefined
      ? ("ignore" as const)
      : new Blob([request.stdin]);
  const managesProcessTree =
    (request.timeoutMs !== undefined ||
      request.signal !== undefined ||
      request.cooperativeStop !== undefined ||
      request.outputSink !== undefined ||
      request.onSpawn !== undefined ||
      request.onControlMessage !== undefined) &&
    process.platform !== "win32";
  const supervisionToken = managesProcessTree ? randomUUID() : undefined;
  const environment =
    supervisionToken === undefined
      ? request.env
      : {
          ...(request.env ?? process.env),
          CODEX_PROCESS_SUPERVISION_TOKEN: supervisionToken,
        };
  const stdio: [typeof stdin, "pipe", "pipe", ...number[]] = [
    stdin,
    "pipe",
    "pipe",
    ...(request.passFds ?? []),
  ];
  const options = {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(environment === undefined ? {} : { env: environment }),
    ...(request.passFds?.length
      ? { stdio }
      : { stdin, stdout: "pipe" as const, stderr: "pipe" as const }),
  };
  let rejectControlFailure!: (error: unknown) => void;
  const controlFailure = new Promise<never>((_, reject) => {
    rejectControlFailure = reject;
  });
  // onSpawn can throw before the main race attaches its rejection observer.
  void controlFailure.catch(() => {});
  const child = Runtime.spawn([request.command, ...(request.args ?? [])], {
    ...options,
    ...(request.onControlMessage
      ? {
          ipc: (message: unknown) => {
            try {
              request.onControlMessage!(message);
            } catch (error) {
              rejectControlFailure(error);
            }
          },
        }
      : {}),
    ...(managesProcessTree ? { detached: true } : {}),
  });
  const captureLimit =
    request.maxCapturedOutputBytes ?? Number.POSITIVE_INFINITY;
  const terminationGraceMs = request.terminationGraceMs ?? 250;
  const returnOnSignal = request.returnOnSignal ?? false;
  let processGroupIdentity: ReturnType<typeof readProcessGroupIdentity>;
  let processGroupMembers: Set<string> | undefined;
  let processTreeDescendants = new Map<number, string>();
  let descendantPoller: ReturnType<typeof setInterval> | undefined;
  const captureProcessTree = (scanSupervised = false) => {
    if (!managesProcessTree) return;
    const token = scanSupervised ? supervisionToken : undefined;
    for (const [pid, processToken] of readProcessTree(child.pid, token))
      processTreeDescendants.set(pid, processToken);
  };
  const processGroupStillBound = (allowLeaderExit = false) => {
    if (
      processGroupIdentity === undefined ||
      processGroupIdentity.groupId !== child.pid
    )
      return false;
    const current = readProcessGroupIdentity(child.pid);
    if (current?.token === processGroupIdentity.token) return true;
    if (!allowLeaderExit || processGroupMembers === undefined) return false;
    const currentMembers = readProcessGroupMembers(processGroupIdentity);
    for (const member of processGroupMembers)
      if (currentMembers.has(member)) return true;
    if (processGroupMembers.size === 0 || currentMembers.size === 0)
      return false;
    const groupId = processGroupIdentity.groupId;
    return ![...currentMembers].some((member) =>
      member.startsWith(`${groupId}:`),
    );
  };
  const signalTree = (
    signal: "SIGTERM" | "SIGKILL",
    allowLeaderExit = false,
  ) => {
    if (managesProcessTree) {
      let signaled = false;
      if (processGroupStillBound(allowLeaderExit || signal === "SIGKILL")) {
        try {
          process.kill(-processGroupIdentity!.groupId, signal);
          signaled = true;
        } catch {
          // The process group may have exited before the timeout signal arrived.
        }
      }
      for (const [pid, token] of processTreeDescendants) {
        if (readProcessEntry(pid)?.token !== token) continue;
        try {
          process.kill(pid, signal);
          signaled = true;
        } catch {}
      }
      if (!signaled) return;
      return;
    }
    child.kill(signal);
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  let abortHandler: (() => void) | undefined;
  let parentSignal: ParentSignal | undefined;
  const propagateParentSignal = request.propagateParentSignal ?? true;
  const terminateTree = (allowLeaderExit = false) => {
    if (termination !== undefined) return;
    if (managesProcessTree && processGroupIdentity !== undefined)
      processGroupMembers = readProcessGroupMembers(processGroupIdentity);
    captureProcessTree(true);
    termination = Promise.resolve().then(async () => {
      if (request.cooperativeStop && !allowLeaderExit) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            request.cooperativeStop(),
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, cooperativeStopTimeoutMs);
            }),
            child.exited.then(() => {}),
          ]);
        } catch {
          // Failure to cooperate does not turn process termination into proof.
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
        }
      }
      signalTree("SIGTERM", allowLeaderExit);
      await new Promise<void>((resolve) => {
        escalationTimer = setTimeout(() => {
          signalTree("SIGKILL", true);
          // Keep the leader from holding the stdout/stderr pipes open when the
          // platform process-group lookup races with child exit.
          try {
            child.kill("SIGKILL");
          } catch {
            // The leader may already have exited.
          }
          resolve();
        }, terminationGraceMs);
      });
    });
  };
  const handleParentSignal = (signal: ParentSignal) => {
    parentSignal ??= signal;
    terminateTree();
  };
  const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (signal) => [signal, () => handleParentSignal(signal)] as const,
  );
  if (request.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, request.timeoutMs);
  }
  if (managesProcessTree) {
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    processGroupIdentity = readProcessGroupIdentity(child.pid);
    captureProcessTree();
    descendantPoller = setInterval(captureProcessTree, 10);
  }
  if (request.signal) {
    abortHandler = () => terminateTree();
    request.signal.addEventListener("abort", abortHandler, { once: true });
    if (request.signal.aborted) terminateTree();
  }
  try {
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      // Hooks run only after cleanup handlers and process ownership are installed.
      request.onSpawn?.({
        pid: child.pid,
        send: (message) => child.send(message),
      });
      const childExit = child.exited.then((code) => {
        captureProcessTree(true);
        if (processGroupIdentity !== undefined) {
          processGroupMembers = readProcessGroupMembers(processGroupIdentity);
        }
        if (processGroupMembers?.size || processTreeDescendants.size)
          terminateTree(true);
        return code;
      });
      [exitCode, stdout, stderr] = await Promise.race([
        Promise.all([
          childExit,
          consumeOutput(
            child.stdout,
            "stdout",
            request.outputSink,
            captureLimit,
          ),
          consumeOutput(
            child.stderr,
            "stderr",
            request.outputSink,
            captureLimit,
          ),
        ]),
        controlFailure,
      ]);
    } catch (error) {
      terminateTree();
      await termination;
      await child.exited;
      throw error;
    }
    if (
      termination !== undefined &&
      !(returnOnSignal && request.signal?.aborted)
    )
      await termination;
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (descendantPoller !== undefined) clearInterval(descendantPoller);
    if (
      escalationTimer !== undefined &&
      !(returnOnSignal && request.signal?.aborted)
    )
      clearTimeout(escalationTimer);
    if (managesProcessTree) {
      for (const [signal, handler] of signalHandlers)
        process.off(signal, handler);
    }
    if (request.signal && abortHandler)
      request.signal.removeEventListener("abort", abortHandler);
    if (parentSignal !== undefined && propagateParentSignal) {
      const signal = parentSignal;
      setImmediate(() => process.kill(process.pid, signal));
    }
  }
}
async function consumeOutput(
  stream: ReadableStream<Uint8Array> | null,
  name: "stdout" | "stderr",
  sink: ProcessRequest["outputSink"],
  captureLimit: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let captured = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      if (!chunk) continue;
      await sink?.(name, chunk);
      if (captured >= captureLimit) continue;
      const remaining = Math.max(0, captureLimit - captured);
      const part =
        chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      if (part.byteLength) {
        chunks.push(part);
        captured += part.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(joinBytes(chunks));
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
