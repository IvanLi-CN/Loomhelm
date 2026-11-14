import { formatLocalTime, fullLocalTime } from "./time";
import { attachTooltip } from "./tooltip";

export function renderTimestamp(value: string | null | undefined): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "timestamp-wrap";
  if (!value || !Number.isFinite(Date.parse(value))) return wrapper;
  const time = document.createElement("time");
  time.dateTime = value;
  time.dataset.localTimestamp = value;
  time.tabIndex = 0;
  time.textContent = formatLocalTime(value);
  const absolute = document.createElement("span");
  absolute.dataset.absoluteTimestamp = value;
  absolute.textContent = fullLocalTime(value);
  const tooltip = attachTooltip(time, absolute, absolute.textContent);
  tooltip.classList.add("timestamp-tooltip");
  wrapper.append(time, tooltip);
  return wrapper;
}

export function refreshTimestamps(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-local-timestamp]")) {
    element.textContent = formatLocalTime(element.dataset.localTimestamp!);
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-absolute-timestamp]")) {
    element.textContent = fullLocalTime(element.dataset.absoluteTimestamp!);
  }
}
