import { record } from "../lib/codex-rpc";

export type AgentRole = "Delivery Agent" | "Task Agent";

export type CodexDiagnosticStage = "process" | "event" | "app_server" | "worktree" | "validation";
export type CodexDiagnostic = {
  stage: CodexDiagnosticStage;
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  retryable: boolean;
};

export function boundedMessage(value: string): string {
  return value.slice(0, 500);
}

export function diagnostic(
  stage: CodexDiagnosticStage,
  code: string,
  message: string,
  severity: CodexDiagnostic["severity"],
  retryable = false,
): CodexDiagnostic {
  return { stage, code, message: boundedMessage(message), severity, retryable };
}

export class CodexCreationError extends Error {
  readonly diagnostics: CodexDiagnostic[];

  constructor(
    public readonly diagnostic: CodexDiagnostic,
    options: { cause?: unknown; diagnostics?: CodexDiagnostic[] } = {},
  ) {
    super(diagnostic.message);
    this.name = "CodexCreationError";
    this.diagnostics = options.diagnostics ?? [diagnostic];
    if (options.cause !== undefined) Object.defineProperty(this, "cause", { value: options.cause });
  }
}

export function diagnosticFromError(
  error: unknown,
  stage: CodexDiagnosticStage,
  code: string,
  severity: CodexDiagnostic["severity"] = "error",
  retryable = false,
): CodexDiagnostic {
  if (error instanceof CodexCreationError) return error.diagnostic;
  return diagnostic(
    stage,
    code,
    error instanceof Error ? error.message : String(error),
    severity,
    retryable,
  );
}

export function diagnosticsFromError(error: unknown): CodexDiagnostic[] {
  return error instanceof CodexCreationError ? error.diagnostics : [];
}

export function diagnosticText(error: unknown): string {
  if (error instanceof CodexCreationError)
    return `${error.diagnostic.code}: ${error.diagnostic.message}`;
  return boundedMessage(error instanceof Error ? error.message : String(error));
}

export function pushDiagnostic(target: CodexDiagnostic[], value: CodexDiagnostic): void {
  if (!target.some((item) => item.code === value.code && item.message === value.message))
    target.push(value);
}

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

export function isWorkItem(value: unknown): boolean {
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

export type InitializationEvent = {
  type: string;
  thread_id?: string;
  item?: unknown;
  diagnostic?: CodexDiagnostic;
};

export function parseInitializationEvent(value: unknown): InitializationEvent {
  const event = record(value);
  const type = typeof event?.type === "string" ? event.type : "";
  if (!event || !type)
    throw new CodexCreationError(
      diagnostic("event", "CODEX_INVALID_EVENT", "Codex emitted an invalid JSON event", "error"),
    );
  const params = record(event.params);
  const hasEventItem = Object.hasOwn(event, "item");
  const hasParamsItem = params !== null && Object.hasOwn(params, "item");
  if (hasEventItem && hasParamsItem)
    throw new CodexCreationError(
      diagnostic(
        "event",
        "CODEX_AMBIGUOUS_ITEM_EVIDENCE",
        "Codex emitted item evidence in both event and params",
        "error",
      ),
    );
  const hasItem = hasEventItem || hasParamsItem;
  const rawItem = hasEventItem ? event.item : hasParamsItem ? params?.item : undefined;
  const item = record(rawItem);
  const itemMessage = typeof item?.message === "string" ? item.message : "";
  const eventError = record(event.error);
  const failureMessage =
    typeof event.message === "string"
      ? event.message
      : typeof event.error === "string"
        ? event.error
        : typeof eventError?.message === "string"
          ? eventError.message
          : "Codex initialization turn failed";
  const eventDiagnostic =
    type === "item.completed" && item?.type === "error"
      ? diagnostic(
          "event",
          "CODEX_EVENT_DIAGNOSTIC",
          itemMessage || "Codex emitted an error item",
          "warning",
        )
      : type === "turn.failed" || type === "error"
        ? diagnostic("event", "CODEX_INITIALIZATION_FAILED", failureMessage, "error")
        : undefined;
  return {
    type,
    ...(typeof event.thread_id === "string" ? { thread_id: event.thread_id } : {}),
    ...(hasItem ? { item: rawItem } : {}),
    ...(eventDiagnostic ? { diagnostic: eventDiagnostic } : {}),
  };
}

/** Only a completed, work-free turn with the exact role prompt can be reconciled. */
export function verifyInitializationTurn(turn: unknown, role: AgentRole = "Task Agent"): void {
  const value = record(turn);
  if (value?.status !== "completed")
    throw new CodexCreationError(
      diagnostic(
        "validation",
        "CODEX_INITIALIZATION_TURN_INCOMPLETE",
        "Initialization turn is not completed",
        "error",
      ),
    );
  try {
    verifyInitializationItems(turn, role);
  } catch (error) {
    throw new CodexCreationError(
      diagnostic(
        "validation",
        "CODEX_INITIALIZATION_INVALID",
        error instanceof Error ? error.message : String(error),
        "error",
      ),
      { cause: error },
    );
  }
}

export type CliRun = {
  thread_id?: string;
  exit_code: number | null;
  turn_completed: boolean;
  events: string[];
  initialization_items: Record<string, unknown>[];
  diagnostics: CodexDiagnostic[];
  timed_out: boolean;
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
