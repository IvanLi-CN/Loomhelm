import type { Approval, CommandAck, Event, Run, Session, Task, TaskStatus } from "@loomhelm/protocol";

import type { ConversationMessage } from "./ConversationMessageStream";
import type { ConnectionAvailability, SessionContextModel } from "../sessions/session-model";
import type { SessionReadReason } from "../sessions/session-client-adapter";

export interface ProductionTaskSummary {
  id: string;
  title: string;
  goal: string;
  state?: string;
  status?: TaskStatus;
}

const taskStateToStatus: Record<string, TaskStatus> = {
  待办: "todo",
  进行中: "in_progress",
  阻塞: "blocked",
  完成: "done",
  取消: "cancelled",
  todo: "todo",
  in_progress: "in_progress",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled"
};

export function taskStatusFromState(state: string | undefined): TaskStatus {
  return state && taskStateToStatus[state] ? taskStateToStatus[state] : "todo";
}

export function toSessionTask(task: ProductionTaskSummary | undefined): Pick<Task, "id" | "title" | "goal" | "status"> | undefined {
  if (!task) return undefined;
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status ?? taskStatusFromState(task.state)
  };
}

export function toSessionContextModel(
  session: Session,
  { conversationTitle, projectName, task }: { conversationTitle: string; projectName?: string; task?: ProductionTaskSummary }
): SessionContextModel {
  return {
    conversationTitle,
    projectName,
    session,
    task: toSessionTask(task)
  };
}

export function isSessionAccessFailure(reason: string | undefined): boolean {
  return reason === "forbidden" || reason === "not_found";
}

export function sessionReadFailureMessage(reason: SessionReadReason | undefined, retainedSession = false): string {
  if (reason === "forbidden") return "当前账户无权读取此 Session；当前会话内容已清除，请返回会话列表。";
  if (reason === "not_found") return "此 Session 不存在或已不可访问；当前会话内容已清除，请返回会话列表。";
  if (retainedSession) return "读取 Session 失败；已保留已观察事实，控制命令已暂停，请刷新或人工对账。";
  if (reason === "transport") return "读取 Session 失败，请刷新后再试。";
  return "Session 响应未通过身份核对，当前不展示猜测内容。";
}

function runStatusFromCommandAck(ack: CommandAck): Run["status"] {
  if (ack.state === "unknown") return "unknown";
  if (ack.state === "failed" || ack.state === "rejected") return "failed";
  return "pending";
}

export function runFromCommandAck(session: Session, ack: CommandAck): Run | undefined {
  const runId = typeof ack.run_id === "string" ? ack.run_id.trim() : "";
  if (!runId) return undefined;
  return {
    command_id: ack.command_id,
    created_at: ack.received_at,
    id: runId,
    last_cursor: ack.event_cursor,
    session_id: session.id,
    status: runStatusFromCommandAck(ack)
  };
}

export function runFromIdentity(session: Session, runId: string, createdAt = session.updated_at): Run {
  return {
    created_at: createdAt,
    id: runId,
    session_id: session.id,
    status: "pending"
  };
}

export function runFromRecoveredIdentity(session: Session, runId: string, createdAt = session.updated_at): Run {
  return { ...runFromIdentity(session, runId, createdAt), status: "unknown" };
}

export function runFromHistory(session: Session, run: Run): Run {
  return { ...run, session_id: session.id, status: "unknown" };
}

export function initialRunCommandId(sessionId: string): string {
  return `${sessionId}:initial`;
}

export function applyRunEvent(run: Run, event: Event): Run {
  const next: Run = { ...run, last_cursor: event.cursor };
  if (event.type === "run.started") return { ...next, started_at: event.occurred_at, status: "running" };
  if (event.type === "approval.requested") return { ...next, status: "waiting_approval" };
  if (event.type === "run.completed") return { ...next, finished_at: event.occurred_at, status: "completed" };
  if (event.type === "run.failed") return { ...next, finished_at: event.occurred_at, status: "failed" };
  if (event.type === "run.interrupted") return { ...next, finished_at: event.occurred_at, status: "interrupted" };
  if (event.type === "reconciliation.required") return { ...next, status: "unknown" };
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function eventItem(event: Event): Record<string, unknown> | undefined {
  const payload = asRecord(event.payload);
  const params = asRecord(payload?.params);
  return asRecord(params?.item) ?? asRecord(payload?.item);
}

function eventItemType(event: Event): string | undefined {
  return firstString(eventItem(event), ["type"]);
}

function eventItemID(event: Event): string | undefined {
  const payload = asRecord(event.payload);
  const params = asRecord(payload?.params);
  return firstString(eventItem(event), ["id"]) ?? firstString(params, ["itemId", "item_id"]) ?? firstString(payload, ["itemId", "item_id"]);
}

function eventText(event: Event, payload: Record<string, unknown> | undefined): string {
  const text = firstString(eventItem(event), ["text", "content"])
    ?? firstString(payload, ["content", "text", "delta", "message", "summary", "description"])
    ?? firstString(asRecord(payload?.params), ["content", "text", "delta", "message", "summary", "description"]);
  if (text) return text;
  if (event.type === "message.delta") return "已接收消息事件，但 payload 未提供可显示文本。";
  if (event.type === "approval.requested") return "已接收到新的审批请求。";
  if (event.type === "approval.resolved") return "已接收到审批决定。";
  if (event.type === "reconciliation.required") return "需要对账；当前结果保持 unknown。";
  if (event.type === "reconciliation.completed") return "对账事件已接收。";
  return `已接收事件：${event.type}`;
}

function rawValueKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `number:${String(value)}`;
  return undefined;
}

