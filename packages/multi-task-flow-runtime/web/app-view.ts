import type { createIcons } from "lucide";
import type { AtomicEdge, AtomicNode } from "../lib/atomic-orchestration";
import { initialOutput, type OutputSnapshot } from "./agent-output";
import type { AppDataState, MenuId, WorkerDiagnostic } from "./app-data";
import type { Group, Task, Theme, ViewResponse } from "./model";
import { defaultTabForPhase, derivePhase } from "./phase";
import {
  createProfileEditor,
  type ProfileCapabilities,
  type ProfileTarget,
} from "./profile-editor";
import { renderTimestamp } from "./timestamp";
import {
  type DashboardTab,
  defaultTaskLayout,
  hasValidLayoutParam,
  hasValidTabParam,
  parseViewState,
  sanitizeViewState,
} from "./view-state";

type Controller = {
  close?: () => void;
  render?: (...args: unknown[]) => void;
  renderTimeline?: (...args: unknown[]) => void;
};

export type AppViewContext = {
  state: AppDataState & {
    revision: number;
    requestSerial: number;
    themeRequestSerial: number;
    themeWriteQueue: Promise<void>;
    phaseTransition: boolean;
    focusDetailsOnNextRender: boolean;
    restoreClosedDetailsOnNextRender: boolean;
    selectedTask: string | null;
    selectedGroup: string | null;
    selectedMilestone: string | null;
  };
  $: <T extends HTMLElement>(id: string) => T;
  icons: Parameters<typeof createIcons>[0]["icons"];
  defaultStates: Set<string>;
  labels: Record<string, string>;
  taskKindLabel: (kind: string) => string;
  applyOutputs: (next: OutputSnapshot, requestEpoch?: string | null) => void;
  outputEpoch: () => string | null;
  clearDetails: () => void;
  connection: (status: "live" | "stale" | "connecting") => void;
  createIcons: typeof createIcons;
  filteredTasks: () => Task[];
  hideHoverPreview: () => void;
  menuTrigger: (id: MenuId) => HTMLButtonElement;
  renderGroups: () => void;
  renderList: (tasks: Task[]) => void;
  renderPlanInfo: () => void;
  renderSummary: () => void;
  setMenuValue: (id: MenuId, value: string) => void;
  showCurrentSelectionPreview: () => void;
  showGroup: (group: Group, atomId: string | null) => void;
  showMilestone: (id: string, group: Group, atomId: string | null) => void;
  showTask: (task: Task, atomId: string | null) => void;
  stateValidation: () => ReturnType<
    () => {
      groups: Set<string>;
      states: Set<string>;
      kinds: Set<string>;
      plans: Set<string>;
      tasks: Set<string>;
      milestones: Set<string>;
    }
  >;
  syncStableGridCardWidth: () => void;
  syncUrl: () => void;
  taskContextMenu: Controller;
  graphController: Controller;
  atomicGraphController: Controller;
  timelineController: Controller;
  applyStateToControls: () => void;
  updateDetailsSurface: (open: boolean, focus?: boolean) => unknown;
  updateMenu: (id: MenuId, items: { value: string; label: string }[], placeholder?: string) => void;
  updateVersionMenu: () => void;
  restoreClosedDetails: () => void;
  captureListFocus: () => unknown;
  captureMenuFocus: () => unknown;
  captureDetailFocus: () => unknown;
  restoreListFocus: (focus: unknown) => void;
  restoreMenuFocus: (focus: unknown) => void;
  restoreDetailFocus: (focus: unknown) => void;
  profile: () => {
    capabilities: ProfileCapabilities | null;
    capabilityError: string;
    update: (
      targetType: ProfileTarget,
      targetId: string,
      profile: { model: string; thinking: string } | null,
      recommend?: boolean,
    ) => Promise<void>;
  };
  showWorkerDiagnostic: (value: Partial<WorkerDiagnostic> & { code?: string }) => void;
};

