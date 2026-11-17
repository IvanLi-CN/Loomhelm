import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { runProcess } from "@loomhelm/runtime-core/modules/core/process";
import { connectSocket, record, rpc, socketPath } from "../lib/codex-rpc";
import {
  type AgentRole,
  boundedMessage,
  type CliCreationInput,
  type CliRun,
  CodexCreationError,
  type CodexDiagnostic,
  diagnostic,
  diagnosticFromError,
  diagnosticsFromError,
  diagnosticText,
  initializationPrompt,
  isWorkItem,
  parseInitializationEvent,
  pushDiagnostic,
  type RepositoryIdentity,
  verifyInitializationTurn,
} from "./codex-cli-initialization";
import { invocationSignal, registerInvocationResource } from "./invocation-journal";

export * from "./codex-cli-initialization";

/** Each process belongs to this attempt; no shell or inherited stdin. */
export async function runInitialization(input: CliCreationInput): Promise<CliRun> {
  const result: CliRun = {
    exit_code: null,
    turn_completed: false,
    events: [],
    initialization_items: [],
    diagnostics: [],
    timed_out: false,
  };
  const decoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const controller = new AbortController();
  const resource = registerInvocationResource("codex-initialization", {
    native_request_id: input.native_request_id,
  });
  const stop = () => controller.abort();
  const parentSignal = invocationSignal();
  parentSignal?.addEventListener("abort", stop, { once: true });
  let pending = "";
  let stderrPending = "";
  let stderrDiagnosticCount = 0;
  const stderrLine = (value: string) => {
    const message = boundedMessage(value);
    if (message && stderrDiagnosticCount < 8 && /error|warn|failed|timed out/i.test(message)) {
      stderrDiagnosticCount += 1;
      pushDiagnostic(result.diagnostics, diagnostic("process", "CODEX_STDERR", message, "warning"));
    }
  };
  const stderrChunk = (chunk: Uint8Array) => {
    stderrPending += stderrDecoder.write(chunk);
    if (stderrPending.length > 64 * 1024) stderrPending = "";
    for (;;) {
      const end = stderrPending.indexOf("\n");
      if (end < 0) break;
      stderrLine(stderrPending.slice(0, end));
      stderrPending = stderrPending.slice(end + 1);
    }
  };
  const abort = (error: CodexCreationError) => {
    for (const item of error.diagnostics) pushDiagnostic(result.diagnostics, item);
    result.error ??= diagnosticText(error);
    controller.abort();
  };
  const line = (value: string) => {
    if (!value.trim() || result.error) return;
    try {
      const event = parseInitializationEvent(JSON.parse(value));
      if (result.events.length < 64) result.events.push(event.type);
      if (event.diagnostic) {
        pushDiagnostic(result.diagnostics, event.diagnostic);
        if (event.type === "turn.failed" || event.type === "error")
          throw new CodexCreationError(event.diagnostic);
      }
      if (event.type === "thread.started") {
        if (result.thread_id || !event.thread_id)
          throw new CodexCreationError(
            diagnostic(
              "event",
              "CODEX_THREAD_IDENTITY_AMBIGUOUS",
              "Codex emitted an ambiguous thread identity",
              "error",
            ),
          );
        result.thread_id = event.thread_id;
        input.onThreadStarted?.(event.thread_id);
      }
      if (event.type === "turn.completed") result.turn_completed = true;
      const item = record(event.item);
      if (item && result.initialization_items.length < 64) result.initialization_items.push(item);
      if (
        event.item !== undefined &&
        isWorkItem(event.item) &&
        record(event.item)?.type !== "error"
      )
        throw new CodexCreationError(
          diagnostic(
            "event",
            "CODEX_INITIALIZATION_WORK_STARTED",
            `Initialization attempted work instead of a handshake: ${JSON.stringify(event.item).slice(0, 500)}`,
            "error",
          ),
        );
    } catch (error) {
      abort(
        error instanceof CodexCreationError
          ? error
          : new CodexCreationError(
              diagnostic(
                "event",
                error instanceof SyntaxError ? "CODEX_INVALID_JSON" : "CODEX_EVENT_PARSE_FAILED",
                error instanceof SyntaxError ? "Codex emitted invalid JSONL" : String(error),
                "error",
              ),
              { cause: error },
            ),
      );
    }
  };
  const configured = Number(process.env.MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS ?? 300_000);
  try {
    const execution = await runProcess({
      command: "codex",
      args: [
        "exec",
        "-C",
        input.cwd ?? process.cwd(),
        "--worktree",
        "--json",
        "-m",
        input.model,
        "-c",
        `model_reasoning_effort=${JSON.stringify(input.thinking)}`,
        initializationPrompt(input.role ?? "Task Agent"),
      ],
      cwd: input.cwd ?? process.cwd(),
      signal: controller.signal,
      env: { ...process.env, MULTI_TASK_FLOW_NATIVE_REQUEST_ID: input.native_request_id },
      timeoutMs:
        Number.isFinite(configured) && configured >= 1000 && configured <= 600_000
          ? configured
          : 300_000,
      maxCapturedOutputBytes: 0,
      outputSink: (stream, chunk) => {
        // Parse stdout events and retain only bounded stderr diagnostics.
        if (stream === "stderr") {
          stderrChunk(chunk);
          return;
        }
        if (result.error) return;
        pending += decoder.write(chunk);
        if (pending.length > 1024 * 1024) {
          pending = "";
          abort(
            new CodexCreationError(
              diagnostic(
                "event",
                "CODEX_EVENT_SIZE_LIMIT",
                "Codex event stream exceeded the 1 MiB limit",
                "error",
              ),
            ),
          );
          return;
        }
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          const next = pending.slice(0, end);
          pending = pending.slice(end + 1);
          line(next);
        }
      },
    });
    pending += decoder.end();
    if (pending.trim()) line(pending);
    stderrPending += stderrDecoder.end();
    if (stderrPending.trim()) stderrLine(stderrPending);
    result.exit_code = execution.exitCode;
    result.timed_out = execution.timedOut;
    if (execution.timedOut) {
      pushDiagnostic(
        result.diagnostics,
        diagnostic(
          "process",
          "CODEX_INITIALIZATION_TIMEOUT",
          "Codex initialization timed out; reconcile before retry",
          "error",
          true,
        ),
      );
    }
    if (execution.exitCode !== 0) {
      const signal = execution.exitCode >= 128 ? ` (signal ${execution.exitCode - 128})` : "";
      pushDiagnostic(
        result.diagnostics,
        diagnostic(
          "process",
          "CODEX_PROCESS_EXITED",
          `codex exec exited with code ${execution.exitCode}${signal}`,
          "error",
          true,
        ),
      );
    }
    if (!result.turn_completed && !result.error)
      pushDiagnostic(
        result.diagnostics,
        diagnostic(
          "process",
          "CODEX_TURN_INCOMPLETE",
          "codex exec exited without a completed initialization turn",
          "error",
          true,
        ),
      );
    if (!result.error && result.diagnostics.some((item) => item.severity === "error")) {
      const failure = result.diagnostics.find((item) => item.severity === "error");
      if (failure) result.error = diagnosticText(new CodexCreationError(failure));
    }
  } catch (error) {
    const failure =
      error instanceof CodexCreationError
        ? error
        : new CodexCreationError(
            diagnostic(
              "process",
              "CODEX_PROCESS_FAILED",
              `Codex initialization process failed: ${String(error)}`,
              "error",
              true,
            ),
            { cause: error },
          );
    for (const item of failure.diagnostics) pushDiagnostic(result.diagnostics, item);
    result.error ??= diagnosticText(failure);
  }
  parentSignal?.removeEventListener("abort", stop);
  if (result.turn_completed && result.exit_code !== null)
    resource.end({
      thread_id: result.thread_id,
      exit_code: result.exit_code,
      turn_completed: true,
    });
  else resource.unknown();
  return result;
}

