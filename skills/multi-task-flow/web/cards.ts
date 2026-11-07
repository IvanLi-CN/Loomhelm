import { renderConversationControl, type ArchiveAction } from "./conversation-control";
import { bindPRStatus } from "./pr-status";
import { attachResourcePopover, closeResourcePopover, type ResourceSource } from "./resource-popover";
import { initialOutput } from "./agent-output";
import { conversationUrl } from "./links";
import { formatDuration } from "./time";
import { groupExecutionVisualState, stateIconName } from "./labels";
import { renderTaskOutput } from "./preview-content";
import type { Group, Task, View } from "./model";
import type { TaskLayout } from "./view-state";

type CardContext = {
  archiveConversation?: ArchiveAction;
  getData: () => View | null;
  getLayout: () => TaskLayout;
  getSelectedTask: () => string | null;
  getSelectedGroup: () => string | null;
  labels: Record<string, string>;
  safeExternal: (url: string | null) => string | null;
  selectTask: (id: string) => void;
  selectGroup: (id: string) => void;
  setKeyboardSelection: () => void;
  updateTaskLayoutControls: () => void;
  bindTaskHover: (target: HTMLElement, task: Task) => void;
  bindGroupHover: (target: HTMLElement, group: Group) => void;
};

export function selectionAriaLabel(kind: "任务" | "交付单元", title: string, state: string, labels: Record<string, string>): string {
  return `选择${kind}：${title}，状态：${labels[state] ?? state}`;
}

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classNames.join(" ");
  node.textContent = value;
  return node;
}

function statusIcon(state: string, ready = false): HTMLElement {
  const normalized = ready && state === "planned" ? "ready" : state;
  const wrapper = text("span", "", "task-row-status-icon");
  wrapper.dataset.state = normalized;
  wrapper.setAttribute("aria-hidden", "true");
  const icon = document.createElement("i");
  icon.dataset.lucide = stateIconName(state, ready);
  wrapper.append(icon);
  return wrapper;
}

function groupVisualState(group: Group): string {
  return groupExecutionVisualState(group.state, group.coordination_execution?.state);
}

export function groupAtomProgress(group: Group): string {
  const atoms = group.atoms ?? [];
  if (!atoms.length) return "未配置原子任务";
  const waiting = group.coordination_execution?.state === "waiting" ? group.coordination_execution.waiting_for_task_ids.length ? " · 等待贡献任务" : " · 等待中" : "";
  const completed = atoms.filter((atom) => atom.status === "completed").length;
  if (atoms.every((atom) => atom.status === "planned")) return `0/${atoms.length} · 待开始${waiting}`;
  const current = atoms.find((atom) => atom.status === "running" || atom.status === "blocked") ?? atoms[completed];
  if (completed === atoms.length) return `${atoms.length}/${atoms.length} · 已完成`;
  if (!current) return `0/${atoms.length} · 待开始`;
  const index = atoms.indexOf(current) + 1;
  const suffix = current.status === "blocked" ? " · 阻塞" : waiting;
  return `${index}/${atoms.length} · ${current.title}${suffix}`;
}

function iconLink(label: string, iconName: string, url: string, external = false): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "resource-action icon-button";
  anchor.href = url;
  anchor.dataset.tooltip = label;
  anchor.setAttribute("aria-label", label);
  if (external) anchor.rel = "noopener noreferrer";
  const icon = document.createElement("i");
  icon.dataset.lucide = iconName;
  anchor.append(icon);
  anchor.addEventListener("click", (event) => event.stopPropagation());
  return anchor;
}

function iconAction(label: string, iconName: string, url: string | null, external = false): HTMLElement {
  if (url) return iconLink(label, iconName, url, external);
  if (label.startsWith("打开") && iconName === "message-circle") label = "示例对话（Mock）";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "resource-action icon-button";
  button.setAttribute("aria-disabled", "true");
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  const icon = document.createElement("i");
  icon.dataset.lucide = iconName;
  button.append(icon);
  return button;
}

function durationValue(start: string | null, end: string | null): HTMLElement {
  const value = text("button", formatDuration(start, end), "task-card-duration");
  value.setAttribute("type", "button");
  value.dataset.durationStart = start ?? "";
  value.dataset.durationEnd = end ?? "";
  return value;
}

