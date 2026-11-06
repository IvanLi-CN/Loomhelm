import { stateIconName, stateLabel } from "./labels";
import { renderTimestamp } from "./timestamp";

export function renderStatusRow(item: { name: string; status: string; completedAt?: string | null | undefined }): HTMLElement {
  const row = document.createElement("div");
  row.className = "status-row";
  const status = document.createElement("span");
  status.className = "task-row-status-icon";
  status.dataset.state = item.status;
  status.setAttribute("role", "img");
  status.setAttribute("aria-label", stateLabel(item.status));
  const icon = document.createElement("i");
  icon.dataset.lucide = stateIconName(item.status);
  icon.setAttribute("aria-hidden", "true");
  status.append(icon);
  const name = document.createElement("span");
  name.className = "status-row-name";
  name.textContent = item.name;
  row.append(status, name);
  if (item.completedAt) row.append(renderTimestamp(item.completedAt));
  return row;
}
