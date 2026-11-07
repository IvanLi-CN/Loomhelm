import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connectSocket, record, rpc, socketPath } from "./codex-rpc";

export const INITIALIZATION_PROMPT = "这是对话初始化握手。只回复‘初始化完成’，然后立即结束本轮。不要调用工具、读取文件、修改文件、执行任务或等待后续消息。正式任务将在创建进程退出并完成账本绑定后另行发送。";
export type CliRun = {
  thread_id?: string; exit_code: number | null; turn_completed: boolean;
  events: string[]; error?: string;
};
export type CliCreationInput = {
  title: string; prompt: string; model: string; thinking: string; cwd?: string;
  native_request_id?: string;
  onThreadStarted?: (threadId: string) => void;
};

/** Each process belongs to this attempt; no shell or inherited stdin. */
export function runInitialization(input: CliCreationInput): Promise<CliRun> {
  return new Promise(resolve => {
    const result: CliRun = { exit_code: null, turn_completed: false, events: [] };
    const decoder = new StringDecoder("utf8");
    let closed = false;
    let pending = "", timer: ReturnType<typeof setTimeout>, killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn("codex", ["exec", "-C", input.cwd ?? process.cwd(), "--worktree", "--json", "-m", input.model,
      "-c", `model_reasoning_effort=${JSON.stringify(input.thinking)}`, INITIALIZATION_PROMPT], {
      cwd: input.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    const abort = (error: string) => {
      result.error ??= error;
      if (closed) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const line = (value: string) => {
      if (!value.trim()) return;
      try {
        const event = JSON.parse(value);
        const type = String(event.type);
        if (result.events.length < 64) result.events.push(type);
        if (type === "thread.started") {
          if (result.thread_id || typeof event.thread_id !== "string" || !event.thread_id) throw new Error("Ambiguous thread identity");
          result.thread_id = event.thread_id;
          input.onThreadStarted?.(event.thread_id);
        }
        if (type === "turn.completed") result.turn_completed = true;
        if (type === "turn.failed" || type === "error") throw new Error("Initialization turn failed");
        if (["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"].includes(event.item?.type))
          throw new Error("Initialization attempted work instead of a handshake");
      } catch (error) { abort(error instanceof SyntaxError ? "Invalid CLI JSONL" : String(error)); }
    };
    child.stdout.on("data", chunk => {
      pending += decoder.write(chunk);
      if (pending.length > 1024 * 1024) { abort("CLI event exceeds limit"); return; }
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { const next = pending.slice(0, end); pending = pending.slice(end + 1); line(next); }
    });
    // Drain diagnostics without exposing credentials or persisting unbounded logs.
    child.stderr.resume();
    child.on("error", () => { result.error = "Codex executable could not be started"; });
    child.on("close", code => {
      closed = true; pending += decoder.end();
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (pending.trim()) line(pending);
      result.exit_code = code;
      resolve(result);
    });
    const configured = Number(process.env.MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS ?? 300_000);
    timer = setTimeout(() => abort("CLI initialization timed out; reconcile before retry"),
      Number.isFinite(configured) && configured >= 1000 && configured <= 600_000 ? configured : 300_000);
  });
}

async function readAndNameThread(threadId: string, title: string): Promise<Record<string, any>> {
  const path = socketPath();
  if (!path) throw new Error("App-server read control is unavailable");
  const { socket, buffer: initial } = await connectSocket(path);
  const buffer = { value: initial };
  try {
    for (const [id, method, params] of [
      [1, "initialize", { clientInfo: { name: "multi-task-flow", version: "2" }, capabilities: { experimentalApi: true } }],
      [2, "thread/name/set", { threadId, name: title }],
    ] as const) {
      const response = await rpc(socket, buffer, id, method, params);
      if (response.error) throw new Error(`${method} rejected`);
    }
    const response = await rpc(socket, buffer, 3, "thread/read", { threadId, includeTurns: false });
    if (response.error) throw new Error("thread/read rejected");
    const thread = record(record(response.result)?.thread);
    if (!thread || thread.id !== threadId) throw new Error("Thread identity mismatch");
    return thread;
  } finally { socket.destroy(); }
}

function verifyWorktree(cwd: string, source: string, threadId: string): string {
  const git = (path: string, args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 10_000 }).trim();
  const actual = realpathSync(cwd), root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  if (root === realpathSync(git(source, ["rev-parse", "--show-toplevel"]))) throw new Error("CLI did not create an independent checkout");
  if (realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
      realpathSync(git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) throw new Error("Worktree repository mismatch");
  const ownership = JSON.parse(readFileSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "codex-thread.json"]), "utf8"));
  if (ownership.version !== 1 || ownership.ownerThreadId !== threadId) throw new Error("Worktree is not owned by the created Codex thread");
  if (git(actual, ["status", "--porcelain"])) throw new Error("Initialization left workspace changes");
  return git(actual, ["rev-parse", "HEAD"]);
}

export async function createCliThread(input: CliCreationInput, dependencies = {
  run: runInitialization, read: readAndNameThread, verify: verifyWorktree,
}) {
  const native_request_id = input.native_request_id ?? randomUUID();
  const evidence_ref = `codex-exec:${native_request_id}`;
  const base = { native_request_id, evidence_ref, model: input.model, thinking: input.thinking };
  let execution: CliRun | undefined;
  let workspace_path: string | undefined;
  try {
    execution = await dependencies.run(input);
    if (execution.error || execution.exit_code !== 0 || !execution.turn_completed || !execution.thread_id)
      throw new Error(execution.error ?? "Initialization did not finish with a unique persisted thread and normal exit");
    const thread = await dependencies.read(execution.thread_id, input.title);
    if (thread.model !== input.model || thread.reasoningEffort !== input.thinking) throw new Error("CLI execution profile mismatch");
    if (typeof thread.cwd !== "string") throw new Error("Thread working directory unavailable");
    workspace_path = thread.cwd;
    const initial_head = dependencies.verify(thread.cwd, input.cwd ?? process.cwd(), execution.thread_id);
    return { ...base, outcome: "succeeded" as const, thread_id: execution.thread_id, workspace_path, initial_head,
      exit_code: execution.exit_code, turn_completed: execution.turn_completed, events: execution.events };
  } catch (error) {
    // A failed CLI can allocate a worktree before it emits thread.started.
    return { ...base, outcome: "unknown" as const, ...(execution?.thread_id ? { thread_id: execution.thread_id } : {}),
      workspace_path, exit_code: execution?.exit_code ?? null, turn_completed: execution?.turn_completed ?? false,
      events: execution?.events ?? [], error: String(error).slice(0, 500) };
  }
}
