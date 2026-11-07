import { paintOutput, type AgentOutput } from "./agent-output";
import { renderTimestamp } from "./timestamp";

type PreviewRow = { label: string; value: string };

function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const element = document.createElement(tag);
  element.className = classNames.join(" ");
  element.textContent = value;
  return element;
}

function row({ label, value }: PreviewRow): HTMLElement {
  const element = text("div", "", "hover-preview-row");
  element.append(text("span", label, "hover-preview-label"), label === "开始时间" || label === "完成时间" ? renderTimestamp(value) : text("strong", value, "hover-preview-value"));
  return element;
}

export function renderTaskOutput(value: string | null | undefined, projection?: AgentOutput, taskId?: string): HTMLElement {
  const output = text("p", value?.trim() ?? "", "task-card-output");
  const content = value?.trim();
  if (content) {
    output.title = `最新 Agent 输出：${content}`;
    output.setAttribute("aria-label", `最新 Agent 输出：${content}`);
  } else {
    output.classList.add("is-empty");
    output.dataset.emptyLabel = "尚无 Agent 输出";
    output.setAttribute("aria-label", "尚无 Agent 输出");
  }
  if (projection) paintOutput(output, projection);
  if (taskId) output.dataset.outputTaskId = taskId;
  return output;
}

export type TaskPreviewContent = {
  title: string;
  state: string;
  kind: string;
  group: string;
  startedAt: string;
  finishedAt: string;
  duration: string;
  blocker: string | null;
  executionGroups?: string;
};

export function renderTaskPreview(task: TaskPreviewContent): HTMLElement {
  const content = text("div", "", "hover-preview-content");
  content.append(text("span", "任务预览", "hover-preview-kicker"), text("strong", task.title, "hover-preview-title"), text("span", task.state, "hover-preview-state"));
  content.append(row({ label: "所属交付单元", value: task.group }), row({ label: "类型", value: task.kind }), row({ label: "开始时间", value: task.startedAt }), row({ label: "完成时间", value: task.finishedAt }), row({ label: "持续时间", value: task.duration }));
  if (task.executionGroups) content.append(row({ label: "执行交付单元历史", value: task.executionGroups }));
  if (task.blocker) content.append(row({ label: "等待原因", value: task.blocker }));
  return content;
}

export type GroupPreviewContent = {
  title: string;
  state: string;
  atomProgress: string;
  duration: string;
  conversation: string;
  parentPr: string;
};

export function renderGroupPreview(group: GroupPreviewContent): HTMLElement {
  const content = text("div", "", "hover-preview-content");
  content.append(text("span", "交付单元预览", "hover-preview-kicker"), text("strong", group.title, "hover-preview-title"), text("span", group.state, "hover-preview-state"));
  content.append(row({ label: "原子任务进度", value: group.atomProgress }), row({ label: "持续时间", value: group.duration }), row({ label: "交付单元对话", value: group.conversation }), row({ label: "父 PR", value: group.parentPr }));
  return content;
}
