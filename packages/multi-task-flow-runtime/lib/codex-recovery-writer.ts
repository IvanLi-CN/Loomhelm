import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "@loomhelm/runtime-core/modules/core/process";
import { isWorkItem } from "./codex-cli-initialization";
import { connectSocket, framePayload, parseRpc, record, websocketFrame } from "./codex-rpc";
import type { RecoveryAttempt } from "./initialization-recovery-attempt";

export type RecoveryRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export function requireRecoveryCapability(): void {
  const version = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  if (version !== "codex-cli 0.169.0")
    throw new Error(
      "CODEX_RECOVERY_CAPABILITY_UNAVAILABLE: native writer exclusion is verified only for codex-cli 0.169.0",
    );
}

/** A private, task-owned server holds the native writer lock throughout inspection, start and ledger resolution. */
export async function withRecoveryWriter<T>(
  attempt: RecoveryAttempt,
  action: (rpc: RecoveryRpc) => Promise<T>,
): Promise<T> {
  requireRecoveryCapability();
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "mfr-"));
  const path = join(directory, "s");
  const directoryIdentity = lstatSync(directory);
  const abort = new AbortController();
  let socket: Socket | undefined;
  let sequence = 0;
  let pending = Buffer.alloc(0);
  let failure: Error | undefined;
  const waiting = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const fail = (error: Error) => {
    failure ??= error;
    rejectFailure(failure);
    for (const waiter of waiting.values()) waiter.reject(failure);
    waiting.clear();
    abort.abort();
  };
  const configured = Number(process.env.MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS ?? 300_000);
  const budget =
    Number.isFinite(configured) && configured >= 1_000 && configured <= 600_000
      ? configured
      : 300_000;
  const deadline = Date.now() + budget;
  const request: RecoveryRpc = (method, params) => {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      try {
        socket!.write(websocketFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      } catch {
        fail(new Error("Recovery transport closed"));
      }
    });
  };
  let parentSignal: NodeJS.Signals | undefined;
  const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = () => {
      parentSignal ??= signal;
      fail(new Error(`Recovery interrupted by ${signal}`));
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const execution = runProcess({
    command: "codex",
    args: ["app-server", "--listen", `unix://${path}`],
    cwd: attempt.workspace_path,
    signal: abort.signal,
    propagateParentSignal: false,
    timeoutMs: budget,
    maxCapturedOutputBytes: 0,
    env: { ...process.env, MULTI_TASK_FLOW_NATIVE_REQUEST_ID: attempt.attempt_id },
  });
  const joined = execution.then(
    (result) => {
      if (!abort.signal.aborted)
        fail(new Error(result.timedOut ? "Recovery writer timed out" : "Recovery writer exited"));
    },
    (error) => {
      if (!abort.signal.aborted) fail(error instanceof Error ? error : new Error(String(error)));
    },
  );
  const timer = setTimeout(() => fail(new Error("Recovery writer deadline exceeded")), budget);
  const onData = (chunk: Buffer) => {
    if (failure) return;
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 1024 * 1024)
      return fail(new Error("Recovery transport exceeded its event size limit"));
    try {
      for (;;) {
        const frame = framePayload(pending);
        if (!frame) break;
        pending = pending.subarray(frame.consumed);
        if (frame.opcode === 8) throw new Error("Recovery transport closed");
        if (frame.opcode !== 1) continue;
        const row = parseRpc(frame.payload);
        if (!row) throw new Error("Malformed recovery event");
        const waiter = typeof row.id === "number" ? waiting.get(row.id) : undefined;
        if (waiter && !row.method) {
          waiting.delete(row.id as number);
          if (row.error)
            waiter.reject(
              new Error(
                `Recovery RPC rejected: ${String(record(row.error)?.message ?? "unknown")}`,
              ),
            );
          else waiter.resolve(record(row.result) ?? {});
        } else if (row.id !== undefined)
          throw new Error("Recovery handshake requested a tool or approval");
        const params = record(row.params);
        if (
          (row.method === "item/started" || row.method === "item/completed") &&
          isWorkItem(params?.item)
        )
          throw new Error("Recovery handshake attempted work");
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  try {
    while (!existsSync(path)) {
      if (failure) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const connected = await connectSocket(
      path,
      Math.max(1, Math.min(5_000, deadline - Date.now())),
    );
    socket = connected.socket;
    if (failure) throw failure;
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", () => {
      if (!abort.signal.aborted) fail(new Error("Recovery transport closed"));
    });
    if (connected.buffer.length) onData(connected.buffer);
    const initialized = await request("initialize", {
      clientInfo: { name: "multi-task-flow-recovery", version: "1" },
      capabilities: { experimentalApi: true },
    });
    if (!String(initialized.userAgent).includes("/0.169.0 "))
      throw new Error("Recovery native protocol version mismatch");
    socket.write(websocketFrame(JSON.stringify({ method: "initialized", params: {} })));
    const resumed = await request("thread/resume", {
      threadId: attempt.thread_id,
      model: attempt.execution_profile.model,
      config: { model_reasoning_effort: attempt.execution_profile.thinking },
      cwd: attempt.workspace_path,
      sandbox: "read-only",
      approvalPolicy: "never",
      excludeTurns: true,
    });
    if (record(resumed.thread)?.id !== attempt.thread_id)
      throw new Error("Recovery resumed another thread");
    const guardedRequest: RecoveryRpc = async (method, params) => {
      const result = await request(method, params);
      if (failure) throw failure;
      return result;
    };
    const result = await Promise.race([action(guardedRequest), failed]);
    if (failure) throw failure;
    return result;
  } finally {
    clearTimeout(timer);
    abort.abort();
    socket?.destroy();
    await joined;
    // Remove only this invocation's exact socket and empty private directory.
    try {
      const current = lstatSync(directory);
      if (
        current.dev === directoryIdentity.dev &&
        current.ino === directoryIdentity.ino &&
        !current.isSymbolicLink()
      ) {
        if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path);
        rmdirSync(directory);
      }
    } finally {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      if (parentSignal) {
        const signal = parentSignal;
        setImmediate(() => process.kill(process.pid, signal));
      }
    }
  }
}
