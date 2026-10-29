import type { Event, JsonValue } from "@loomhelm/protocol";

export type ConversationEvent = Pick<Event, "event_id" | "type" | "payload">;

export type ToolStatus = "pending" | "running" | "completed" | "failed" | "unknown";

interface ConversationContentBase {
  eventId: string;
  eventType: Event["type"];
  raw: JsonValue;
}

export interface MessageContent extends ConversationContentBase {
  kind: "message";
  role: "user" | "assistant" | "system";
  text: string;
}

export interface CodeContent extends ConversationContentBase {
  kind: "code";
  code: string;
  language?: string;
  filename?: string;
}

export interface ToolContent extends ConversationContentBase {
  kind: "tool";
  name: string;
  status: ToolStatus;
  summary?: string;
}

export interface UnknownContent extends ConversationContentBase {
  kind: "unknown";
  label: string;
  itemType?: string;
}

export type ConversationContent = MessageContent | CodeContent | ToolContent | UnknownContent;

type JsonRecord = { readonly [key: string]: JsonValue };

const sensitiveFieldNames = new Set([
  "accesskey",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "secret",
  "token"
]);

const privatePathFieldNames = new Set(["cwd", "filepath", "grantroot", "path", "root", "workspace"]);

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function isSensitiveField(value: string): boolean {
  const normalized = normalizedFieldName(value);
  return sensitiveFieldNames.has(normalized) || [...sensitiveFieldNames].some((name) => normalized.endsWith(name));
}

function isPrivatePath(value: string): boolean {
  return value.startsWith("~") || /^\\\\/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\/(?:Users|home|private|root|tmp|var)(?:\/|$)/i.test(value);
}

function redactInspectableValue(value: JsonValue, fieldName?: string): JsonValue {
  if (fieldName && isSensitiveField(fieldName)) return "[已隐藏]";
  if (typeof value === "string") {
    return fieldName && privatePathFieldNames.has(normalizedFieldName(fieldName)) && isPrivatePath(value) ? "[路径已隐藏]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactInspectableValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactInspectableValue(item, key)]));
  }
  return value;
}

/** Preserve the lossless event in `raw`; only the user-facing inspection view is projected safely. */
export function inspectableRawPayload(raw: JsonValue): JsonValue {
  return redactInspectableValue(raw);
}

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(...values: Array<JsonValue | undefined>): string | undefined {
  for (const value of values) {
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }
  return undefined;
}

function asNestedItem(payload: JsonRecord, params: JsonRecord): JsonRecord {
  return asRecord(params.item) ?? asRecord(payload.item) ?? asRecord(params.content) ?? asRecord(payload.content) ?? payload;
}

function isToolType(value: string | undefined): boolean {
  if (!value) return false;
  return ["commandExecution", "mcpToolCall", "dynamicToolCall", "collabToolCall", "webSearch", "tool"].includes(value);
}

function isCodeType(value: string | undefined): boolean {
  return value === "code" || value === "codeBlock" || value === "source";
}

function readToolStatus(value: JsonValue | undefined, eventType: Event["type"], method?: string): ToolStatus {
  const status = asString(value);
  if (status === "pending" || status === "queued") return "pending";
  if (status === "running" || status === "inProgress" || status === "started") return "running";
  if (status === "completed" || status === "succeeded" || status === "finished") return "completed";
  if (status === "failed" || status === "error" || status === "declined") return "failed";
  if (method?.endsWith("/outputDelta")) return "running";
  if (method === "item/started") return "running";
  if (method === "item/completed") return "completed";
  if (eventType === "item.started") return "running";
  if (eventType === "item.completed") return "completed";
  return "unknown";
}

export function classifyConversationEvent(event: ConversationEvent): ConversationContent {
  const payload = asRecord(event.payload) ?? {};
  const params = asRecord(payload.params) ?? {};
  const method = firstString(payload.method, payload.event);
  const item = asNestedItem(payload, params);
  const itemType = firstString(item.type, params.kind, payload.kind);
  const eventId = event.event_id;

  const messageText = firstString(
    item.text,
    item.delta,
    item.message,
    params.text,
    params.delta,
    params.message,
    payload.text,
    payload.delta,
    payload.message
  );
  const isToolMethod = Boolean(method && (method.includes("commandExecution") || method.includes("mcpTool") || method.includes("dynamicTool") || method.includes("collabTool") || method === "item/tool/call"));
  const isMessage = !isToolMethod && (event.type === "message.delta" || method === "item/agentMessage/delta" || itemType === "agentMessage" || itemType === "userMessage" || itemType === "message");
  if (isMessage && messageText) {
    const roleValue = firstString(item.role, params.role, payload.role);
    const role = roleValue === "user" || roleValue === "system" ? roleValue : "assistant";
    return { eventId, eventType: event.type, kind: "message", role, text: messageText, raw: event.payload };
  }

  const code = firstString(item.code, item.source, params.code, params.source, payload.code, payload.source);
  if (code && (isCodeType(itemType) || item.language !== undefined || params.language !== undefined || payload.language !== undefined)) {
    return {
      eventId,
      eventType: event.type,
      kind: "code",
      code,
      language: firstString(item.language, params.language, payload.language),
      filename: firstString(item.filename, item.path, params.filename, params.path, payload.filename, payload.path),
      raw: event.payload
    };
  }

  const isTool = isToolType(itemType) || isToolMethod;
  if (isTool) {
    return {
      eventId,
      eventType: event.type,
      kind: "tool",
      name: firstString(item.tool, item.name, item.command, params.tool, params.name, payload.tool, payload.name, itemType, method) ?? "未命名工具",
      status: readToolStatus(item.status ?? params.status ?? payload.status, event.type, method),
      summary: firstString(item.summary, item.description, params.summary, isToolMethod ? params.delta : undefined, payload.summary),
      raw: event.payload
    };
  }

  return {
    eventId,
    eventType: event.type,
    kind: "unknown",
    label: itemType ?? method ?? event.type,
    itemType,
    raw: event.payload
  };
}
