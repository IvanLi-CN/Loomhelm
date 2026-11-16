import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { runProcess } from "@loomhelm/runtime-core/modules/core/process";
import { connectSocket, record, rpc, socketPath } from "../lib/codex-rpc";

export type AgentRole = "Delivery Agent" | "Task Agent";
export function initializationPrompt(role: AgentRole): string {
  return `$multi-task-flow\n\n你是本次运行中的 ${role}，由主 Agent 委派到独立工作区。当前只是初始化握手：正式派发前只回复 READY，不要开始正式任务，也不要读取或修改文件、调用工具或执行命令。主 Agent 稍后会发送正式派发消息；收到后再按本 Skill 读取任务上下文并推进自己的任务。`;
}
function legacyInitializationPrompt(role: AgentRole): string {
  return initializationPrompt(role).replace("，也不要调用工具、读取或修改文件、执行命令。", "。");
}
function historicalInitializationPrompt(role: AgentRole): string {
  return `$multi-task-flow\n\n你是本次运行中的 ${role}，由主 Agent 委派到独立工作区。主 Agent 稍后会发送正式派发消息；收到后按本 Skill 读取任务上下文并推进自己的任务。正式派发前不要开始正式任务。`;
}
export const INITIALIZATION_PROMPT = initializationPrompt("Task Agent");

const handshakeItemTypes = new Set(["user_message", "agent_message", "reasoning"]);

function normalizedItemType(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/-/g, "_")
        .toLowerCase()
    : "";
}

function isIgnorableInitializationDiagnostic(value: unknown): boolean {
  const item = record(value);
  const message = typeof item?.message === "string" ? item.message.trim() : "";
  return (
    normalizedItemType(item?.type) === "error" &&
    (/^`?\[features\]\.multi_agent`? is deprecated\./.test(message) ||
      /^Codex is ignoring \d+ unrecognized configuration settings?\.$/.test(message) ||
      message === "loading hooks from two config layers; prefer a single representation")
  );
}

function isWorkItem(value: unknown): boolean {
  const item = record(value);
  return (
    item === null ||
    (!handshakeItemTypes.has(normalizedItemType(item.type)) &&
      !isIgnorableInitializationDiagnostic(item))
  );
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") {
    if ("content" in item) throw new Error("Initialization item content is malformed");
    return item.text;
  }
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part: unknown) => {
      const value = record(part);
      if (!value || normalizedItemType(value.type) !== "text" || typeof value.text !== "string")
        throw new Error("Initialization item content is malformed");
      return value.text;
    })
    .join("");
}

function verifyInitializationItems(turn: unknown, role: AgentRole): void {
  const value = record(turn);
  if (!Array.isArray(value.items)) throw new Error("Initialization items are unavailable");
  const items = value.items.map((item) => {
    const parsed = record(item);
    if (!parsed) throw new Error("Initialization item is malformed");
    return parsed;
  });
  const userMessages = items.filter((item) => normalizedItemType(item.type) === "user_message");
  const userMessage = userMessages[0];
  if (
    userMessages.length !== 1 ||
    !userMessage ||
    ![
      initializationPrompt(role),
      legacyInitializationPrompt(role),
      historicalInitializationPrompt(role),
    ].includes(itemText(userMessage))
  )
    throw new Error("Initialization prompt does not match the expected agent role");
  if (
    !items.some(
      (item) =>
        normalizedItemType(item.type) === "agent_message" && itemText(item).trim().length > 0,
    )
  )
    throw new Error("Initialization response is unavailable");
  if (items.some(isWorkItem))
    throw new Error("Initialization recorded work instead of a handshake");
}

/** Only a completed, work-free turn with the exact role prompt can be reconciled. */
export function verifyInitializationTurn(turn: unknown, role: AgentRole = "Task Agent"): void {
  const value = record(turn);
  if (value?.status !== "completed") throw new Error("Initialization turn is not completed");
  verifyInitializationItems(turn, role);
}

/** An interrupted initialization may only be recovered if it remained work-free. */
export function verifyInterruptedInitializationTurn(
  turn: unknown,
  role: AgentRole = "Task Agent",
): void {
  const value = record(turn);
  if (value?.status !== "interrupted" && value?.status !== "failed")
    throw new Error("Initialization turn is not interrupted");
  verifyInitializationItems(turn, role);
}

