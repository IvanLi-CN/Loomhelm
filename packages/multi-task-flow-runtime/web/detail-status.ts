import { deriveDetailStatus } from "./detail-status-model";
import { stateLabel } from "./labels";
import type { ReadinessSummary } from "./model";
import { attachTooltip } from "./tooltip";

export function renderDetailStatus(options: {
  kind: "task" | "group";
  state: string;
  visualState?: string;
  label: string;
  runtime?: ReadinessSummary;
  dispatch?: "ready" | "blocked" | "unknown";
}): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "detail-status-group";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "detail-status-trigger";
  const runtime = options.runtime?.status ?? "unknown";
  const dispatch = options.dispatch ?? "unknown";
  const status = deriveDetailStatus({ ...options, runtime, dispatch });
  trigger.dataset.compositeState = status.key;
  trigger.dataset.presentation = status.presentation;
  trigger.dataset.tone = status.tone;
  const icon = document.createElement("i");
  icon.dataset.lucide = status.icon;
  icon.setAttribute("aria-hidden", "true");
  trigger.append(icon);
  const content = document.createElement("div");
  content.className = "detail-status-explanation";
  const stateLine = document.createElement("div");
  const sourceState =
    options.visualState && options.visualState !== options.state
      ? `（业务：${stateLabel(options.state)}）`
      : "";
  stateLine.textContent = `${options.kind === "task" ? "任务" : "交付单元"}状态：${options.label}${sourceState}${status.issue ? ` · ${status.issue}` : ""}`;
  const readinessLine = document.createElement("div");
  const readinessLabel =
    { ready: "就绪", blocked: "阻塞", unknown: "未知" }[runtime] ?? `未知（${runtime}）`;
  const dispatchLabel =
    { ready: "可调度", blocked: "不可调度", unknown: "未知" }[dispatch] ?? `未知（${dispatch}）`;
  readinessLine.textContent = `${options.kind === "task" ? "所属单元" : ""}运行就绪：${readinessLabel} · 调度状态：${dispatchLabel}`;
  content.append(stateLine, readinessLine);
  wrapper.append(
    trigger,
    attachTooltip(
      trigger,
      content,
      `${status.label}；${stateLine.textContent}；${readinessLine.textContent}`,
    ),
  );
  return wrapper;
}
