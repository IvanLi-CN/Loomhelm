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
  for (const tooltip of document.querySelectorAll<HTMLElement>("[role=tooltip].dependency-tooltip.is-open")) {
    const triggerId = tooltip.dataset.triggerId;
    if (except && (tooltip.contains(except) || (triggerId && document.getElementById(triggerId) === except))) continue;
    tooltip.classList.remove("is-open");
    tooltip.hidden = true;
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

export function attachTooltip(trigger: HTMLElement, content: HTMLElement, label: string): HTMLElement {
  installDocumentBinding();
  trigger.classList.add("dependency-tooltip-anchor");
  trigger.setAttribute("aria-label", label);
  const triggerId = `dependency-trigger-${++tooltipSerial}`;
  const tooltip = text("div", "", "dependency-tooltip");
  const tooltipId = `dependency-tooltip-${tooltipSerial}`;
  trigger.id = triggerId;
  tooltip.id = tooltipId;
  tooltip.dataset.triggerId = triggerId;
  tooltip.setAttribute("role", "tooltip");
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
    closeTooltips(trigger);
    tooltip.hidden = false;
    tooltip.classList.add("is-open");
    positionTooltip(trigger, tooltip);
  };
  const close = (): void => {
    cancelTimers();
    tooltip.classList.remove("is-open");
    tooltip.hidden = true;
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
  trigger.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== trigger && !tooltip.matches(":hover")) close();
    }, 0);
  });
  return tooltip;
}
