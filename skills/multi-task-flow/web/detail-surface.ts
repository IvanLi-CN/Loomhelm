import type { DetailSurface } from "./interaction-policy";

export type DetailSurfaceElements = {
  workspace: HTMLElement;
  background: HTMLElement[];
  details: HTMLElement;
  detailsBackdrop: HTMLElement;
  hoverPreview: HTMLElement;
  closeDetails?: HTMLElement;
};

export function applyDetailSurface(elements: DetailSurfaceElements, surface: DetailSurface, detailPanelViewport: boolean, focus = false): void {
  const detailVisible = surface === "desktop-inspector" || surface === "overlay-inspector" || surface === "drawer";
  const drawer = surface === "drawer";
  const overlay = surface === "overlay-inspector";
  const backgroundElements = [...elements.background, ...[...elements.workspace.children]
    .filter((child) => child !== elements.details && child !== elements.detailsBackdrop)
    .map((child) => child as HTMLElement)];
  for (const background of new Set(backgroundElements)) {
    // A temporary surface must not block selection. Clicking another semantic
    // task or group updates this same surface instead of opening a second one.
    background.removeAttribute("inert");
    background.removeAttribute("aria-hidden");
  }
  elements.workspace.classList.toggle("has-details", detailPanelViewport && surface === "desktop-inspector");
  elements.workspace.classList.toggle("has-overlay-selection", overlay);
  elements.workspace.classList.toggle("has-drawer-selection", drawer);
  elements.details.hidden = !detailVisible;
  elements.details.classList.toggle("open", drawer || overlay);
  elements.details.setAttribute("aria-hidden", String(!detailVisible));
  elements.details.setAttribute("aria-modal", "false");
  if (drawer || overlay) elements.details.setAttribute("role", "dialog"); else elements.details.removeAttribute("role");
  elements.detailsBackdrop.hidden = !(drawer || overlay);
  if (surface !== "hover-preview") {
    elements.hoverPreview.classList.remove("is-visible");
    elements.hoverPreview.hidden = true;
  }
  if (focus) window.setTimeout(() => {
    if (drawer || overlay) elements.closeDetails?.focus();
    else if (surface === "desktop-inspector") elements.details.focus();
  }, 0);
}
