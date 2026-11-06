export function focusAfterRerender(primary: HTMLElement | null, fallback: HTMLElement | null): void {
  const isFocusable = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected && !element.hidden && !element.closest("[hidden]") && (element.matches("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])") || element.getAttribute("role") === "button"));
  const target = isFocusable(primary) ? primary : isFocusable(fallback) ? fallback : null;
  target?.focus();
}

export function firstVisibleElement(root: ParentNode, selector: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>(selector)].find((element) => !element.closest("[hidden]")) ?? null;
}
