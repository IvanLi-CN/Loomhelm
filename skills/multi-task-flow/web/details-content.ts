import { initialOutput, paintOutput } from "./agent-output";
import { createProfileEditor, type ProfileEditorContext } from "./profile-editor";
import { conversationUrl } from "./links";
import { formatDuration } from "./time";
import { renderTimestamp } from "./timestamp";
import { renderStatusRow } from "./status-row";
import { renderGroupPreview, renderTaskPreview } from "./preview-content";
import { attachDependencyTooltip, renderDependencyTooltip, type DependencyTooltipItem } from "./dependency-tooltip";
import type { Group, Task, View } from "./model";
import { dependencyLabel, groupExecutionVisualState, stateLabel, taskKindLabel } from "./labels";
import { buildGraphProjection, nodeTitle, type GraphBoundaryDependency, type GraphDependencyPath, type GraphProjectionEdge } from "./graph-projection";

type DetailContentContext = {
  getData: () => View | null;
  labels: Record<string, string>;
  labelTask: (task: Task) => string;
  time: (value: string | null) => string;
  safeExternal: (url: string | null) => string | null;
  profileContext?: () => ProfileEditorContext;
};

function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classNames.join(" ");
  node.textContent = value;
  return node;
}

function clearDetails(): HTMLElement {
  const container = document.getElementById("details-content")!;
  container.replaceChildren();
  container.className = "details-empty";
  const rule = text("span", "", "empty-rule");
  rule.setAttribute("aria-hidden", "true");
  container.append(rule, text("strong", "选择交付单元或任务"), text("span", "查看依赖、运行时间和原生会话链接"));
  return container;
}

function field(container: HTMLElement, name: string, value: HTMLElement | string): void {
  const row = text("div", "", "detail-field");
  row.append(text("div", name, "detail-label"));
  const content = text("div", "", "detail-value");
  content.append(typeof value === "string" ? document.createTextNode(value) : value);
  row.append(content);
  container.append(row);
}

function emptyOutput(): HTMLElement {
  const value = text("span", "", "detail-empty-output");
  value.dataset.emptyLabel = "尚无 Agent 输出";
  value.setAttribute("aria-label", "尚无 Agent 输出");
  return value;
}

function link(label: string, url: string | null): HTMLElement {
  if (url === null) return text("span", "示例对话（Mock）");
  const anchor = document.createElement("a");
  anchor.textContent = label;
  anchor.href = url;
  if (url.startsWith("https://")) anchor.rel = "noopener noreferrer";
  return anchor;
}

function durationValue(start: string | null, end: string | null): HTMLElement {
  const value = text("strong", formatDuration(start, end), "detail-duration");
  value.dataset.durationStart = start ?? "";
  value.dataset.durationEnd = end ?? "";
  return value;
}

function atomList(atoms: Task["atoms"] | Group["atoms"], dependencies: (index: number) => DependencyTooltipItem[]): HTMLElement | string {
  if (!atoms?.length) return "未配置原子任务";
  const list = document.createElement("ol");
  list.className = "atom-list";
  const wrapper = document.createElement("div");
  wrapper.append(list);
  const current = atoms.find((atom) => atom.status === "running" || atom.status === "blocked") ?? atoms.find((atom) => atom.status === "planned");
  for (const [index, atom] of atoms.entries()) {
    const item = document.createElement("li");
    item.dataset.status = atom.status;
    item.tabIndex = 0;
    if (atom.id === current?.id) item.dataset.current = "true";
    item.append(renderStatusRow({ name: atom.title, status: atom.status, completedAt: atom.completed_at }));
    list.append(item);
    wrapper.append(attachDependencyTooltip(item, dependencies(index), `${atom.title}，查看依赖`));
  }
  return wrapper;
}

