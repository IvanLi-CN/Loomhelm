let tooltipSerial = 0;
let documentBindingInstalled = false;
let touchModality = false;

function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classNames.join(" ");
  node.textContent = value;
  return node;
}

function closeTooltips(except: HTMLElement | null = null): void {
  for (const tooltip of document.querySelectorAll<HTMLElement>(".dependency-tooltip.is-open")) {
    const triggerId = tooltip.dataset.triggerId;
    if (except && (tooltip.contains(except) || (triggerId && document.getElementById(triggerId) === except))) continue;
    tooltip.classList.remove("is-open");
    tooltip.hidden = true;
    if (triggerId) document.getElementById(triggerId)?.setAttribute("aria-expanded", "false");
  }
}

function installDocumentBinding(): void {
  if (documentBindingInstalled) return;
  documentBindingInstalled = true;
  document.addEventListener("pointerdown", (event) => {
    touchModality = event.pointerType !== "mouse";
    const target = event.target as Element | null;
    if (!target?.closest(".dependency-tooltip-anchor, .dependency-tooltip")) closeTooltips();
  }, true);
  document.addEventListener("keydown", (event) => {
    touchModality = false;
    if (event.key === "Escape" && document.querySelector(".dependency-tooltip.is-open") && !document.querySelector(".resource-popover")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeTooltips();
    }
  }, true);
}

function positionTooltip(trigger: HTMLElement, tooltip: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.left))}px`;
  const above = rect.top - tooltip.offsetHeight - 8;
  const below = rect.bottom + 8;
  const top = above >= 8 ? above : Math.min(window.innerHeight - tooltip.offsetHeight - 8, below);
  tooltip.style.top = `${Math.max(8, top)}px`;
}

export function attachTooltip(trigger: HTMLElement, content: HTMLElement, label: string, options: { interactive?: boolean } = {}): HTMLElement {
  installDocumentBinding();
  trigger.classList.add("dependency-tooltip-anchor");
  trigger.setAttribute("aria-label", label);
  const triggerId = `dependency-trigger-${++tooltipSerial}`;
  const tooltip = text("div", "", "dependency-tooltip");
  const tooltipId = `dependency-tooltip-${tooltipSerial}`;
  trigger.id ||= triggerId;
  tooltip.id = tooltipId;
  tooltip.dataset.triggerId = trigger.id;
  tooltip.setAttribute("role", options.interactive ? "dialog" : "tooltip");
  if (options.interactive) {
    tooltip.setAttribute("aria-label", label);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", tooltipId);
  }
  tooltip.hidden = true;
  tooltip.append(content);
  trigger.setAttribute("aria-describedby", tooltipId);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerStart: { x: number; y: number } | null = null;
  const cancelTimers = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    if (longPressTimer) clearTimeout(longPressTimer);
    if (closeTimer) clearTimeout(closeTimer);
    hoverTimer = null;
    longPressTimer = null;
    closeTimer = null;
  };
  const open = (): void => {
    cancelTimers();
    if (!trigger.isConnected) return;
    closeTooltips(trigger);
    tooltip.hidden = false;
    tooltip.classList.add("is-open");
    positionTooltip(trigger, tooltip);
    if (options.interactive) trigger.setAttribute("aria-expanded", "true");
  };
  const close = (): void => {
    cancelTimers();
    tooltip.classList.remove("is-open");
    tooltip.hidden = true;
    if (options.interactive) trigger.setAttribute("aria-expanded", "false");
  };
  const scheduleClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { closeTimer = null; close(); }, 180);
  };
  trigger.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") hoverTimer = setTimeout(open, 250);
  });
  trigger.addEventListener("pointerleave", scheduleClose);
  tooltip.addEventListener("pointerenter", () => { if (closeTimer) clearTimeout(closeTimer); closeTimer = null; });
  tooltip.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("pointerdown", (event) => {
    pointerStart = { x: event.clientX, y: event.clientY };
    if (event.pointerType !== "mouse") longPressTimer = setTimeout(open, 500);
  });
  trigger.addEventListener("pointermove", (event) => {
    if (!pointerStart) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 10) {
      pointerStart = null;
      cancelTimers();
    }
  });
  trigger.addEventListener("pointerup", () => {
    pointerStart = null;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  });
  trigger.addEventListener("pointercancel", () => { pointerStart = null; cancelTimers(); });
  trigger.addEventListener("focus", () => { if (!touchModality) open(); });
  if (options.interactive) trigger.addEventListener("click", event => {
    event.stopPropagation();
    open();
  });
  tooltip.addEventListener("click", event => event.stopPropagation());
  tooltip.addEventListener("focusout", event => {
    const next = event.relatedTarget as Node | null;
    if (next !== trigger && !tooltip.contains(next)) close();
  });
  trigger.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== trigger && !tooltip.contains(document.activeElement) && !tooltip.matches(":hover")) close();
    }, 0);
  });
  return tooltip;
}


/** Bind explicit icon-control hints to the project tooltip.
 * Body text, titles, progress and output use their dedicated preview/detail surfaces.
 * Observe dynamic controls and text updates; remove portals when their controls leave.
 */
export function installTextTooltips(root: HTMLElement = document.body): () => void {
  const bindings = new Map<HTMLElement, { tooltip: HTMLElement; content: HTMLElement }>();
  const sync = (): void => {
    for (const [trigger, { tooltip }] of bindings) {
      if (!root.contains(trigger)) {
        tooltip.remove();
        bindings.delete(trigger);
      }
    }
    for (const trigger of root.querySelectorAll<HTMLElement>("button.icon-button[data-tooltip], a.icon-button[data-tooltip]")) {
      const label = trigger.dataset.tooltip ?? "";
      const existing = bindings.get(trigger);
      if (existing) {
        if (existing.content.textContent !== label) existing.content.textContent = label;
        continue;
      }
      const content = text("span", label);
      const tooltip = attachTooltip(trigger, content, trigger.getAttribute("aria-label") ?? label);
      tooltip.classList.add("control-tooltip");
      root.append(tooltip);
      bindings.set(trigger, { tooltip, content });
    }
  };
  sync();
  const observer = new window.MutationObserver(sync);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tooltip"] });
  return () => {
    observer.disconnect();
    for (const [trigger, { tooltip }] of bindings) {
      if (trigger.getAttribute("aria-describedby") === tooltip.id) trigger.removeAttribute("aria-describedby");
      tooltip.remove();
    }
    bindings.clear();
  };
}
