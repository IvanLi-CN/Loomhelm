import type { OutputSnapshot } from "./agent-output";
import type { AppDataState, MenuId, WorkerDiagnostic } from "./app-data";
import type { AppViewContext } from "./app-view";
import { createHoverPreviewBridge } from "./hover-preview";
import { installViewStateNavigation } from "./navigation";
import { derivePhase } from "./phase";
import { parseRuntimeMetadata, runtimeWithEmbeddedViewer } from "./runtime-metadata";
import type { DashboardTab } from "./view-state";

type EventState = AppDataState &
  AppViewContext["state"] & {
    connected: boolean;
    keyboardSelection: boolean;
    activePlanId: string;
    phase: "planning" | "execution" | null;
  };

type GraphEventsController = {
  zoomIn?: () => void;
  zoomOut?: () => void;
  fit?: () => void;
  rankDir?: () => string;
  render?: (...args: unknown[]) => void;
};

type TimelineEventsController = {
  adjustWindow?: (direction: "in" | "out") => void;
  fit?: () => void;
  redraw?: () => void;
};

export type AppEventsContext = {
  state: EventState;
  $: <T extends HTMLElement>(id: string) => T;
  anyFinePointerCapability: MediaQueryList;
  anyHoverCapability: MediaQueryList;
  closeDetails: () => void;
  closeMenus: () => void;
  closePlanInfo: (restoreFocus?: boolean) => void;
  chooseMenu: (id: MenuId, value: string) => void;
  connection: (status: "live" | "stale" | "connecting") => void;
  filterFromControls: () => void;
  hideHoverPreview: () => void;
  loadProfileCapabilities: () => Promise<void>;
  loadTheme: () => Promise<void>;
  menuTrigger: (id: MenuId) => HTMLButtonElement;
  openMenu: (id: MenuId) => void;
  openPlanInfo: () => void;
  planInfoIsOpen: () => boolean;
  recordPointerType: (pointerType: string) => void;
  refresh: () => Promise<void>;
  refreshCardDurations: () => void;
  refreshResponsiveDetails: () => void;
  render: () => void;
  reconnectViewer: () => Promise<void>;
  saveTheme: (theme: import("./model").Theme) => Promise<void>;
  setDetailsHeight: (height: number, persist?: boolean) => void;
  setTab: (tab: DashboardTab) => void;
  setTaskLayout: (layout: "board" | "grid") => void;
  showWorkerDiagnostic: (value: Partial<WorkerDiagnostic> & { code?: string }) => void;
  syncPlanInfoSurface: () => void;
  timelineController: TimelineEventsController;
  graphController: GraphEventsController;
  atomicGraphController: GraphEventsController;
  trapDetailsFocus: (event: KeyboardEvent) => void;
  trapPlanInfoFocus: (event: KeyboardEvent) => void;
  stateValidation: () => ReturnType<AppViewContext["stateValidation"]>;
  filteredTasks: () => import("./model").Task[];
  applyOutputs: (next: OutputSnapshot, requestEpoch?: string | null) => void;
  renderPlanInfo: () => void;
  refreshIcons: () => void;
  hoverPreviewElement: HTMLElement;
  dismissHoverPreview: () => void;
};

