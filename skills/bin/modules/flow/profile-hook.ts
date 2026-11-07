import { FlowError, isRecord, nonemptyString, stableHash } from "./common";
import {
  AUTONOMOUS_MODELS,
  SUPPORTED_MODEL_EFFORTS,
  autonomousModelAllowed,
  modelOverridePaths,
  readModelOverrideState,
  stateDir,
  supportedExplicitProfile,
  updateModelOverrideState,
  type LogicalIdentity,
} from "./profile-state";

const DIRECTIVE_RE =
  /^agent-model:[ \t]*(?<model>auto|gpt-[A-Za-z0-9.-]+)[ \t]*$/i;
export const NO_MODEL_DIRECTIVE = Symbol("no-model-directive");

export function profileOverrideUnavailable(
  value: unknown,
  model: string,
  effort: string,
): boolean {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.error !== "string"
  )
    return false;
  const message = value.error;
  if (typeof message !== "string" || !/^[\x00-\x7f]*$/.test(message))
    return false;
  const unavailable =
    "(?:unknown|unsupported|unavailable|not (?:available|supported))";
  const modelRef = `(?<![A-Za-z0-9_.-])${escapeRegExp(model)}(?![A-Za-z0-9_.-])`;
  const effortRef = `(?<![A-Za-z0-9_.-])${escapeRegExp(effort)}(?![A-Za-z0-9_.-])`;
  const patterns = [
    new RegExp(
      `model ${modelRef} with (?:reasoning effort|effort) ${effortRef} is ${unavailable}`,
      "i",
    ),
    new RegExp(
      `(?:reasoning effort|effort) ${effortRef} (?:for|with) model ${modelRef} is ${unavailable}`,
      "i",
    ),
  ];
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.source}$`, "i").test(message),
  );
}

export interface HookEvent {
  [key: string]: unknown;
}

export function hookInput(event: HookEvent): Record<string, unknown> {
  for (const key of ["tool_input", "toolInput", "input"]) {
    const value = event[key];
    if (isRecord(value)) return value;
  }
  return {};
}

export function hookToolName(event: HookEvent): string {
  return (
    consistentNonemptyAlias(event, ["tool_name", "toolName"], "tool name") ?? ""
  );
}

export function isSpawnTool(event: HookEvent): boolean {
  const name = hookToolName(event);
  return (
    name === "Agent" || name === "spawn_agent" || name.endsWith("__spawn_agent")
  );
}

export function isCreateThreadTool(event: HookEvent): boolean {
  return ["mcp__codex_app__create_thread", "create_thread"].includes(
    hookToolName(event),
  );
}

export function isSendMessageTool(event: HookEvent): boolean {
  return [
    "mcp__codex_app__send_message_to_thread",
    "send_message_to_thread",
  ].includes(hookToolName(event));
}

function isModelSelectionTool(event: HookEvent): boolean {
  return (
    isSpawnTool(event) || isCreateThreadTool(event) || isSendMessageTool(event)
  );
}

export function eventSessionId(event: HookEvent): string | undefined {
  return (
    consistentNonemptyAlias(
      event,
      ["session_id", "sessionId", "thread_id", "threadId"],
      "session identity",
    ) ?? nonemptyString(process.env.CODEX_THREAD_ID)
  );
}

export function eventToolUseId(event: HookEvent): string | undefined {
  const toolUseId = consistentNonemptyAlias(
    event,
    ["tool_use_id", "toolUseId"],
    "tool request identity",
  );
  const callId = consistentNonemptyAlias(
    event,
    ["call_id", "callId"],
    "function call identity",
  );
  return toolUseId ?? callId ?? nonemptyString(event.id);
}

export function parseModelDirective(
  prompt: unknown,
): string | null | typeof NO_MODEL_DIRECTIVE {
  if (typeof prompt !== "string") return NO_MODEL_DIRECTIVE;
  const lines = prompt.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstIndex < 0) return NO_MODEL_DIRECTIVE;
  const first = lines[firstIndex]?.trim() ?? "";
  const match = DIRECTIVE_RE.exec(first);
  if (!match?.groups?.model) {
    if (first.toLowerCase().startsWith("agent-model")) {
      throw new FlowError(
        "agent-model directive must be the complete first non-empty line",
      );
    }
    return NO_MODEL_DIRECTIVE;
  }
  const directives = lines
    .slice(firstIndex)
    .filter((line) => line.trim().toLowerCase().startsWith("agent-model"));
  if (directives.length !== 1)
    throw new FlowError("duplicate agent-model directives are not allowed");
  if (directives.some((line) => !DIRECTIVE_RE.test(line.trim()))) {
    throw new FlowError(
      "agent-model directive must be a complete standalone line",
    );
  }
  const model = match.groups.model.toLowerCase();
  if (model === "auto") return null;
  if (!Object.hasOwn(SUPPORTED_MODEL_EFFORTS, model))
    throw new FlowError("agent-model directive names an unsupported model");
  return model;
}

export function allow(): { continue: true } {
  return { continue: true };
}

export function deny(reason: string): Record<string, unknown> {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function userPromptSubmit(
  event: HookEvent,
  permitsRoot = stateDir(),
): Record<string, unknown> {
  let sessionId: string | undefined;
  try {
    sessionId = eventSessionId(event);
  } catch (error) {
    return {
      decision: "block",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let directive: string | null | typeof NO_MODEL_DIRECTIVE;
  try {
    directive = parseModelDirective(event.prompt);
  } catch (error) {
    return {
      decision: "block",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (directive === NO_MODEL_DIRECTIVE) return allow();
  if (!sessionId)
    return {
      decision: "block",
      reason: "agent-model directive requires a session_id",
    };
  try {
    updateModelOverrideState(permitsRoot, (state) => {
      if (directive === null) delete state.sessions[sessionId];
      else state.sessions[sessionId] = { model: directive };
    });
  } catch (error) {
    return {
      decision: "block",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return allow();
}

function requestedProfile(
  input: Record<string, unknown>,
  spawn: boolean,
): [string | undefined, string | undefined] {
  const model = nonemptyString(input.model);
  const effortKey = spawn ? "reasoning_effort" : "thinking";
  return [model, nonemptyString(input[effortKey])];
}

function overrideForSession(
  root: string,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  return readModelOverrideState(root).sessions[sessionId]?.model;
}

export function preToolUse(
  event: HookEvent,
  permitsRoot = stateDir(),
): Record<string, unknown> {
  if (!isModelSelectionTool(event)) return allow();
  const input = hookInput(event);
  const spawn = isSpawnTool(event);
  const [model, effort] = requestedProfile(input, spawn);
  if (!model && isSendMessageTool(event)) {
    return effort &&
      !new Set(["low", "medium", "high", "xhigh", "max", "ultra"]).has(effort)
      ? deny("task continuation thinking is not supported")
      : allow();
  }
  if (model && isSendMessageTool(event) && !effort) {
    if (!Object.hasOwn(SUPPORTED_MODEL_EFFORTS, model))
      return deny("task continuation model is not supported");
    try {
      const override = overrideForSession(permitsRoot, eventSessionId(event));
      if (!autonomousModelAllowed(model, override)) {
        return deny(
          override === undefined
            ? "task continuation model is outside the autonomous model allowlist"
            : "task continuation model does not match the current agent-model directive",
        );
      }
    } catch (error) {
      return deny(error instanceof Error ? error.message : String(error));
    }
    return allow();
  }
  if (!model || !effort)
    return deny(
      `Agent launch must provide both model and ${spawn ? "reasoning_effort" : "thinking"}`,
    );
  if (!supportedExplicitProfile({ model, effort }))
    return deny(
      `Agent launch model and ${spawn ? "reasoning_effort" : "thinking"} are not a supported explicit pair`,
    );
  try {
    const override = overrideForSession(permitsRoot, eventSessionId(event));
    if (!autonomousModelAllowed(model, override)) {
      return deny(
        override === undefined
          ? "Agent launch model is outside the autonomous model allowlist"
          : "Agent launch model does not match the current agent-model directive",
      );
    }
  } catch (error) {
    return deny(error instanceof Error ? error.message : String(error));
  }
  return allow();
}

export function runHook(
  event: HookEvent,
  permitsRoot = stateDir(),
): Record<string, unknown> {
  const name = String(event.hook_event_name ?? event.hookEventName ?? "");
  if (name === "UserPromptSubmit") return userPromptSubmit(event, permitsRoot);
  if (name === "PreToolUse") {
    try {
      return enrichNativeCreateThreadDenial(
        preToolUse(event, permitsRoot),
        event,
      );
    } catch (error) {
      return deny(error instanceof Error ? error.message : String(error));
    }
  }
  return {};
}

function enrichNativeCreateThreadDenial(
  result: Record<string, unknown>,
  event: HookEvent,
): Record<string, unknown> {
  if (!isCreateThreadTool(event)) return result;
  const output = result.hookSpecificOutput;
  if (
    !isRecord(output) ||
    output.hookEventName !== "PreToolUse" ||
    output.permissionDecision !== "deny"
  )
    return result;
  const enriched: Record<string, unknown> = {
    ...result,
    tool_name: "create_thread",
  };
  const requestId = eventToolUseId(event);
  if (requestId) enriched.request_id = requestId;
  const operationId = consistentNonemptyAlias(
    event,
    ["operation_id", "dispatch_operation_id"],
    "dispatch operation identity",
  );
  if (operationId) enriched.operation_id = operationId;
  return enriched;
}

function consistentNonemptyAlias(
  event: HookEvent,
  keys: string[],
  field: string,
): string | undefined {
  const values: string[] = [];
  for (const key of keys) {
    if (!(key in event)) continue;
    const value = nonemptyString(event[key]);
    if (!value) throw new FlowError(`${field} aliases must be non-empty text`);
    values.push(value);
  }
  if (!values.length) return undefined;
  if (new Set(values).size !== 1)
    throw new FlowError(`${field} aliases conflict`);
  return values[0];
}

export function logicalIdentity(
  sessionId: string,
  input: Record<string, unknown>,
): LogicalIdentity {
  const message = nonemptyString(input.message);
  const taskName = nonemptyString(input.task_name);
  const agentType = nonemptyString(input.agent_type) ?? "default";
  const rawForkTurns = input.fork_turns;
  const forkTurns =
    rawForkTurns === undefined
      ? "all"
      : typeof rawForkTurns === "string" && rawForkTurns.trim()
        ? rawForkTurns.trim()
        : undefined;
  if (!taskName || !message)
    throw new FlowError(
      "native spawn must include non-empty task_name and message",
    );
  if (!forkTurns) throw new FlowError("native spawn has invalid fork_turns");
  return {
    session_id: sessionId,
    task_name: taskName,
    agent_type: agentType,
    fork_turns: forkTurns,
    message_digest: stableHash(message),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