export type CliRun = {
  thread_id?: string;
  exit_code: number | null;
  turn_completed: boolean;
  events: string[];
  error?: string;
};
export type CliCreationInput = {
  title: string;
  prompt: string;
  model: string;
  thinking: string;
  cwd?: string;
  role?: AgentRole;
  repository?: RepositoryIdentity;
  native_request_id?: string;
  onThreadStarted?: (threadId: string) => void;
};
export type RepositoryIdentity = { host: string; owner: string; name: string };

/** Each process belongs to this attempt; no shell or inherited stdin. */
export async function runInitialization(input: CliCreationInput): Promise<CliRun> {
  const result: CliRun = { exit_code: null, turn_completed: false, events: [] };
  const decoder = new StringDecoder("utf8");
  const controller = new AbortController();
  let pending = "";
  const abort = (error: string) => {
    result.error ??= error;
    controller.abort();
  };
  const line = (value: string) => {
    if (!value.trim() || result.error) return;
    try {
      const event = JSON.parse(value);
      const type = String(event.type);
      if (result.events.length < 64) result.events.push(type);
      if (type === "thread.started") {
        if (result.thread_id || typeof event.thread_id !== "string" || !event.thread_id)
          throw new Error("Ambiguous thread identity");
        result.thread_id = event.thread_id;
        input.onThreadStarted?.(event.thread_id);
      }
      if (type === "turn.completed") result.turn_completed = true;
      if (type === "turn.failed" || type === "error") throw new Error("Initialization turn failed");
      const params = record(event.params);
      const hasEventItem = Object.hasOwn(event, "item");
      const hasParamsItem = params !== null && Object.hasOwn(params, "item");
      if (hasEventItem && hasParamsItem) throw new Error("Ambiguous CLI item evidence");
      const item = hasEventItem ? event.item : hasParamsItem ? params?.item : undefined;
      if ((hasEventItem || hasParamsItem) && isWorkItem(item))
        throw new Error(
          `Initialization attempted work instead of a handshake: ${JSON.stringify(item).slice(0, 500)}`,
        );
    } catch (error) {
      abort(error instanceof SyntaxError ? "Invalid CLI JSONL" : String(error));
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
        // Drain diagnostics without exposing credentials or retaining logs.
        if (stream !== "stdout" || result.error) return;
        pending += decoder.write(chunk);
        if (pending.length > 1024 * 1024) {
          pending = "";
          abort("CLI event exceeds limit");
          return;
        }
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const next = pending.slice(0, end);
          pending = pending.slice(end + 1);
          line(next);
        }
      },
    });
    pending += decoder.end();
    if (pending.trim()) line(pending);
    result.exit_code = execution.exitCode;
    if (execution.timedOut) result.error ??= "CLI initialization timed out; reconcile before retry";
  } catch (error) {
    result.error ??= `Codex initialization process failed: ${String(error).slice(0, 300)}`;
  }
  return result;
}

async function readAndNameThread(threadId: string, title: string): Promise<ReconciliationRead> {
  const path = socketPath();
  if (!path) throw new Error("App-server read control is unavailable");
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
      if (response.error) throw new Error(`${method} rejected`);
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

type ReconciliationRead = {
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
  if (response.error) throw new Error("thread/read rejected");
  const thread = record(record(response.result)?.thread);
  if (!thread || thread.id !== threadId) throw new Error("Thread identity mismatch");
  const turns = await request(socket, buffer, requestId + 1, "thread/turns/list", {
    threadId,
    sortDirection: "asc",
    limit: 1,
    itemsView: "summary",
  });
  const turnData = record(turns.result)?.data;
  const turn = Array.isArray(turnData) ? record(turnData[0]) : null;
  if (turns.error || !turn || typeof turn.id !== "string")
    throw new Error("Initialization turn evidence unavailable");
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
  if (!path) throw new Error("App-server read control is unavailable");
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
    return readThreadEvidence(socket, buffer, threadId, 2, request);
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
    const response = await request(socket, buffer, 2, "thread/turns/list", {
      threadId,
      sortDirection: "asc",
      limit: 1,
      itemsView: "summary",
    });
    const data = record(response.result)?.data;
    const turn = Array.isArray(data) ? record(data[0]) : null;
    if (response.error || !turn || turn.status !== "completed" || typeof turn.id !== "string")
      throw new Error("Completed initialization turn unavailable");
    return turn;
  } finally {
    socket.destroy();
  }
}