export function installAppEvents(context: AppEventsContext): EventSource {
  const { state } = context;
  document.addEventListener("service-session", (event) => {
    state.serviceSessionExpired = Boolean((event as CustomEvent).detail?.expired);
    context.connection(
      state.serviceSessionExpired
        ? "stale"
        : (context.$("connection").dataset.state as "live" | "stale" | "connecting") ||
            "connecting",
    );
  });
  document.addEventListener("loomhelm-runtime", (event) => {
    state.runtimeMetadata = runtimeWithEmbeddedViewer(
      parseRuntimeMetadata((event as CustomEvent).detail),
      document,
      { trustEmbeddedViewer: false },
    );
    if (state.data) {
      context.renderPlanInfo();
      context.refreshIcons();
    }
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
    button.addEventListener("click", () => context.setTab(button.dataset.tab as DashboardTab));
  context.$("search").addEventListener("input", () => {
    context.filterFromControls();
    context.render();
  });
  for (const id of ["theme", "version", "group-filter", "state-filter", "kind-filter"] as MenuId[])
    context.menuTrigger(id).addEventListener("click", () => {
      if (context.menuTrigger(id).getAttribute("aria-expanded") === "true") context.closeMenus();
      else context.openMenu(id);
    });
  for (const option of document.querySelectorAll<HTMLButtonElement>("#theme-menu [role=option]"))
    option.addEventListener("click", () =>
      context.chooseMenu("theme", option.dataset.menuValue ?? "system"),
    );
  context.$("version-menu").addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const option = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[role=option]");
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      option.click();
    },
    true,
  );
  context.$("task-layout-board").addEventListener("click", () => context.setTaskLayout("board"));
  context.$("task-layout-grid").addEventListener("click", () => context.setTaskLayout("grid"));
  context.$("plan-info-trigger").addEventListener("click", (event) => {
    event.stopPropagation();
    if (context.planInfoIsOpen()) context.closePlanInfo(false);
    else context.openPlanInfo();
  });
  context.$("close-plan-info").addEventListener("click", () => context.closePlanInfo());
  context.$("plan-info-backdrop").addEventListener("click", () => context.closePlanInfo());
  context.$("plan-info-panel").addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest("[data-menu]")) context.closeMenus();
    if (context.planInfoIsOpen() && !target.closest("#plan-info-panel, #plan-info-trigger"))
      context.closePlanInfo();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      state.keyboardSelection = false;
      context.recordPointerType(event.pointerType);
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => context.recordPointerType(event.pointerType),
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        (event.target as HTMLElement).closest(".task-card-select, .task-column-select, .task-row")
      )
        state.keyboardSelection = true;
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    const trigger = target.closest<HTMLButtonElement>(".menu-trigger, .theme-trigger");
    const option = target.closest<HTMLButtonElement>("[role=option]");
    if (event.key === "Escape" && trigger) {
      event.preventDefault();
      event.stopPropagation();
      context.closeMenus();
      trigger.focus();
    } else if (
      trigger &&
      (event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " ")
    ) {
      event.preventDefault();
      const id = trigger.id.replace(/-trigger$/, "") as MenuId;
      context.openMenu(id);
    } else if (option && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const options = [
        ...(option
          .closest<HTMLElement>("[role=listbox]")
          ?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []),
      ];
      const index = options.indexOf(option);
      options[
        (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
      ]?.focus();
    } else if (option && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const menu = option.closest<HTMLElement>("[role=listbox]");
      const id = menu?.id.replace(/-menu$/, "") as MenuId;
      context.chooseMenu(id, option.dataset.menuValue ?? "");
    } else if (option && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      context.closeMenus();
      context
        .menuTrigger(
          option.closest<HTMLElement>("[role=listbox]")?.id.replace(/-menu$/, "") as MenuId,
        )
        .focus();
    }
  });
  context.$("close-details").addEventListener("click", context.closeDetails);
  context.$("details-backdrop").addEventListener("click", context.closeDetails);
  context.$("phase-jump").addEventListener("click", () => {
    state.phaseTransition = false;
    context.setTab("actual");
  });
  context
    .$("zoom-in")
    .addEventListener("click", () =>
      state.viewState.tab === "atomic"
        ? context.atomicGraphController.zoomIn?.()
        : context.graphController.zoomIn?.(),
    );
  context
    .$("zoom-out")
    .addEventListener("click", () =>
      state.viewState.tab === "atomic"
        ? context.atomicGraphController.zoomOut?.()
        : context.graphController.zoomOut?.(),
    );
  context
    .$("fit")
    .addEventListener("click", () =>
      state.viewState.tab === "atomic"
        ? context.atomicGraphController.fit?.()
        : context.graphController.fit?.(),
    );
  context
    .$("timeline-zoom-in")
    .addEventListener("click", () => context.timelineController.adjustWindow?.("in"));
  context
    .$("timeline-zoom-out")
    .addEventListener("click", () => context.timelineController.adjustWindow?.("out"));
  context.$("timeline-fit").addEventListener("click", () => context.timelineController.fit?.());
  installViewStateNavigation(window, {
    getSearch: () => window.location.search,
    getValidation: (search) => {
      const targetPlan = search ? new URLSearchParams(search).get("plan") : null;
      if ((targetPlan ?? state.activePlanId) !== (state.viewState.plan ?? state.activePlanId))
        return { plans: new Set(state.data?.plans.map((plan) => plan.id) ?? []) };
      return state.data ? context.stateValidation() : {};
    },
    getPhase: () => (state.data ? (state.phase ?? derivePhase(state.data.tasks)) : null),
    restore: (next, hasExplicitTab) => {
      const planChanged = next.plan !== state.viewState.plan;
      const closingDetails = state.viewState.detail && !next.detail;
      state.userChangedTab = hasExplicitTab;
      if (closingDetails) {
        state.keyboardSelection = false;
        context.hideHoverPreview();
        state.restoreClosedDetailsOnNextRender = true;
      }
      state.viewState = next;
      state.selectedTask = next.selected?.kind === "task" ? next.selected.id : null;
      state.selectedGroup = next.selected?.kind === "group" ? next.selected.id : null;
      state.selectedMilestone = next.selected?.kind === "milestone" ? next.selected.id : null;
      state.activePlan = next.plan ?? "";
      if (next.detail) state.focusDetailsOnNextRender = true;
      if (planChanged) void context.refresh();
      else if (state.data) context.render();
    },
  });
  window.addEventListener("keydown", (event) => {
    context.trapDetailsFocus(event);
    context.trapPlanInfoFocus(event);
    if (event.key === "Escape" && context.planInfoIsOpen()) {
      event.preventDefault();
      context.closePlanInfo();
    } else if (event.key === "Escape" && state.viewState.detail) context.closeDetails();
  });
  window.addEventListener("resize", () => {
    context.refreshResponsiveDetails();
    context.syncPlanInfoSurface();
    if (
      state.data &&
      state.viewState.tab === "graph" &&
      context.graphController.rankDir?.() !== (window.innerWidth < 768 ? "TB" : "LR")
    )
      context.graphController.render?.(
        context.filteredTasks(),
        state.viewState.group ? new Set([state.viewState.group]) : undefined,
      );
    window.requestAnimationFrame(() => context.timelineController.redraw?.());
  });
  context.anyHoverCapability.addEventListener("change", context.refreshResponsiveDetails);
  context.anyFinePointerCapability.addEventListener("change", context.refreshResponsiveDetails);
  const stream = new EventSource("api/events");
  stream.addEventListener("open", () => {
    if (state.reconnectBlocked) return;
    state.connected = true;
    context.connection("live");
    void context.refresh();
  });
  stream.addEventListener("revision", () => void context.refresh());
  stream.addEventListener("stale", () => {
    state.connected = false;
    context.connection("stale");
  });
  stream.addEventListener("heartbeat", (event) => {
    try {
      if (
        !state.reconnectBlocked &&
        JSON.parse((event as MessageEvent).data).watching &&
        !state.connected
      ) {
        state.connected = true;
        void context.refresh();
      }
    } catch {
      context.connection("stale");
    }
  });
  stream.addEventListener("error", () => {
    state.connected = false;
    context.connection("stale");
    void fetch(
      `api/diagnostics/worker?run_id=${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (value?.diagnostic) {
          stream.close();
          context.showWorkerDiagnostic(value.diagnostic);
        }
      });
  });
  state.hoverBridge = createHoverPreviewBridge(
    context.hoverPreviewElement,
    context.dismissHoverPreview,
  );
  window.setInterval(context.refreshCardDurations, 60_000);
  window.setInterval(() => {
    if (!state.connected && !state.reconnectBlocked) void context.refresh();
  }, 5_000);
  context.$("worker-diagnostic-copy").addEventListener("click", async () => {
    if (!state.workerDiagnostic) return;
    await navigator.clipboard?.writeText(JSON.stringify(state.workerDiagnostic));
  });
  context.$("worker-diagnostic-reconnect").addEventListener("click", () => {
    state.reconnectBlocked = false;
    void context.reconnectViewer().catch((error) =>
      context.showWorkerDiagnostic({
        ...state.workerDiagnostic,
        safe_summary: error instanceof Error ? error.message : "无法重新连接",
      }),
    );
  });
  context.connection("connecting");
  void context.loadTheme();
  void context.refresh();
  stream.addEventListener("agent-output", (event) => {
    try {
      context.applyOutputs(JSON.parse((event as MessageEvent).data) as OutputSnapshot);
    } catch {
      context.connection("stale");
    }
  });
  void context.loadProfileCapabilities().then(() => {
    if (state.data) context.render();
  });
  return stream;
}
