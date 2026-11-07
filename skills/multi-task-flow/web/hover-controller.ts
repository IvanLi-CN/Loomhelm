import { refreshOutputNodes } from "./agent-output";
import { canShowHoverPreview, selectedObjectFocusSelector, supportsHoverInput } from "./interaction-policy";
import { firstVisibleElement } from "./focus";
import type { HoverPreviewBridge } from "./hover-preview";
import type { Group, Task, View } from "./model";
import type { ViewState } from "./view-state";

type PointerType = "mouse" | "touch" | "pen";
type HoverAnchor = HTMLElement | DOMRect | { x: number; y: number };

type HoverControllerContext = {
  element: <T extends HTMLElement>(id: string) => T;
  getData: () => View | null;
  getViewState: () => ViewState;
  getSelected: () => { task: string | null; group: string | null };
  getKeyboardSelection: () => boolean;
  getBridge: () => HoverPreviewBridge | null;
  getAnyHover: () => boolean;
  getAnyFinePointer: () => boolean;
  getDetailPanelViewport: () => boolean;
  taskPreview: (task: Task) => HTMLElement;
  groupPreview: (group: Group) => HTMLElement;
  updateDetailsSurface: (open: boolean, focus?: boolean) => void;
  focusSelectedObject: () => void;
};

