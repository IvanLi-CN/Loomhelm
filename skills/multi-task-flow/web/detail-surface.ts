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
  const slot = elements.details.closest<HTMLElement>(".details-slot");
  if (slot) slot.hidden = !detailVisible;
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
    if (drawer || overlay) elements.closeDetails?.focus({ preventScroll: true });
    else if (surface === "desktop-inspector") elements.details.focus({ preventScroll: true });
  }, 0);
}

// Keep the reserved grid column while the inspector follows the viewport.
export function installDetailViewport(details: HTMLElement): void {
  const slot = details.closest<HTMLElement>(".details-slot")!;
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const workspace = details.closest<HTMLElement>(".workspace");
  const update = (): void => {
    if (details.hidden || window.innerWidth < 768) return;
    const bounds = slot.getBoundingClientRect();
    // Start below the overview, then pin to the viewport as the workspace scrolls.
    const top = Math.min(Math.max(16, (workspace?.getBoundingClientRect().top ?? 16), (topbar?.getBoundingClientRect().bottom ?? 0) + 16), Math.max(16, window.innerHeight - 160));
    details.style.setProperty("--details-left", `${bounds.left}px`);
    details.style.setProperty("--details-width", `${bounds.width}px`);
    details.style.setProperty("--details-top", `${top}px`);
  };
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => { scheduled = false; update(); });
  };
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(slot);
  if (workspace) resizeObserver.observe(workspace);
  if (topbar) resizeObserver.observe(topbar);
  new MutationObserver(update).observe(details, { attributes: true, attributeFilter: ["hidden", "class"] });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  update();
}