function appServerDiagnostic(error: unknown): CodexDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("identity mismatch"))
    return diagnostic("validation", "CODEX_THREAD_IDENTITY_MISMATCH", message, "error");
  if (
    message.includes("unavailable") ||
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED")
  )
    return diagnostic("app_server", "CODEX_APP_SERVER_UNAVAILABLE", message, "warning", true);
  if (message.includes("timed out"))
    return diagnostic("app_server", "CODEX_APP_SERVER_TIMEOUT", message, "warning", true);
  if (message.includes("rejected"))
    return diagnostic("app_server", "CODEX_APP_SERVER_REQUEST_REJECTED", message, "error");
  return diagnostic("app_server", "CODEX_APP_SERVER_READ_FAILED", message, "warning", true);
}

function worktreeDiagnostic(error: unknown): CodexDiagnostic {
  return diagnostic(
    "worktree",
    "CODEX_WORKTREE_VERIFICATION_FAILED",
    error instanceof Error ? error.message : String(error),
    "error",
  );
}

function errorWithDiagnostics(
  error: unknown,
  fallback: CodexDiagnostic,
  previous: CodexDiagnostic[] = [],
): CodexCreationError {
  const primary = error instanceof CodexCreationError ? error.diagnostic : fallback;
  const all = [...previous];
  for (const item of diagnosticsFromError(error)) pushDiagnostic(all, item);
  pushDiagnostic(all, primary);
  return new CodexCreationError(primary, { cause: error, diagnostics: all });
}