export function createHoverController(context: HoverControllerContext) {
  let lastPointerType: PointerType | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const selected = (): boolean => {
    const current = context.getSelected();
    return Boolean(current.task || current.group);
  };

  const supportsHoverDetails = (): boolean => supportsHoverInput({
    anyHover: context.getAnyHover(),
    anyFinePointer: context.getAnyFinePointer(),
    pointerType: lastPointerType,
  });

  const pointerTypeFromEvent = (event: unknown): PointerType | null => {
    if (!event || typeof event !== "object") return null;
    const value = (event as { pointerType?: unknown }).pointerType;
    return value === "mouse" || value === "touch" || value === "pen" ? value : null;
  };

  const previewAnchorRect = (anchor: HoverAnchor | null): DOMRect | null => {
    if (!anchor) return null;
    if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
    if (anchor instanceof DOMRect) return anchor;
    return new DOMRect(anchor.x, anchor.y, 1, 1);
  };

  const positionPreview = (anchor: HoverAnchor | null): void => {
    const preview = context.element("hover-preview");
    const rect = previewAnchorRect(anchor);
    if (!rect) return;
    const width = preview.offsetWidth;
    const height = preview.offsetHeight;
    const margin = 12;
    const gap = 12;
    const viewport = { left: margin, top: margin, right: window.innerWidth - margin, bottom: window.innerHeight - margin };
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
    const candidates = [
      { left: clamp(rect.left + (rect.width - width) / 2, viewport.left, viewport.right - width), top: rect.top - height - gap },
      { left: clamp(rect.left + (rect.width - width) / 2, viewport.left, viewport.right - width), top: rect.bottom + gap },
      { left: rect.right + gap, top: clamp(rect.top + (rect.height - height) / 2, viewport.top, viewport.bottom - height) },
      { left: rect.left - width - gap, top: clamp(rect.top + (rect.height - height) / 2, viewport.top, viewport.bottom - height) },
    ];
    const overlaps = (candidate: { left: number; top: number }): boolean => candidate.left < rect.right && candidate.left + width > rect.left && candidate.top < rect.bottom && candidate.top + height > rect.top;
    const fits = (candidate: { left: number; top: number }): boolean => candidate.left >= viewport.left && candidate.top >= viewport.top && candidate.left + width <= viewport.right && candidate.top + height <= viewport.bottom && !overlaps(candidate);
    const chosen = candidates.find(fits) ?? candidates.sort((left, right) => Number(overlaps(left)) - Number(overlaps(right)))[0]!;
    preview.style.left = `${clamp(chosen.left, viewport.left, viewport.right - width)}px`;
    preview.style.top = `${clamp(chosen.top, viewport.top, viewport.bottom - height)}px`;
  };

  const dismiss = (): void => {
    if (hideTimer) clearTimeout(hideTimer);
    const preview = context.element("hover-preview");
    preview.classList.remove("is-visible");
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!preview.classList.contains("is-visible")) preview.hidden = true;
    }, 180);
  };

  const hideHoverPreview = (): void => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    const bridge = context.getBridge();
    if (bridge) bridge.scheduleDismiss();
    else dismiss();
  };

  const showHoverPreview = (content: HTMLElement, anchor: HoverAnchor): void => {
    const viewState = context.getViewState();
    if (!canShowHoverPreview({ selected: selected(), detailOpen: viewState.detail, hoverCapable: supportsHoverDetails(), detailPanelViewport: context.getDetailPanelViewport(), keyboardSelection: context.getKeyboardSelection() })) return;
    const bridge = context.getBridge();
    bridge?.cancelDismiss();
    if (previewTimer) clearTimeout(previewTimer);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    previewTimer = setTimeout(() => {
      if (document.querySelector(".resource-popover:not([hidden]), .unbound-pr-tooltip:not([hidden])")) return;
      const current = context.getViewState();
      if (!canShowHoverPreview({ selected: selected(), detailOpen: current.detail, hoverCapable: supportsHoverDetails(), detailPanelViewport: context.getDetailPanelViewport(), keyboardSelection: context.getKeyboardSelection() })) return;
      const preview = context.element("hover-preview");
      const entering = !preview.classList.contains("is-visible");
      refreshOutputNodes(content, context.getData()?.tasks ?? []);
      preview.replaceChildren(content);
      preview.hidden = false;
      positionPreview(anchor);
      if (entering) window.requestAnimationFrame(() => preview.classList.add("is-visible"));
    }, 250);
  };

  const showCurrentSelectionPreview = (): void => {
    const data = context.getData();
    const current = context.getSelected();
    if (!data || !current.task && !current.group) return;
    if (current.task) {
      const task = data.tasks.find((item) => item.id === current.task);
      if (task) showSelectedHoverPreview({ kind: "task", id: task.id }, context.taskPreview(task));
    } else if (current.group) {
      const group = data.groups.find((item) => item.id === current.group);
      if (group) showSelectedHoverPreview({ kind: "group", id: group.id }, context.groupPreview(group));
    }
  };

  const showSelectedHoverPreview = (selection: { kind: "task" | "group"; id: string }, content: HTMLElement): void => {
    const viewState = context.getViewState();
    if (!viewState.detail || context.getKeyboardSelection() || context.getDetailPanelViewport() || !supportsHoverDetails()) return;
    const selector = selectedObjectFocusSelector(selection);
    const target = selector ? firstVisibleElement(document, selector) : null;
    const anchor = target ?? context.element("task-list");
    context.getBridge()?.bindTarget(anchor, () => showHoverPreview(content, anchor), hideHoverPreview);
    showHoverPreview(content, anchor);
  };

  document.addEventListener("resource-popover-open", () => { hideHoverPreview(); dismiss(); });

  const bindHoverTarget = (target: HTMLElement, content: HTMLElement): void => {
    const excluded = (node: EventTarget | null): boolean => node instanceof window.Element && Boolean(node.closest("[data-resource-trigger]"));
    let resourceHovered = false;
    const enter = (event: PointerEvent): void => {
      if (!resourceHovered && !excluded(event.target)) showHoverPreview(content, target);
    };
    context.getBridge()?.bindTarget(target, enter, () => { resourceHovered = false; hideHoverPreview(); });
    // pointerenter does not fire again when moving between descendants of a card.
    target.addEventListener("pointerover", (event) => {
      resourceHovered = excluded(event.target);
      if (resourceHovered) { hideHoverPreview(); dismiss(); }
      else if (excluded(event.relatedTarget)) showHoverPreview(content, target);
    });
  };

  const recordPointerType = (value: string | null | undefined): void => {
    if (!value) return;
    const next = value === "touch" || value === "pen" ? value : "mouse";
    const changed = lastPointerType !== next;
    lastPointerType = next;
    const viewState = context.getViewState();
    if (!changed || !viewState.detail || context.getKeyboardSelection()) return;
    const details = context.element("details");
    const focusWasInDrawer = details.classList.contains("open") && details.contains(document.activeElement);
    context.updateDetailsSurface(true, next !== "mouse");
    if (next !== "mouse") hideHoverPreview();
    else {
      if (focusWasInDrawer) context.focusSelectedObject();
      showCurrentSelectionPreview();
    }
  };

  const focusSelectedObject = (): void => {
    const current = context.getSelected();
    const selection = current.task ? { kind: "task" as const, id: current.task } : current.group ? { kind: "group" as const, id: current.group } : null;
    const selector = selectedObjectFocusSelector(selection);
    const target = selector ? firstVisibleElement(document, selector) : null;
    if (target) target.focus();
  };

  return {
    supportsHoverDetails,
    showHoverPreview,
    hideHoverPreview,
    recordPointerType,
    showCurrentSelectionPreview,
    bindHoverTarget,
    dismiss,
    pointerTypeFromEvent,
    focusSelectedObject,
  };
}