type ReconciliationDependencies = {
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
  try {
    ({ thread, turn } = await dependencies.read(input.thread_id));
  } catch (error) {
    if (error instanceof Error && error.message === "Thread identity mismatch") throw error;
    const workspacePath = (dependencies.findWorktree ?? findOwnedWorktree)(
      input.source_cwd,
      input.thread_id,
    );
    turn = await (dependencies.readCompletedTurn ?? readCompletedTurn)(input.thread_id);
    thread = {
      id: input.thread_id,
      cwd: workspacePath,
      model: input.model,
      reasoningEffort: input.thinking,
    };
  }
  if (thread.id !== input.thread_id) throw new Error("Thread identity mismatch");
  if (thread.model !== input.model || thread.reasoningEffort !== input.thinking)
    throw new Error("CLI execution profile mismatch");
  if (typeof thread.cwd !== "string") throw new Error("Thread working directory unavailable");
  verifyInitializationTurn(turn, input.role);
  const initialHead = dependencies.verify(thread.cwd, input.source_cwd, input.thread_id);
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
  };
}

export async function createCliThread(
  input: CliCreationInput,
  dependencies: {
    run: (input: CliCreationInput) => Promise<CliRun>;
    read: (threadId: string, title: string) => Promise<ReconciliationRead>;
    verify: (cwd: string, source: string, threadId: string) => string;
    findWorktree?: (source: string, threadId: string) => string;
  } = {
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
  try {
    if (input.repository) verifyRepositoryIdentity(input.cwd ?? process.cwd(), input.repository);
    execution = await dependencies.run({ ...input, native_request_id });
    if (
      execution.error ||
      execution.exit_code !== 0 ||
      !execution.turn_completed ||
      !execution.thread_id
    )
      throw new Error(
        execution.error ??
          "Initialization did not finish with a unique persisted thread and normal exit",
      );
    let evidence: ReconciliationRead;
    try {
      evidence = await dependencies.read(execution.thread_id, input.title);
    } catch (error) {
      if (error instanceof Error && error.message === "Thread identity mismatch") throw error;
      // codex exec may own a completed thread that the shared daemon reports as notLoaded.
      // The CLI protocol and the unique owner worktree are the authoritative creation evidence.
      const fallbackWorkspace = (dependencies.findWorktree ?? findOwnedWorktree)(
        input.cwd ?? process.cwd(),
        execution.thread_id,
      );
      evidence = {
        thread: {
          id: execution.thread_id,
          cwd: fallbackWorkspace,
          model: input.model,
          reasoningEffort: input.thinking,
        },
        turn: { id: `codex-exec:${execution.thread_id}`, status: "completed" },
      };
      void error;
    }
    verifyInitializationTurn(evidence.turn, input.role);
    const thread = evidence.thread;
    if (thread.id !== execution.thread_id) throw new Error("Thread identity mismatch");
    if (thread.model !== input.model || thread.reasoningEffort !== input.thinking)
      throw new Error("CLI execution profile mismatch");
    if (typeof thread.cwd !== "string") throw new Error("Thread working directory unavailable");
    workspace_path = thread.cwd;
    const initial_head = dependencies.verify(
      thread.cwd,
      input.cwd ?? process.cwd(),
      execution.thread_id,
    );
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
    };
  } catch (error) {
    // A failed CLI can allocate a worktree before it emits thread.started.
    return {
      ...base,
      outcome: "unknown" as const,
      ...(execution?.thread_id ? { thread_id: execution.thread_id } : {}),
      workspace_path,
      exit_code: execution?.exit_code ?? null,
      turn_completed: execution?.turn_completed ?? false,
      events: execution?.events ?? [],
      error: String(error).slice(0, 500),
    };
  }
}