function eventRequestKey(event: Event): string | undefined {
  const payload = asRecord(event.payload);
  const params = asRecord(payload?.params);
  return rawValueKey(params?.requestId) ?? rawValueKey(payload?.id);
}

function eventResolution(event: Event): "approved" | "denied" | undefined {
  const payload = asRecord(event.payload);
  const params = asRecord(payload?.params);
  const resolution = firstString(params, ["resolution", "decision"]) ?? firstString(payload, ["resolution", "decision"]);
  if (resolution === "accept" || resolution === "approve") return "approved";
  if (resolution === "decline" || resolution === "deny") return "denied";
  return undefined;
}

export interface ApprovalResolutionApplication {
  approvals: readonly Approval[];
  matched: boolean;
  unresolved: boolean;
}

export function applyApprovalResolutionEvents(
  approvals: readonly Approval[],
  observedEvents: readonly Event[],
  resolutionEvents: readonly Event[] = observedEvents.filter((event) => event.type === "approval.resolved")
): ApprovalResolutionApplication {
  const requestedEventByRequestKey = new Map<string, string>();
  const resolutionEventIDs = new Set(resolutionEvents.map((event) => event.event_id));
  const orderedEvents = [...observedEvents].sort((left, right) => left.sequence - right.sequence || left.event_id.localeCompare(right.event_id));
  const byRevision = new Map(approvals.map((approval) => [`${approval.id}:${approval.revision}`, approval]));
  let matched = false;
  let unresolved = false;
  const processedResolutionIDs = new Set<string>();
  orderedEvents.forEach((event) => {
    if (event.type === "approval.requested") {
      const requestKey = eventRequestKey(event);
      if (requestKey) requestedEventByRequestKey.set(requestKey, event.event_id);
      return;
    }
    if (event.type !== "approval.resolved" || !resolutionEventIDs.has(event.event_id)) return;
    processedResolutionIDs.add(event.event_id);
    const status = eventResolution(event);
    const requestKey = eventRequestKey(event);
    const requestedEventID = requestKey ? requestedEventByRequestKey.get(requestKey) : undefined;
    if (!status || !requestedEventID) {
      unresolved = true;
      return;
    }
    const candidates = approvals.filter((approval) => approval.requested_event_id === requestedEventID);
    if (candidates.length !== 1) {
      unresolved = true;
      return;
    }
    const approval = candidates[0];
    byRevision.set(`${approval.id}:${approval.revision}`, { ...approval, status });
    matched = true;
  });
  resolutionEvents.forEach((event) => {
    if (!processedResolutionIDs.has(event.event_id)) unresolved = true;
  });
  return { approvals: [...byRevision.values()], matched, unresolved };
}

function eventDetail(event: Event): string {
  const metadata = JSON.stringify({
    cursor: event.cursor,
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    run_id: event.run_id,
    sequence: event.sequence,
    session_id: event.session_id,
    source: event.source,
    type: event.type
  }, null, 2);
  const payload = JSON.stringify(event.payload, null, 2);
  return `事件元数据\n${metadata}\n\n原始 payload\n${payload}`;
}

const knownItemTypes = new Set(["agentMessage", "artifact", "collabToolCall", "commandExecution", "dynamicToolCall", "fileChange", "mcpToolCall", "plan", "reasoning", "userMessage", "webSearch"]);

function eventHasUnknownContent(event: Event): boolean {
  if (event.type === "unknown" || event.type.startsWith("reconciliation.")) return true;
  if (event.type !== "item.started" && event.type !== "item.completed") return false;
  const payload = asRecord(event.payload);
  const params = asRecord(payload?.params);
  const item = asRecord(params?.item) ?? asRecord(payload?.item);
  const itemType = firstString(item, ["type"]);
  return Boolean(itemType && !knownItemTypes.has(itemType));
}