async function readAndNameThread(threadId: string, title: string): Promise<ReconciliationRead> {
  const path = socketPath();
  if (!path)
    throw new CodexCreationError(
      diagnostic(
        "app_server",
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex app-server control is unavailable",
        "warning",
        true,
      ),
    );
  const { socket, buffer: initial } = await connectSocket(path);
  const buffer = { value: initial };
  try {
    for (const [id, method, params] of [
      [
        1,
        "initialize",
        {
          clientInfo: { name: "multi-task-flow", version: "2" },
          capabilities: { experimentalApi: true },
        },
      ],
      [2, "thread/name/set", { threadId, name: title }],
    ] as const) {
      const response = await rpc(socket, buffer, id, method, params);
      if (response.error)
        throw new CodexCreationError(
          diagnostic(
            "app_server",
            "CODEX_APP_SERVER_REQUEST_REJECTED",
            `${method} rejected`,
            "error",
          ),
        );
    }
    return await readThreadEvidence(socket, buffer, threadId, 3);
  } finally {
    socket.destroy();
  }
}

function parseRemoteRepository(remote: string): RepositoryIdentity | null {
  const value = remote.trim();
  const scp = value.match(/^[^@]+@([^:]+):(.+)$/);
  const hostPath = scp
    ? `${scp[1]}/${scp[2]}`
    : value.includes("://")
      ? value.slice(value.indexOf("://") + 3).replace(/^[^/]*@/, "")
      : value;
  const parts = hostPath.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const name = parts.at(-1)?.replace(/\.git$/, "");
  const owner = parts.at(-2);
  const host = parts[0];
  return host && owner && name ? { host, owner, name } : null;
}

function repositoryKey(repository: RepositoryIdentity): string {
  return [repository.host, repository.owner, repository.name]
    .map((value) =>
      value
        .trim()
        .replace(/\.git$/, "")
        .toLowerCase(),
    )
    .join("/");
}

export function verifyRepositoryIdentity(cwd: string, expected: RepositoryIdentity): void {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    throw new Error("Repository origin is unavailable");
  }
  const actual = parseRemoteRepository(remote);
  if (!actual || repositoryKey(actual) !== repositoryKey(expected))
    throw new Error("Repository identity does not match the orchestration repository");
}