function pathValue(path: GraphDependencyPath, index: number | null): string {
  const conditions = path.requires.length ? path.requires.map(dependencyLabel).join(" → ") : "未声明条件";
  const rawEdges = path.sourceEdgeIds.length ? path.sourceEdgeIds.join("、") : "无";
  const boundary = path.boundaryNodeIds.length ? `；隐藏边界：${path.boundaryNodeIds.join("、")}` : "";
  const truncated = path.truncated ? "；其余路径已省略" : "";
  return `${index === null ? "" : `路径${index}：`}条件：${conditions}；原始边：${rawEdges}${boundary}${truncated}`;
}

function dependencyValue(projection: ReturnType<typeof buildGraphProjection>, edge: GraphProjectionEdge, neighborId: string, data: View): DependencyTooltipItem {
  const paths = edge.paths.map((path, index) => pathValue(path, edge.paths.length > 1 ? index + 1 : null)).join("；");
  const node = projection.nodes.find((item) => item.id === neighborId);
  const task = node?.nodeKind === "task" ? data.tasks.find((item) => item.id === node.refId) : null;
  const completedAt = task?.finished_at ?? data.actual_milestones.find((item) => item.node_id === node?.sourceNodeId)?.occurred_at;
  return { name: nodeTitle(projection, neighborId), state: paths, status: task?.state ?? (completedAt ? "completed" : node?.state ?? "planned"), completedAt };
}

function boundaryValue(boundary: GraphBoundaryDependency): DependencyTooltipItem {
  const name = boundary.direction === "incoming" ? "计划入口" : "计划出口";
  const paths = boundary.paths.map((path, index) => pathValue(path, boundary.paths.length > 1 ? index + 1 : null)).join("；");
  return { name, state: paths };
}

function dependenciesFor(projection: ReturnType<typeof buildGraphProjection>, nodeId: string | undefined, direction: "incoming" | "outgoing", data: View): DependencyTooltipItem[] {
  if (!nodeId) return [];
  const edges = projection.edges.filter((edge) => direction === "incoming" ? edge.target === nodeId : edge.source === nodeId);
  const boundaries = projection.boundaryDependencies.filter((item) => item.direction === direction && item.nodeId === nodeId);
  const values = [
    ...edges.map((edge) => dependencyValue(projection, edge, direction === "incoming" ? edge.source : edge.target, data)),
    ...boundaries.map(boundaryValue),
  ];
  return values;
}

