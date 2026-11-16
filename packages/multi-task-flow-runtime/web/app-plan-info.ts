import type { AppDataState } from "./app-data";
import { firstVisibleElement, focusAfterRerender } from "./focus";
import { DETAILS_PANEL_BREAKPOINT, selectedObjectFocusSelector } from "./interaction-policy";
import {
  closeRuntimeIdentityTooltips,
  planStateSeverity,
  renderPlanInfoContent,
} from "./status-row";

type PlanInfoState = AppDataState & {
  selectedTask: string | null;
  selectedGroup: string | null;
  selectedMilestone: string | null;
  planInfoLastFocus: HTMLElement | null;
  keyboardSelection: boolean;
};

export type AppPlanInfoContext = {
  state: PlanInfoState;
  $: <T extends HTMLElement>(id: string) => T;
  closeMenus: () => void;
  hideHoverPreview: () => void;
  showCurrentSelectionPreview: () => void;
  updateDetailsSurface: (open: boolean, focus?: boolean) => unknown;
};

export function createAppPlanInfoController(context: AppPlanInfoContext) {
  const { state } = context;

  function planInfoIsOpen(): boolean {
    return context.$("plan-info-panel").classList.contains("open");
  }

  function planInfoIsDrawer(): boolean {
    return window.innerWidth < DETAILS_PANEL_BREAKPOINT;
  }

  function isVisiblePlanInfoControl(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const collapsed = element.closest("details:not([open])");
    if (collapsed && element.tagName !== "SUMMARY") return false;
    for (
      let current: HTMLElement | null = element;
      current && current !== document.body;
      current = current.parentElement
    ) {
      if (current.hidden) return false;
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  function positionPlanInfo(): void {
    const trigger = context.$("plan-info-trigger");
    const panel = context.$("plan-info-panel");
    if (!planInfoIsOpen() || planInfoIsDrawer()) return;
    const rect = trigger.getBoundingClientRect();
    const versionDetailsReservation =
      window.innerWidth >= 1024 ? Math.min(380, window.innerWidth - 24) + 24 : 0;
    const maxLeft = window.innerWidth - panel.offsetWidth - 12 - versionDetailsReservation;
    const left = Math.max(12, Math.min(Math.max(12, maxLeft), rect.right - panel.offsetWidth));
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(12, Math.min(window.innerHeight - panel.offsetHeight - 12, rect.bottom + 8))}px`;
  }

  function syncPlanInfoSurface(): void {
    const panel = context.$("plan-info-panel");
    const drawer = planInfoIsDrawer();
    panel.dataset.surface = drawer ? "drawer" : "popover";
    if (drawer) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
    } else positionPlanInfo();
    context.$("plan-info-backdrop").hidden = !(planInfoIsOpen() && drawer);
  }

  function openPlanInfo(): void {
    if (!state.data) return;
    const panel = context.$("plan-info-panel");
    if (planInfoIsOpen()) return;
    state.planInfoLastFocus = document.activeElement as HTMLElement | null;
    context.closeMenus();
    context.hideHoverPreview();
    panel.hidden = false;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    context.$("plan-info-trigger").setAttribute("aria-expanded", "true");
    syncPlanInfoSurface();
    window.requestAnimationFrame(() => {
      const closeButton = context.$("close-plan-info");
      closeButton.dataset.suppressTooltipFocus = "true";
      closeButton.focus({ preventScroll: true });
    });
  }

  function closePlanInfo(restoreFocus = true): void {
    closeRuntimeIdentityTooltips();
    const panel = context.$("plan-info-panel");
    if (!planInfoIsOpen()) return;
    panel.classList.remove("open");
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    context.$("plan-info-trigger").setAttribute("aria-expanded", "false");
    context.$("plan-info-backdrop").hidden = true;
    if (restoreFocus && state.planInfoLastFocus && document.contains(state.planInfoLastFocus))
      state.planInfoLastFocus.focus({ preventScroll: true });
    state.planInfoLastFocus = null;
  }

  function trapPlanInfoFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !planInfoIsOpen()) return;
    const panel = context.$("plan-info-panel");
    const tooltipRoots = [
      ...document.querySelectorAll<HTMLElement>(".plan-info-identity-tooltip.is-open"),
    ];
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
      ),
      ...tooltipRoots.flatMap((root) => [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ),
      ]),
    ].filter(isVisiblePlanInfoControl);
    if (!focusable.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function renderPlanInfo(): void {
    const trigger = context.$("plan-info-trigger");
    const severity = planStateSeverity(state.data?.plan_state);
    const iconName =
      severity === "blocked" ? "circle-alert" : severity === "unknown" ? "circle-help" : "info";
    const label =
      severity === "blocked"
        ? "查看编排问题"
        : severity === "unknown"
          ? "查看编排状态"
          : "查看编排信息";
    trigger.dataset.status = severity;
    trigger.dataset.tooltip = label;
    trigger.setAttribute("aria-label", label);
    trigger.setAttribute("aria-expanded", String(planInfoIsOpen()));
    const icon = document.createElement("i");
    icon.id = "plan-info-icon";
    icon.dataset.lucide = iconName;
    icon.setAttribute("aria-hidden", "true");
    trigger.replaceChildren(icon);
    if (state.data) {
      context.$("plan-info-title").textContent =
        `${state.data.orchestration.repository.owner} / ${state.data.orchestration.repository.name}`;
      renderPlanInfoContent(context.$("plan-info-content"), state.data, state.runtimeMetadata);
    } else context.$("plan-info-content").replaceChildren();
    if (planInfoIsOpen()) syncPlanInfoSurface();
  }

  function trapDetailsFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const details = context.$("details");
    if (!details.classList.contains("open")) return;
    const focusable = [
      ...details.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(isVisiblePlanInfoControl);
    if (!focusable.length) {
      event.preventDefault();
      details.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function refreshResponsiveDetails(): void {
    context.hideHoverPreview();
    if (!state.data) return;
    const surface = context.updateDetailsSurface(state.viewState.detail);
    if (surface === "hover-preview" && state.viewState.detail) {
      const selection = state.selectedTask
        ? { kind: "task" as const, id: state.selectedTask }
        : state.selectedGroup
          ? { kind: "group" as const, id: state.selectedGroup }
          : state.selectedMilestone
            ? { kind: "milestone" as const, id: state.selectedMilestone }
            : null;
      const selector = selectedObjectFocusSelector(selection);
      const selectedTarget = selector ? firstVisibleElement(document, selector) : null;
      focusAfterRerender(
        null,
        selectedTarget ??
          firstVisibleElement(document, ".task-card-select, .task-column-select") ??
          context.$("search"),
      );
      context.showCurrentSelectionPreview();
    }
  }

  return {
    closePlanInfo,
    openPlanInfo,
    planInfoIsOpen,
    refreshResponsiveDetails,
    renderPlanInfo,
    syncPlanInfoSurface,
    trapDetailsFocus,
    trapPlanInfoFocus,
  };
}
