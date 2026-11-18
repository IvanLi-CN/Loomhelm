import { ChevronRight, createElement, GitPullRequest } from "lucide";
import { inspectAtomicGraph } from "../lib/atomic-graph-order";
import { initialOutput, paintOutput } from "./agent-output";
import {
  type ArchiveAction,
  archivePresentation,
  hasArchiveAction,
  renderArchiveAction,
} from "./conversation-control";
import { agentHeader } from "./detail-agent";
import { atomHeading } from "./detail-atom-heading";
import { atomRelations } from "./detail-atom-relations";
import { renderDetailStatus } from "./detail-status";
import { deliveryPolicyChip, executionPolicyChip } from "./execution-policy-chip";
import { buildGraphProjection } from "./graph-projection";
import { groupExecutionVisualState, taskKindLabel } from "./labels";
import { conversationUrl } from "./links";
import type { AtomicTask, Group, Task, View } from "./model";
import { renderGroupPreview, renderTaskPreview } from "./preview-content";
import { createProfileEditor, type ProfileEditorContext } from "./profile-editor";
import { renderStatusRow } from "./status-row";
import { taskDispatchStatus } from "./task-dispatch-status";
import { formatDuration, fullLocalTime } from "./time";
import { renderTimestamp } from "./timestamp";
import { attachTooltip } from "./tooltip";

type DetailContentContext = {
  getData: () => View | null;
  labels: Record<string, string>;
  labelTask: (task: Task) => string;
  time: (value: string | null) => string;
  safeExternal: (url: string | null) => string | null;
  profileContext?: () => ProfileEditorContext;
  archiveConversation?: ArchiveAction;
};

function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classNames.join(" ");
  node.textContent = value;
  return node;
}

function clearDetails(): HTMLElement {
  const container = document.getElementById("details-content")!;
  document.getElementById("details-summary")?.replaceChildren();
  delete container.dataset.selection;
  delete container.dataset.detailKind;
  container.replaceChildren();
  container.scrollTop = 0;
  container.className = "details-empty";
  const rule = text("span", "", "empty-rule");
  rule.setAttribute("aria-hidden", "true");
  container.append(
    rule,
    text("strong", "选择交付单元或任务"),
    text("span", "查看依赖、运行时间和原生会话链接"),
  );
  return container;
}

function field(
  container: HTMLElement,
  name: string,
  value: HTMLElement | string | null | undefined,
): void {
  const row = text("div", "", "detail-field");
  row.append(text("div", name, "detail-label"));
  const content = text("div", "", "detail-value");
  const emptyLabels: Record<string, string> = {
    所属交付单元: "未关联",
    用途: "未配置",
    产出要求: "未配置",
    "执行 Agent": "未声明",
    对话策略: "未声明",
    交付策略: "未声明",
  };
  const hasValue =
    typeof value === "string"
      ? Boolean(value.trim())
      : value &&
        (value.textContent?.trim() ||
          value.matches("[data-empty-label]") ||
          value.querySelector("button, input, select, svg, [data-empty-label]"));
  content.append(
    hasValue && value != null
      ? typeof value === "string"
        ? document.createTextNode(value)
        : value
      : text("span", emptyLabels[name] ?? "未提供", "detail-placeholder"),
  );
  row.append(content);
  container.append(row);
}

function groupFactRow(container: HTMLElement, label: string): HTMLElement {
  const row = text("section", "", "detail-fact-row");
  row.setAttribute("aria-label", label);
  const items = text("div", "", "detail-fact-items");
  row.append(text("span", label, "detail-fact-category"), items);
  container.append(row);
  return items;
}

function requirementsValue(path: string | null, kind: "task" | "group", id: string): HTMLElement {
  if (path) return link("查看 Markdown", `api/document/${kind}-${encodeURIComponent(id)}`);
  return text(
    "span",
    kind === "task" ? "未配置任务文档" : "未配置交付单元文档",
    "detail-placeholder",
  );
}

