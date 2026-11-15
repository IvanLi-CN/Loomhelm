let tooltipSerial = 0;
const documentBindings = new WeakSet<Document>();
const tooltipClosers = new WeakMap<HTMLElement, (restoreFocus?: boolean) => void>();
let touchModality = false;

function text(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classNames.join(" ");
  node.textContent = value;
  return node;
}

function closeTooltips(
  except: HTMLElement | null = null,
  restoreFocus = false,
  ownerDocument: Document = except?.ownerDocument ?? document,
): void {
  for (const tooltip of ownerDocument.querySelectorAll<HTMLElement>(
    ".dependency-tooltip.is-open",
  )) {
    const triggerId = tooltip.dataset.triggerId;
    const trigger = triggerId ? ownerDocument.getElementById(triggerId) : null;
    if (except && (tooltip.contains(except) || trigger === except)) continue;
    const shouldRestoreFocus =
      restoreFocus && Boolean(trigger && tooltip.contains(ownerDocument.activeElement));
    const close = tooltipClosers.get(tooltip);
    if (close) {
      close(restoreFocus && shouldRestoreFocus);
      continue;
    }
    tooltip.classList.remove("is-open");
    tooltip.hidden = true;
    if (trigger && tooltip.getAttribute("role") === "dialog") {
      trigger.setAttribute("aria-expanded", "false");
      if (shouldRestoreFocus) {
        trigger.dataset.suppressTooltipFocus = "true";
        trigger.focus({ preventScroll: true });
      }
    }
  }
}

function installDocumentBinding(): void {
  const ownerDocument = document;
  if (documentBindings.has(ownerDocument)) return;
  documentBindings.add(ownerDocument);
  ownerDocument.addEventListener(
    "pointerdown",
    (event) => {
      touchModality = event.pointerType !== "mouse";
      const target = event.target as Element | null;
      if (!target?.closest(".dependency-tooltip-anchor, .dependency-tooltip"))
        closeTooltips(null, false, ownerDocument);
    },
    true,
  );
  ownerDocument.addEventListener(
    "keydown",
    (event) => {
      touchModality = false;
      if (
        event.key === "Escape" &&
        ownerDocument.querySelector(".dependency-tooltip.is-open") &&
        !ownerDocument.querySelector(".resource-popover")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeTooltips(null, true, ownerDocument);
      }
    },
    true,
  );
}

type TooltipPlacement = "auto" | "right";

