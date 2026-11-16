import {
  initialOutput,
  type OutputSnapshot,
  type OutputSnapshots,
  refreshOutputNodes,
} from "./agent-output";
import { hasArchiveAction } from "./conversation-control";
import { firstVisibleElement, focusAfterRerender } from "./focus";
import type { Task, Theme, View } from "./model";
import { refreshResourcePopover } from "./resource-popover";
import type { RuntimeMetadata } from "./runtime-metadata";
import { runtimeTaskState } from "./task-state";
import { formatDuration, formatLocalTime } from "./time";
import { refreshTimestamps } from "./timestamp";
import {
  canonicalViewUrl,
  DEFAULT_VIEW_STATE,
  defaultTaskLayout,
  replaceViewState,
  type ViewState,
} from "./view-state";

export type WorkerDiagnostic = {
  diagnostic_id: string;
  run_id: string;
  stage: string;
  worker_key?: string;
  worker_generation?: string;
  error_code?: string;
  safe_summary?: string;
  retry_count?: number;
  state?: string;
  retryable: boolean;
  reconnect_required: boolean;
};

export type AppDataState = {
  data: View | null;
  runtimeMetadata: RuntimeMetadata | null;
  viewState: ViewState;
  activePlan: string;
  activePlanId: string;
  phase: "planning" | "execution" | null;
  hydrated: boolean;
  serviceSessionExpired: boolean;
  workerDiagnostic: WorkerDiagnostic | null;
  reconnectBlocked: boolean;
  missingLinkedTask: string | null;
  userChangedTab: boolean;
  hoverBridge: { resetTargets(): void } | null;
};

export type MenuId = "theme" | "version" | "group-filter" | "state-filter" | "kind-filter";
export type MenuItem = { value: string; label: string };

export type AppDataContext = {
  state: AppDataState;
  $: <T extends HTMLElement>(id: string) => T;
  labels: Record<string, string>;
  defaultStates: Set<string>;
  defaultKinds: Set<string>;
  palette: string[];
  statusColors: Record<string, string>;
  outputSnapshots: OutputSnapshots;
  render: () => void;
  refresh: () => Promise<void>;
  saveTheme: (theme: Theme) => Promise<void>;
  css: (name: string, fallback: string) => string;
  syncStableGridCardWidth: () => void;
  renderList: (tasks: Task[]) => void;
  refreshIcons: () => void;
  hideHoverPreview: () => void;
  showCurrentSelectionPreview: () => void;
};