export function createDetailContent(context: DetailContentContext) {
  const showTask = (task: Task): void => {
    const data = context.getData();
    if (!data) return;
    const container = clearDetails();
    container.replaceChildren();
    container.className = "";
    container.append(text("div", task.title, "detail-title"), text("div", context.labelTask(task), "detail-state"));
    const currentGroup = data.groups.find((group) => group.id === task.group_id)?.title ?? task.group_id;
    const executionGroups = [...new Set(data.actual_intervals.filter((row) => row.task_id === task.id).map((row) => row.group_id))].map((id) => data.groups.find((group) => group.id === id)?.title ?? id);
    field(container, "所属交付单元", currentGroup);
    if (executionGroups.length > 1) field(container, "执行交付单元历史", executionGroups.join("、"));
    field(container, "类型", taskKindLabel(task.kind));
    if (context.profileContext) {
      const profileContext = context.profileContext();
      field(container, "执行配置", createProfileEditor(profileContext, "task", task.id, task.execution_profile ?? null, task.effective_execution_profile ?? data.orchestration.execution_profile ?? null, data.profile_read_only ? "当前视图只读或尚未迁移" : task.profile_freeze_reason ?? (task.thread_id ? "对话已创建" : null), task.execution_profile_source === "recommendation" ? `按任务类型 ${task.kind} 推荐 · ${task.execution_profile_rule ?? "kind-v1"}` : null));
    }
    if (task.disposition && task.disposition !== "active") field(container, "任务处置", task.disposition);
    if (task.is_held && task.hold_reason) field(container, "计划修订暂停", task.hold_reason);
    const node = data.nodes.find((item) => item.kind === "task" && item.ref_id === task.id);
    const projection = buildGraphProjection(data);
    const predecessors = dependenciesFor(projection, node?.id, "incoming", data);
    const successors = dependenciesFor(projection, node?.id, "outgoing", data);
    const taskAtoms = task.atoms ?? task.planned_atoms;
    field(container, "原子任务", atomList(taskAtoms, (index) => {
      const id = taskAtoms![index]!.id;
      return (data.atomic_edges ?? []).filter((edge) => edge.to_atom_id === id).map((edge) => {
        const source = data.tasks.flatMap((item) => item.atoms ?? item.planned_atoms ?? []).find((atom) => atom.id === edge.from_atom_id);
        return { name: source?.title ?? edge.from_atom_id, state: "", status: source?.status ?? "unknown", completedAt: source?.completed_at };
      });
    }));
    field(container, "前驱", renderDependencyTooltip(predecessors, predecessors.length ? `查看 ${predecessors.length} 项依赖` : "无依赖"));
    field(container, "后继", renderDependencyTooltip(successors, successors.length ? `查看 ${successors.length} 项依赖` : "无依赖"));
    const projectedNode = projection.nodes.find((item) => item.sourceNodeId === node?.id);
    const plannedGroup = projectedNode?.plannedGroupId && projectedNode.plannedGroupId !== task.group_id ? data.groups.find((group) => group.id === projectedNode.plannedGroupId)?.title ?? projectedNode.plannedGroupId : null;
    if (plannedGroup) field(container, "计划归属交付单元", plannedGroup);
    if (task.blocker) field(container, "等待原因", task.blocker);
    field(container, "开始时间", renderTimestamp(task.started_at));
    field(container, "完成时间", renderTimestamp(task.finished_at));
    field(container, "持续时间", durationValue(task.started_at, task.finished_at));
    const output = text("div", "", "detail-agent-output");
    output.dataset.outputTaskId = task.id; output.dataset.outputFull = "true";
    paintOutput(output, task.latest_agent_output ?? initialOutput(task.thread_id), true);
    field(container, "最新 Agent 输出", output);
    field(container, "任务对话", task.thread_id ? link("打开对话", conversationUrl(task.thread_id)) : "尚未创建");
    const pr = context.safeExternal(task.pr?.url ?? null);
    if (pr) field(container, "子 PR", link("查看 PR", pr));
    if (task.requirements_path) field(container, "任务要求", link("查看 Markdown", `api/document/task-${encodeURIComponent(task.id)}`));
    for (const follow of data.follow_prs.filter((item) => item.origin_task_id === task.id)) {
      const url = context.safeExternal(follow.pr.url);
      field(container, "Follow PR", url ? link(context.labels[follow.state] ?? follow.state, url) : context.labels[follow.state] ?? follow.state);
    }
  };

  const showGroup = (group: Group): void => {
    const data = context.getData();
    if (!data) return;
    const container = clearDetails();
    container.replaceChildren();
    container.className = "";
    const tasks = data.tasks.filter((task) => task.group_id === group.id);
    const historicalTaskIds = [...new Set(data.actual_intervals.filter((row) => row.group_id === group.id).map((row) => row.task_id))];
    const executionState = groupExecutionVisualState(group.state, group.coordination_execution?.state);
    container.append(text("div", group.title, "detail-title"), text("div", context.labels[executionState] ?? executionState, "detail-state"));
    const groupAtoms = group.atoms ?? group.planned_atoms;
    field(container, "原子任务", atomList(groupAtoms, (index) => {
      const atom = groupAtoms![index]!;
      const previous = groupAtoms![index - 1];
      const items: DependencyTooltipItem[] = previous ? [{ name: previous.title, state: "", status: previous.status, completedAt: previous.completed_at }] : [];
      if (atom.lifecycle_stage) {
        const titles = { workspace_ready: "父分支准备就绪", pr_created: "父 PR 已创建", pr_merged: "父 PR 已合并", closed: "交付单元收口" };
        const status = group.lifecycle?.[atom.lifecycle_stage];
        items.push({ name: titles[atom.lifecycle_stage], state: "", status: status === "passed" ? "completed" : status === "failed" ? "blocked" : "planned", completedAt: group.lifecycle_completed_at?.[atom.lifecycle_stage] });
      }
      return items;
    }));
    if (group.coordination_execution?.state === "waiting") field(container, "协调等待", group.coordination_execution.reason ?? "等待贡献任务");
    if (group.coordination_execution?.state === "blocked") field(container, "协调阻塞", group.coordination_execution.reason ?? "未知原因");
    field(container, "任务数", `${tasks.length} 个任务`);
    if (historicalTaskIds.length) field(container, "历史执行任务", historicalTaskIds.map((id) => data.tasks.find((task) => task.id === id)?.title ?? id).join("、"));
    field(container, "持续时间", durationValue(group.started_at ?? null, group.finished_at ?? null));
    if (context.profileContext) {
      const profileContext = context.profileContext();
      field(container, "执行配置", createProfileEditor(profileContext, "group", group.id, group.execution_profile ?? null, group.effective_execution_profile ?? data.orchestration.execution_profile ?? null, data.profile_read_only ? "当前视图只读或尚未迁移" : group.profile_freeze_reason ?? (group.agent_thread_id ? "对话已创建" : null)));
    }
    field(container, "交付单元对话", group.agent_thread_id ? link("打开对话", conversationUrl(group.agent_thread_id)) : "尚未创建");
    const pr = context.safeExternal(group.parent_pr?.url ?? null);
    field(container, "父 PR", pr ? link("查看 PR", pr) : "尚未创建");
    if (group.requirements_path) field(container, "交付单元要求", link("查看 Markdown", `api/document/group-${encodeURIComponent(group.id)}`));
  };

  const taskPreview = (task: Task): HTMLElement => {
    const data = context.getData();
    const group = data?.groups.find((item) => item.id === task.group_id);
    const executionGroups = [...new Set(data?.actual_intervals.filter((row) => row.task_id === task.id).map((row) => row.group_id) ?? [])].map((id) => data?.groups.find((item) => item.id === id)?.title ?? id);
    return renderTaskPreview({ title: task.title, state: context.labelTask(task), kind: taskKindLabel(task.kind), group: group?.title ?? task.group_id, startedAt: task.started_at ?? "", finishedAt: task.finished_at ?? "", duration: formatDuration(task.started_at, task.finished_at), blocker: task.blocker, ...(executionGroups.length > 1 ? { executionGroups: executionGroups.join("、") } : {}) });
  };

  const groupPreview = (group: Group): HTMLElement => {
    const executionState = groupExecutionVisualState(group.state, group.coordination_execution?.state);
    const atoms = group.atoms ?? group.planned_atoms ?? [];
    const atom = atoms.find((item) => item.status === "running" || item.status === "blocked") ?? atoms.find((item) => item.status === "planned");
    const progress = atoms.length === 0 ? "未配置原子任务" : atoms.every((item) => item.status === "completed") ? `${atoms.length}/${atoms.length} · 已完成` : atom ? `${atoms.indexOf(atom) + 1}/${atoms.length} · ${atom.title}` : `0/${atoms.length} · 待开始`;
    return renderGroupPreview({ title: group.title, state: context.labels[executionState] ?? executionState, atomProgress: progress, duration: formatDuration(group.started_at ?? null, group.finished_at ?? null), conversation: group.delivery_unit_kind === "bootstrap" ? "主对话" : group.agent_thread_id ? "已创建" : "尚未创建", parentPr: context.safeExternal(group.parent_pr?.url ?? null) ? "已关联" : "尚未创建" });
  };
  return { clearDetails, showTask, showGroup, taskPreview, groupPreview };
}
