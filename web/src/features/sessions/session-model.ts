import type { Session, SessionPath, SessionState, Task } from "@loomhelm/protocol";

export type ConnectionAvailability = "online" | "offline" | "reconnecting";
export type SessionContextKind = "standalone" | "task-main";

export interface SessionContextModel {
  session: Session;
  conversationTitle: string;
  projectName?: string;
  task?: Pick<Task, "id" | "title" | "goal" | "status">;
}
export function getSessionContextKind(context: SessionContextModel): SessionContextKind {
  return context.task ? "task-main" : "standalone";
}

export function getSessionContextLabel(kind: SessionContextKind): string {
  return kind === "task-main" ? "任务主会话" : "独立会话";
}

export function getSessionStateLabel(state: SessionState): string {
  const labels: Record<SessionState, string> = {
    starting: "正在建立",
    active: "已连接",
    reconciling: "正在对账",
    disconnected: "已断线",
    closed: "已关闭",
    unsupported: "Desktop 接入未证明"
  };
  return labels[state];
}

export function getSessionPathLabel(path: SessionPath): string {
  return path === "existing_active" ? "现有活跃对话" : "新建对话";
}

export function getConnectionLabel(connection: ConnectionAvailability): string {
  const labels: Record<ConnectionAvailability, string> = {
    online: "在线",
    offline: "已断线",
    reconnecting: "连接恢复中"
  };
  return labels[connection];
}

export function canSendControl(connection: ConnectionAvailability, readOnly = false): boolean {
  return connection === "online" && !readOnly;
}