function positionTooltip(
  trigger: HTMLElement,
  tooltip: HTMLElement,
  placement: TooltipPlacement = "auto",
): void {
  const rect = trigger.getBoundingClientRect();
  if (placement === "right") {
    const gap = 12;
    const viewportGap = 12;
    const owner = trigger.closest<HTMLElement>(".plan-info-panel");
    const ownerRect = owner?.getBoundingClientRect();
    const preferredLeft = Math.max(rect.right + gap, (ownerRect?.right ?? rect.right) + gap);
    const availableRight = window.innerWidth - preferredLeft - viewportGap;
    const preferredWidth = tooltip.offsetWidth;
    if (availableRight > 0 && availableRight < preferredWidth) {
      tooltip.style.width = `${Math.floor(availableRight)}px`;
    } else {
      tooltip.style.removeProperty("width");
    }
    const tooltipHeight = tooltip.getBoundingClientRect().height;
    // Version details have a strict right-side contract. The owning panel
    // reserves this lane, so never silently move the detail surface left.
    const left = preferredLeft;
    tooltip.dataset.placement = "right";
    const top = Math.max(8, Math.min(window.innerHeight - tooltipHeight - 8, rect.top));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    return;
  }
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.left))}px`;
  const above = rect.top - tooltip.offsetHeight - 8;
  const below = rect.bottom + 8;
  const top = above >= 8 ? above : Math.min(window.innerHeight - tooltip.offsetHeight - 8, below);
  tooltip.style.top = `${Math.max(8, top)}px`;
}

export function attachTooltip(
  trigger: HTMLElement,
  content: HTMLElement,
  label: string,
  options: { interactive?: boolean; placement?: TooltipPlacement } = {},
): HTMLElement {
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
  let suppressUntilPointerLeave = false;
  const cancelTimers = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    if (longPressTimer) clearTimeout(longPressTimer);
    if (closeTimer) clearTimeout(closeTimer);
    hoverTimer = null;
    longPressTimer = null;
    closeTimer = null;
  };
  const reposition = (): void => {
    if (!tooltip.hidden && tooltip.classList.contains("is-open"))
      positionTooltip(trigger, tooltip, options.placement);
  };
  const open = (): void => {
    cancelTimers();
    if (!trigger.isConnected) return;
    closeTooltips(trigger);
    if (options.interactive) trigger.setAttribute("aria-expanded", "true");
    tooltip.hidden = false;
    tooltip.classList.add("is-open");
    positionTooltip(trigger, tooltip, options.placement);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    trigger.closest<HTMLElement>(".plan-info-panel")?.addEventListener("scroll", reposition);
  };
  const close = (restoreFocus = true): void => {
    cancelTimers();
    const restoreTriggerFocus =
      restoreFocus && options.interactive && tooltip.contains(tooltip.ownerDocument.activeElement);
    tooltip.classList.remove("is-open");
    tooltip.hidden = true;
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    trigger.closest<HTMLElement>(".plan-info-panel")?.removeEventListener("scroll", reposition);
    if (options.interactive) trigger.setAttribute("aria-expanded", "false");
    if (restoreTriggerFocus && trigger.isConnected) {
      trigger.dataset.suppressTooltipFocus = "true";
      trigger.focus({ preventScroll: true });
    }
  };
  tooltipClosers.set(tooltip, close);
  const scheduleClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      close();
    }, 180);
  };
  trigger.addEventListener("pointerenter", (event) => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (event.pointerType === "mouse" && !suppressUntilPointerLeave)
      hoverTimer = setTimeout(open, 250);
  });
  trigger.addEventListener("pointerleave", () => {
    suppressUntilPointerLeave = false;
    scheduleClose();
  });
  tooltip.addEventListener("pointerenter", () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  });
  tooltip.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("pointerdown", (event) => {
    pointerStart = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "mouse" && !options.interactive) {
      suppressUntilPointerLeave = true;
      close();
    }
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
  trigger.addEventListener("pointercancel", () => {
    pointerStart = null;
    cancelTimers();
  });
  trigger.addEventListener("focus", () => {
    if (trigger.dataset.suppressTooltipFocus === "true") {
      delete trigger.dataset.suppressTooltipFocus;
      return;
    }
    if (suppressUntilPointerLeave) return;
    if (!touchModality) open();
  });
  if (options.interactive)
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      open();
    });
  tooltip.addEventListener("click", (event) => event.stopPropagation());
  tooltip.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next !== trigger && !tooltip.contains(next)) close();
  });
  trigger.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (
        document.activeElement !== trigger &&
        !tooltip.contains(document.activeElement) &&
        !tooltip.matches(":hover")
      )
        close();
    }, 0);
  });
  return tooltip;
}

export function closeAttachedTooltip(tooltip: HTMLElement): void {
  tooltipClosers.get(tooltip)?.();
}

/** Bind explicit icon-control hints to the project tooltip.
 * Body text, titles, progress and output use their dedicated preview/detail surfaces.
 * Observe dynamic controls and text updates; remove portals when their controls leave.
 */
export function installTextTooltips(root: HTMLElement = document.body): () => void {
  type Binding = {
    tooltip: HTMLElement;
    content: HTMLElement;
    previousAriaDescribedBy: string | null;
    hadAnchorClass: boolean;
  };
  const bindings = new Map<HTMLElement, Binding>();
  const removeBinding = (trigger: HTMLElement, binding: Binding): void => {
    if (trigger.getAttribute("aria-describedby") === binding.tooltip.id) {
      if (binding.previousAriaDescribedBy === null) trigger.removeAttribute("aria-describedby");
      else trigger.setAttribute("aria-describedby", binding.previousAriaDescribedBy);
    }
    if (!binding.hadAnchorClass) trigger.classList.remove("dependency-tooltip-anchor");
    closeAttachedTooltip(binding.tooltip);
    binding.tooltip.remove();
  };
  const sync = (): void => {
    const eligible = new Set(
      root.querySelectorAll<HTMLElement>(
        "button.icon-button[data-tooltip], a.icon-button[data-tooltip], a.brand-mark[data-tooltip], summary.profile-trigger[data-tooltip]",
      ),
    );
    for (const [trigger, binding] of bindings) {
      if (!root.contains(trigger) || !eligible.has(trigger)) {
        removeBinding(trigger, binding);
        bindings.delete(trigger);
      }
    }
    for (const trigger of eligible) {
      const label = trigger.dataset.tooltip ?? "";
      const existing = bindings.get(trigger);
      if (existing) {
        if (existing.content.textContent !== label) existing.content.textContent = label;
        continue;
      }
      const content = text("span", label);
      const previousAriaDescribedBy = trigger.getAttribute("aria-describedby");
      const hadAnchorClass = trigger.classList.contains("dependency-tooltip-anchor");
      const tooltip = attachTooltip(trigger, content, trigger.getAttribute("aria-label") ?? label);
      tooltip.classList.add("control-tooltip");
      root.append(tooltip);
      bindings.set(trigger, { tooltip, content, previousAriaDescribedBy, hadAnchorClass });
    }
  };
  sync();
  const observer = new window.MutationObserver(sync);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-tooltip"],
  });
  return () => {
    observer.disconnect();
    for (const [trigger, binding] of bindings) {
      removeBinding(trigger, binding);
    }
    bindings.clear();
  };
}
