import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "@loomhelm/runtime-core/modules/core/process";
import { isWorkItem } from "./codex-cli-initialization";
import { connectSocket, framePayload, parseRpc, record, websocketFrame } from "./codex-rpc";
import { ContractError } from "./errors";
import type { RecoveryAttempt } from "./initialization-recovery-attempt";
import {
  type RecoveryPermissions,
  readPermissions,
  restrictedPermissions,
  samePermissions,
} from "./recovery-permissions";

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
  action: (rpc: RecoveryRpc, restore: () => Promise<void>) => Promise<T>,
  permissions: { restrict: boolean; capture: (original: RecoveryPermissions) => void },
): Promise<T> {
  if (!attempt.permissions)
    throw new ContractError(
      "RECOVERY_PERMISSIONS_UNAVAILABLE",
      "Recovery historical attempt requires independent audit; original permissions will not be guessed",
      5,
    );
  requireRecoveryCapability();
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "mfr-"));
  const path = join(directory, "s");
  const directoryIdentity = lstatSync(directory);
  const abort = new AbortController();
  let socket: Socket | undefined;
  let sequence = 0;
  let pending = Buffer.alloc(0);
  let failure: Error | undefined;
  let original = attempt.permissions.original;
  let restoreNeeded = false;
  let settingsSequence = 0;
  let settings: Record<string, unknown> | undefined;
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
  const resume = async () => {
    const response = await request("thread/resume", {
      threadId: attempt.thread_id,
      excludeTurns: true,
    });
    if (record(response.thread)?.id !== attempt.thread_id)
      throw new Error("Recovery resumed another thread");
    return readPermissions(response);
  };
  const updatePermissions = async (value: RecoveryPermissions) => {
    const before = settingsSequence;
    await request("thread/settings/update", { threadId: attempt.thread_id, ...value });
    while (settingsSequence === before) {
      if (failure) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!samePermissions(readPermissions({ ...settings, sandbox: settings?.sandboxPolicy }), value))
      throw new Error("Recovery native permissions update could not be verified");
  };
  const restore = async () => {
    if (!original) throw new Error("Original recovery permissions unavailable");
    if (restoreNeeded) {
      await updatePermissions(original);
    }
    restoreNeeded = false;
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
    args: ["app-server", "--disable", "daemon_auto_start", "--listen", `unix://${path}`],
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
        if (row.method === "thread/settings/updated" && params?.threadId === attempt.thread_id) {
          settings = record(params.threadSettings) ?? undefined;
          settingsSequence++;
        }
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
    const endpoint = lstatSync(path);
    // 0.169.0 shortens long Unix addresses using a per-address SHA256 alias, even
    // with daemon_auto_start disabled. Accept only that exact task address.
    if (!endpoint.isSocket()) {
      const alias = join(
        realpathSync("/tmp"),
        `codex-daemon-${process.getuid?.()}`,
        createHash("sha256").update(path).digest("hex"),
      );
      if (
        !endpoint.isSymbolicLink() ||
        readlinkSync(path) !== alias ||
        !lstatSync(alias).isSocket()
      )
        throw new Error("Recovery requires its own private socket, not a shared daemon redirect");
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
    // A neutral resume acquires the writer fence without changing sticky thread configuration.
    const current = await resume();
    if (original) {
      if (
        !samePermissions(current, original) &&
        !samePermissions(current, restrictedPermissions(original))
      )
        throw new Error(
          "Recovery permissions conflict with the frozen original and handshake policies",
        );
      restoreNeeded = !samePermissions(current, original);
    } else {
      permissions.capture(current); // Synchronous durable write MUST precede the first override.
      original = current;
    }
    if (permissions.restrict) {
      restoreNeeded = true; // An ambiguous update reply still requires reconciliation.
      await updatePermissions(restrictedPermissions(original));
    }
    const guardedRequest: RecoveryRpc = async (method, params) => {
      const result = await request(method, params);
      if (failure) throw failure;
      return result;
    };
    const result = await Promise.race([action(guardedRequest, restore), failed]);
    if (failure) throw failure;
    return result;
  } finally {
    // On a live transport, also restore on validation/ledger failure. On transport loss the
    // durable snapshot remains the only authority for a later reconcile; never report success.
    try {
      if (restoreNeeded && !failure) await restore();
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
          const entry = lstatSync(path, { throwIfNoEntry: false });
          if (entry?.isSocket() || entry?.isSymbolicLink()) unlinkSync(path);
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
}
