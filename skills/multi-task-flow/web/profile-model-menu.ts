/** Same stroked chevron used by the dashboard's Lucide menu triggers. */
export function menuChevron(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(icon.namespaceURI, "path"); path.setAttribute("d", "m6 9 6 6 6-6"); icon.append(path);
  return icon;
}

export function profileModelMenu(label: string, options: { value: string; label: string }[], selected: string, onChange: () => void) {
  const root = document.createElement("div"); root.className = "profile-model-control";
  const button = document.createElement("button"); button.type = "button"; button.className = "profile-model";
  button.setAttribute("aria-label", label); button.setAttribute("aria-haspopup", "listbox"); button.setAttribute("aria-expanded", "false");
  const valueLabel = document.createElement("span"); button.append(valueLabel, menuChevron());
  const list = document.createElement("ul"); list.className = "custom-menu profile-model-options"; list.role = "listbox"; list.setAttribute("aria-label", label); list.hidden = true;
  const close = (focus = false) => { list.hidden = true; button.setAttribute("aria-expanded", "false"); if (focus) button.focus(); };
  let value = selected;
  const update = () => { valueLabel.textContent = options.find((item) => item.value === value)?.label ?? value; for (const item of list.querySelectorAll<HTMLElement>("[role=option]")) item.setAttribute("aria-selected", String(item.dataset.value === value)); };
  const open = () => { if (button.disabled) return; list.hidden = false; button.setAttribute("aria-expanded", "true"); (list.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.querySelector<HTMLElement>("button"))?.focus(); };
  for (const option of options) {
    const row = document.createElement("li"); const item = document.createElement("button"); item.type = "button"; item.role = "option"; item.tabIndex = -1; item.dataset.value = option.value; item.textContent = option.label;
    item.addEventListener("click", () => { value = option.value; update(); close(true); onChange(); }); row.append(item); list.append(row);
  }
  button.addEventListener("click", () => { if (list.hidden) open(); else close(); });
  root.addEventListener("click", (event) => event.stopPropagation());
  root.addEventListener("focusout", (event) => { if (!root.contains(event.relatedTarget as Node | null)) close(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && list.hidden) return;
    event.stopPropagation();
    const items = [...list.querySelectorAll<HTMLButtonElement>("[role=option]")]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" && !list.hidden) { event.preventDefault(); close(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); if (list.hidden) open(); else items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus(); }
  });
  update(); root.append(button, list);
  return { root, button, get value() { return value; }, set disabled(disabled: boolean) { button.disabled = disabled; if (disabled) close(); } };
}
