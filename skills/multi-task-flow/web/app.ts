import { refreshResourcePopover } from "./resource-popover";
import { OutputSnapshots, initialOutput, refreshOutputNodes, type OutputSnapshot } from "./agent-output";
import { createProfileEditor } from "./profile-editor";
import type { ProfileCapabilities, ProfileTarget } from "./profile-editor";
import moment from "moment";
import { createIcons, Contrast, Network, Search, X, Plus, Minus, Maximize2, ChevronDown, CircleDashed, CircleDot, CirclePlay, LoaderCircle, Hourglass, CircleAlert, CircleCheck, GitMerge, Columns3, LayoutGrid, MessageCircle, GitPullRequest } from "lucide";
import { createCardRenderer } from "./cards";
import { createTimelineController } from "./timeline";
import { createGraphController } from "./graph";
import { createHoverController } from "./hover-controller";
import { createDetailContent } from "./details-content";
import { deriveConnectionStatus, type Task, type View, type ViewResponse, type Theme } from "./model";
import { defaultTabForPhase, derivePhase, type DisplayPhase } from "./phase";
import { DETAILS_PANEL_BREAKPOINT, detailsPanelFits, isDetailInteraction, resolveDetailSurface, selectedObjectFocusSelector } from "./interaction-policy";
import { applyDetailSurface } from "./detail-surface";
import { firstVisibleElement, focusAfterRerender } from "./focus";
import { installViewStateNavigation } from "./navigation";
import { createHoverPreviewBridge, type HoverPreviewBridge } from "./hover-preview";
import { formatDuration, formatLocalTime } from "./time";
import { renderTimestamp, refreshTimestamps } from "./timestamp";
import { rangeFromIntervals } from "./execution-range";
import { taskKindLabel } from "./labels";
import { DEFAULT_VIEW_STATE, canonicalViewUrl, hasValidTabParam, parseViewState, replaceViewState, sanitizeViewState, type DashboardTab, type TaskLayout, type ViewState } from "./view-state";
const ICONS = { Contrast, Network, Search, X, Plus, Minus, Maximize2, ChevronDown, CircleDashed, CircleDot, CirclePlay, LoaderCircle, Hourglass, CircleAlert, CircleCheck, GitMerge, Columns3, LayoutGrid, MessageCircle, GitPullRequest };
createIcons({ icons: ICONS });
moment.defineLocale("zh-task", { parentLocale: "en", months: "一月_二月_三月_四月_五月_六月_七月_八月_九月_十月_十一月_十二月".split("_"), monthsShort: "1月_2月_3月_4月_5月_6月_7月_8月_9月_10月_11月_12月".split("_"), weekdays: "星期日_星期一_星期二_星期三_星期四_星期五_星期六".split("_"), weekdaysShort: "周日_周一_周二_周三_周四_周五_周六".split("_"), weekdaysMin: "日_一_二_三_四_五_六".split("_") });
moment.locale("zh-task");
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const palette = ["#1b6c80", "#2f70bb", "#a86f0c", "#6f7880", "#1e7b4f", "#8a6470"];
const labels: Record<string, string> = { planned: "待开始", ready: "就绪", starting: "启动中", running: "执行中", waiting: "等待中", blocked: "阻塞", integrated: "已集成", completed: "已完成", closed: "已收口", merged: "已合并", active: "进行中" };
const statusColors: Record<string, string> = { planned: "#8a9295", ready: "#2f70bb", starting: "#2f70bb", running: "#2f70bb", waiting: "#a86f0c", blocked: "#c4242a", integrated: "#1e7b4f", completed: "#1e7b4f", closed: "#71797d", merged: "#1e7b4f" };
const defaultStates = new Set(Object.keys(labels).filter((key) => !["active", "merged"].includes(key)));
const defaultKinds = new Set(["contribution", "release", "deployment", "verification", "coordination", "development", "other"]);
let data: View | null = null;
let revision = -1;
const outputSnapshots = new OutputSnapshots();
function applyOutputs(next: OutputSnapshot, requestEpoch?: string | null): void {
  const outputSnapshot = outputSnapshots.accept(next, requestEpoch);
  if (!data || !outputSnapshot) return;
  for (const task of data.tasks) {
    const output = outputSnapshot.outputs[`task:${task.id}`] ?? outputSnapshot.outputs[task.id];
    task.latest_agent_output = output?.thread_id === task.thread_id ? output : initialOutput(task.thread_id);
  }
  for (const group of data.groups) {
    const thread = group.delivery_unit_kind === "bootstrap" ? data.orchestration.owner_thread_id : group.agent_thread_id;
    const output = outputSnapshot.outputs[`group:${group.id}`];
    group.latest_agent_output = output?.thread_id === thread ? output : initialOutput(thread ?? null);
  }
  refreshOutputNodes(document, data.tasks);
  refreshResourcePopover();
}
let viewState: ViewState = parseViewState(window.location.search);
let selectedTask: string | null = viewState.selected?.kind === "task" ? viewState.selected.id : null;
let selectedGroup: string | null = viewState.selected?.kind === "group" ? viewState.selected.id : null;
let activePlan = viewState.plan ?? "";
let activePlanId = "";
let connected = false;
let requestSerial = 0;
let themeRequestSerial = 0;
let themeWriteQueue: Promise<void> = Promise.resolve();
let phase: DisplayPhase | null = null;
let phaseTransition = false;
let hydrated = false;
let userChangedTab = hasValidTabParam(window.location.search);
let lastFocus: HTMLElement | null = null;
let lastScrollTop: number | null = null;
let focusDetailsOnNextRender = false;
let keyboardSelection = false;
let hoverBridge: HoverPreviewBridge | null = null;
let restoreClosedDetailsOnNextRender = false;
const anyHoverCapability = window.matchMedia("(any-hover: hover)");
const anyFinePointerCapability = window.matchMedia("(any-pointer: fine)");
function text(tag: string, value: string, ...classNames: string[]): HTMLElement { const element = document.createElement(tag); if (classNames.length) element.className = classNames.join(" "); element.textContent = value; return element; }
function clear(id: string): HTMLElement { const element = $(id); element.replaceChildren(); return element; }
function label(task: Task): string { return task.state === "planned" && task.is_ready ? "就绪" : labels[task.state] ?? task.state; }
function groupColor(groupId: string | null): string { if (!data || !groupId) return "#87978f"; const index = data.groups.findIndex((item) => item.id === groupId); return palette[Math.max(0, index) % palette.length] ?? "#87978f"; }
function stateColor(state: string, ready = false): string {
  const normalized = ready && state === "planned" ? "ready" : state;
  const token = normalized === "blocked" ? "--negative" : ["waiting"].includes(normalized) ? "--warning" : ["integrated", "completed", "closed", "merged"].includes(normalized) ? "--positive" : normalized === "planned" ? "--control" : "--accent";
  return css(token, statusColors[normalized] ?? "#87978f");
}
function time(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "未知";
  return formatLocalTime(value);
}
let serviceSessionExpired = false;
document.addEventListener("service-session", (event) => {
  serviceSessionExpired = Boolean((event as CustomEvent).detail?.expired);
  connection(serviceSessionExpired ? "stale" : ($("connection").dataset.state as "live" | "stale" | "connecting") || "connecting");
});
function connection(status: "live" | "stale" | "connecting"): void {
  if (serviceSessionExpired) status = "stale";
  const element = $("connection"); element.dataset.state = status;
  element.replaceChildren(text("span", "", "connection-dot"), document.createTextNode(status === "live" ? "实时" : status === "stale" ? "数据过期" : "连接中"));
  const notice = $("connection-notice"); notice.hidden = status !== "stale";
  if (status === "stale") notice.textContent = serviceSessionExpired ? "登录已过期，请重新连接。当前显示最后一次有效快照。" : data ? "连接中断，当前显示最后一次有效快照。恢复连接后会重新获取视图。" : "首次加载失败，暂时无法读取编排视图。";
}
function stateValidation() {
  return { groups: new Set(data?.groups.map((item) => item.id) ?? []), states: defaultStates, kinds: defaultKinds, plans: new Set(data?.plans.map((item) => item.id) ?? []), tasks: new Set(data?.tasks.map((item) => item.id) ?? []) };
}
function syncUrl(): void {
  const phaseDefaultTab = phase === "execution" ? "actual" : DEFAULT_VIEW_STATE.tab;
  replaceViewState(viewState, activePlanId || null, phaseDefaultTab);
}
function filterFromControls(): void {
  viewState = { ...viewState, query: $<HTMLInputElement>("search").value.trim(), group: menuValue("group-filter"), state: menuValue("state-filter"), kind: menuValue("kind-filter") };
  syncUrl();
}
function filteredTasks(): Task[] {
  if (!data) return [];
  const query = viewState.query.toLocaleLowerCase();
  return data.tasks.filter((task) => (!query || `${task.title} ${task.id}`.toLocaleLowerCase().includes(query)) && (!viewState.group || task.group_id === viewState.group) && (!viewState.kind || task.kind === viewState.kind) && (!viewState.state || (viewState.state === "ready" ? task.is_ready && task.state === "planned" : task.state === viewState.state)));
}
type MenuId = "theme" | "version" | "group-filter" | "state-filter" | "kind-filter";
type MenuItem = { value: string; label: string };
const menuValues: Record<MenuId, string> = { theme: "system", version: "", "group-filter": "", "state-filter": "", "kind-filter": "" };
function menuTrigger(id: MenuId): HTMLButtonElement { return $(`${id}-trigger`) as HTMLButtonElement; }
function menuValue(id: MenuId): string { return menuTrigger(id).dataset.value ?? menuValues[id]; }
function setMenuValue(id: MenuId, value: string): void {
  const trigger = menuTrigger(id);
  trigger.dataset.value = value;
  menuValues[id] = value;
  const option = document.querySelector<HTMLElement>(`#${id}-menu [data-menu-value="${CSS.escape(value)}"]`);
  $(`${id}-value`).textContent = option?.textContent ?? value;
  for (const item of document.querySelectorAll<HTMLElement>(`#${id}-menu [role="option"]`)) item.setAttribute("aria-selected", String(item.dataset.menuValue === value));
}
function closeMenus(): void {
  for (const menu of document.querySelectorAll<HTMLElement>(".custom-menu")) menu.hidden = true;
  for (const trigger of document.querySelectorAll<HTMLButtonElement>(".menu-trigger, .theme-trigger")) trigger.setAttribute("aria-expanded", "false");
}
function openMenu(id: MenuId): void {
  closeMenus();
  const menu = $(`${id}-menu`); const trigger = menuTrigger(id);
  menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
  const selected = menu.querySelector<HTMLElement>(`[data-menu-value="${CSS.escape(menuValue(id))}"]`);
  (selected ?? menu.querySelector<HTMLElement>("[role=option]"))?.focus();
}
function chooseMenu(id: MenuId, value: string): void {
  const trigger = menuTrigger(id);
  setMenuValue(id, value); closeMenus();
  if (id === "theme") { focusAfterRerender(trigger, trigger); void saveTheme(value as Theme); return; }
  viewState = { ...viewState, ...(id === "group-filter" ? { group: value } : id === "state-filter" ? { state: value } : { kind: value }) };
  syncUrl(); render(); focusAfterRerender(trigger, trigger);
}
function updateVersionMenu(): void {
  if (!data) return;
  const menu = $("version-menu"); menu.replaceChildren();
  const defaultPlan = activePlanId || data.selected_plan_id;
  for (const plan of data.plans) {
    const listItem = document.createElement("li"); const option = document.createElement("a");
    const selected = (activePlan || defaultPlan) === plan.id;
    option.href = canonicalViewUrl(window.location.href, { ...viewState, plan: plan.id === defaultPlan ? null : plan.id }, defaultPlan, phase === "execution" ? "actual" : DEFAULT_VIEW_STATE.tab);
    option.role = "option"; option.dataset.menuValue = plan.id; option.setAttribute("aria-selected", String(selected)); option.textContent = plan.id;
    option.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); activePlan = plan.id === defaultPlan ? "" : plan.id; viewState = { ...viewState, plan: activePlan || null }; closeMenus(); syncUrl(); focusAfterRerender($("version-trigger"), $("version-trigger")); void refresh();
    });
    listItem.append(option); menu.append(listItem);
  }
  setMenuValue("version", activePlan || defaultPlan);
}
function updateMenu(id: MenuId, items: MenuItem[], placeholder?: string): void {
  if (id === "theme" || id === "version") return;
  const menu = $(`${id}-menu`); menu.replaceChildren();
  const options = placeholder ? [{ value: "", label: placeholder }, ...items] : items;
  for (const item of options) {
    const listItem = document.createElement("li"); const option = document.createElement("button");
    option.type = "button"; option.role = "option"; option.dataset.menuValue = item.value; option.textContent = item.label;
    option.addEventListener("click", () => chooseMenu(id, item.value)); listItem.append(option); menu.append(listItem);
  }
}
function renderSummary(): void {
  if (!data) return;
  const summary = clear("summary");
  const tasks = data.tasks;
  const entries = [["就绪", tasks.filter((task) => task.is_ready && task.state === "planned").length, "ready"], ["执行中", `${tasks.filter((task) => ["starting", "running"].includes(task.state)).length}/${data.orchestration.max_running_tasks}`, "running"], ["阻塞", tasks.filter((task) => task.state === "blocked").length, "blocked"], ["已集成", tasks.filter((task) => task.state === "integrated").length, "integrated"], ["已收口", tasks.filter((task) => task.state === "closed").length, "closed"]] as const;
  const iconNames: Record<string, string> = { ready: "circle-dot", running: "circle-play", blocked: "circle-alert", integrated: "git-merge", closed: "circle-check" };
  for (const [name, count, status] of entries) { const row = text("div", "", "summary-item"); row.dataset.status = status; const icon = text("span", "", "summary-icon"); icon.setAttribute("aria-hidden", "true"); const iconElement = document.createElement("i"); iconElement.dataset.lucide = iconNames[status]; icon.append(iconElement); row.append(icon, text("span", name, "summary-label"), text("strong", String(count))); summary.append(row); }
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
  for (const [id, layout] of [["task-layout-board", "board"], ["task-layout-grid", "grid"]] as const) $<HTMLButtonElement>(id).setAttribute("aria-pressed", String(viewState.layout === layout));
  $("group-section").hidden = viewState.layout === "board";
  const heading = $(viewState.layout === "board" ? "task-heading" : "group-heading").parentElement!;
  const actions = document.querySelector<HTMLElement>(".section-heading-actions")!;
  if (actions.parentElement !== heading) {
    const focused = actions.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    heading.append(actions);
    focused?.focus({ preventScroll: true });
  }
}
function syncStableGridCardWidth(): void {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  const card = document.querySelector<HTMLElement>("#task-list.task-layout-grid .task-card");
  if (!workspace || !card) return;
  if (window.innerWidth >= 768 && window.innerWidth <= 1444) {
    workspace.style.removeProperty("--stable-task-card-width");
    return;
  }
  const surfaceIsOpen = workspace.classList.contains("has-details") || workspace.classList.contains("has-overlay-selection");
  const existing = workspace.style.getPropertyValue("--stable-task-card-width");
  if (surfaceIsOpen && existing) return;
  const wasDetails = workspace.classList.contains("has-details");
  const wasOverlay = workspace.classList.contains("has-overlay-selection");
  const stableWidth = workspace.style.getPropertyValue("--stable-task-card-width");
  workspace.classList.remove("has-details", "has-overlay-selection");
  workspace.style.removeProperty("--stable-task-card-width");
  const width = Math.round(card.getBoundingClientRect().width);
  workspace.classList.toggle("has-details", wasDetails);
  workspace.classList.toggle("has-overlay-selection", wasOverlay);
  if (stableWidth) workspace.style.setProperty("--stable-task-card-width", stableWidth);
  if (width > 0) workspace.style.setProperty("--stable-task-card-width", `${width}px`);
}
function setTaskLayout(layout: TaskLayout): void {
  if (viewState.layout === layout) return;
  viewState = { ...viewState, layout };
  syncUrl();
  if (data) { hideHoverPreview(); hoverBridge?.resetTargets(); renderList(filteredTasks()); syncStableGridCardWidth(); createIcons({ icons: ICONS }); showCurrentSelectionPreview(); }
}
const cardRenderer = createCardRenderer({
  getData: () => data,
  getLayout: () => viewState.layout,
  getSelectedTask: () => selectedTask,
  getSelectedGroup: () => selectedGroup,
  labels,
  safeExternal,
  groupRange,
  selectTask: (id) => selectTask(id),
  selectGroup: (id) => selectGroup(id),
  setKeyboardSelection: () => { keyboardSelection = true; },
  updateTaskLayoutControls,
  bindTaskHover: (target, task) => hoverController.bindHoverTarget(target, taskPreview(task)),
  bindGroupHover: (target, group) => hoverController.bindHoverTarget(target, groupPreview(group)),
});
const { renderList, renderGroups } = cardRenderer;
function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
function safeExternal(url: string | null): string | null { if (!url || !data) return null; try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === data.orchestration.repository.host && !parsed.port && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; } }
function taskRange(tasks: Task[]): { start: string | null; end: string | null } {
  return rangeFromIntervals(tasks.map((task) => ({ start: task.started_at, end: task.finished_at })));
}
function groupRange(groupId: string, tasks: Task[]): { start: string | null; end: string | null } {
  const historical = data?.actual_intervals.filter((interval) => interval.group_id === groupId) ?? [];
  return historical.length ? rangeFromIntervals(historical) : taskRange(tasks);
}
let profileCapabilities: ProfileCapabilities | null = null;
let profileCapabilityError = "正在读取模型能力…";
async function loadProfileCapabilities(): Promise<void> {
  try {
    const response = await fetch("api/execution-profile");
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.capabilities)) throw new Error(result.message ?? "模型能力目录不可用，暂时无法编辑");
    profileCapabilities = result.capabilities;
    profileCapabilityError = "";
  } catch (cause) { profileCapabilityError = cause instanceof Error ? cause.message : String(cause); }
}
async function updateProfile(targetType: ProfileTarget, targetId: string, profile: { model: string; thinking: string } | null, recommend = false): Promise<void> {
  if (!data?.orchestration.owner_thread_id) throw new Error("主会话身份不可用");
  const response = await fetch("api/execution-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run_id: data.orchestration.id, actor: { role: "main", thread_id: data.orchestration.owner_thread_id }, request_id: `profile-${crypto.randomUUID()}`, expected_revision: data.orchestration.revision, payload: { target_type: targetType, target_id: targetId, execution_profile: profile, recommend } }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? result.error ?? "配置保存失败");
  await refresh();
}
const detailContent = createDetailContent({ getData: () => data, labels, labelTask: label, time, safeExternal, groupRange, profileContext: () => ({ capabilities: profileCapabilities, capabilityError: profileCapabilityError, update: updateProfile }) });
const { clearDetails, showTask, showGroup, taskPreview, groupPreview } = detailContent;
const hasSelectedObject = (): boolean => Boolean(
  (selectedTask && data?.tasks.some((task) => task.id === selectedTask))
  || (selectedGroup && data?.groups.some((group) => group.id === selectedGroup)),
);
function canUseDetailsPanel(): boolean {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  return detailsPanelFits(workspace?.getBoundingClientRect().width ?? 0);
}
const hoverController = createHoverController({
  element: $,
  getData: () => data,
  getViewState: () => viewState,
  getSelected: () => ({ task: selectedTask, group: selectedGroup }),
  getKeyboardSelection: () => keyboardSelection,
  getBridge: () => hoverBridge,
  getAnyHover: () => anyHoverCapability.matches,
  getAnyFinePointer: () => anyFinePointerCapability.matches,
  getDetailPanelViewport: canUseDetailsPanel,
  taskPreview,
  groupPreview,
  updateDetailsSurface,
  focusSelectedObject: () => hoverController.focusSelectedObject(),
});
const { supportsHoverDetails, showHoverPreview, hideHoverPreview, recordPointerType, showCurrentSelectionPreview, dismiss: dismissHoverPreview, pointerTypeFromEvent } = hoverController;
function updateDetailsSurface(open: boolean, focus = false): ReturnType<typeof resolveDetailSurface> {
  const detailPanelViewport = canUseDetailsPanel();
  const drawerViewport = window.innerWidth < DETAILS_PANEL_BREAKPOINT;
  const surface = resolveDetailSurface({ selected: hasSelectedObject(), detailOpen: open, hoverCapable: supportsHoverDetails(), keyboardSelection, detailPanelViewport, drawerViewport });
  applyDetailSurface({ workspace: document.querySelector<HTMLElement>(".workspace")!, background: [document.querySelector<HTMLElement>(".topbar")!, document.querySelector<HTMLElement>(".overview")!, document.querySelector<HTMLElement>(".workspace-main")!], details: $("details"), detailsBackdrop: $("details-backdrop"), hoverPreview: $("hover-preview"), closeDetails: $("close-details") }, surface, detailPanelViewport, focus);
  return surface;
}
const timelineController = createTimelineController({
  getData: () => data,
  getViewState: () => viewState,
  setViewState: (next) => { viewState = next; },
  syncUrl,
  element: $,
  css,
  groupColor,
  stateColor,
  labels,
  taskPreview,
  showHoverPreview,
  hideHoverPreview,
  recordPointerType,
  selectTask,
});
const graphController = createGraphController({
  element: $,
  getData: () => data,
  getViewState: () => viewState,
  setZoom: (zoom) => { viewState = { ...viewState, zoom }; syncUrl(); },
  css,
  stateColor,
  groupColor,
  taskPreview,
  groupPreview,
  showHoverPreview,
  hideHoverPreview,
  recordPointerType,
  selectTask,
  selectGroup,
  getSelected: () => ({ task: selectedTask, group: selectedGroup }),
});
function openDetails(): void { updateDetailsSurface(true, true); }
function restoreClosedDetails(): void {
  const selection = selectedTask ? { kind: "task" as const, id: selectedTask } : selectedGroup ? { kind: "group" as const, id: selectedGroup } : null;
  const fallback = selectedObjectFocusSelector(selection);
  focusAfterRerender(lastFocus, (fallback ? firstVisibleElement(document, fallback) : null) ?? $("search"));
  if (lastScrollTop !== null) {
    const scrollTop = lastScrollTop;
    window.requestAnimationFrame(() => window.scrollTo({ top: scrollTop, left: window.scrollX, behavior: "auto" }));
    lastScrollTop = null;
  }
}
function closeDetails(): void { hideHoverPreview(); keyboardSelection = false; viewState = { ...viewState, detail: false }; syncUrl(); updateDetailsSurface(false); syncStableGridCardWidth(); restoreClosedDetails(); }
function trapDetailsFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const details = $("details");
  if (!details.classList.contains("open")) return;
  const focusable = [...details.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden);
  if (!focusable.length) { event.preventDefault(); details.focus(); return; }
  const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function refreshResponsiveDetails(): void {
  hideHoverPreview();
  if (!data) return;
  const surface = updateDetailsSurface(viewState.detail, viewState.detail);
  if (surface === "hover-preview" && viewState.detail) {
    const selection = selectedTask ? { kind: "task" as const, id: selectedTask } : selectedGroup ? { kind: "group" as const, id: selectedGroup } : null;
    const selector = selectedObjectFocusSelector(selection);
    const selectedTarget = selector ? firstVisibleElement(document, selector) : null;
    focusAfterRerender(null, selectedTarget ?? firstVisibleElement(document, ".task-card-select, .task-column-select") ?? $("search"));
    showCurrentSelectionPreview();
  }
}
function restoreSelectedFocus(selection: { kind: "task" | "group"; id: string }): void { const selector = selectedObjectFocusSelector(selection); focusAfterRerender(lastFocus, selector ? firstVisibleElement(document, selector) : null); }
function selectGroup(id: string): void { if (!data) return; if (selectedGroup === id && viewState.detail) { closeDetails(); return; } const group = data.groups.find((item) => item.id === id); if (!group) return; hideHoverPreview(); hoverBridge?.resetTargets(); lastFocus = document.activeElement as HTMLElement; lastScrollTop = window.scrollY; selectedGroup = id; selectedTask = null; viewState = { ...viewState, selected: { kind: "group", id }, detail: true }; syncUrl(); showGroup(group); renderGroups(); renderList(filteredTasks()); syncStableGridCardWidth(); graphController.highlightSelection(); createIcons({ icons: ICONS }); openDetails(); restoreSelectedFocus({ kind: "group", id }); showCurrentSelectionPreview(); }
function selectTask(id: string): void { if (!data) return; if (selectedTask === id && viewState.detail) { closeDetails(); return; } const task = data.tasks.find((item) => item.id === id); if (!task) return; hideHoverPreview(); hoverBridge?.resetTargets(); lastFocus = document.activeElement as HTMLElement; lastScrollTop = window.scrollY; selectedTask = id; selectedGroup = null; viewState = { ...viewState, selected: { kind: "task", id }, detail: true }; syncUrl(); showTask(task); renderGroups(); renderList(filteredTasks()); syncStableGridCardWidth(); graphController.highlightSelection(); createIcons({ icons: ICONS }); openDetails(); restoreSelectedFocus({ kind: "task", id }); showCurrentSelectionPreview(); }
function applyStateToControls(): void { $<HTMLInputElement>("search").value = viewState.query; setMenuValue("group-filter", viewState.group); setMenuValue("state-filter", viewState.state); setMenuValue("kind-filter", viewState.kind); }
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
  const selector = focus.kind === "task" ? `[data-task-id="${CSS.escape(focus.id)}"]` : `[data-group-id="${CSS.escape(focus.id)}"]`;
  const container = firstVisibleElement(document, selector);
  const target = (focus.href && container ? [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].find((link) => link.href === focus.href) : null)
    ?? (container ? container.querySelector<HTMLElement>("button") : null)
    ?? firstVisibleElement(document, ".task-card-select, .task-column-select")
    ?? $("search");
  target.focus();
}
type MenuFocus = { id: MenuId; value: string } | null;
function captureMenuFocus(): MenuFocus {
  const active = document.activeElement as HTMLElement | null;
  const container = active?.closest<HTMLElement>("[data-menu]");
  const option = active?.closest<HTMLElement>("[role=option]");
  const id = container?.dataset.menu as MenuId | undefined;
  return id && option?.dataset.menuValue !== undefined ? { id, value: option.dataset.menuValue } : null;
}
function restoreMenuFocus(focus: MenuFocus): void {
  if (!focus || menuTrigger(focus.id).getAttribute("aria-expanded") !== "true") return;
  const option = [...document.querySelectorAll<HTMLElement>(`#${focus.id}-menu [role=option]`)].find((item) => item.dataset.menuValue === focus.value);
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
  if (!focus || !viewState.detail) return;
  const target = "href" in focus
    ? [...document.querySelectorAll<HTMLAnchorElement>("#details a")].find((link) => link.href === focus.href)
    : document.getElementById(focus.id);
  target?.focus();
}
function render(): void {
  const runProfileControl = document.getElementById("run-profile-control");
  if (runProfileControl && data) runProfileControl.replaceChildren(createProfileEditor({ capabilities: profileCapabilities, capabilityError: profileCapabilityError, update: updateProfile }, "run", data.orchestration.id, data.orchestration.execution_profile ?? null, data.orchestration.execution_profile ?? null, data.profile_read_only ? "当前视图只读或尚未迁移" : null));
  if (!data) return;
  const listFocus = captureListFocus();
  const menuFocus = captureMenuFocus();
  const detailFocus = captureDetailFocus();
  hideHoverPreview();
  hoverBridge?.resetTargets();
  $("project-name").textContent = `${data.orchestration.repository.owner} / ${data.orchestration.repository.name}`; $("updated").replaceChildren(document.createTextNode("数据更新 "), renderTimestamp(data.orchestration.updated_at));
  $("revision").textContent = `rev ${data.orchestration.revision}`;
  const currentPhase = derivePhase(data.tasks, data.execution_phase); phase = currentPhase;
  $("operation-warning").hidden = data.warnings.length === 0; $("operation-warning").textContent = data.warnings.length ? `${data.warnings.length} 项外部操作结果待核实。` : "";
  const planWarnings = data.plan_warnings ?? [];
  const planWarning = $("plan-warning");
  planWarning.hidden = viewState.tab !== "planned" || planWarnings.length === 0;
  planWarning.textContent = planWarnings.some((warning) => warning.code === "missing_start_at")
    ? "理论安排暂不可计算：当前计划未设置开始时间。请在计划版本中补充计划开始时间后重新生成或批准计划。"
    : planWarnings.map((warning) => warning.reason).join(" ");
  updateMenu("group-filter", data.groups.map((group) => ({ value: group.id, label: group.title })), "全部交付单元"); updateMenu("state-filter", [...defaultStates].filter((key) => !["active", "merged"].includes(key)).map((value) => ({ value, label: value === "ready" ? "就绪" : labels[value] ?? value })), "全部状态"); updateMenu("kind-filter", ["contribution", "release", "deployment", "verification", "coordination"].map((value) => ({ value, label: taskKindLabel(value) })), "全部任务类型"); updateVersionMenu();
  setMenuValue("group-filter", viewState.group); setMenuValue("state-filter", viewState.state); setMenuValue("kind-filter", viewState.kind); $("graph-tools").hidden = viewState.tab !== "graph"; $("timeline-tools").hidden = viewState.tab === "graph"; applyStateToControls(); renderSummary(); const tasks = filteredTasks(); $("task-count").textContent = `${tasks.length} / ${data.tasks.length} 个任务`; $("view-context").textContent = viewState.tab === "graph" ? "依赖关系" : viewState.tab === "planned" ? "理论安排" : "实际运行"; $("view-count").textContent = `${tasks.length} 项任务 · ${data.groups.length} 个交付单元`; renderGroups(); renderList(tasks); syncStableGridCardWidth(); setTabAria(viewState.tab); if (viewState.tab === "graph") graphController.render(tasks); else timelineController.renderTimeline(tasks, viewState.tab); const focusDetails = focusDetailsOnNextRender; focusDetailsOnNextRender = false; updateDetailsSurface(viewState.detail, focusDetails); const selectedTaskData = selectedTask ? data.tasks.find((item) => item.id === selectedTask) : null; const selectedGroupData = selectedGroup ? data.groups.find((item) => item.id === selectedGroup) : null; if (selectedTaskData) showTask(selectedTaskData); else if (selectedGroupData) showGroup(selectedGroupData); else clearDetails(); createIcons({ icons: ICONS }); showCurrentSelectionPreview(); restoreListFocus(listFocus);
  restoreMenuFocus(menuFocus);
  restoreDetailFocus(detailFocus);
  if (restoreClosedDetailsOnNextRender) { restoreClosedDetailsOnNextRender = false; restoreClosedDetails(); }
  if (phaseTransition) { $("phase-notice").hidden = false; $("phase-notice-text").textContent = "已有真实任务开始执行，阶段已切换；当前视图和筛选保持不变。"; } else $("phase-notice").hidden = true;
}
function setTabAria(tab: DashboardTab): void { for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === tab)); for (const name of ["graph", "planned", "actual"]) $(`${name}-view`).hidden = name !== tab; }
function setTab(tab: DashboardTab, user = true): void { viewState = { ...viewState, tab }; if (user) userChangedTab = true; syncUrl(); render(); }
async function refresh(): Promise<void> {
  const serial = ++requestSerial;
  const outputEpoch = outputSnapshots.epoch;
  const requestedPlan = activePlan;
  try {
    const query = requestedPlan ? `?plan=${encodeURIComponent(requestedPlan)}` : ""; let response = await fetch(`api/view${query}`, { cache: "no-store" });
    if (response.status === 404 && requestedPlan) { if (serial !== requestSerial) return; activePlan = ""; viewState = { ...viewState, plan: null }; syncUrl(); response = await fetch("api/view", { cache: "no-store" }); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let result = await response.json() as ViewResponse;
    if (!viewState.plan && requestedPlan && result.active_plan_id !== requestedPlan) {
      if (serial !== requestSerial) return;
      activePlan = "";
      response = await fetch("api/view", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      result = await response.json() as ViewResponse;
    }
    if (serial !== requestSerial || result.revision < revision) return;
    const previousPhase = phase; revision = result.revision; activePlanId = result.active_plan_id; data = result.view; applyOutputs({ output_epoch: result.output_epoch ?? "static-demo", output_revision: result.output_revision ?? 0, outputs: Object.fromEntries([...data.tasks.map(t => [t.id, t.latest_agent_output ?? initialOutput(t.thread_id)]), ...data.groups.map(g => [`group:${g.id}`, g.latest_agent_output ?? initialOutput(g.agent_thread_id)])]) }, outputEpoch); const currentPhase = derivePhase(data.tasks, data.execution_phase);
    if (!hydrated && !userChangedTab && !hasValidTabParam(window.location.search)) viewState = { ...viewState, tab: defaultTabForPhase(currentPhase) };
    viewState = sanitizeViewState(viewState, stateValidation()); selectedTask = viewState.selected?.kind === "task" ? viewState.selected.id : null; selectedGroup = viewState.selected?.kind === "group" ? viewState.selected.id : null; activePlan = viewState.plan ?? data.selected_plan_id;
    if (previousPhase === "planning" && currentPhase === "execution") phaseTransition = true; phase = currentPhase; const shouldFocusRestoredDetails = !hydrated && viewState.detail; hydrated = true; if (shouldFocusRestoredDetails) focusDetailsOnNextRender = true; syncUrl(); connection(deriveConnectionStatus(connected, result.watching)); $("load-error").hidden = true; render();
  } catch (error) { if (serial !== requestSerial) return; connection("stale"); if (!data) { $("load-error").hidden = false; $("load-error").textContent = `首次加载失败：${error instanceof Error ? error.message : "无法读取数据"}`; } }
}
async function loadTheme(): Promise<void> { const serial = ++themeRequestSerial; await themeWriteQueue; try { const response = await fetch("api/preferences", { cache: "no-store" }); if (!response.ok) return; const loaded = (await response.json() as { theme: Theme }).theme; if (serial === themeRequestSerial) applyTheme(loaded); } catch {} }
function applyTheme(theme: Theme): void { document.documentElement.dataset.theme = theme; setMenuValue("theme", theme); }
async function saveTheme(theme: Theme): Promise<void> { const serial = ++themeRequestSerial; const trigger = menuTrigger("theme"); applyTheme(theme); trigger.removeAttribute("aria-invalid"); const write = async (): Promise<void> => { try { const response = await fetch("api/preferences", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme }) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); } catch { if (serial === themeRequestSerial) trigger.setAttribute("aria-invalid", "true"); } }; themeWriteQueue = themeWriteQueue.then(write, write); await themeWriteQueue; }

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) button.addEventListener("click", () => setTab(button.dataset.tab as DashboardTab));
$("search").addEventListener("input", () => { filterFromControls(); render(); });
for (const id of ["theme", "version", "group-filter", "state-filter", "kind-filter"] as MenuId[]) menuTrigger(id).addEventListener("click", () => { if (menuTrigger(id).getAttribute("aria-expanded") === "true") closeMenus(); else openMenu(id); });
for (const option of document.querySelectorAll<HTMLButtonElement>("#theme-menu [role=option]")) option.addEventListener("click", () => chooseMenu("theme", option.dataset.menuValue ?? "system"));
$("version-menu").addEventListener("keydown", (event) => { if (event.key !== "Enter" && event.key !== " ") return; const option = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[role=option]"); if (!option) return; event.preventDefault(); event.stopPropagation(); option.click(); }, true);
$("task-layout-board").addEventListener("click", () => setTaskLayout("board")); $("task-layout-grid").addEventListener("click", () => setTaskLayout("grid"));
document.addEventListener("click", (event) => { const target = event.target as HTMLElement; if (!target.closest("[data-menu]")) closeMenus(); if (viewState.detail && $("details").classList.contains("open") && !isDetailInteraction(target)) closeDetails(); });
document.addEventListener("pointerdown", (event) => { keyboardSelection = false; recordPointerType(event.pointerType); }, true); document.addEventListener("pointermove", (event) => recordPointerType(event.pointerType), true);
document.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && (event.target as HTMLElement).closest(".task-card-select, .task-column-select, .task-row")) keyboardSelection = true; }, true);
document.addEventListener("keydown", (event) => { const target = event.target as HTMLElement; const trigger = target.closest<HTMLButtonElement>(".menu-trigger, .theme-trigger"); const option = target.closest<HTMLButtonElement>("[role=option]"); if (event.key === "Escape" && trigger) { event.preventDefault(); event.stopPropagation(); closeMenus(); trigger.focus(); } else if (trigger && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) { event.preventDefault(); const id = trigger.id.replace(/-trigger$/, "") as MenuId; openMenu(id); } else if (option && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); const options = [...option.closest<HTMLElement>("[role=listbox]")!.querySelectorAll<HTMLButtonElement>("[role=option]")]; const index = options.indexOf(option); options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus(); } else if (option && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); const menu = option.closest<HTMLElement>("[role=listbox]"); const id = menu?.id.replace(/-menu$/, "") as MenuId; chooseMenu(id, option.dataset.menuValue ?? ""); } else if (option && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenus(); menuTrigger(option.closest<HTMLElement>("[role=listbox]")?.id.replace(/-menu$/, "") as MenuId).focus(); } });
$("close-details").addEventListener("click", closeDetails); $("details-backdrop").addEventListener("click", closeDetails); $("phase-jump").addEventListener("click", () => { phaseTransition = false; setTab("actual"); });
$("zoom-in").addEventListener("click", () => graphController.zoomIn()); $("zoom-out").addEventListener("click", () => graphController.zoomOut()); $("fit").addEventListener("click", () => graphController.fit());
$("timeline-zoom-in").addEventListener("click", () => timelineController.adjustWindow("in")); $("timeline-zoom-out").addEventListener("click", () => timelineController.adjustWindow("out")); $("timeline-fit").addEventListener("click", () => timelineController.fit());
installViewStateNavigation(window, { getSearch: () => window.location.search, getValidation: (search) => { const targetPlan = search ? new URLSearchParams(search).get("plan") : null; if (targetPlan !== viewState.plan) return { plans: new Set(data?.plans.map((plan) => plan.id) ?? []) }; return data ? stateValidation() : {}; }, getPhase: () => data ? phase ?? derivePhase(data.tasks) : null, restore: (next, hasExplicitTab) => { const planChanged = next.plan !== viewState.plan; const closingDetails = viewState.detail && !next.detail; userChangedTab = hasExplicitTab; if (closingDetails) { keyboardSelection = false; hideHoverPreview(); restoreClosedDetailsOnNextRender = true; } viewState = next; selectedTask = next.selected?.kind === "task" ? next.selected.id : null; selectedGroup = next.selected?.kind === "group" ? next.selected.id : null; activePlan = next.plan ?? ""; if (next.detail) focusDetailsOnNextRender = true; if (planChanged) void refresh(); else if (data) render(); } });
window.addEventListener("keydown", (event) => { trapDetailsFocus(event); if (event.key === "Escape" && viewState.detail) closeDetails(); });
window.addEventListener("resize", () => { refreshResponsiveDetails(); if (data && viewState.tab === "graph" && graphController.rankDir() !== (window.innerWidth < 768 ? "TB" : "LR")) graphController.render(filteredTasks()); window.requestAnimationFrame(() => timelineController.redraw()); });
anyHoverCapability.addEventListener("change", refreshResponsiveDetails); anyFinePointerCapability.addEventListener("change", refreshResponsiveDetails);
const stream = new EventSource("api/events"); stream.addEventListener("open", () => { connected = true; connection("live"); void refresh(); }); stream.addEventListener("revision", () => void refresh()); stream.addEventListener("stale", () => { connected = false; connection("stale"); }); stream.addEventListener("heartbeat", (event) => { try { if (JSON.parse((event as MessageEvent).data).watching && !connected) { connected = true; void refresh(); } } catch { connection("stale"); } }); stream.addEventListener("error", () => { connected = false; connection("stale"); });
hoverBridge = createHoverPreviewBridge($("hover-preview"), dismissHoverPreview);
window.setInterval(refreshCardDurations, 60_000);
connection("connecting"); void loadTheme(); void refresh();

stream.addEventListener("agent-output", event => {
  try { applyOutputs(JSON.parse((event as MessageEvent).data) as OutputSnapshot); } catch { connection("stale"); }
});
void loadProfileCapabilities().then(() => { if (data) render(); });
