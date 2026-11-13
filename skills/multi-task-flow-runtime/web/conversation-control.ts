import { attachTooltip } from "./tooltip";
import { conversationUrl } from "./links";
import type { Task } from "./model";

export type ArchiveAction = (taskId: string, action?: "archive" | "unarchive") => void | Promise<void>;
export function canArchiveConversation(task: Task): boolean {
  const output = task.latest_agent_output;
  return task.conversation_archive?.eligible === true && !!task.thread_id &&
    output?.thread_id === task.thread_id && output.agent_state === "idle" && !output.stale;
}
export function hasArchiveAction(task: Task): boolean {
  const status = task.conversation_resource?.status;
  return status === "closed" || !!status?.startsWith("unarchive_") || status === "archive_unknown" || canArchiveConversation(task);
}
export function hasConversationControl(task: Task): boolean {
  return hasArchiveAction(task) || !!task.conversation_resource;
}
export function archivePresentation(task: Task) {
  const resource = task.conversation_resource;
  const status = resource?.status;
  const restoring = status?.startsWith("unarchive_");
  const unknown = status === "archive_unknown" || status === "unarchive_unknown";
  const failed = status === "archive_failed" || status === "unarchive_failed";
  const closed = status === "closed";
  const manual = status === "active" && resource?.archive_policy === "manual";
  return {
    label: closed ? "对话已归档" : restoring ? unknown ? "取消归档结果未知" : "取消归档失败" : unknown ? "对话归档结果未知" : failed ? "对话归档失败" : manual ? "对话已取消归档" : canArchiveConversation(task) ? "可以归档" : "等待归档",
    badge: unknown ? "?" : failed ? "!" : closed ? "✓" : manual ? "↩" : "…",
    tone: unknown || failed ? "warning" : closed ? "archived" : "active",
    description: resource?.error ?? (closed ? "任务已结束，对话已成功归档。可取消归档以恢复到对话列表。" : manual ? "对话已恢复到对话列表；保留手动状态，不会再次自动归档。" : "对话归档尚未完成。"),
    action: closed || restoring ? "unarchive" as const : "archive" as const,
    actionLabel: closed ? "取消归档" : restoring ? unknown ? "取消归档对账" : "重试取消归档" : unknown ? "归档对账" : failed ? "重试归档" : "归档",
    actionIcon: closed || restoring ? "archive-restore" : unknown ? "refresh-cw" : "archive",
  };
}
export function renderArchiveAction(task: Task, execute?: ArchiveAction, readOnly = false): HTMLButtonElement {
  const state = archivePresentation(task);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "detail-action archive-action";
  const icon = document.createElement("i"); icon.dataset.lucide = state.actionIcon; icon.setAttribute("aria-hidden", "true");
  button.append(icon, document.createTextNode(state.actionLabel));
  button.disabled = !execute || readOnly || !hasArchiveAction(task);
  button.addEventListener("click", async event => {
    event.stopPropagation();
    if (!execute || readOnly || !hasArchiveAction(task)) return;
    button.disabled = true;
    try { await execute?.(task.id, state.action); }
    finally { button.disabled = !execute || readOnly || !hasArchiveAction(task); }
  });
  return button;
}
export function renderConversationControl(task: Task, execute?: ArchiveAction, readOnly = false): HTMLElement {
  const state = archivePresentation(task);
  const wrapper = document.createElement("span"); wrapper.className = "conversation-control";
  const trigger = document.createElement("button"); trigger.type = "button";
  trigger.className = `resource-action icon-button conversation-status conversation-status-${state.tone}`;
  const bubble = document.createElement("i"); bubble.dataset.lucide = "message-circle"; bubble.setAttribute("aria-hidden", "true");
  const badge = document.createElement("span"); badge.className = "conversation-status-badge"; badge.textContent = state.badge; badge.setAttribute("aria-hidden", "true");
  trigger.append(bubble, badge);
  const content = document.createElement("div"); content.className = "conversation-popover";
  const heading = document.createElement("strong"); heading.textContent = state.label;
  const description = document.createElement("p"); description.textContent = state.description;
  content.append(heading, description);
  if (task.conversation_resource?.last_attempt_at) {
    const attempt = document.createElement("p"); attempt.textContent = `最近尝试：${new Date(task.conversation_resource.last_attempt_at).toLocaleString("zh-CN")}`; content.append(attempt);
  }
  const actions = document.createElement("div"); actions.className = "conversation-popover-actions";
  if (hasArchiveAction(task)) actions.append(renderArchiveAction(task, execute, readOnly));
  if (task.thread_id) {
    const open = document.createElement("a"); open.href = conversationUrl(task.thread_id); open.textContent = "打开对话"; actions.append(open);
  }
  content.append(actions);
  const popover = attachTooltip(trigger, content, state.label, { interactive: true });
  wrapper.append(trigger, popover);
  return wrapper;
}