function _emptyOutput(): HTMLElement {
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

function atomList(
  atoms: Task["atoms"] | Group["atoms"],
  focusedAtomId?: string | null,
  parent?: { kind: "task" | "group"; id: string },
  diagnostics?: (id: string) => string[],
): HTMLElement | string {
  if (!atoms?.length) return "未配置原子任务";
  const list = document.createElement("ol");
  list.className = "atom-list";
  const wrapper = document.createElement("div");
  wrapper.append(list);
  for (const atom of atoms) {
    const item = document.createElement("li");
    item.dataset.status = atom.status;
    if (parent) {
      item.dataset.contextKind = "atom";
      item.dataset.contextId = atom.id;
      item.dataset.contextParentKind = parent.kind;
      item.dataset.contextParentId = parent.id;
    }
    item.tabIndex = 0;
    if (parent) {
      const emit = (action: "hover" | "leave" | "click") =>
        item.dispatchEvent(
          new CustomEvent("loomhelm:atomic-details", {
            bubbles: true,
            detail: { atomId: atom.id, parentKind: parent.kind, parentId: parent.id, action },
          }),
        );
      item.addEventListener("mouseenter", () => emit("hover"));
      item.addEventListener("mouseleave", () => emit("leave"));
      item.addEventListener("focus", () => emit("hover"));
      item.addEventListener("blur", () => emit("leave"));
      item.addEventListener("click", () => emit("click"));
    }
    if (atom.id === focusedAtomId) {
      item.dataset.focused = "true";
      item.setAttribute("aria-current", "true");
    }
    const issues = diagnostics?.(atom.id) ?? [];
    if (issues.length) {
      item.dataset.diagnostic = "true";
      item.title = issues.join("；");
      item.append(text("span", `⚠ ${issues.join("、")}`, "atom-warning"));
    }
    item.append(
      renderStatusRow({ name: atom.title, status: atom.status, completedAt: atom.completed_at }),
    );
    list.append(item);
  }
  return wrapper;
}

function atomicStatus(state: string): AtomicTask["status"] {
  return state === "completed" || state === "running" || state === "blocked" ? state : "planned";
}

function lifecycleDisplayRank(
  atom: { lifecycle_stage?: string | null } | undefined,
  kind: string | undefined,
): number | null {
  if (kind === "milestone") return 35;
  if (!atom) return null;
  if (!atom.lifecycle_stage) return 30;
  return (
    { workspace_ready: 10, pr_created: 20, pr_merged: 40, closed: 50 }[atom.lifecycle_stage] ?? null
  );
}

function scopedAtomicAtoms(
  data: View,
  scope: { kind: "task" | "group"; id: string },
): { atoms: AtomicTask[]; diagnostics: Map<string, string[]> } {
  const legacy =
    scope.kind === "task"
      ? (data.tasks.find((item) => item.id === scope.id)?.atoms ??
        data.tasks.find((item) => item.id === scope.id)?.planned_atoms ??
        [])
      : (data.groups.find((item) => item.id === scope.id)?.atoms ??
        data.groups.find((item) => item.id === scope.id)?.planned_atoms ??
        []);
  const nodes = (data.atomic_nodes ?? []).filter((node) => {
    const nodeScope = node.scope;
    if (
      !nodeScope ||
      nodeScope.delivery_unit_id !==
        (scope.kind === "group"
          ? scope.id
          : data.tasks.find((item) => item.id === scope.id)?.group_id)
    )
      return false;
    return scope.kind === "group"
      ? nodeScope.kind === "delivery_unit"
      : nodeScope.kind === "task" && nodeScope.task_id === scope.id;
  });
  const legacyById = new Map(legacy.map((atom) => [atom.id, atom]));
  const canonicalIds = new Set((data.atomic_nodes ?? []).map((node) => node.id));
  const legacyNodes = [
    ...data.tasks.flatMap((item) => item.atoms ?? item.planned_atoms ?? []),
    ...data.groups.flatMap((item) => item.atoms ?? item.planned_atoms ?? []),
  ]
    .filter((atom) => !canonicalIds.has(atom.id))
    .map((atom) => ({ kind: "work", id: atom.id, title: atom.title, state: atom.status }));
  const sourceNodes = [...(data.atomic_nodes ?? []), ...legacyNodes];
  const nodeById = new Map(sourceNodes.map((node) => [node.id, node]));
  const edges = (
    data.canonical_atomic_edges ??
    data.atomic_edges?.map((edge) => ({
      id: edge.id,
      from_node_id: edge.from_atom_id,
      to_node_id: edge.to_atom_id,
    })) ??
    []
  ).filter((edge) => nodeById.has(edge.from_node_id) && nodeById.has(edge.to_node_id));
  const inspection = inspectAtomicGraph(sourceNodes, edges);
  const scopedIds = new Set(
    nodes
      .map((node) => node.id)
      .concat(
        legacyNodes
          .filter((node) => legacy.some((atom) => atom.id === node.id))
          .map((node) => node.id),
      ),
  );
  const globalIndex = new Map(inspection.order.map((id, index) => [id, index]));
  const orderedIds = [
    ...inspection.order.filter((id) => scopedIds.has(id)),
    ...[...scopedIds]
      .filter((id) => !inspection.order.includes(id))
      .sort((left, right) => left.localeCompare(right)),
  ];
  if (scope.kind === "group") {
    orderedIds.sort((left, right) => {
      const leftRank = lifecycleDisplayRank(legacyById.get(left), nodeById.get(left)?.kind);
      const rightRank = lifecycleDisplayRank(legacyById.get(right), nodeById.get(right)?.kind);
      if (leftRank !== null && rightRank !== null && leftRank !== rightRank)
        return leftRank - rightRank;
      return (
        (globalIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (globalIndex.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
      );
    });
  }
  const completedAt = new Map(
    (data.actual_milestones ?? []).map((item) => [item.node_id, item.occurred_at]),
  );
  const atoms = orderedIds.map((id) => {
    const node = nodeById.get(id)!;
    const old = legacyById.get(id);
    return {
      ...old,
      id,
      title: node.title,
      status: atomicStatus(node.state ?? old?.status ?? "planned"),
      completed_at: completedAt.get(id) ?? old?.completed_at ?? null,
    };
  });
  const diagnostics = new Map<string, string[]>();
  for (const [id, codes] of inspection.nodeDiagnostics)
    diagnostics.set(
      id,
      codes.map(
        (code) => inspection.diagnostics.find((item) => item.code === code)?.message ?? code,
      ),
    );
  return { atoms, diagnostics };
}

export function createDetailContent(context: DetailContentContext) {
  const expandedAtomRelations = new Map<string, boolean>();
  const expandedAgentDiagnostics = new Map<string, boolean>();
  function arrangeInspector(
    container: HTMLElement,
    facts: HTMLElement,
    atoms: AtomicTask[],
    focusedAtomId: string | null,
    owner: Task | Group,
  ) {
    const data = context.getData()!;
    const panel = (name: string, title: string) => {
      const element = text("section", "", `detail-pane detail-pane-${name}`);
      element.setAttribute("aria-label", title);
      element.append(text("h3", title, "detail-pane-heading"));
      return element;
    };
    const info = panel("owner", "thread_id" in owner ? "任务信息" : "交付单元信息");
    const list = panel("atoms", "原子任务列表");
    const progress = text(
      "span",
      `${atoms.filter((atom) => atom.status === "completed").length}/${atoms.length}`,
      "detail-atom-progress",
    );
    progress.setAttribute(
      "aria-label",
      `已完成 ${atoms.filter((atom) => atom.status === "completed").length}，共 ${atoms.length} 个原子任务`,
    );
    list.querySelector(".detail-pane-heading")!.append(progress);
    const atomInfo = panel("atom", "原子任务信息");
    info.querySelector("h3")?.remove();
    const agent = panel("agent", "Agent");
    const atomField = [...container.children].find((element) => element !== facts) as HTMLElement;
    if (atomField) {
      atomField.querySelector(":scope > .detail-label")?.remove();
      list.append(atomField);
    }
    const outputField = facts.querySelector(".detail-agent-output")?.closest(".detail-field");
    const conversation = facts.querySelector(".detail-conversation");
    conversation?.closest(".detail-field")?.remove();
    const conversationField = [...facts.querySelectorAll(".detail-field")].find(
      (element) => element.querySelector(":scope > .detail-label")?.textContent === "交付单元对话",
    );
    conversationField?.remove();
    for (const element of facts.querySelectorAll(".detail-field")) {
      const label = element.querySelector(":scope > .detail-label")?.textContent;
      if (["交付协调者", "交付 Agent", "开始时间", "持续时间", "调度状态"].includes(label ?? ""))
        element.remove();
    }
    const timing = text("div", "", "detail-summary-timing");
    const start = owner.started_at;
    timing.append(
      text(
        "span",
        `开始 ${start && Number.isFinite(Date.parse(start)) ? fullLocalTime(start) : "未知"}`,
      ),
    );
    const duration = text("span", "持续 ");
    duration.append(durationValue(start ?? null, owner.finished_at ?? null));
    timing.append(duration);
    document.getElementById("details-summary")?.append(timing);
    const stateBadge = document.querySelector<HTMLElement>("#details-summary .detail-state");
    const isTask = "thread_id" in owner;
    const runtimeOwner = isTask ? data.groups.find((group) => group.id === owner.group_id) : owner;
    stateBadge?.replaceWith(
      renderDetailStatus({
        kind: isTask ? "task" : "group",
        state: owner.state,
        visualState: isTask
          ? owner.state
          : groupExecutionVisualState(owner.state, owner.coordination_execution?.state),
        label: stateBadge.textContent ?? "未知",
        runtime: runtimeOwner?.runtime_readiness,
        dispatch: owner.dispatch_readiness,
      }),
    );
    const prUrl = context.safeExternal((isTask ? owner.pr?.url : owner.parent_pr?.url) ?? null);
    const prKind = isTask ? "子 PR" : "父 PR";
    const prAction = document.createElement("a");
    prAction.className = "detail-pr-action";
    if (prUrl) {
      prAction.href = prUrl;
      prAction.target = "_blank";
      prAction.rel = "noopener noreferrer";
    } else {
      prAction.setAttribute("aria-disabled", "true");
      prAction.tabIndex = -1;
    }
    prAction.append(createElement(GitPullRequest, { "aria-hidden": "true" }));
    const prLabel = prUrl ? `查看${prKind}` : `${prKind}尚未创建`;
    const prWrapper = text("span", "", "detail-pr-link");
    prWrapper.append(prAction, attachTooltip(prAction, prLabel, prLabel));
    document.querySelector("#details-summary .detail-title")?.after(prWrapper);
    const bootstrap = !isTask && owner.delivery_unit_kind === "bootstrap";
    const threadId =
      "thread_id" in owner
        ? owner.thread_id
        : bootstrap
          ? (data.orchestration.owner_thread_id ?? null)
          : owner.agent_thread_id;
    agent
      .querySelector(".detail-pane-heading")!
      .replaceWith(
        agentHeader(
          threadId,
          owner.latest_agent_output?.thread_title || (bootstrap ? "Main Agent" : null),
        ),
      );
    const agentFacts = text("div", "", "detail-agent-facts");
    const diagnostics = document.createElement("details");
    diagnostics.className = "detail-agent-diagnostics";
    const diagnosticKey = `${isTask ? "task" : "group"}:${owner.id}`;
    diagnostics.open = expandedAgentDiagnostics.get(diagnosticKey) ?? false;
    const diagnosticSummary = document.createElement("summary");
    diagnosticSummary.append(
      createElement(ChevronRight, { "aria-hidden": "true" }),
      document.createTextNode("运行诊断"),
    );
    diagnostics.append(diagnosticSummary);
    diagnostics.addEventListener("toggle", () =>
      expandedAgentDiagnostics.set(diagnosticKey, diagnostics.open),
    );
    for (const element of [...facts.querySelectorAll(".detail-field")]) {
      const label = element.querySelector(":scope > .detail-label")?.textContent;
      if (["运行时观察时间", "观察 Turn"].includes(label ?? "")) {
        diagnostics.append(element);
      } else if (
        ["执行配置", "执行 Agent", "对话策略", "交付策略", "运行时提示"].includes(label ?? "")
      ) {
        if (label === "运行时提示") element.classList.add("detail-agent-runtime-note");
        if (["执行 Agent", "对话策略", "交付策略"].includes(label ?? "")) {
          element.classList.add("detail-agent-chip");
        }
        agentFacts.append(element);
      }
    }
    for (const row of facts.querySelectorAll(".detail-fact-row")) {
      if (!row.querySelector(".detail-fact-items")?.childElementCount) row.remove();
    }
    const runtimeNote = agentFacts.querySelector(".detail-agent-runtime-note");
    if (runtimeNote) agentFacts.append(runtimeNote);
    if (runtimeNote && diagnostics.childElementCount > 1) {
      diagnosticSummary.replaceChildren(
        ...runtimeNote.childNodes,
        createElement(ChevronRight, { "aria-hidden": "true" }),
      );
      diagnosticSummary.setAttribute("aria-label", "运行时提示与诊断详情");
      runtimeNote.replaceWith(diagnostics);
    }
    if (agentFacts.childElementCount) agent.append(agentFacts);
    if (!runtimeNote && diagnostics.childElementCount > 1) agent.append(diagnostics);
    if (conversation) {
      conversation.querySelector("a")?.remove();
      if (conversation.querySelector("button, .detail-conversation-notice"))
        agent.append(conversation);
    }
    if (outputField) {
      outputField.querySelector(":scope > .detail-label")?.remove();
      agent.append(outputField);
    }
    info.append(facts);
    const leftColumn = text("div", "", "detail-column detail-column-left");
    const rightColumn = text("div", "", "detail-column detail-column-right");
    leftColumn.append(info, list);
    rightColumn.append(atomInfo, agent);
    container.classList.add("detail-inspector");
    container.replaceChildren(leftColumn, rightColumn);
    const selectAtom = (id: string | null) => {
      const atom = atoms.find((item) => item.id === id);
      container.dataset.atomSelection = atom?.id ?? "";
      atomInfo.replaceChildren();
      for (const item of list.querySelectorAll<HTMLElement>(".atom-list li")) {
        const selected = item.dataset.contextId === atom?.id;
        item.dataset.focused = String(selected);
        if (selected) item.setAttribute("aria-current", "true");
        else item.removeAttribute("aria-current");
      }
      if (!atom) {
        atomInfo.append(text("p", "未配置原子任务", "detail-placeholder"));
        return;
      }
      atomInfo.append(atomHeading(atom));
      field(atomInfo, "原子任务 ID", atom.id);
      field(atomInfo, "用途", atom.purpose || "未配置");
      field(atomInfo, "产出要求", atom.output || "未配置");
      field(
        atomInfo,
        "关系",
        atomRelations(data, atom, {
          expanded: expandedAtomRelations.get(atom.id),
          onToggle: (expanded) => expandedAtomRelations.set(atom.id, expanded),
        }),
      );
      atomInfo.lastElementChild?.classList.add("detail-atom-relations");
    };
    for (const item of list.querySelectorAll<HTMLElement>(".atom-list li")) {
      item.setAttribute("role", "button");
      item.addEventListener("click", () => selectAtom(item.dataset.contextId ?? null));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          item.click();
        }
      });
    }
    const newFocus = focusedAtomId && focusedAtomId !== container.dataset.atomFocusRequest;
    const selected = newFocus ? focusedAtomId : container.dataset.atomSelection;
    container.dataset.atomFocusRequest = focusedAtomId ?? "";
    selectAtom(atoms.some((atom) => atom.id === selected) ? selected! : (atoms[0]?.id ?? null));
  }
  function begin(kind: "task" | "group", id: string, title: string, state: string) {
    const container = document.getElementById("details-content")!;
    const selection = `${kind}:${id}`;
    const sameSelection = container.dataset.selection === selection;
    if (!sameSelection) {
      delete container.dataset.atomSelection;
      delete container.dataset.atomFocusRequest;
    }
    const top = sameSelection ? container.scrollTop : 0;
    container.dataset.selection = selection;
    container.dataset.detailKind = kind;
    container.replaceChildren();
    container.className = "";
    const summary = document.getElementById("details-summary")!;
    summary.replaceChildren(text("div", state, "detail-state"), text("div", title, "detail-title"));
    return {
      container,
      restore: () => {
        container.scrollTop = top;
      },
    };
  }
  const showTask = (task: Task, focusedAtomId: string | null = null): void => {
    const data = context.getData();
    if (!data) return;
    const { container, restore } = begin("task", task.id, task.title, context.labelTask(task));
    const facts = text("div", "", "detail-group-facts");
    const currentGroup =
      data.groups.find((group) => group.id === task.group_id)?.title ?? task.group_id;
    const executionGroups = [
      ...new Set(
        data.actual_intervals.filter((row) => row.task_id === task.id).map((row) => row.group_id),
      ),
    ].map((id) => data.groups.find((group) => group.id === id)?.title ?? id);
    field(facts, "所属交付单元", currentGroup);
    if (executionGroups.length > 1) field(facts, "执行交付单元历史", executionGroups.join("、"));
    field(facts, "类型", taskKindLabel(task.kind));
    if (context.profileContext) {
      const profileContext = context.profileContext();
      field(
        facts,
        "执行配置",
        createProfileEditor(
          profileContext,
          "task",
          task.id,
          task.execution_profile ?? null,
          task.effective_execution_profile ?? data.orchestration.execution_profile ?? null,
          data.profile_read_only
            ? "当前视图只读或尚未迁移"
            : (task.profile_freeze_reason ?? (task.thread_id ? "对话已创建" : null)),
          task.execution_profile_source === "recommendation"
            ? `按任务类型 ${task.kind} 推荐 · ${task.execution_profile_rule ?? "kind-v1"}`
            : null,
          true,
        ),
      );
    }
    if (task.disposition && task.disposition !== "active")
      field(facts, "任务处置", task.disposition);
    if (task.is_held && task.hold_reason) field(facts, "计划修订暂停", task.hold_reason);
    const node = data.nodes.find((item) => item.kind === "task" && item.ref_id === task.id);
    const projection =
      Array.isArray(data.nodes) && Array.isArray(data.edges) ? buildGraphProjection(data) : null;
    const scoped = scopedAtomicAtoms(data, { kind: "task", id: task.id });
    const taskAtoms = scoped.atoms.length ? scoped.atoms : (task.atoms ?? task.planned_atoms);
    field(
      container,
      "原子任务",
      atomList(
        taskAtoms,
        focusedAtomId,
        { kind: "task", id: task.id },
        (id) => scoped.diagnostics.get(id) ?? [],
      ),
    );
    container.append(facts);
    const projectedNode = projection?.nodes.find((item) => item.sourceNodeId === node?.id);
    const plannedGroup =
      projectedNode?.plannedGroupId && projectedNode.plannedGroupId !== task.group_id
        ? (data.groups.find((group) => group.id === projectedNode.plannedGroupId)?.title ??
          projectedNode.plannedGroupId)
        : null;
    if (plannedGroup) field(facts, "计划归属交付单元", plannedGroup);
    if (task.blocker) field(facts, "等待原因", task.blocker);
    field(facts, "开始时间", renderTimestamp(task.started_at));
    field(
      facts,
      "完成时间",
      renderTimestamp(task.finished_at, task.state === "closed" ? "未知" : "尚未完成"),
    );
    field(facts, "持续时间", durationValue(task.started_at, task.finished_at));
    const output = text("div", "", "detail-agent-output");
    output.dataset.outputTaskId = task.id;
    output.dataset.outputFull = "true";
    paintOutput(output, task.latest_agent_output ?? initialOutput(task.thread_id), true);
    if (task.state === "agent_idle")
      field(facts, "运行时提示", "Agent 当前没有活跃 turn，可能需要人工恢复");
    if (task.state === "agent_idle") {
      const observed = task.latest_agent_output;
      if (observed?.observed_at)
        field(facts, "运行时观察时间", renderTimestamp(observed.observed_at));
      if (observed?.runtime_turn_id) field(facts, "观察 Turn", observed.runtime_turn_id);
    }
    const conversation = text("div", "", "detail-conversation");
    const conversationActions = text("div", "", "detail-conversation-actions");
    conversationActions.append(
      task.thread_id ? link("打开对话", conversationUrl(task.thread_id)) : text("span", "尚未创建"),
    );
    if (hasArchiveAction(task))
      conversationActions.append(
        renderArchiveAction(task, context.archiveConversation, data.profile_read_only === true),
      );
    conversation.append(conversationActions);
    const archive = task.conversation_resource;
    if (
      archive?.error ||
      archive?.status.endsWith("failed") ||
      archive?.status.endsWith("unknown")
    ) {
      const presentation = archivePresentation(task);
      conversation.append(
        text(
          "p",
          `${presentation.label}：${presentation.description}`,
          "detail-conversation-notice",
        ),
      );
    }
    field(facts, "任务对话", conversation);
    field(facts, "执行 Agent", executionPolicyChip(task.execution_owner, task.conversation_policy));
    field(facts, "交付策略", deliveryPolicyChip(task.delivery_policy));
    field(
      facts,
      "调度状态",
      taskDispatchStatus(task) ??
        (task.dispatch_readiness === "blocked"
          ? `不可调度：${task.dispatch_diagnostics?.map((item) => item.message).join("；") || "未知原因"}`
          : task.dispatch_readiness === "ready"
            ? "可调度"
            : "未知"),
    );
    field(facts, "任务要求", requirementsValue(task.requirements_path, "task", task.id));
    for (const follow of data.follow_prs.filter((item) => item.origin_task_id === task.id)) {
      const url = context.safeExternal(follow.pr.url);
      field(
        facts,
        "Follow PR",
        url
          ? link(context.labels[follow.state] ?? follow.state, url)
          : (context.labels[follow.state] ?? follow.state),
      );
    }
    field(facts, "Agent 输出", output);
    arrangeInspector(container, facts, taskAtoms ?? [], focusedAtomId, task);
    restore();
  };

  const showGroup = (group: Group, focusedAtomId: string | null = null): void => {
    const data = context.getData();
    if (!data) return;
    const executionState = groupExecutionVisualState(
      group.state,
      group.coordination_execution?.state,
    );
    const { container, restore } = begin(
      "group",
      group.id,
      group.title,
      context.labels[executionState] ?? executionState,
    );
    const scoped = scopedAtomicAtoms(data, { kind: "group", id: group.id });
    const groupAtoms = scoped.atoms.length
      ? scoped.atoms
      : (group.atoms ?? group.planned_atoms ?? []);
    field(
      container,
      "原子任务",
      atomList(
        groupAtoms,
        focusedAtomId,
        { kind: "group", id: group.id },
        (id) => scoped.diagnostics.get(id) ?? [],
      ),
    );
    const facts = text("div", "", "detail-group-facts");
    container.append(facts);
    if (group.coordination_execution?.state === "waiting")
      field(facts, "协调等待", group.coordination_execution.reason ?? "等待贡献任务");
    if (group.coordination_execution?.state === "blocked")
      field(facts, "协调阻塞", group.coordination_execution.reason ?? "未知原因");
    const metadata = text("section", "", "detail-group-metadata");
    metadata.setAttribute("aria-label", "交付单元信息");
    facts.append(metadata);
    const executionFacts = groupFactRow(metadata, "执行");
    if (context.profileContext) {
      field(
        executionFacts,
        "执行配置",
        createProfileEditor(
          context.profileContext(),
          "group",
          group.id,
          group.execution_profile ?? null,
          group.effective_execution_profile ?? data.orchestration.execution_profile ?? null,
          data.profile_read_only
            ? "当前视图只读或尚未迁移"
            : (group.profile_freeze_reason ?? (group.agent_thread_id ? "对话已创建" : null)),
          null,
          true,
        ),
      );
    }
    field(facts, "交付单元要求", requirementsValue(group.requirements_path, "group", group.id));
    const output = text("div", "", "detail-agent-output");
    output.dataset.outputGroupId = group.id;
    output.dataset.outputFull = "true";
    paintOutput(output, group.latest_agent_output ?? initialOutput(group.agent_thread_id), true);
    field(facts, "Agent 输出", output);
    arrangeInspector(container, facts, groupAtoms, focusedAtomId, group);
    restore();
  };

  const taskPreview = (task: Task): HTMLElement => {
    const data = context.getData();
    const group = data?.groups.find((item) => item.id === task.group_id);
    const executionGroups = [
      ...new Set(
        data?.actual_intervals
          .filter((row) => row.task_id === task.id)
          .map((row) => row.group_id) ?? [],
      ),
    ].map((id) => data?.groups.find((item) => item.id === id)?.title ?? id);
    return renderTaskPreview({
      title: task.title,
      state: context.labelTask(task),
      kind: taskKindLabel(task.kind),
      group: group?.title ?? task.group_id,
      startedAt: task.started_at ?? "",
      finishedAt: task.finished_at ?? "",
      duration: formatDuration(task.started_at, task.finished_at),
      blocker: task.blocker,
      ...(executionGroups.length > 1 ? { executionGroups: executionGroups.join("、") } : {}),
    });
  };

  const groupPreview = (group: Group): HTMLElement => {
    const executionState = groupExecutionVisualState(
      group.state,
      group.coordination_execution?.state,
    );
    const atoms = group.atoms ?? group.planned_atoms ?? [];
    const atom =
      atoms.find((item) => item.status === "running" || item.status === "blocked") ??
      atoms.find((item) => item.status === "planned");
    const progress =
      atoms.length === 0
        ? "未配置原子任务"
        : atoms.every((item) => item.status === "completed")
          ? `${atoms.length}/${atoms.length} · 已完成`
          : atom
            ? `${atoms.indexOf(atom) + 1}/${atoms.length} · ${atom.title}`
            : `0/${atoms.length} · 待开始`;
    return renderGroupPreview({
      title: group.title,
      state: context.labels[executionState] ?? executionState,
      atomProgress: progress,
      duration: formatDuration(group.started_at ?? null, group.finished_at ?? null),
      conversation:
        group.delivery_unit_kind === "bootstrap"
          ? "主对话"
          : group.agent_thread_id
            ? "已创建"
            : "尚未创建",
      parentPr: context.safeExternal(group.parent_pr?.url ?? null) ? "已关联" : "尚未创建",
    });
  };
  const showMilestone = (
    nodeId: string,
    group: Group,
    focusedAtomId: string | null = null,
  ): void => {
    const data = context.getData();
    const node = data?.nodes.find((item) => item.id === nodeId && item.kind === "milestone");
    if (!data || !node) return;
    showGroup(group, focusedAtomId ?? nodeId);
  };
  return { clearDetails, showTask, showGroup, showMilestone, taskPreview, groupPreview };
}
