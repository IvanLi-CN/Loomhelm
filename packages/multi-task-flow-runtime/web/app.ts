import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  ArrowDown,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CirclePlay,
  Columns3,
  Contrast,
  Copy,
  createIcons,
  GitMerge,
  GitPullRequest,
  Hourglass,
  Info,
  LayoutGrid,
  List,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minus,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sun,
  SunMoon,
  TreePalm,
  X,
} from "lucide";
import moment from "moment";
import { OutputSnapshots } from "./agent-output";
import { type AppDataState, createAppDataController, type WorkerDiagnostic } from "./app-data";
import { installAppEvents } from "./app-events";
import { createAppPlanInfoController } from "./app-plan-info";
import { createAppViewController } from "./app-view";
import { createAtomicGraphController } from "./atomic-graph-view";
import { createCardRenderer } from "./cards";
import { applyDetailSurface, installDetailViewport } from "./detail-surface";
import { createDetailContent } from "./details-content";
import { firstVisibleElement, focusAfterRerender } from "./focus";
import { createGraphController } from "./graph";
import { createHoverController } from "./hover-controller";
import type { HoverPreviewBridge } from "./hover-preview";
import {
  DETAILS_PANEL_BREAKPOINT,
  detailsPanelFits,
  resolveDetailSurface,
  selectedObjectFocusSelector,
} from "./interaction-policy";
import { STATE_LABELS, taskKindLabel } from "./labels";
import type { Theme, View } from "./model";
import type { DisplayPhase } from "./phase";
import type { ProfileCapabilities, ProfileTarget } from "./profile-editor";
import { type RuntimeMetadata, runtimeWithEmbeddedViewer } from "./runtime-metadata";
import { installTaskContextMenu } from "./task-context-menu";
import { createTimelineController } from "./timeline";
import { installTextTooltips } from "./tooltip";
import { hasValidTabParam, parseViewState, type ViewState } from "./view-state";

const ICONS = {
  Contrast,
  Network,
  Search,
  X,
  Plus,
  Minus,
  Maximize2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  CirclePlay,
  LoaderCircle,
  Hourglass,
  CircleAlert,
  CircleHelp,
  CircleCheck,
  GitMerge,
  Columns3,
  LayoutGrid,
  MessageCircle,
  GitPullRequest,
  TreePalm,
  ArchiveX,
  ArchiveRestore,
  Archive,
  ArrowDown,
  ArrowRight,
  RefreshCw,
  Info,
  Copy,
  List,
  Settings2,
  SunMoon,
  Sun,
  Moon,
};
installTextTooltips();
createIcons({ icons: ICONS });
moment.defineLocale("zh-task", {
  parentLocale: "en",
  months: "一月_二月_三月_四月_五月_六月_七月_八月_九月_十月_十一月_十二月".split("_"),
  monthsShort: "1月_2月_3月_4月_5月_6月_7月_8月_9月_10月_11月_12月".split("_"),
  weekdays: "星期日_星期一_星期二_星期三_星期四_星期五_星期六".split("_"),
  weekdaysShort: "周日_周一_周二_周三_周四_周五_周六".split("_"),
  weekdaysMin: "日_一_二_三_四_五_六".split("_"),
});
moment.locale("zh-task");
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
installDetailViewport($("details"));
const palette = ["#1b6c80", "#2f70bb", "#a86f0c", "#6f7880", "#1e7b4f", "#8a6470"];
const labels = STATE_LABELS;
const statusColors: Record<string, string> = {
  agent_idle: "#a86f0c",
  planned: "#8a9295",
  ready: "#2f70bb",
  starting: "#2f70bb",
  running: "#2f70bb",
  waiting: "#a86f0c",
  blocked: "#c4242a",
  integrated: "#1e7b4f",
  completed: "#1e7b4f",
  closed: "#71797d",
  merged: "#1e7b4f",
};
const defaultStates = new Set(
  Object.keys(labels).filter((key) => !["active", "merged", "unknown", "idle"].includes(key)),
);
const defaultKinds = new Set([
  "contribution",
  "release",
  "deployment",
  "verification",
  "coordination",
  "development",
  "other",
]);
let data: View | null = null;
let runtimeMetadata: RuntimeMetadata | null = runtimeWithEmbeddedViewer(null, document);
let viewState: ViewState = parseViewState(window.location.search);
let selectedTask: string | null =
  viewState.selected?.kind === "task" ? viewState.selected.id : null;
