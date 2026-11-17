import { conversationUrl } from "./links";
import { attachTooltip } from "./tooltip";

export function agentHeader(threadId: string | null, title?: string | null): HTMLElement {
  const header = document.createElement("div");
  header.className = "detail-agent-header";
  const heading = document.createElement("h3");
  heading.className = "detail-pane-heading";
  heading.dataset.agentThreadId = threadId ?? "";
  heading.textContent = `Agent：${threadId ? title?.trim() || "对话标题暂不可用" : "未关联"}`;
  header.append(heading);
  if (!threadId) return header;
  const actions = document.createElement("div");
  actions.className = "detail-agent-actions";
  const open = document.createElement("a");
  const url = conversationUrl(threadId);
  if (url) open.href = url;
  else {
    open.setAttribute("aria-disabled", "true");
    open.tabIndex = -1;
  }
  open.className = "detail-agent-icon-action";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "detail-agent-icon-action";
  for (const [control, label, iconName] of [
    [open, url ? "打开对话" : "示例对话（Mock）", "message-circle"],
    [copy, "复制对话 ID", "copy"],
  ] as const) {
    const icon = document.createElement("i");
    icon.dataset.lucide = iconName;
    icon.setAttribute("aria-hidden", "true");
    control.append(icon);
    actions.append(control, attachTooltip(control, label, label));
  }
  const feedback = document.createElement("span");
  feedback.className = "sr-only";
  feedback.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(threadId);
      feedback.textContent = "对话 ID 已复制";
    } catch {
      feedback.textContent = `复制失败，对话 ID：${threadId}`;
      // Keep the ID selectable when clipboard access is unavailable.
      feedback.classList.remove("sr-only");
    }
  });
  header.append(actions, feedback);
  return header;
}
