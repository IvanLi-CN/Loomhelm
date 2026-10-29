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

export function initialRunCommandId(sessionId: string): string {
  return `${sessionId}:initial`;
}

export function applyRunEvent(run: Run, event: Event): Run {
  const next: Run = { ...run, last_cursor: event.cursor };
  if (event.type === "run.started") return { ...next, started_at: event.occurred_at, status: "running" };
  if (event.type === "approval.requested") return { ...next, status: "waiting_approval" };
  if (event.type === "approval.resolved" && run.status === "waiting_approval") return { ...next, status: "running" };
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

function eventText(event: Event, payload: Record<string, unknown> | undefined): string {
  const text = firstString(payload, ["content", "text", "delta", "message", "summary", "description"])
    ?? firstString(asRecord(payload?.params), ["content", "text", "delta", "message", "summary", "description"]);
  if (text) return text;
  if (event.type === "message.delta") return "已接收消息事件，但 payload 未提供可显示文本。";
  if (event.type === "approval.requested") return "已接收到新的审批请求。";
  if (event.type === "approval.resolved") return "已接收到审批决定。";
  if (event.type === "reconciliation.required") return "需要对账；当前结果保持 unknown。";
  if (event.type === "reconciliation.completed") return "对账事件已接收。";
  return `已接收事件：${event.type}`;
}

export function eventToConversationMessage(event: Event): ConversationMessage {
  const isMessage = event.type === "message.delta";
  const isUnknown = event.type === "unknown" || event.type.startsWith("reconciliation.");
  const isTool = !isMessage && !isUnknown;
  return {
    author: isMessage ? "Codex" : isUnknown ? "未识别内容" : "执行事件",
    content: eventText(event, asRecord(event.payload)),
    eventType: event.type,
    id: `${event.session_id}:${event.run_id ?? "session"}:${event.event_id}`,
    kind: isMessage ? "message" : isUnknown ? "unknown" : "tool",
    occurredAt: event.occurred_at,
    role: isMessage ? "assistant" : "system",
    sequence: event.sequence
  };
}

export interface ApprovalContextFields {
  complete: boolean;
  command: string;
  directory?: string;
  impact?: string;
  rawContext?: string;
}

export function approvalContextFromApproval(approval: Approval): ApprovalContextFields {
  const context = asRecord(approval.context);
  const command = firstString(context, ["command", "cmd", "command_line"]);
  const knownKeys = new Set(["command", "cmd", "command_line", "directory", "cwd", "workdir", "impact", "risk", "description"]);
  const hasUnknownFields = context ? Object.keys(context).some((key) => !knownKeys.has(key)) : false;
  return {
    complete: Boolean(context && command),
    command: command ?? approval.summary,
    directory: firstString(context, ["directory", "cwd", "workdir"]),
    impact: firstString(context, ["impact", "risk", "description"]),
    ...(hasUnknownFields ? { rawContext: JSON.stringify(context, null, 2) } : {})
  };
}

export function connectionFromSessionState(state: Session["state"]): ConnectionAvailability {
  if (state === "disconnected" || state === "closed" || state === "unsupported") return "offline";
  if (state === "reconciling" || state === "starting") return "reconnecting";
  return "online";
}