let selectedGroup: string | null =
  viewState.selected?.kind === "group" ? viewState.selected.id : null;
let selectedMilestone: string | null =
  viewState.selected?.kind === "milestone" ? viewState.selected.id : null;
let activePlan = viewState.plan ?? "";
let activePlanId = "";
let connected = false;
const requestSerial = 0;
const themeRequestSerial = 0;
const themeWriteQueue: Promise<void> = Promise.resolve();
let phase: DisplayPhase | null = null;
let phaseTransition = false;
let hydrated = false;
let missingLinkedTask: string | null = null;
let userChangedTab = hasValidTabParam(window.location.search);
let lastFocus: HTMLElement | null = null;
let _lastScrollTop: number | null = null;
let focusDetailsOnNextRender = false;
let keyboardSelection = false;
let hoverBridge: HoverPreviewBridge | null = null;
let restoreClosedDetailsOnNextRender = false;
let planInfoLastFocus: HTMLElement | null = null;
let serviceSessionExpired = false;
let workerDiagnostic: WorkerDiagnostic | null = null;
let reconnectBlocked = false;
const anyHoverCapability = window.matchMedia("(any-hover: hover)");
const anyFinePointerCapability = window.matchMedia("(any-pointer: fine)");
const outputSnapshots = new OutputSnapshots();

const appState: AppDataState & {
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
  planInfoLastFocus: HTMLElement | null;
  connected: boolean;
  keyboardSelection: boolean;
} = {
  get data() {
    return data;
  },
  set data(value) {
    data = value;
  },
  get runtimeMetadata() {
    return runtimeMetadata;
  },
  set runtimeMetadata(value) {
    runtimeMetadata = value;
  },
  get viewState() {
    return viewState;
  },
  set viewState(value) {
    viewState = value;
  },
  get activePlan() {
    return activePlan;
  },
  set activePlan(value) {
    activePlan = value;
  },
  get activePlanId() {
    return activePlanId;
  },
  set activePlanId(value) {
    activePlanId = value;
  },
  get phase() {
    return phase;
  },
  set phase(value) {
    phase = value;
  },
  get hydrated() {
    return hydrated;
  },
  set hydrated(value) {
    hydrated = value;
  },
  get serviceSessionExpired() {
    return serviceSessionExpired;
  },
  set serviceSessionExpired(value) {
    serviceSessionExpired = value;
  },
  get workerDiagnostic() {
    return workerDiagnostic;
  },
  set workerDiagnostic(value) {
    workerDiagnostic = value;
  },
  get reconnectBlocked() {
    return reconnectBlocked;
  },
  set reconnectBlocked(value) {
    reconnectBlocked = value;
  },
  get missingLinkedTask() {
    return missingLinkedTask;
  },
  set missingLinkedTask(value) {
    missingLinkedTask = value;
  },
  get userChangedTab() {
    return userChangedTab;
  },
  set userChangedTab(value) {
    userChangedTab = value;
  },
  get hoverBridge() {
    return hoverBridge;
  },
  set hoverBridge(value) {
    hoverBridge = value as HoverPreviewBridge | null;
  },
  revision: -1,
  requestSerial,
  themeRequestSerial,
  themeWriteQueue,
  get phaseTransition() {
    return phaseTransition;
  },
  set phaseTransition(value) {
    phaseTransition = value;
  },
  get focusDetailsOnNextRender() {
    return focusDetailsOnNextRender;
  },
  set focusDetailsOnNextRender(value) {
    focusDetailsOnNextRender = value;
  },
  get restoreClosedDetailsOnNextRender() {
    return restoreClosedDetailsOnNextRender;
  },
  set restoreClosedDetailsOnNextRender(value) {
    restoreClosedDetailsOnNextRender = value;
  },
  get selectedTask() {
    return selectedTask;
  },
  set selectedTask(value) {
    selectedTask = value;
  },
  get selectedGroup() {
    return selectedGroup;
  },
  set selectedGroup(value) {
    selectedGroup = value;
  },
  get selectedMilestone() {
    return selectedMilestone;
  },
  set selectedMilestone(value) {
    selectedMilestone = value;
  },
  get connected() {
    return connected;
  },
  set connected(value) {
    connected = value;
  },
  get keyboardSelection() {
    return keyboardSelection;
  },
  set keyboardSelection(value) {
    keyboardSelection = value;
  },
  get planInfoLastFocus() {
    return planInfoLastFocus;
  },
  set planInfoLastFocus(value) {
    planInfoLastFocus = value;
  },
};

