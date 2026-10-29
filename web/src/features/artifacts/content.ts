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

function asNestedItem(payload: JsonRecord): JsonRecord {
  return asRecord(payload.item) ?? asRecord(payload.content) ?? payload;
}

function isToolType(value: string | undefined): boolean {
  if (!value) return false;
  return ["commandExecution", "mcpToolCall", "dynamicToolCall", "collabToolCall", "webSearch", "tool"].includes(value);
}

function isCodeType(value: string | undefined): boolean {
  return value === "code" || value === "codeBlock" || value === "source";
}

function readToolStatus(value: JsonValue | undefined, eventType: Event["type"]): ToolStatus {
  const status = asString(value);
  if (status === "pending" || status === "queued") return "pending";
  if (status === "running" || status === "inProgress" || status === "started") return "running";
  if (status === "completed" || status === "succeeded" || status === "finished") return "completed";
  if (status === "failed" || status === "error" || status === "declined") return "failed";
  if (eventType === "item.started") return "running";
  if (eventType === "item.completed") return "completed";
  return "unknown";
}

export function classifyConversationEvent(event: ConversationEvent): ConversationContent {
  const payload = asRecord(event.payload) ?? {};
  const item = asNestedItem(payload);
  const itemType = firstString(item.type, payload.kind);
  const eventId = event.event_id;

  const messageText = firstString(
    item.text,
    item.delta,
    item.message,
    payload.text,
    payload.delta,
    payload.message
  );
  const isMessage = event.type === "message.delta" || itemType === "agentMessage" || itemType === "userMessage" || itemType === "message";
  if (isMessage && messageText) {
    const roleValue = firstString(item.role, payload.role);
    const role = roleValue === "user" || roleValue === "system" ? roleValue : "assistant";
    return { eventId, eventType: event.type, kind: "message", role, text: messageText, raw: event.payload };
  }

  const code = firstString(item.code, payload.code, item.source, payload.source);
  if (code && (isCodeType(itemType) || item.language !== undefined || payload.language !== undefined)) {
    return {
      eventId,
      eventType: event.type,
      kind: "code",
      code,
      language: firstString(item.language, payload.language),
      filename: firstString(item.filename, item.path, payload.filename, payload.path),
      raw: event.payload
    };
  }

  const isTool = isToolType(itemType);
  if (isTool) {
    return {
      eventId,
      eventType: event.type,
      kind: "tool",
      name: firstString(item.tool, item.name, item.command, payload.tool, payload.name, itemType) ?? "未命名工具",
      status: readToolStatus(item.status ?? payload.status, event.type),
      summary: firstString(item.summary, item.description, payload.summary),
      raw: event.payload
    };
  }

  return {
    eventId,
    eventType: event.type,
    kind: "unknown",
    label: itemType ?? event.type,
    itemType,
    raw: event.payload
  };
}