export function eventToConversationMessage(event: Event): ConversationMessage {
  const isMessage = event.type === "message.delta" || (event.type === "item.completed" && eventItemType(event) === "agentMessage");
  const isUnknown = eventHasUnknownContent(event);
  const isTool = !isMessage && !isUnknown;
  const hasInspectableItem = event.type === "item.started" || event.type === "item.completed";
  const itemID = isMessage ? eventItemID(event) : undefined;
  const deltaParts = event.type === "message.delta" && typeof event.sequence === "number"
    ? [{ content: eventText(event, asRecord(event.payload)), sequence: event.sequence }]
    : undefined;
  return {
    author: isMessage ? "Codex" : isUnknown ? "未识别内容" : "执行事件",
    content: eventText(event, asRecord(event.payload)),
    ...(isUnknown || hasInspectableItem ? { detail: eventDetail(event) } : {}),
    ...(deltaParts ? { deltaParts } : {}),
    eventType: event.type,
    id: `${event.session_id}:${event.run_id ?? "session"}:${itemID ? `item:${itemID}` : event.event_id}`,
    kind: isMessage ? "message" : isUnknown ? "unknown" : "tool",
    occurredAt: event.occurred_at,
    role: isMessage ? "assistant" : "system",
    sequence: event.sequence
  };
}

export function mergeConversationMessages(current: readonly ConversationMessage[], incoming: readonly ConversationMessage[]): readonly ConversationMessage[] {
  const byID = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => {
    const existing = byID.get(message.id);
    if (!existing) {
      byID.set(message.id, message);
      return;
    }
    if (existing.kind !== "message" || message.kind !== "message") {
      byID.set(message.id, message);
      return;
    }
    if (message.eventType === "item.completed") {
      byID.set(message.id, message);
      return;
    }
    if (existing.eventType === "item.completed") return;
    const parts = new Map<number, string>();
    for (const part of existing.deltaParts ?? (existing.sequence === undefined ? [] : [{ content: existing.content, sequence: existing.sequence }])) parts.set(part.sequence, part.content);
    for (const part of message.deltaParts ?? (message.sequence === undefined ? [] : [{ content: message.content, sequence: message.sequence }])) parts.set(part.sequence, part.content);
    const orderedParts = [...parts.entries()].sort(([left], [right]) => left - right).map(([, content]) => content);
    const sequence = existing.sequence === undefined ? message.sequence : message.sequence === undefined ? existing.sequence : Math.max(existing.sequence, message.sequence);
    byID.set(message.id, {
      ...existing,
      content: orderedParts.join(""),
      detail: message.detail ?? existing.detail,
      deltaParts: [...parts.entries()].sort(([left], [right]) => left - right).map(([sequence, content]) => ({ content, sequence })),
      eventType: message.eventType,
      occurredAt: message.occurredAt,
      sequence
    });
  });
  return [...byID.values()].sort((left, right) => {
    if (left.sequence === undefined || right.sequence === undefined) return 0;
    return left.sequence - right.sequence;
  });
}

export interface ApprovalContextFields {
  complete: boolean;
  command: string;
  directory?: string;
  impact?: string;
  rawContext?: string;
  scope?: string;
}

export function approvalContextFromApproval(approval: Approval): ApprovalContextFields {
  const context = asRecord(approval.context);
  const command = firstString(context, ["command", "cmd", "command_line"]);
  const directory = firstString(context, ["directory", "cwd", "workdir", "grantRoot", "path"]);
  const isFileChange = approval.kind === "file_change";
  const explicitScope = firstString(context, ["scope"]);
  const fileChangeScope = firstString(context, ["scope", "grantRoot", "directory"]);
  const scope = explicitScope ?? (isFileChange ? fileChangeScope : undefined);
  const impact = firstString(context, ["impact", "risk", "description", "reason"]);
  const knownKeys = new Set(["command", "cmd", "command_line", "directory", "cwd", "workdir", "grantRoot", "path", "scope", "impact", "risk", "description", "reason"]);
  const hasUnknownFields = context ? Object.keys(context).some((key) => !knownKeys.has(key)) : false;
  const commandContextComplete = !isFileChange && Boolean(command && directory);
  const fileChangeContextComplete = isFileChange && Boolean(fileChangeScope && impact);
  return {
    complete: Boolean(context && (commandContextComplete || fileChangeContextComplete)),
    command: command ?? approval.summary,
    directory,
    impact,
    ...(hasUnknownFields ? { rawContext: JSON.stringify(context, null, 2) } : {}),
    ...(explicitScope ? { scope: explicitScope } : {})
  };
}

export function connectionFromSessionState(state: Session["state"]): ConnectionAvailability {
  if (state === "disconnected" || state === "closed" || state === "unsupported") return "offline";
  if (state === "reconciling" || state === "starting") return "reconnecting";
  return "online";
}