let render: () => void = () => undefined;
let refresh: () => Promise<void> = async () => undefined;
let saveTheme: (theme: Theme) => Promise<void> = async () => undefined;

function syncStableGridCardWidth(): void {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  const card = document.querySelector<HTMLElement>("#task-list.task-layout-grid .task-card");
  if (!workspace || !card) return;
  if (window.innerWidth >= 768 && window.innerWidth <= 1444) {
    workspace.style.removeProperty("--stable-task-card-width");
    return;
  }
  const surfaceIsOpen =
    workspace.classList.contains("has-details") ||
    workspace.classList.contains("has-overlay-selection");
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

const appData = createAppDataController({
  state: appState,
  $,
  labels,
  defaultStates,
  defaultKinds,
  palette,
  statusColors,
  outputSnapshots,
  render: () => render(),
  refresh: () => refresh(),
  saveTheme: (theme) => saveTheme(theme),
  css,
  syncStableGridCardWidth,
  renderList: (tasks) => renderList(tasks),
  refreshIcons: () => createIcons({ icons: ICONS }),
  hideHoverPreview: () => hideHoverPreview(),
  showCurrentSelectionPreview: () => showCurrentSelectionPreview(),
});
const {
  applyOutputs,
  applyStateToControls,
  archiveConversation,
  captureDetailFocus,
  captureListFocus,
  captureMenuFocus,
  chooseMenu,
  closeMenus,
  connection,
  filterFromControls,
  filteredTasks,
  groupColor,
  label,
  menuTrigger,
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
  time,
  updateMenu,
  updateTaskLayoutControls,
  updateVersionMenu,
} = appData;

const taskContextMenu = installTaskContextMenu({
  getData: () => data,
  beforeOpen: () => {
    hideHoverPreview();
    closeMenus();
  },
});
const cardRenderer = createCardRenderer({
  getData: () => data,
  getLayout: () => viewState.layout,
  getSelectedTask: () => selectedTask,
  getSelectedGroup: () => selectedGroup,
  labels,
  safeExternal,
  archiveConversation,
  selectTask: (id, atomId) => selectTask(id, atomId),
  selectGroup: (id) => selectGroup(id),
  setKeyboardSelection: () => {
    keyboardSelection = true;
  },
  updateTaskLayoutControls,
  bindTaskHover: (target, task) => hoverController.bindHoverTarget(target, taskPreview(task)),
  bindGroupHover: (target, group) => hoverController.bindHoverTarget(target, groupPreview(group)),
});
const { renderList, renderGroups } = cardRenderer;
function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function safeExternal(url: string | null): string | null {
  if (!url || !data) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      parsed.hostname === data.orchestration.repository.host &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
let profileCapabilities: ProfileCapabilities | null = null;
let profileCapabilityError = "正在读取模型能力…";
async function loadProfileCapabilities(): Promise<void> {
  try {
    const response = await fetch("api/execution-profile");
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.capabilities))
      throw new Error(result.message ?? "模型能力目录不可用，暂时无法编辑");
    profileCapabilities = result.capabilities;
    profileCapabilityError = "";
  } catch (cause) {
    profileCapabilityError = cause instanceof Error ? cause.message : String(cause);
  }
}
async function updateProfile(
  targetType: ProfileTarget,
  targetId: string,
  profile: { model: string; thinking: string } | null,
  recommend = false,
): Promise<void> {
  if (!data?.orchestration.owner_thread_id) throw new Error("主会话身份不可用");
  const response = await fetch("api/execution-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: data.orchestration.id,
      actor: { role: "main", thread_id: data.orchestration.owner_thread_id },
      request_id: `profile-${crypto.randomUUID()}`,
      expected_revision: data.orchestration.revision,
      payload: {
        target_type: targetType,
        target_id: targetId,
        execution_profile: profile,
        recommend,
      },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? result.error ?? "配置保存失败");
  await refresh();
}
const detailContent = createDetailContent({
  getData: () => data,
  labels,
  labelTask: label,
  time,
  safeExternal,
  archiveConversation,
  profileContext: () => ({
    capabilities: profileCapabilities,
    capabilityError: profileCapabilityError,
    update: updateProfile,
  }),
});
const { clearDetails, showTask, showGroup, showMilestone, taskPreview, groupPreview } =
  detailContent;