export function verifyWorktree(cwd: string, source: string, threadId: string): string {
  const git = (path: string, args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 10_000 }).trim();
  const actual = realpathSync(cwd),
    root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  if (root === realpathSync(git(source, ["rev-parse", "--show-toplevel"])))
    throw new Error("CLI did not create an independent checkout");
  if (
    realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
    realpathSync(git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  )
    throw new Error("Worktree repository mismatch");
  const ownership = JSON.parse(
    readFileSync(
      git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "codex-thread.json"]),
      "utf8",
    ),
  );
  if (ownership.version !== 1 || ownership.ownerThreadId !== threadId)
    throw new Error("Worktree is not owned by the created Codex thread");
  if (git(actual, ["status", "--porcelain"]))
    throw new Error("Initialization left workspace changes");
  return git(actual, ["rev-parse", "HEAD"]);
}

/** Find the unique worktree that Codex assigned to the observed CLI thread. */
export function findOwnedWorktree(source: string, threadId: string): string {
  const listing = execFileSync("git", ["-C", source, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const roots = [...listing.matchAll(/^worktree (.+)$/gm)].map((match) => match[1]);
  const matches = roots.filter((root): root is string => {
    try {
      const gitPath = execFileSync(
        "git",
        ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "codex-thread.json"],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
      if (!existsSync(gitPath)) return false;
      const ownership = JSON.parse(readFileSync(gitPath, "utf8"));
      return ownership.version === 1 && ownership.ownerThreadId === threadId;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw new Error("Unique Codex-owned worktree unavailable");
  return realpathSync(matches[0]);
}

export type ReconciliationRead = {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
};

function unsupportedRpcResponse(response: Record<string, unknown>): boolean {
  const error = record(response.error);
  const message = typeof error?.message === "string" ? error.message : JSON.stringify(error ?? "");
  return /method not found|unknown (?:method|variant)|unsupported method/i.test(message);
}

function fullTurn(value: unknown, turnId: string): Record<string, unknown> | null {
  const turn = record(value);
  if (!turn || turn.id !== turnId || !Array.isArray(turn.items)) return null;
  const items = turn.items.filter((item): item is Record<string, unknown> => record(item) !== null);
  return items.length === turn.items.length && items.length > 0
    ? { ...turn, items, itemsView: "full" }
    : null;
}

export async function readThreadEvidence(
  socket: Socket,
  buffer: { value: Buffer },
  threadId: string,
  requestId = 2,
  request: typeof rpc = rpc,
): Promise<ReconciliationRead> {
  const response = await request(socket, buffer, requestId, "thread/read", {
    threadId,
    includeTurns: false,
  });
  if (response.error)
    throw new CodexCreationError(
      diagnostic("app_server", "CODEX_THREAD_READ_REJECTED", "thread/read rejected", "error"),
    );
  const thread = record(record(response.result)?.thread);
  if (!thread || thread.id !== threadId)
    throw new CodexCreationError(
      diagnostic(
        "validation",
        "CODEX_THREAD_IDENTITY_MISMATCH",
        "Thread identity mismatch",
        "error",
      ),
    );
  const turns = await request(socket, buffer, requestId + 1, "thread/turns/list", {
    threadId,
    sortDirection: "asc",
    limit: 1,
    itemsView: "summary",
  });
  const turnData = record(turns.result)?.data;
  const turn = Array.isArray(turnData) ? record(turnData[0]) : null;
  if (turns.error || !turn || typeof turn.id !== "string")
    throw new CodexCreationError(
      diagnostic(
        "app_server",
        "CODEX_INITIALIZATION_TURN_UNAVAILABLE",
        "Initialization turn evidence unavailable",
        "warning",
        true,
      ),
    );
  let cursor: unknown;
  const cursors = new Set<unknown>();
  const turnItems: Record<string, unknown>[] = [];
  try {
    while (true) {
      const items = await request(
        socket,
        buffer,
        requestId + 2 + cursors.size,
        "thread/items/list",
        {
          threadId,
          sortDirection: "asc",
          limit: 50,
          ...(cursor ? { cursor } : {}),
        },
      );
      if (items.error) {
        if (unsupportedRpcResponse(items)) throw new Error("thread/items/list unsupported");
        throw new Error("thread/items/list rejected");
      }
      const itemData = record(items.result)?.data;
      if (!Array.isArray(itemData)) throw new Error("thread/items/list malformed");
      for (const row of itemData) {
        const value = record(row);
        if (!value || value.turnId !== turn.id) continue;
        const item = record(value.item) ?? (typeof value.type === "string" ? { ...value } : null);
        if (item) {
          delete item.turnId;
          turnItems.push(item);
        }
      }
      const next = record(items.result)?.nextCursor;
      if (!next) break;
      if (cursors.has(next)) throw new Error("Repeated thread item cursor");
      cursors.add(next);
      cursor = next;
    }
    if (turnItems.length) return { thread, turn: { ...turn, items: turnItems, itemsView: "full" } };
    throw new Error("thread/items/list returned no matching items");
  } catch (error) {
    if (!(error instanceof Error && /unsupported|malformed|no matching items/.test(error.message)))
      throw error;
    const full = await request(socket, buffer, requestId + 100, "thread/turns/list", {
      threadId,
      sortDirection: "asc",
      limit: 1,
      itemsView: "full",
    });
    const fullData = record(full.result)?.data;
    const hydrated = Array.isArray(fullData) ? fullTurn(fullData[0], turn.id) : null;
    if (!hydrated) throw new Error("Initialization items unavailable");
    return { thread, turn: hydrated };
  }
}

export async function readReconciliationEvidence(threadId: string): Promise<ReconciliationRead> {
  const path = socketPath();
  if (!path)
    throw new CodexCreationError(
      diagnostic(
        "app_server",
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex app-server control is unavailable",
        "warning",
        true,
      ),
    );
  const timeout = reconciliationTimeoutMs();
  const { socket, buffer: initial } = await connectSocket(path, timeout);
  const buffer = { value: initial };
  try {
    const request: typeof rpc = (requestSocket, requestBuffer, requestId, method, params) =>
      rpc(requestSocket, requestBuffer, requestId, method, params, { timeoutMs: timeout });
    const initialized = await request(socket, buffer, 1, "initialize", {
      clientInfo: { name: "multi-task-flow", version: "2" },
      capabilities: { experimentalApi: true },
    });
    if (initialized.error) throw new Error("Codex app-server initialization rejected");
    return await readThreadEvidence(socket, buffer, threadId, 2, request);
  } finally {
    socket.destroy();
  }
}

function reconciliationTimeoutMs(): number {
  const configured = Number(process.env.MULTI_TASK_FLOW_CODEX_RECONCILE_TIMEOUT_MS ?? 5_000);
  return Number.isFinite(configured) && configured >= 1_000 && configured <= 60_000
    ? configured
    : 5_000;
}

export async function readThreadRecord(threadId: string): Promise<Record<string, unknown>> {
  const path = socketPath();
  if (!path) throw new Error("App-server read control is unavailable");
  const timeout = reconciliationTimeoutMs();
  const { socket, buffer: initial } = await connectSocket(path, timeout);
  const buffer = { value: initial };
  const request: typeof rpc = (requestSocket, requestBuffer, requestId, method, params) =>
    rpc(requestSocket, requestBuffer, requestId, method, params, { timeoutMs: timeout });
  try {
    const initialized = await request(socket, buffer, 1, "initialize", {
      clientInfo: { name: "multi-task-flow", version: "2" },
      capabilities: { experimentalApi: true },
    });
    if (initialized.error) throw new Error("Codex app-server initialization rejected");
    const response = await request(socket, buffer, 2, "thread/read", {
      threadId,
      includeTurns: false,
    });
    if (response.error) throw new Error("thread/read rejected");
    const thread = record(record(response.result)?.thread);
    if (!thread || thread.id !== threadId) throw new Error("Thread identity mismatch");
    return thread;
  } finally {
    socket.destroy();
  }
}

async function readCompletedTurn(threadId: string): Promise<Record<string, unknown>> {
  const path = socketPath();
  if (!path)
    throw new CodexCreationError(
      diagnostic(
        "app_server",
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex app-server control is unavailable",
        "warning",
        true,
      ),
    );
  const timeout = reconciliationTimeoutMs();
  const { socket, buffer: initial } = await connectSocket(path, timeout);
  const buffer = { value: initial };
  const request: typeof rpc = (requestSocket, requestBuffer, requestId, method, params) =>
    rpc(requestSocket, requestBuffer, requestId, method, params, { timeoutMs: timeout });
  try {
    const initialized = await request(socket, buffer, 1, "initialize", {
      clientInfo: { name: "multi-task-flow", version: "2" },
      capabilities: { experimentalApi: true },
    });
    if (initialized.error) throw new Error("Codex app-server initialization rejected");
    const response = await request(socket, buffer, 2, "thread/turns/list", {
      threadId,
      sortDirection: "asc",
      limit: 1,
      itemsView: "summary",
    });
    const data = record(response.result)?.data;
    const turn = Array.isArray(data) ? record(data[0]) : null;
    if (response.error || !turn || turn.status !== "completed" || typeof turn.id !== "string")
      throw new CodexCreationError(
        diagnostic(
          "app_server",
          "CODEX_COMPLETED_TURN_UNAVAILABLE",
          "Completed initialization turn unavailable",
          "warning",
          true,
        ),
      );
    return turn;
  } finally {
    socket.destroy();
  }
}

export type ReconciliationMode = "app-server" | "worktree-fallback" | "not-attempted";

export type ReconciliationDependencies = {
  read: (threadId: string) => Promise<ReconciliationRead>;
  verify: (cwd: string, source: string, threadId: string) => string;
  findWorktree?: (source: string, threadId: string) => string;
  readCompletedTurn?: (threadId: string) => Promise<Record<string, unknown>>;
};
export async function reconcileCliThread(
  input: {
    thread_id: string;
    model: string;
    thinking: string;
    source_cwd: string;
    role?: AgentRole;
  },
  dependencies: ReconciliationDependencies = {
    read: readReconciliationEvidence,
    verify: verifyWorktree,
  },
) {
  let thread: Record<string, unknown>;
  let turn: Record<string, unknown>;
  const diagnostics: CodexDiagnostic[] = [];
  let reconciliation_mode: ReconciliationMode = "app-server";
  const fail = (error: unknown, fallback: CodexDiagnostic): never => {
    throw errorWithDiagnostics(error, fallback, diagnostics);
  };
  try {
    ({ thread, turn } = await dependencies.read(input.thread_id));
  } catch (error) {
    const readFailure = appServerDiagnostic(error);
    if (readFailure.code === "CODEX_THREAD_IDENTITY_MISMATCH")
      throw errorWithDiagnostics(error, readFailure, diagnostics);
    pushDiagnostic(diagnostics, readFailure);
    reconciliation_mode = "worktree-fallback";
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "validation",
        "CODEX_WORKTREE_FALLBACK_USED",
        "App-server evidence was unavailable; using the uniquely owned worktree",
        "info",
      ),
    );
    let workspacePath: string;
    try {
      workspacePath = (dependencies.findWorktree ?? findOwnedWorktree)(
        input.source_cwd,
        input.thread_id,
      );
    } catch (fallbackError) {
      throw errorWithDiagnostics(fallbackError, worktreeDiagnostic(fallbackError), diagnostics);
    }
    try {
      turn = await (dependencies.readCompletedTurn ?? readCompletedTurn)(input.thread_id);
    } catch (turnError) {
      throw errorWithDiagnostics(turnError, appServerDiagnostic(turnError), diagnostics);
    }
    thread = {
      id: input.thread_id,
      cwd: workspacePath,
      model: input.model,
      reasoningEffort: input.thinking,
    };
  }
  if (thread.id !== input.thread_id)
    fail(
      new Error("Thread identity mismatch"),
      diagnostic(
        "validation",
        "CODEX_THREAD_IDENTITY_MISMATCH",
        "Thread identity mismatch",
        "error",
      ),
    );
  if (thread.model !== input.model || thread.reasoningEffort !== input.thinking)
    fail(
      new Error("CLI execution profile mismatch"),
      diagnostic(
        "validation",
        "CODEX_EXECUTION_PROFILE_MISMATCH",
        "CLI execution profile mismatch",
        "error",
      ),
    );
  if (typeof thread.cwd !== "string")
    fail(
      new Error("Thread working directory unavailable"),
      diagnostic(
        "validation",
        "CODEX_WORKTREE_PATH_UNAVAILABLE",
        "Thread working directory unavailable",
        "error",
      ),
    );
  try {
    verifyInitializationTurn(turn, input.role);
  } catch (error) {
    fail(error, diagnosticFromError(error, "validation", "CODEX_INITIALIZATION_INVALID"));
  }
  let initialHead: string;
  try {
    initialHead = dependencies.verify(thread.cwd, input.source_cwd, input.thread_id);
  } catch (error) {
    throw errorWithDiagnostics(error, worktreeDiagnostic(error), diagnostics);
  }
  return {
    thread_id: input.thread_id,
    workspace_path: thread.cwd,
    initial_head: initialHead,
    turn_completed: true,
    model: input.model,
    thinking: input.thinking,
    evidence_ref: `codex-thread-reconcile:${input.thread_id}`,
    initialization_turn_id: turn.id,
    created_at: new Date().toISOString(),
    reconciliation_mode,
    diagnostics,
  };
}

export type CliCreationDependencies = {
  run: (input: CliCreationInput) => Promise<CliRun>;
  read: (threadId: string, title: string) => Promise<ReconciliationRead>;
  verify: (cwd: string, source: string, threadId: string) => string;
  findWorktree?: (source: string, threadId: string) => string;
};

export async function createCliThread(
  input: CliCreationInput,
  dependencies: CliCreationDependencies = {
    run: runInitialization,
    read: readAndNameThread,
    verify: verifyWorktree,
  },
) {
  const native_request_id = input.native_request_id ?? randomUUID();
  const evidence_ref = `codex-exec:${native_request_id}`;
  const base = { native_request_id, evidence_ref, model: input.model, thinking: input.thinking };
  let execution: CliRun | undefined;
  let workspace_path: string | undefined;
  let reconciliation_mode: ReconciliationMode = "not-attempted";
  const diagnostics: CodexDiagnostic[] = [];
  try {
    if (input.repository) verifyRepositoryIdentity(input.cwd ?? process.cwd(), input.repository);
    execution = await dependencies.run({ ...input, native_request_id });
    for (const item of execution.diagnostics ?? []) pushDiagnostic(diagnostics, item);
    if (
      execution.error ||
      execution.exit_code !== 0 ||
      !execution.turn_completed ||
      !execution.thread_id
    )
      throw new CodexCreationError(
        execution.diagnostics?.find((item) => item.severity === "error") ??
          diagnostic(
            "process",
            "CODEX_INITIALIZATION_INCOMPLETE",
            execution.error ??
              "Initialization did not finish with a unique persisted thread and normal exit",
            "error",
            true,
          ),
        { diagnostics },
      );
    let evidence: ReconciliationRead;
    try {
      evidence = await dependencies.read(execution.thread_id, input.title);
      reconciliation_mode = "app-server";
    } catch (error) {
      const readFailure = appServerDiagnostic(error);
      if (readFailure.code === "CODEX_THREAD_IDENTITY_MISMATCH")
        throw errorWithDiagnostics(error, readFailure, diagnostics);
      pushDiagnostic(diagnostics, readFailure);
      reconciliation_mode = "worktree-fallback";
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "validation",
          "CODEX_WORKTREE_FALLBACK_USED",
          "App-server evidence was unavailable; using the uniquely owned worktree",
          "info",
        ),
      );
      // codex exec may own a completed thread that the shared daemon reports as notLoaded.
      // The CLI protocol and the unique owner worktree are the authoritative creation evidence.
      let fallbackWorkspace: string;
      try {
        fallbackWorkspace = (dependencies.findWorktree ?? findOwnedWorktree)(
          input.cwd ?? process.cwd(),
          execution.thread_id,
        );
      } catch (fallbackError) {
        throw errorWithDiagnostics(fallbackError, worktreeDiagnostic(fallbackError), diagnostics);
      }
      evidence = {
        thread: {
          id: execution.thread_id,
          cwd: fallbackWorkspace,
          model: input.model,
          reasoningEffort: input.thinking,
        },
        turn: {
          id: `codex-exec:${execution.thread_id}`,
          status: "completed",
          items: execution.initialization_items,
        },
      };
    }
    const thread = evidence.thread;
    if (thread.id !== execution.thread_id)
      throw new CodexCreationError(
        diagnostic(
          "validation",
          "CODEX_THREAD_IDENTITY_MISMATCH",
          "Thread identity mismatch",
          "error",
        ),
      );
    if (thread.model !== input.model || thread.reasoningEffort !== input.thinking)
      throw new CodexCreationError(
        diagnostic(
          "validation",
          "CODEX_EXECUTION_PROFILE_MISMATCH",
          "CLI execution profile mismatch",
          "error",
        ),
      );
    if (typeof thread.cwd !== "string")
      throw new CodexCreationError(
        diagnostic(
          "validation",
          "CODEX_WORKTREE_PATH_UNAVAILABLE",
          "Thread working directory unavailable",
          "error",
        ),
      );
    verifyInitializationTurn(evidence.turn, input.role);
    workspace_path = thread.cwd;
    let initial_head: string;
    try {
      initial_head = dependencies.verify(
        thread.cwd,
        input.cwd ?? process.cwd(),
        execution.thread_id,
      );
    } catch (error) {
      throw errorWithDiagnostics(error, worktreeDiagnostic(error), diagnostics);
    }
    return {
      ...base,
      outcome: "succeeded" as const,
      thread_id: execution.thread_id,
      workspace_path,
      initial_head,
      exit_code: execution.exit_code,
      turn_completed: execution.turn_completed,
      events: execution.events,
      initialization_turn_id: typeof evidence.turn.id === "string" ? evidence.turn.id : undefined,
      reconciliation_mode,
      diagnostics,
    };
  } catch (error) {
    // A failed CLI can allocate a worktree before it emits thread.started.
    for (const item of diagnosticsFromError(error)) pushDiagnostic(diagnostics, item);
    const failure = diagnosticFromError(error, "validation", "CODEX_CREATION_FAILED", "error");
    pushDiagnostic(diagnostics, failure);
    return {
      ...base,
      outcome: "unknown" as const,
      ...(execution?.thread_id ? { thread_id: execution.thread_id } : {}),
      workspace_path,
      exit_code: execution?.exit_code ?? null,
      turn_completed: execution?.turn_completed ?? false,
      events: execution?.events ?? [],
      reconciliation_mode,
      diagnostics,
      error: diagnosticText(error),
    };
  }
}
