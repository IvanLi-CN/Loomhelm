export type DetailSurface = "none" | "hover-preview" | "desktop-inspector" | "overlay-inspector" | "drawer";

export const DETAILS_PANEL_BREAKPOINT = 768;
export const DETAILS_PANEL_WIDTH = 336;
export const DETAILS_PANEL_GAP = 20;
export const MIN_DETAILS_CANVAS_WIDTH = 1000;

export const DETAIL_INTERACTION_SELECTOR = "#details, .task-card, .task-column, .task-row, #graph, #graph-a11y, .timeline-view";

export type DetailSurfaceContext = {
  selected: boolean;
  detailOpen: boolean;
  hoverCapable: boolean;
  detailPanelViewport?: boolean;
  drawerViewport?: boolean;
  keyboardSelection?: boolean;
};

export function detailsPanelFits(workspaceWidth: number): boolean {
  return workspaceWidth - DETAILS_PANEL_GAP - DETAILS_PANEL_WIDTH >= MIN_DETAILS_CANVAS_WIDTH;
}

export function supportsHoverInput(capabilities: {
  anyHover: boolean;
  anyFinePointer: boolean;
  pointerType?: "mouse" | "touch" | "pen" | null;
}): boolean {
  if (capabilities.pointerType && capabilities.pointerType !== "mouse") return false;
  return capabilities.anyHover && capabilities.anyFinePointer;
}

export function resolveDetailSurface(context: DetailSurfaceContext): DetailSurface {
  const detailVisible = context.selected && context.detailOpen;
  if (context.detailPanelViewport) return detailVisible ? "desktop-inspector" : "none";
  if (context.keyboardSelection) {
    return detailVisible ? context.drawerViewport ? "drawer" : "overlay-inspector" : "none";
  }
  if (detailVisible) {
    return context.drawerViewport ? "drawer" : "overlay-inspector";
  }
  return context.hoverCapable ? "hover-preview" : "none";
}

export function canShowHoverPreview(context: Pick<DetailSurfaceContext, "selected" | "detailOpen" | "hoverCapable" | "detailPanelViewport" | "keyboardSelection">): boolean {
  if (context.keyboardSelection || !context.hoverCapable) return false;
  return !context.detailOpen;
}

export function isDetailInteraction(target: Element | null): boolean {
  return Boolean(target?.closest(DETAIL_INTERACTION_SELECTOR));
}

export function selectedObjectFocusSelector(selection: { kind: "task" | "group"; id: string } | null): string | null {
  if (!selection) return null;
  const attribute = selection.kind === "task" ? "data-task-id" : "data-group-id";
  return `[${attribute}="${selection.id}"] .task-card-select, [${attribute}="${selection.id}"] .task-column-select`;
}