const hasSelectedObject = (): boolean =>
  Boolean(
    (selectedTask && data?.tasks.some((task) => task.id === selectedTask)) ||
      (selectedGroup && data?.groups.some((group) => group.id === selectedGroup)) ||
      (selectedMilestone &&
        data?.nodes.some((node) => node.kind === "milestone" && node.id === selectedMilestone)),
  );
function canUseDetailsPanel(): boolean {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  return detailsPanelFits(workspace?.getBoundingClientRect().width ?? 0);
}
const DETAILS_MIN_HEIGHT = 120;
const detailsHeightKey = `loomhelm:details-height:${location.pathname}`;
function detailsHeightBounds(): { min: number; max: number } {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  const available = Math.max(
    DETAILS_MIN_HEIGHT,
    workspace?.getBoundingClientRect().height ?? window.innerHeight,
  );
  return {
    min: DETAILS_MIN_HEIGHT,
    max: Math.max(DETAILS_MIN_HEIGHT, Math.min(window.innerHeight * 0.6, available - 240)),
  };
}
function setDetailsHeight(value: number, persist = true): void {
  const bounds = detailsHeightBounds();
  const height = Math.round(Math.max(bounds.min, Math.min(bounds.max, value)));
  document.documentElement.style.setProperty("--details-height", `${height}px`);
  const separator = document.getElementById("details-resize");
  separator?.setAttribute("aria-valuemin", String(bounds.min));
  separator?.setAttribute("aria-valuemax", String(bounds.max));
  separator?.setAttribute("aria-valuenow", String(height));
  if (persist) localStorage.setItem(detailsHeightKey, String(height));
}
const savedDetailsHeight = Number(localStorage.getItem(detailsHeightKey));
setDetailsHeight(
  Number.isFinite(savedDetailsHeight) && savedDetailsHeight > 0
    ? savedDetailsHeight
    : window.innerHeight * 0.4,
  false,
);
const detailsResize = document.getElementById("details-resize");
if (detailsResize) {
  let startY = 0;
  let startHeight = 0;
  const move = (event: PointerEvent) => {
    event.preventDefault();
    setDetailsHeight(startHeight + startY - event.clientY);
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
  };
  detailsResize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startY = event.clientY;
    startHeight =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--details-height"),
      ) || window.innerHeight * 0.4;
    detailsResize.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
  });
  detailsResize.addEventListener("keydown", (event) => {
    const current =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--details-height"),
      ) || window.innerHeight * 0.4;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setDetailsHeight(current + 24);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setDetailsHeight(current - 24);
    } else if (event.key === "Home") {
      event.preventDefault();
      setDetailsHeight(detailsHeightBounds().min);
    } else if (event.key === "End") {
      event.preventDefault();
      setDetailsHeight(detailsHeightBounds().max);
    }
  });
}
const hoverController = createHoverController({
  element: $,
  getData: () => data,
  getViewState: () => viewState,
  getSelected: () => ({
    task: selectedTask,
    group: selectedGroup,
    milestone: selectedMilestone,
    atom: viewState.atom,
  }),
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
const {
  supportsHoverDetails,
  showHoverPreview,
  hideHoverPreview,
  recordPointerType,
  showCurrentSelectionPreview,
  dismiss: dismissHoverPreview,
} = hoverController;
function updateDetailsSurface(
  open: boolean,
  focus = false,
): ReturnType<typeof resolveDetailSurface> {
  const detailPanelViewport = canUseDetailsPanel();
  const mediumShort =
    window.innerWidth >= DETAILS_PANEL_BREAKPOINT &&
    window.innerWidth <= 1444 &&
    window.innerHeight <= 960;
  const drawerViewport = window.innerWidth < DETAILS_PANEL_BREAKPOINT || mediumShort;
  const surface = resolveDetailSurface({
    selected: hasSelectedObject(),
    detailOpen: open,
    hoverCapable: supportsHoverDetails(),
    keyboardSelection,
    detailPanelViewport,
    drawerViewport,
  });
  applyDetailSurface(
    {
      workspace: document.querySelector<HTMLElement>(".workspace")!,
      background: [
        document.querySelector<HTMLElement>(".topbar")!,
        document.querySelector<HTMLElement>(".overview")!,
        document.querySelector<HTMLElement>(".workspace-main")!,
      ],
      details: $("details"),
      detailsBackdrop: $("details-backdrop"),
      hoverPreview: $("hover-preview"),
      closeDetails: $("close-details"),
    },
    surface,
    detailPanelViewport,
    focus,
  );
  return surface;
}
const timelineController = createTimelineController({
  taskContextMenu: (event, id, target) => taskContextMenu.open(event, id, target),
  getData: () => data,
  getViewState: () => viewState,
  setViewState: (next) => {
    viewState = next;
  },
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
  setZoom: (zoom) => {
    viewState = { ...viewState, zoom };
    syncUrl();
  },
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
  selectMilestone,
  getSelected: () => ({
    task: selectedTask,
    group: selectedGroup,
    milestone: selectedMilestone,
    atom: viewState.atom,
  }),
});
const atomicGraphController = createAtomicGraphController({
  element: $,
  getData: () => data,
  getViewState: () => viewState,
  setZoom: (zoom) => {
    viewState = { ...viewState, zoom };
    syncUrl();
  },
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
  selectMilestone,
  getSelected: () => ({
    task: selectedTask,
    group: selectedGroup,
    milestone: selectedMilestone,
    atom: viewState.atom,
  }),
});
function openDetails(): void {
  updateDetailsSurface(true, true);
}
function restoreClosedDetails(): void {
  const selection = selectedTask
    ? { kind: "task" as const, id: selectedTask }
    : selectedGroup
      ? { kind: "group" as const, id: selectedGroup }
      : null;
  const fallback = selectedObjectFocusSelector(selection);
  focusAfterRerender(
    lastFocus,
    (fallback ? firstVisibleElement(document, fallback) : null) ?? $("search"),
  );
}
function closeDetails(): void {
  hideHoverPreview();
  keyboardSelection = false;
  viewState = { ...viewState, detail: false };
  syncUrl();
  updateDetailsSurface(false);
  syncStableGridCardWidth();
  restoreClosedDetails();
}
function restoreSelectedFocus(selection: {
  kind: "task" | "group" | "milestone";
  id: string;
}): void {
  const selector = selectedObjectFocusSelector(selection);
  focusAfterRerender(lastFocus, selector ? firstVisibleElement(document, selector) : null);
}
function dismissTaskLinkNotice(): void {
  missingLinkedTask = null;
  const notice = document.getElementById("task-link-notice");
  if (notice) notice.hidden = true;
}
function selectGroup(id: string, atomId: string | null = null): void {
  if (!data) return;
  dismissTaskLinkNotice();
  if (selectedGroup === id && viewState.detail && viewState.atom === atomId) {
    closeDetails();
    return;
  }
  const group = data.groups.find((item) => item.id === id);
  if (!group) return;
  hideHoverPreview();
  hoverBridge?.resetTargets();
  lastFocus = document.activeElement as HTMLElement;
  _lastScrollTop = window.scrollY;
  selectedGroup = id;
  selectedTask = null;
  selectedMilestone = null;
  viewState = { ...viewState, selected: { kind: "group", id }, atom: atomId, detail: true };
  syncUrl();
  showGroup(group, atomId);
  renderGroups();
  renderList(filteredTasks());
  syncStableGridCardWidth();
  graphController.highlightSelection();
  atomicGraphController.highlightSelection();
  createIcons({ icons: ICONS });
  openDetails();
  restoreSelectedFocus({ kind: "group", id });
  showCurrentSelectionPreview();
}
function selectTask(id: string, atomId: string | null = null): void {
  if (!data) return;
  dismissTaskLinkNotice();
  if (selectedTask === id && viewState.detail && viewState.atom === atomId) {
    closeDetails();
    return;
  }
  const task = data.tasks.find((item) => item.id === id);
  if (!task) return;
  hideHoverPreview();
  hoverBridge?.resetTargets();
  lastFocus = document.activeElement as HTMLElement;
  _lastScrollTop = window.scrollY;
  selectedTask = id;
  selectedGroup = null;
  selectedMilestone = null;
  viewState = { ...viewState, selected: { kind: "task", id }, atom: atomId, detail: true };
  syncUrl();
  showTask(task, atomId);
  renderGroups();
  renderList(filteredTasks());
  syncStableGridCardWidth();
  graphController.highlightSelection();
  atomicGraphController.highlightSelection();
  createIcons({ icons: ICONS });
  openDetails();
  restoreSelectedFocus({ kind: "task", id });
  showCurrentSelectionPreview();
}
function selectMilestone(id: string, atomId: string | null = null): void {
  if (!data) return;
  const node = data.nodes.find((item) => item.kind === "milestone" && item.id === id);
  const group = node?.group_id ? data.groups.find((item) => item.id === node.group_id) : null;
  if (!node || !group) return;
  hideHoverPreview();
  hoverBridge?.resetTargets();
  lastFocus = document.activeElement as HTMLElement;
  selectedMilestone = id;
  selectedTask = null;
  selectedGroup = null;
  viewState = { ...viewState, selected: { kind: "milestone", id }, atom: atomId, detail: true };
  syncUrl();
  showMilestone(id, group, atomId);
  renderGroups();
  renderList(filteredTasks());
  syncStableGridCardWidth();
  graphController.highlightSelection();
  atomicGraphController.highlightSelection();
  createIcons({ icons: ICONS });
  openDetails();
  restoreSelectedFocus({ kind: "milestone", id });
  showCurrentSelectionPreview();
}
const planInfo = createAppPlanInfoController({
  state: appState,
  $,
  closeMenus,
  hideHoverPreview,
  showCurrentSelectionPreview,
  updateDetailsSurface,
});
const {
  closePlanInfo,
  openPlanInfo,
  planInfoIsOpen,
  refreshResponsiveDetails,
  renderPlanInfo,
  syncPlanInfoSurface,
  trapDetailsFocus,
  trapPlanInfoFocus,
} = planInfo;

const appView = createAppViewController({
  state: appState,
  $,
  icons: ICONS,
  defaultStates,
  labels,
  taskKindLabel,
  applyOutputs,
  clearDetails,
  connection,
  createIcons,
  filteredTasks,
  hideHoverPreview,
  menuTrigger,
  renderGroups,
  renderList,
  renderPlanInfo,
  renderSummary,
  setMenuValue,
  showCurrentSelectionPreview,
  showGroup,
  showMilestone,
  showTask,
  stateValidation,
  syncStableGridCardWidth,
  syncUrl,
  taskContextMenu,
  graphController,
  atomicGraphController,
  timelineController,
  applyStateToControls,
  updateDetailsSurface,
  restoreClosedDetails,
  captureListFocus,
  captureMenuFocus,
  captureDetailFocus,
  restoreListFocus,
  restoreMenuFocus,
  restoreDetailFocus,
  updateMenu,
  updateVersionMenu,
  profile: () => ({
    capabilities: profileCapabilities,
    capabilityError: profileCapabilityError,
    update: updateProfile,
  }),
  showWorkerDiagnostic,
});
render = appView.render;
refresh = appView.refresh;
saveTheme = appView.saveTheme;

installAppEvents({
  state: appState,
  $,
  anyFinePointerCapability: anyFinePointerCapability,
  anyHoverCapability,
  closeDetails,
  closeMenus,
  closePlanInfo,
  chooseMenu,
  connection,
  filterFromControls,
  hideHoverPreview,
  loadProfileCapabilities,
  loadTheme: appView.loadTheme,
  menuTrigger,
  openMenu,
  openPlanInfo,
  planInfoIsOpen,
  recordPointerType,
  refresh,
  refreshCardDurations,
  refreshResponsiveDetails,
  render,
  reconnectViewer,
  saveTheme,
  setDetailsHeight,
  setTab: appView.setTab,
  setTaskLayout,
  showWorkerDiagnostic,
  syncPlanInfoSurface,
  timelineController,
  graphController,
  atomicGraphController,
  trapDetailsFocus,
  trapPlanInfoFocus,
  stateValidation,
  hoverPreviewElement: $("hover-preview"),
  dismissHoverPreview,
  applyOutputs,
  filteredTasks,
  renderPlanInfo,
  refreshIcons: () => createIcons({ icons: ICONS }),
});