function resources(actions: HTMLElement, meta: HTMLElement | null, kind: "task" | "group", id: string, context: CardContext): void {
  const view = context.getData(); if (!view) return;
  const task = view.tasks.find(t => t.id === id), group = view.groups.find(g => g.id === id);
  const thread = kind === "task" ? task?.thread_id ?? null : group?.delivery_unit_kind === "bootstrap" ? view.orchestration.owner_thread_id ?? null : group?.agent_thread_id ?? null;
  const source: ResourceSource = { kind, id, view, thread, output: () => kind === "task" ? task?.latest_agent_output : group?.latest_agent_output, start: kind === "task" ? task?.started_at ?? null : group?.started_at ?? null, end: kind === "task" ? task?.finished_at ?? null : group?.finished_at ?? null };
  const triggers = actions.children;
  if (triggers[0] && !(triggers[0] as HTMLElement).classList.contains("conversation-control")) attachResourcePopover(triggers[0] as HTMLElement, "conversation", source);
  if (triggers[1]) {
    const prTrigger = triggers[1] as HTMLElement;
    attachResourcePopover(prTrigger, "pr", source);
    const prUrl = kind === "task" ? task?.pr?.url : group?.parent_pr?.url;
    if (prUrl) bindPRStatus(prTrigger, kind, id, prUrl);
  }
  const time = meta?.firstElementChild as HTMLElement | null;
  if (time) attachResourcePopover(time, "time", source);
}

function taskCard(task: Task, context: CardContext): HTMLElement {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.taskId = task.id;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-current", String(context.getSelectedTask() === task.id));
  const head = text("div", "", "task-card-head");
  const select = document.createElement("button");
  select.type = "button";
  select.className = "task-card-select";
  select.setAttribute("aria-label", selectionAriaLabel("任务", task.title, task.is_ready && task.state === "planned" ? "ready" : task.state, context.labels));
  select.setAttribute("aria-pressed", String(context.getSelectedTask() === task.id));
  select.append(statusIcon(task.state, task.is_ready), text("span", task.title, "task-card-title"));
  (select.lastElementChild as HTMLElement).dataset.tooltip = task.title;
  select.addEventListener("click", (event) => { event.stopPropagation(); if (event.detail === 0) context.setKeyboardSelection(); context.selectTask(task.id); });
  head.append(select);
  const actions = text("div", "", "task-card-actions");
  const archiveStatus = task.conversation_resource?.status;
  if (archiveStatus && ["closed", "archive_failed", "archive_unknown", "unarchive_failed", "unarchive_unknown"].includes(archiveStatus) || task.conversation_resource?.archive_policy === "manual") {
    actions.append(renderConversationControl(task, context.archiveConversation, context.getData()?.profile_read_only === true));
  } else actions.append(iconAction(task.thread_id ? task.state === "agent_idle" ? "Agent 已停止工作，打开任务对话" : "打开任务对话" : "任务对话尚未创建", "message-circle", task.thread_id ? conversationUrl(task.thread_id) : null));
  const pr = context.safeExternal(task.pr?.url ?? null);
  actions.append(iconAction(pr ? "打开任务 PR" : "任务 PR 尚未创建", "git-pull-request", pr, true));
  head.append(actions);
  const meta = text("div", "", "task-card-meta");
  meta.append(durationValue(task.started_at, task.finished_at));
  resources(actions, meta, "task", task.id, context);
  card.append(head, meta, renderTaskOutput(task.latest_output, task.latest_agent_output ?? initialOutput(task.thread_id), task.id));
  card.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("a, button")) return; context.selectTask(task.id); });
  context.bindTaskHover(card, task);
  return card;
}

