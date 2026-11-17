/** A compact PR empty state, with refresh only when a query can be retried. */
export function unboundPRHint(refresh?: () => void, glyph?: SVGElement): HTMLElement {
  const hint = document.createElement("div");
  hint.className = "unbound-pr-hint";
  const label = document.createElement("span");
  label.textContent = "尚未关联 PR";
  hint.append(label);
  if (!refresh || !glyph) return hint;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "刷新 PR 信息");
  button.append(glyph);
  button.addEventListener("click", refresh);
  hint.append(button);
  return hint;
}