export function createAppDataController(context: AppDataContext) {
  const { state } = context;
  const menuValues: Record<MenuId, string> = {
    theme: "system",
    version: "",
    "group-filter": "",
    "state-filter": "",
    "kind-filter": "",
  };

  function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
    const element = document.createElement(tag);
    if (classNames.length) element.className = classNames.join(" ");
    element.textContent = value;
    return element;
  }

  function clear(id: string): HTMLElement {
    const element = context.$(id);
    element.replaceChildren();
    return element;
  }

  function label(task: Task): string {
    return task.state === "planned" && task.is_ready
      ? "就绪"
      : (context.labels[task.state] ?? task.state);
  }

  async function archiveConversation(
    taskId: string,
    action: "archive" | "unarchive" = "archive",
  ): Promise<void> {
    try {
      const response = await fetch("api/conversation-archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: taskId, action }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        await context.refresh();
        throw new Error(error.message ?? error.error ?? `HTTP ${response.status}`);
      }
      await context.refresh();
    } catch (error) {
      const notice = document.getElementById("connection-notice");
      if (notice) {
        notice.hidden = false;
        notice.textContent = `对话归档未完成：${error instanceof Error ? error.message : "请稍后重试并检查资源状态"}`;
      }
    }
  }

  function groupColor(groupId: string | null): string {
    if (!state.data || !groupId) return "#87978f";
    const index = state.data.groups.findIndex((item) => item.id === groupId);
    return context.palette[Math.max(0, index) % context.palette.length] ?? "#87978f";
  }

  function stateColor(stateName: string, ready = false): string {
    const normalized = ready && stateName === "planned" ? "ready" : stateName;
    const token =
      normalized === "blocked"
        ? "--negative"
        : ["waiting"].includes(normalized)
          ? "--warning"
          : ["integrated", "completed", "closed", "merged"].includes(normalized)
            ? "--positive"
            : normalized === "planned"
              ? "--control"
              : "--accent";
    return context.css(token, context.statusColors[normalized] ?? "#87978f");
  }

  function time(value: string | null): string {
    if (!value || Number.isNaN(Date.parse(value))) return "未知";
    return formatLocalTime(value);
  }

  function showWorkerDiagnostic(
    value: Partial<WorkerDiagnostic> & {
      diagnostic_id?: string;
      run_id?: string;
      stage?: string;
      code?: string;
    },
  ): void {
    state.workerDiagnostic = {
      ...state.workerDiagnostic,
      ...value,
      diagnostic_id: value.diagnostic_id ?? "unknown",
      run_id: value.run_id ?? location.pathname.split("/")[2] ?? "unknown",
      stage: value.stage ?? "request_dispatch",
      safe_summary: value.safe_summary ?? "展示服务暂时不可用",
      retryable: value.retryable ?? false,
      reconnect_required: value.reconnect_required ?? true,
    };
    state.reconnectBlocked =
      value.code === "RUN_WORKER_UNAVAILABLE" ||
      (Boolean(value.diagnostic_id) && value.state !== "recovered");
    const card = context.$("worker-diagnostic");
    context.$("worker-diagnostic-summary").textContent =
      `运行 ${state.workerDiagnostic.run_id} · 诊断 ${state.workerDiagnostic.diagnostic_id} · 阶段 ${state.workerDiagnostic.stage}：${state.workerDiagnostic.safe_summary}`;
    card.hidden = false;
    connection("stale");
  }

  async function reconnectViewer(): Promise<void> {
    const target = location.pathname + location.search;
    const response = await fetch(`/api/v1/reconnect?target=${encodeURIComponent(target)}`, {
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as { login_url?: string };
    if (!response.ok || !result.login_url) throw new Error("无法创建新的连接入口");
    location.assign(result.login_url);
  }

  function connection(status: "live" | "stale" | "connecting"): void {
    if (state.serviceSessionExpired) status = "stale";
    const element = context.$("connection");
    element.dataset.state = status;
    element.replaceChildren(
      text("span", "", "connection-dot"),
      document.createTextNode(
        status === "live" ? "实时" : status === "stale" ? "数据过期" : "连接中",
      ),
    );
    const notice = context.$("connection-notice");
    notice.hidden = status !== "stale";
    if (status === "stale")
      notice.textContent = state.serviceSessionExpired
        ? "登录已过期，请重新连接。当前显示最后一次有效快照。"
        : state.data
          ? "连接中断，当前显示最后一次有效快照。恢复连接后会重新获取视图。"
          : "首次加载失败，暂时无法读取编排视图。";
  }

  function stateValidation() {
    return {
      groups: new Set(state.data?.groups.map((item) => item.id) ?? []),
      states: context.defaultStates,
      kinds: context.defaultKinds,
      plans: new Set(state.data?.plans.map((item) => item.id) ?? []),
      tasks: new Set(state.data?.tasks.map((item) => item.id) ?? []),
      milestones: new Set(
        state.data?.nodes.filter((item) => item.kind === "milestone").map((item) => item.id) ?? [],
      ),
    };
  }

  function syncUrl(): void {
    const phaseDefaultTab = state.phase === "execution" ? "actual" : DEFAULT_VIEW_STATE.tab;
    replaceViewState(
      state.viewState,
      state.activePlanId || null,
      phaseDefaultTab,
      defaultTaskLayout(state.data?.groups.length ?? 0),
    );
  }

  function filterFromControls(): void {
    state.viewState = {
      ...state.viewState,
      query: context.$<HTMLInputElement>("search").value.trim(),
      group: menuValue("group-filter"),
      state: menuValue("state-filter"),
      kind: menuValue("kind-filter"),
    };
    syncUrl();
  }

  function filteredTasks(): Task[] {
    if (!state.data) return [];
    const query = state.viewState.query.toLocaleLowerCase();
    return state.data.tasks.filter(
      (task) =>
        (!query || `${task.title} ${task.id}`.toLocaleLowerCase().includes(query)) &&
        (!state.viewState.group || task.group_id === state.viewState.group) &&
        (!state.viewState.kind || task.kind === state.viewState.kind) &&
        (!state.viewState.state ||
          (state.viewState.state === "ready"
            ? task.is_ready && task.state === "planned"
            : task.state === state.viewState.state)),
    );
  }

  function menuTrigger(id: MenuId): HTMLButtonElement {
    return context.$(`${id}-trigger`) as HTMLButtonElement;
  }

  function menuValue(id: MenuId): string {
    return menuTrigger(id).dataset.value ?? menuValues[id];
  }

  function setMenuValue(id: MenuId, value: string): void {
    const trigger = menuTrigger(id);
    trigger.dataset.value = value;
    menuValues[id] = value;
    const option = document.querySelector<HTMLElement>(
      `#${id}-menu [data-menu-value="${CSS.escape(value)}"]`,
    );
    context.$(`${id}-value`).textContent = option?.textContent ?? value;
    for (const item of document.querySelectorAll<HTMLElement>(`#${id}-menu [role="option"]`))
      item.setAttribute("aria-selected", String(item.dataset.menuValue === value));
  }

  function closeMenus(): void {
    for (const menu of document.querySelectorAll<HTMLElement>(".custom-menu")) menu.hidden = true;
    for (const trigger of document.querySelectorAll<HTMLButtonElement>(
      ".menu-trigger, .theme-trigger",
    ))
      trigger.setAttribute("aria-expanded", "false");
  }

  function openMenu(id: MenuId): void {
    closeMenus();
    const menu = context.$(`${id}-menu`);
    const trigger = menuTrigger(id);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const selected = menu.querySelector<HTMLElement>(
      `[data-menu-value="${CSS.escape(menuValue(id))}"]`,
    );
    (selected ?? menu.querySelector<HTMLElement>("[role=option]"))?.focus();
  }

  function chooseMenu(id: MenuId, value: string): void {
    const trigger = menuTrigger(id);
    setMenuValue(id, value);
    closeMenus();
    if (id === "theme") {
      focusAfterRerender(trigger, trigger);
      void context.saveTheme(value as Theme);
      return;
    }
    state.viewState = {
      ...state.viewState,
      ...(id === "group-filter"
        ? { group: value }
        : id === "state-filter"
          ? { state: value }
          : { kind: value }),
    };
    syncUrl();
    context.render();
    focusAfterRerender(trigger, trigger);
  }

  function updateVersionMenu(): void {
    if (!state.data) return;
    const menu = context.$("version-menu");
    menu.replaceChildren();
    const defaultPlan = state.activePlanId || state.data.selected_plan_id;
    for (const plan of state.data.plans) {
      const listItem = document.createElement("li");
      const option = document.createElement("a");
      const selected = (state.activePlan || defaultPlan) === plan.id;
      option.href = canonicalViewUrl(
        window.location.href,
        { ...state.viewState, plan: plan.id === defaultPlan ? null : plan.id },
        defaultPlan,
        state.phase === "execution" ? "actual" : DEFAULT_VIEW_STATE.tab,
        defaultTaskLayout(state.data.groups.length),
      );
      option.role = "option";
      option.dataset.menuValue = plan.id;
      option.setAttribute("aria-selected", String(selected));
      option.textContent = plan.id;
      option.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        state.activePlan = plan.id === defaultPlan ? "" : plan.id;
        state.viewState = { ...state.viewState, plan: state.activePlan || null };
        closeMenus();
        syncUrl();
        focusAfterRerender(context.$("version-trigger"), context.$("version-trigger"));
        void context.refresh();
      });
      listItem.append(option);
      menu.append(listItem);
    }
    setMenuValue("version", state.activePlan || defaultPlan);
  }

  function updateMenu(id: MenuId, items: MenuItem[], placeholder?: string): void {
    if (id === "theme" || id === "version") return;
    const menu = context.$(`${id}-menu`);
    menu.replaceChildren();
    const options = placeholder ? [{ value: "", label: placeholder }, ...items] : items;
    for (const item of options) {
      const listItem = document.createElement("li");
      const option = document.createElement("button");
      option.type = "button";
      option.role = "option";
      option.dataset.menuValue = item.value;
      option.textContent = item.label;
      option.addEventListener("click", () => chooseMenu(id, item.value));
      listItem.append(option);
      menu.append(listItem);
    }
  }

  function renderSummary(): void {
    if (!state.data) return;
    const summary = clear("summary");
    const tasks = state.data.tasks;
    const entries = [
      ["Agent 空闲", tasks.filter((task) => task.state === "agent_idle").length, "agent_idle"],
      ["就绪", tasks.filter((task) => task.is_ready && task.state === "planned").length, "ready"],
      [
        "执行中",
        `${tasks.filter((task) => ["starting", "running"].includes(task.state)).length}/${state.data.orchestration.max_running_tasks}`,
        "running",
      ],
      ["阻塞", tasks.filter((task) => task.state === "blocked").length, "blocked"],
      ["已集成", tasks.filter((task) => task.state === "integrated").length, "integrated"],
      ["已收口", tasks.filter((task) => task.state === "closed").length, "closed"],
    ] as const;
    const iconNames: Record<string, string> = {
      agent_idle: "tree-palm",
      ready: "circle-dot",
      running: "circle-play",
      blocked: "circle-alert",
      integrated: "git-merge",
      closed: "circle-check",
    };
    for (const [name, count, status] of entries) {
      const row = text("div", "", "summary-item");
      row.dataset.status = status;
      const icon = text("span", "", "summary-icon");
      icon.setAttribute("aria-hidden", "true");
      const iconElement = document.createElement("i");
      iconElement.dataset.lucide = iconNames[status];
      icon.append(iconElement);
      row.append(icon, text("span", name, "summary-label"), text("strong", String(count)));
      summary.append(row);
    }
  }

  function refreshCardDurations(): void {
    refreshTimestamps();
    refreshResourcePopover();
    for (const element of document.querySelectorAll<HTMLElement>("[data-duration-start]")) {
      const start = element.dataset.durationStart || null;
      const end = element.dataset.durationEnd || null;
      element.textContent = formatDuration(start, end);
    }
  }

  function updateTaskLayoutControls(): void {
    for (const [id, layout] of [
      ["task-layout-board", "board"],
      ["task-layout-grid", "grid"],
    ] as const)
      context
        .$<HTMLButtonElement>(id)
        .setAttribute("aria-pressed", String(state.viewState.layout === layout));
    context.$("group-section").hidden = state.viewState.layout === "board";
  }

  function applyOutputs(next: OutputSnapshot, requestEpoch?: string | null): void {
    const outputSnapshot = context.outputSnapshots.accept(next, requestEpoch);
    if (!state.data || !outputSnapshot) return;
    let idleChanged = false;
    for (const task of state.data.tasks) {
      const previousState = task.state;
      const previousArchiveAction = hasArchiveAction(task);
      const output = outputSnapshot.outputs[`task:${task.id}`] ?? outputSnapshot.outputs[task.id];
      task.latest_agent_output =
        output?.thread_id === task.thread_id ? output : initialOutput(task.thread_id);
      const observedState = runtimeTaskState(task, task.latest_agent_output);
      if (observedState === "agent_idle" && previousState !== "agent_idle")
        task.agent_resume_state = previousState as "starting" | "running";
      task.state = observedState;
      if (observedState !== "agent_idle") delete task.agent_resume_state;
      idleChanged ||=
        previousState !== task.state || previousArchiveAction !== hasArchiveAction(task);
    }
    for (const group of state.data.groups) {
      const thread =
        group.delivery_unit_kind === "bootstrap"
          ? state.data.orchestration.owner_thread_id
          : group.agent_thread_id;
      const output = outputSnapshot.outputs[`group:${group.id}`];
      group.latest_agent_output =
        output?.thread_id === thread ? output : initialOutput(thread ?? null);
    }
    refreshOutputNodes(document, state.data.tasks);
    if (state.hydrated && idleChanged) context.render();
    refreshResourcePopover();
  }

  function setTaskLayout(layout: "board" | "grid"): void {
    if (state.viewState.layout === layout) return;
    state.viewState = { ...state.viewState, layout };
    syncUrl();
    if (state.data) {
      context.hideHoverPreview();
      state.hoverBridge?.resetTargets();
      context.renderList(filteredTasks());
      context.syncStableGridCardWidth();
      context.refreshIcons();
      context.showCurrentSelectionPreview();
    }
  }

  function applyStateToControls(): void {
    context.$<HTMLInputElement>("search").value = state.viewState.query;
    setMenuValue("group-filter", state.viewState.group);
    setMenuValue("state-filter", state.viewState.state);
    setMenuValue("kind-filter", state.viewState.kind);
  }

  type ListFocus = { kind: "task" | "group"; id: string; href: string | null } | null;
  function captureListFocus(): ListFocus {
    const active = document.activeElement as HTMLElement | null;
    const task = active?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
    const href = active instanceof HTMLAnchorElement ? active.href : null;
    if (task) return { kind: "task", id: task, href };
    const group = active?.closest<HTMLElement>("[data-group-id]")?.dataset.groupId;
    return group ? { kind: "group", id: group, href } : null;
  }

  function restoreListFocus(focus: ListFocus): void {
    if (!focus) return;
    const selector =
      focus.kind === "task"
        ? `[data-task-id="${CSS.escape(focus.id)}"]`
        : `[data-group-id="${CSS.escape(focus.id)}"]`;
    const container = firstVisibleElement(document, selector);
    const target =
      (focus.href && container
        ? [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].find(
            (link) => link.href === focus.href,
          )
        : null) ??
      (container ? container.querySelector<HTMLElement>("button") : null) ??
      firstVisibleElement(document, ".task-card-select, .task-column-select") ??
      context.$("search");
    target.focus({ preventScroll: true });
  }

  type MenuFocus = { id: MenuId; value: string } | null;
  function captureMenuFocus(): MenuFocus {
    const active = document.activeElement as HTMLElement | null;
    const container = active?.closest<HTMLElement>("[data-menu]");
    const option = active?.closest<HTMLElement>("[role=option]");
    const id = container?.dataset.menu as MenuId | undefined;
    return id && option?.dataset.menuValue !== undefined
      ? { id, value: option.dataset.menuValue }
      : null;
  }

  function restoreMenuFocus(focus: MenuFocus): void {
    if (!focus || menuTrigger(focus.id).getAttribute("aria-expanded") !== "true") return;
    const option = [
      ...document.querySelectorAll<HTMLElement>(`#${focus.id}-menu [role=option]`),
    ].find((item) => item.dataset.menuValue === focus.value);
    option?.focus();
  }

  type DetailFocus = { href: string } | { id: string } | null;
  function captureDetailFocus(): DetailFocus {
    const active = document.activeElement as HTMLElement | null;
    if (!active?.closest("#details")) return null;
    if (active instanceof HTMLAnchorElement && active.href) return { href: active.href };
    return active.id ? { id: active.id } : null;
  }

  function restoreDetailFocus(focus: DetailFocus): void {
    if (!focus || !state.viewState.detail) return;
    const target =
      "href" in focus
        ? [...document.querySelectorAll<HTMLAnchorElement>("#details a")].find(
            (link) => link.href === focus.href,
          )
        : document.getElementById(focus.id);
    target?.focus();
  }

  return {
    applyOutputs,
    applyStateToControls,
    archiveConversation,
    captureDetailFocus,
    captureListFocus,
    captureMenuFocus,
    chooseMenu,
    clear,
    closeMenus,
    connection,
    filterFromControls,
    filteredTasks,
    groupColor,
    label,
    menuTrigger,
    menuValue,
    openMenu,
    reconnectViewer,
    refreshCardDurations,
    renderSummary,
    restoreDetailFocus,
    restoreListFocus,
    restoreMenuFocus,
    setMenuValue,
    setTaskLayout,
    showWorkerDiagnostic,
    stateColor,
    stateValidation,
    syncUrl,
    text,
    time,
    updateMenu,
    updateTaskLayoutControls,
    updateVersionMenu,
  };
}