function groupCard(group: Group, context: CardContext): HTMLElement {
  const data = context.getData();
  if (!data) throw new Error("Group view data is unavailable");
  const card = document.createElement("article");
  card.className = "task-card group-card";
  card.dataset.groupId = group.id;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-current", String(context.getSelectedGroup() === group.id));
  const head = text("div", "", "task-card-head");
  const select = document.createElement("button");
  select.type = "button";
  select.className = "task-card-select";
  const visualState = groupVisualState(group);
  select.setAttribute("aria-label", selectionAriaLabel("交付单元", group.title, visualState, context.labels));
  select.setAttribute("aria-pressed", String(context.getSelectedGroup() === group.id));
  select.append(statusIcon(visualState), text("span", group.title, "task-card-title"));
  (select.lastElementChild as HTMLElement).dataset.tooltip = group.title;
  select.addEventListener("click", (event) => { event.stopPropagation(); if (event.detail === 0) context.setKeyboardSelection(); context.selectGroup(group.id); });
  head.append(select);
  const actions = text("div", "", "task-card-actions");
  actions.append(iconAction(group.delivery_unit_kind === "bootstrap" ? "主对话负责首个交付单元" : group.agent_thread_id ? "打开交付单元对话" : "交付单元对话尚未创建", "message-circle", (group.delivery_unit_kind === "bootstrap" ? data.orchestration.owner_thread_id : group.agent_thread_id) ? conversationUrl((group.delivery_unit_kind === "bootstrap" ? data.orchestration.owner_thread_id : group.agent_thread_id)!) : null));
  const pr = context.safeExternal(group.parent_pr?.url ?? null);
  actions.append(iconAction(pr ? "打开交付单元 PR" : "交付单元 PR 尚未创建", "git-pull-request", pr, true));
  head.append(actions);
  const groupTasks = data.tasks.filter((task) => task.group_id === group.id);
  const range = { start: group.started_at ?? null, end: group.finished_at ?? null };
  const meta = text("div", "", "task-card-meta");
  meta.append(durationValue(range.start, range.end));
  const summary = text("p", `${group.delivery_unit_kind === "bootstrap" ? "引导交付单元" : "普通交付单元"} · ${groupAtomProgress(group)}`, "task-card-summary", "group-card-summary");
  resources(actions, meta, "group", group.id, context);
  card.append(head, meta, summary);
  card.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("a, button")) return; context.selectGroup(group.id); });
  context.bindGroupHover(card, group);
  return card;
}

export function createCardRenderer(context: CardContext): { renderList: (tasks: Task[]) => void; renderGroups: () => void } {
  const renderList = (tasks: Task[]): void => {
    closeResourcePopover();
    const list = element<HTMLElement>("task-list");
    list.replaceChildren();
    list.className = `task-list task-cards task-layout-${context.getLayout()}`;
    context.updateTaskLayoutControls();
    if (!tasks.length) { list.append(text("div", "暂无匹配任务", "details-empty")); return; }
    if (context.getLayout() === "grid") { for (const task of tasks) list.append(taskCard(task, context)); return; }
    const data = context.getData();
    if (!data) return;
    for (const group of data.groups) {
      const groupTasks = tasks.filter((task) => task.group_id === group.id);
      if (!groupTasks.length) continue;
      const column = text("section", "", "task-column");
      column.dataset.groupId = group.id;
      column.setAttribute("role", "listitem");
      column.setAttribute("aria-current", String(context.getSelectedGroup() === group.id));
      const heading = text("div", "", "task-column-heading");
      const select = document.createElement("button");
      select.type = "button";
      select.className = "task-column-select";
      const visualState = groupVisualState(group);
      select.setAttribute("aria-label", selectionAriaLabel("交付单元", group.title, visualState, context.labels));
      select.setAttribute("aria-pressed", String(context.getSelectedGroup() === group.id));
      select.append(statusIcon(visualState), text("span", group.title, "task-column-title"));
      select.addEventListener("click", (event) => { if (event.detail === 0) context.setKeyboardSelection(); context.selectGroup(group.id); });
      const actions = text("div", "", "task-column-actions");
      actions.append(iconAction(group.delivery_unit_kind === "bootstrap" ? "主对话负责首个交付单元" : group.agent_thread_id ? "打开交付单元对话" : "交付单元对话尚未创建", "message-circle", (group.delivery_unit_kind === "bootstrap" ? data.orchestration.owner_thread_id : group.agent_thread_id) ? conversationUrl((group.delivery_unit_kind === "bootstrap" ? data.orchestration.owner_thread_id : group.agent_thread_id)!) : null));
      const pr = context.safeExternal(group.parent_pr?.url ?? null);
      actions.append(iconAction(pr ? "打开交付单元 PR" : "交付单元 PR 尚未创建", "git-pull-request", pr, true));
      const progress = text("span", groupAtomProgress(group), "task-column-count");
      progress.dataset.tooltip = groupAtomProgress(group);
      const meta = text("div", "", "task-card-meta task-column-time");
      meta.append(durationValue(group.started_at ?? null, group.finished_at ?? null));
      resources(actions, meta, "group", group.id, context);
      heading.append(select, progress, actions, meta);
      const cards = text("div", "", "task-column-list");
      cards.setAttribute("role", "list");
      for (const task of groupTasks) cards.append(taskCard(task, context));
      context.bindGroupHover(heading, group);
      column.append(heading, cards);
      list.append(column);
    }
  };
  const renderGroups = (): void => {
    const data = context.getData();
    if (!data) return;
    closeResourcePopover();
    const list = element<HTMLElement>("group-list");
    list.replaceChildren();
    list.className = "task-list task-cards group-cards";
    for (const group of data.groups) list.append(groupCard(group, context));
  };
  return { renderList, renderGroups };
}