export function applyViewOutputSnapshot(
  applyOutputs: AppViewContext["applyOutputs"],
  result: Pick<ViewResponse, "view" | "output_epoch" | "output_revision">,
  requestEpoch: string | null,
): void {
  applyOutputs(
    {
      output_epoch: result.output_epoch ?? "static-demo",
      output_revision: result.output_revision ?? 0,
      outputs: Object.fromEntries([
        ...result.view.tasks.map((task) => [
          task.id,
          task.latest_agent_output ?? initialOutput(task.thread_id),
        ]),
        ...result.view.groups.map((group) => [
          `group:${group.id}`,
          group.latest_agent_output ?? initialOutput(group.agent_thread_id),
        ]),
      ]),
    },
    requestEpoch,
  );
}

export function createAppViewController(context: AppViewContext) {
  const { state } = context;

  function setTabAria(tab: DashboardTab): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    const graphView = context.$("graph-view");
    const graphVisible = ["graph", "atomic"].includes(tab);
    graphView.hidden = !graphVisible;
    graphView.setAttribute("aria-labelledby", tab === "atomic" ? "tab-atomic" : "tab-graph");
    for (const name of ["planned", "actual", "tasks"])
      context.$(`${name}-view`).hidden = name !== tab;
    context.$("workspace").dataset.viewTab = tab;
  }

  function renderAtomicGraph(): void {
    if (!state.data) return;
    const allNodes = (state.data.atomic_nodes ?? []) as unknown as AtomicNode[];
    const taskById = new Map(state.data.tasks.map((task) => [task.id, task]));
    const nodes = allNodes.filter((node) => {
      const scope = node.kind === "work" || node.kind === "milestone" ? node.scope : undefined;
      const taskId = scope?.kind === "task" ? scope.task_id : null;
      const deliveryUnitId =
        scope?.kind === "task"
          ? scope.delivery_unit_id
          : scope?.kind === "delivery_unit"
            ? scope.delivery_unit_id
            : null;
      if (state.viewState.group && deliveryUnitId !== state.viewState.group) return false;
      if (node.kind === "work" && taskId) {
        const task = taskById.get(taskId);
        if (!task) return false;
        if (state.viewState.kind && task.kind !== state.viewState.kind) return false;
        if (
          state.viewState.state &&
          task.state !== state.viewState.state &&
          node.state !== state.viewState.state
        )
          return false;
      }
      return true;
    });
    const visible = new Set(nodes.map((node) => node.id));
    const edges = ((state.data.canonical_atomic_edges ?? []) as unknown as AtomicEdge[]).filter(
      (edge) => visible.has(edge.from_node_id) && visible.has(edge.to_node_id),
    );
    context.atomicGraphController.render?.(nodes, edges);
  }

  function render(): void {
    const runProfileControl = document.getElementById("run-profile-control");
    if (runProfileControl && state.data) {
      const profile = context.profile();
      runProfileControl.replaceChildren(
        createProfileEditor(
          profile,
          "run",
          state.data.orchestration.id,
          state.data.orchestration.execution_profile ?? null,
          state.data.orchestration.execution_profile ?? null,
          state.data.profile_read_only ? "当前视图只读或尚未迁移" : null,
        ),
      );
    }
    if (!state.data) return;
    context.taskContextMenu.close?.();
    const listFocus = context.captureListFocus();
    const menuFocus = context.captureMenuFocus();
    const detailFocus = context.captureDetailFocus();
    context.hideHoverPreview();
    state.hoverBridge?.resetTargets();
    context.$("project-name").textContent =
      `${state.data.orchestration.repository.owner} / ${state.data.orchestration.repository.name}`;
    context
      .$("updated")
      .replaceChildren(
        document.createTextNode("数据更新 "),
        renderTimestamp(state.data.orchestration.updated_at),
      );
    context.$("revision").textContent = `rev ${state.data.orchestration.revision}`;
    const currentPhase = derivePhase(state.data.tasks, state.data.execution_phase);
    state.phase = currentPhase;
    if (state.data.orchestration.version)
      context
        .$("updated")
        .append(
          document.createTextNode(
            ` · Skill ${state.data.orchestration.version.skill_version} · Viewer contract ${state.data.orchestration.version.viewer_contract}`,
          ),
        );
    if (state.data.orchestration.version_status?.state !== "current") {
      const reason = state.data.orchestration.version_status?.reason ?? "版本状态未知";
      context.$("operation-warning").hidden = false;
      context.$("operation-warning").textContent = `版本诊断：${reason}`;
    }
    context.$("operation-warning").hidden = state.data.warnings.length === 0;
    context.$("operation-warning").textContent = state.data.warnings.length
      ? `${state.data.warnings.length} 项外部操作结果待核实。`
      : "";
    const planWarnings = state.data.plan_warnings ?? [];
    const planWarning = context.$("plan-warning");
    const planState = state.data.plan_state;
    context.renderPlanInfo();
    const authorizationLabel =
      planState?.authorization_label ??
      (planState?.approval_pending ? "Not approved" : "Schedulable");
    const runtimeBlockers =
      planState?.runtime_readiness?.status === "blocked"
        ? planState.runtime_readiness.blockers.map((blocker) => blocker.message)
        : [];
    const warningReasons = planWarnings.length
      ? planWarnings.map((warning) => warning.reason)
      : planState?.approval_pending
        ? ["Owner approval 尚未完成。"]
        : runtimeBlockers;
    planWarning.hidden =
      state.viewState.tab !== "planned" ||
      (!warningReasons.length && authorizationLabel === "Schedulable");
    planWarning.textContent = [
      authorizationLabel,
      ...(warningReasons.length ? warningReasons : ["计划完整性检查通过。"]),
    ].join(" · ");
    context.updateMenu(
      "group-filter",
      state.data.groups.map((group) => ({ value: group.id, label: group.title })),
      "全部交付单元",
    );
    context.updateMenu(
      "state-filter",
      [...context.defaultStates]
        .filter((key) => !["active", "merged", "unknown", "idle"].includes(key))
        .map((value) => ({
          value,
          label: value === "ready" ? "就绪" : (context.labels[value] ?? value),
        })),
      "全部状态",
    );
    context.updateMenu(
      "kind-filter",
      ["contribution", "release", "deployment", "verification"].map((value) => ({
        value,
        label: context.taskKindLabel(value),
      })),
      "全部任务类型",
    );
    context.updateVersionMenu();
    context.setMenuValue("group-filter", state.viewState.group);
    context.setMenuValue("state-filter", state.viewState.state);
    context.setMenuValue("kind-filter", state.viewState.kind);
    context.$("graph-tools").hidden = !["graph", "atomic"].includes(state.viewState.tab);
    context.$("atomic-view-tools").hidden = state.viewState.tab !== "atomic";
    context.$("timeline-tools").hidden = !["planned", "actual"].includes(state.viewState.tab);
    context.applyStateToControls();
    context.renderSummary();
    const tasks = context.filteredTasks();
    context.$("task-count").textContent = `${tasks.length} / ${state.data.tasks.length} 个任务`;
    context.$("view-context").textContent = ["graph", "atomic"].includes(state.viewState.tab)
      ? "依赖关系"
      : state.viewState.tab === "planned"
        ? "理论安排"
        : state.viewState.tab === "actual"
          ? "实际运行"
          : "任务";
    context.$("view-count").textContent =
      `${tasks.length} 项任务 · ${state.data.groups.length} 个交付单元`;
    context.renderGroups();
    context.renderList(tasks);
    context.syncStableGridCardWidth();
    setTabAria(state.viewState.tab);
    const aggregateGraph = context.$("graph");
    const atomicGraph = context.$("atomic-graph");
    if (["graph", "atomic"].includes(state.viewState.tab)) {
      aggregateGraph.hidden = state.viewState.tab !== "graph";
      atomicGraph.hidden = state.viewState.tab !== "atomic";
      if (state.viewState.tab === "atomic") renderAtomicGraph();
      else
        context.graphController.render?.(
          tasks,
          state.viewState.group ? new Set([state.viewState.group]) : undefined,
        );
    } else {
      aggregateGraph.hidden = true;
      atomicGraph.hidden = true;
      if (["planned", "actual"].includes(state.viewState.tab))
        context.timelineController.renderTimeline?.(tasks, state.viewState.tab);
    }
    const focusDetails = state.focusDetailsOnNextRender;
    state.focusDetailsOnNextRender = false;
    context.updateDetailsSurface(state.viewState.detail, focusDetails);
    const selectedTaskData = state.selectedTask
      ? state.data.tasks.find((item) => item.id === state.selectedTask)
      : null;
    const selectedGroupData = state.selectedGroup
      ? state.data.groups.find((item) => item.id === state.selectedGroup)
      : null;
    const selectedMilestoneData = state.selectedMilestone
      ? state.data.nodes.find(
          (item) => item.kind === "milestone" && item.id === state.selectedMilestone,
        )
      : null;
    const selectedMilestoneGroup = selectedMilestoneData?.group_id
      ? state.data.groups.find((item) => item.id === selectedMilestoneData.group_id)
      : null;
    if (selectedTaskData) context.showTask(selectedTaskData, state.viewState.atom);
    else if (selectedGroupData) context.showGroup(selectedGroupData, state.viewState.atom);
    else if (selectedMilestoneData && selectedMilestoneGroup)
      context.showMilestone(selectedMilestoneData.id, selectedMilestoneGroup, state.viewState.atom);
    else context.clearDetails();
    context.createIcons({ icons: context.icons });
    context.showCurrentSelectionPreview();
    context.restoreListFocus(listFocus);
    context.restoreMenuFocus(menuFocus);
    context.restoreDetailFocus(detailFocus);
    if (state.restoreClosedDetailsOnNextRender) {
      state.restoreClosedDetailsOnNextRender = false;
      context.restoreClosedDetails();
    }
    if (state.phaseTransition) {
      context.$("phase-notice").hidden = false;
      context.$("phase-notice-text").textContent =
        "已有真实任务开始执行，阶段已切换；当前视图和筛选保持不变。";
    } else context.$("phase-notice").hidden = true;
  }

  function setTab(tab: DashboardTab, user = true): void {
    state.viewState = {
      ...state.viewState,
      tab,
      ...(tab === "atomic"
        ? { graphMode: "atomic" as const }
        : tab === "graph"
          ? { graphMode: "aggregate" as const }
          : {}),
    };
    if (user) state.userChangedTab = true;
    context.syncUrl();
    render();
  }

  async function refresh(): Promise<void> {
    if (state.reconnectBlocked) return;
    const serial = ++state.requestSerial;
    const outputEpoch = context.outputEpoch();
    const requestedPlan = state.activePlan;
    try {
      const query = requestedPlan ? `?plan=${encodeURIComponent(requestedPlan)}` : "";
      let response = await fetch(`api/view${query}`, { cache: "no-store" });
      if (response.status === 404 && requestedPlan) {
        if (serial !== state.requestSerial) return;
        state.activePlan = "";
        state.viewState = { ...state.viewState, plan: null };
        context.syncUrl();
        response = await fetch("api/view", { cache: "no-store" });
      }
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          code?: string;
          diagnostic_id?: string;
          run_id?: string;
          stage?: string;
          retryable?: boolean;
          reconnect_required?: boolean;
        };
        if (failure.code === "RUN_WORKER_UNAVAILABLE" && failure.diagnostic_id)
          context.showWorkerDiagnostic(failure);
        throw new Error(`HTTP ${response.status}`);
      }
      let result = (await response.json()) as ViewResponse;
      if (!state.viewState.plan && requestedPlan && result.active_plan_id !== requestedPlan) {
        if (serial !== state.requestSerial) return;
        state.activePlan = "";
        response = await fetch("api/view", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        result = (await response.json()) as ViewResponse;
      }
      if (serial !== state.requestSerial || result.revision < state.revision) return;
      const previousPhase = state.phase;
      state.revision = result.revision;
      state.activePlanId = result.active_plan_id;
      state.data = result.view;
      applyViewOutputSnapshot(context.applyOutputs, result, outputEpoch);
      const currentPhase = derivePhase(state.data.tasks, state.data.execution_phase);
      const explicitUrlState = parseViewState(window.location.search);
      if (hasValidTabParam(window.location.search))
        state.viewState = { ...state.viewState, tab: explicitUrlState.tab };
      else if (!state.hydrated && !state.userChangedTab)
        state.viewState = { ...state.viewState, tab: defaultTabForPhase(currentPhase) };
      if (!hasValidLayoutParam(window.location.search))
        state.viewState = {
          ...state.viewState,
          layout: defaultTaskLayout(state.data.groups.length),
        };
      const requestedTask =
        state.viewState.selected?.kind === "task"
          ? state.viewState.selected.id
          : state.missingLinkedTask;
      const missingTask =
        requestedTask && !state.data.tasks.some((task) => task.id === requestedTask);
      state.missingLinkedTask = missingTask ? requestedTask : null;
      let taskNotice = document.getElementById("task-link-notice");
      if (!taskNotice) {
        taskNotice = document.createElement("div");
        taskNotice.id = "task-link-notice";
        taskNotice.className = "notice notice-warning";
        taskNotice.role = "status";
        context.$("connection-notice").after(taskNotice);
      }
      taskNotice.hidden = !missingTask;
      taskNotice.textContent = missingTask ? `任务 ${requestedTask} 不存在或已不可用。` : "";
      if (!state.hydrated && requestedTask && !missingTask && state.viewState.detail)
        state.viewState = { ...state.viewState, query: "", group: "", kind: "", state: "" };
      state.viewState = sanitizeViewState(state.viewState, context.stateValidation());
      state.selectedTask =
        state.viewState.selected?.kind === "task" ? state.viewState.selected.id : null;
      state.selectedGroup =
        state.viewState.selected?.kind === "group" ? state.viewState.selected.id : null;
      state.selectedMilestone =
        state.viewState.selected?.kind === "milestone" ? state.viewState.selected.id : null;
      state.activePlan = state.viewState.plan ?? state.data.selected_plan_id;
      if (previousPhase === "planning" && currentPhase === "execution")
        state.phaseTransition = true;
      state.phase = currentPhase;
      const shouldFocusRestoredDetails = !state.hydrated && state.viewState.detail;
      state.hydrated = true;
      if (shouldFocusRestoredDetails) state.focusDetailsOnNextRender = true;
      context.syncUrl();
      context.connection(result.watching ? "live" : "stale");
      context.$("load-error").hidden = true;
      render();
      if (shouldFocusRestoredDetails && state.selectedTask) {
        const card = document.querySelector<HTMLElement>(
          `[data-task-id="${CSS.escape(state.selectedTask)}"]`,
        );
        card?.scrollIntoView({ block: "center", inline: "center" });
        card?.querySelector<HTMLElement>(".task-card-select")?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (serial !== state.requestSerial) return;
      context.connection("stale");
      if (!state.data && !state.workerDiagnostic) {
        context.$("load-error").hidden = false;
        context.$("load-error").textContent =
          `首次加载失败：${error instanceof Error ? error.message : "无法读取数据"}`;
      }
    }
  }

  async function loadTheme(): Promise<void> {
    const serial = ++state.themeRequestSerial;
    await state.themeWriteQueue;
    try {
      const response = await fetch("api/preferences", { cache: "no-store" });
      if (!response.ok) return;
      const loaded = ((await response.json()) as { theme: Theme }).theme;
      if (serial === state.themeRequestSerial) applyTheme(loaded);
    } catch {}
  }

  function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
    context.setMenuValue("theme", theme);
  }

  async function saveTheme(theme: Theme): Promise<void> {
    const serial = ++state.themeRequestSerial;
    const trigger = context.menuTrigger("theme");
    applyTheme(theme);
    trigger.removeAttribute("aria-invalid");
    const write = async (): Promise<void> => {
      try {
        const response = await fetch("api/preferences", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        if (serial === state.themeRequestSerial) trigger.setAttribute("aria-invalid", "true");
      }
    };
    state.themeWriteQueue = state.themeWriteQueue.then(write, write);
    await state.themeWriteQueue;
  }

  return {
    applyTheme,
    loadTheme,
    refresh,
    render,
    renderAtomicGraph,
    saveTheme,
    setTab,
    setTabAria,
  };
}
