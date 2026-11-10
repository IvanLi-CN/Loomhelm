import { stateIconName, stateLabel } from "./labels";
import { renderTimestamp } from "./timestamp";
import type { PlanState, ReadinessBlocker, View } from "./model";

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

export type PlanStatusRow = {
  key: "proposal" | "approval" | "scheduling" | "runtime";
  label: string;
  status: string;
  value: string;
  blockers: ReadinessBlocker[];
};

export type PlanStateSeverity = "ok" | "blocked" | "unknown";

function blockerText(blocker: ReadinessBlocker): string {
  const resource = blocker.resource
    ? ` · 资源：${blocker.resource.status === "not_created" ? "尚未创建" : "未知"}`
    : "";
  return `${blocker.message}${resource}`;
}

export function planStateRows(planState?: PlanState): PlanStatusRow[] {
  const proposal = planState?.proposal ?? (planState?.completeness
    ? { status: planState.completeness.status, issues: planState.completeness.issues }
    : { status: "unknown" as const, issues: [] });
  const approval = planState?.approval ?? {
    status: planState?.approval_pending === false ? "approved" as const : "unknown" as const,
    approval_id: null,
  };
  const scheduling = planState?.scheduling ?? {
    status: planState?.scheduling_eligible === true
      ? "eligible" as const
      : planState?.scheduling_eligible === false
        ? "blocked" as const
        : "unknown" as const,
    blockers: [],
  };
  const runtime = planState?.runtime_readiness ?? { status: "unknown" as const, blockers: [] };
  return [
    {
      key: "proposal",
      label: "提案完整性",
      status: proposal.status,
      value: proposal.status === "complete" ? "Complete" : proposal.status === "blocked" ? "Blocked" : "Unknown",
      blockers: proposal.issues.map((issue) => ({ code: issue.code, group_id: null, message: issue.message, resource: null })),
    },
    {
      key: "approval",
      label: "Owner approval",
      status: approval.status,
      value: approval.status === "approved" ? "Approved" : approval.status === "not_approved" ? "Not approved" : "Unknown",
      blockers: [],
    },
    {
      key: "scheduling",
      label: "Scheduling",
      status: scheduling.status,
      value: scheduling.status === "eligible" ? "Schedulable" : scheduling.status === "blocked" ? "Not schedulable" : "Unknown",
      blockers: scheduling.blockers,
    },
    {
      key: "runtime",
      label: "Runtime readiness",
      status: runtime.status,
      value: runtime.status === "ready" ? "Ready" : runtime.status === "blocked" ? "Blocked" : "Unknown",
      blockers: runtime.blockers,
    },
  ];
}

export function planStateIssueRows(planState?: PlanState): PlanStatusRow[] {
  return planStateRows(planState).filter((item) => item.key === "approval"
    ? item.status !== "approved"
    : item.status === "blocked" || item.status === "unknown");
}

export function planStateSeverity(planState?: PlanState): PlanStateSeverity {
  if (!planState) return "ok";
  const issues = planStateIssueRows(planState);
  if (issues.some((item) => item.status === "blocked" || item.status === "not_approved")) return "blocked";
  return issues.length ? "unknown" : "ok";
}

export function planStateHasIssues(planState?: PlanState): boolean {
  return planStateSeverity(planState) !== "ok";
}

export function renderPlanState(container: HTMLElement, planState?: PlanState): void {
  container.replaceChildren();
  container.hidden = !planStateHasIssues(planState);
  if (!planState || !planStateHasIssues(planState)) return;
  for (const item of planStateRows(planState)) {
    const row = document.createElement("div");
    row.className = "plan-state-row";
    row.dataset.planStateKey = item.key;
    row.dataset.status = item.status;
    const label = document.createElement("span");
    label.className = "plan-state-label";
    label.textContent = item.label;
    const value = document.createElement("strong");
    value.className = "plan-state-value";
    value.textContent = item.value;
    row.append(label, value);
    if (item.blockers.length) {
      const details = document.createElement("span");
      details.className = "plan-state-detail";
      details.textContent = item.blockers.map(blockerText).join(" · ");
      row.append(details);
    }
    container.append(row);
  }
}

function infoField(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan-info-field";
  const name = document.createElement("span");
  name.className = "plan-info-label";
  name.textContent = label;
  const content = document.createElement("span");
  content.className = "plan-info-value";
  content.textContent = value;
  row.append(name, content);
  return row;
}

function infoSection(title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "plan-info-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function phaseLabel(phase: View["execution_phase"]): string {
  return phase === "implementation" ? "实施中" : phase === "planning" ? "规划中" : "未知";
}

function lifecycleLabel(lifecycle: string | undefined): string {
  return lifecycle === "approved" ? "已批准" : lifecycle === "draft" ? "草稿" : lifecycle ?? "未知";
}

function issueEntries(planState?: PlanState): { key: string; message: string }[] {
  const entries: { key: string; message: string }[] = [];
  for (const row of planStateIssueRows(planState)) {
    if (row.key === "approval" && row.status !== "approved") {
      entries.push({ key: "approval", message: "Owner approval 尚未完成。" });
    }
    for (const blocker of row.blockers) {
      entries.push({ key: `${blocker.code}:${blocker.group_id ?? ""}`, message: blockerText(blocker) });
    }
    if (!row.blockers.length && row.key !== "approval") {
      entries.push({ key: row.key, message: `${row.label}：${row.value}` });
    }
  }
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
}

export function renderPlanInfoContent(container: HTMLElement, view: Pick<View, "orchestration" | "groups" | "tasks" | "selected_plan_id" | "execution_phase" | "plan_state">): void {
  container.replaceChildren();
  const planState = view.plan_state;
  const overview = infoSection("这次编排");
  overview.append(
    infoField("项目", `${view.orchestration.repository.owner} / ${view.orchestration.repository.name}`),
    infoField("版本", view.selected_plan_id || planState?.active_plan_id || "未知"),
    infoField("阶段", phaseLabel(view.execution_phase)),
    infoField("生命周期", lifecycleLabel(planState?.lifecycle)),
    infoField("对象", `${view.tasks.length} 个任务 · ${view.groups.length} 个交付单元`),
    infoField("修订", `rev ${view.orchestration.revision}`),
  );
  container.append(overview);

  const status = infoSection("状态");
  for (const row of planStateRows(planState)) {
    const item = document.createElement("div");
    item.className = "plan-info-status";
    item.dataset.status = row.status;
    const label = document.createElement("span");
    label.className = "plan-info-label";
    label.textContent = row.label;
    const value = document.createElement("strong");
    value.className = "plan-info-value";
    value.textContent = row.value;
    item.append(label, value);
    if (row.blockers.length) {
      const detail = document.createElement("span");
      detail.className = "plan-info-detail";
      detail.textContent = row.blockers.map(blockerText).join(" · ");
      item.append(detail);
    }
    status.append(item);
  }
  container.append(status);

  const issues = infoSection("问题");
  const entries = issueEntries(planState);
  if (entries.length) {
    const list = document.createElement("ul");
    list.className = "plan-info-issues";
    for (const entry of entries) {
      const item = document.createElement("li");
      item.textContent = entry.message;
      list.append(item);
    }
    issues.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "plan-info-empty";
    empty.textContent = "当前没有待处理问题。";
    issues.append(empty);
  }
  container.append(issues);
}
