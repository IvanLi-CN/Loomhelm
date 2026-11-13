/** A standalone, actionable hint for an absent PR binding. */
export function unboundPRHint(refresh: () => void, glyph: SVGElement): HTMLElement {
  const hint = document.createElement("div"); hint.className = "unbound-pr-hint";
  const label = document.createElement("span"); label.textContent = "尚未关联 PR";
  const button = document.createElement("button"); button.type = "button";
  button.setAttribute("aria-label", "刷新 PR 信息"); button.append(glyph);
  button.addEventListener("click", refresh);
  hint.append(label, button); return hint;
}
