import { attachTooltip } from "./tooltip";
import { renderStatusRow } from "./status-row";

export type DependencyTooltipItem = {
  name: string;
  state: string;
  status?: string;
  completedAt?: string | null | undefined;
};

export function renderDependencyTooltip(items: DependencyTooltipItem[], label: string): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "dependency-tooltip-wrap";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dependency-tooltip-trigger";
  trigger.textContent = label;
  wrapper.append(trigger, attachDependencyTooltip(trigger, items, label));
  return wrapper;
}

export function attachDependencyTooltip(trigger: HTMLElement, items: DependencyTooltipItem[], label: string): HTMLElement {
  const content = document.createElement("div");
  if (!items.length) {
    content.className = "dependency-tooltip-empty";
    content.textContent = "无依赖";
  } else {
    const list = document.createElement("ul");
    for (const item of items) {
      const row = document.createElement("li");
      row.append(renderStatusRow({ name: item.name, status: item.status ?? "unknown", completedAt: item.completedAt }));
      if (item.state) {
        const description = document.createElement("span");
        description.className = "dependency-tooltip-state";
        description.textContent = item.state;
        row.append(description);
      }
      list.append(row);
    }
    content.append(list);
  }
  return attachTooltip(trigger, content, label);
}
