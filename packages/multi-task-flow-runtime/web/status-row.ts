import { stateIconName, stateLabel } from "./labels";
import type { PlanState, ReadinessBlocker, View } from "./model";
import { type RuntimeMetadata, runtimeIdentityWarning } from "./runtime-metadata";
import { renderTimestamp } from "./timestamp";
import { attachTooltip, closeAttachedTooltip } from "./tooltip";

export function renderStatusRow(item: {
  name: string;
  status: string;
  completedAt?: string | null | undefined;
}): HTMLElement {
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
  const proposal =
    planState?.proposal ??
    (planState?.completeness
      ? { status: planState.completeness.status, issues: planState.completeness.issues }
      : { status: "unknown" as const, issues: [] });
  const approval = planState?.approval ?? {
    status: planState?.approval_pending === false ? ("approved" as const) : ("unknown" as const),
    approval_id: null,
  };
  const scheduling = planState?.scheduling ?? {
    status:
      planState?.scheduling_eligible === true
        ? ("eligible" as const)
        : planState?.scheduling_eligible === false
          ? ("blocked" as const)
          : ("unknown" as const),
    blockers: [],
  };
  const runtime = planState?.runtime_readiness ?? { status: "unknown" as const, blockers: [] };
  return [
    {
      key: "proposal",
      label: "提案完整性",
      status: proposal.status,
      value:
        proposal.status === "complete"
          ? "Complete"
          : proposal.status === "blocked"
            ? "Blocked"
            : "Unknown",
      blockers: proposal.issues.map((issue) => ({
        code: issue.code,
        group_id: null,
        message: issue.message,
        resource: null,
      })),
    },
    {
      key: "approval",
      label: "Owner approval",
      status: approval.status,
      value:
        approval.status === "approved"
          ? "Approved"
          : approval.status === "not_approved"
            ? "Not approved"
            : "Unknown",
      blockers: [],
    },
    {
      key: "scheduling",
      label: "Scheduling",
      status: scheduling.status,
      value:
        scheduling.status === "eligible"
          ? "Schedulable"
          : scheduling.status === "blocked"
            ? "Not schedulable"
            : "Unknown",
      blockers: scheduling.blockers,
    },
    {
      key: "runtime",
      label: "Runtime readiness",
      status: runtime.status,
      value:
        runtime.status === "ready" ? "Ready" : runtime.status === "blocked" ? "Blocked" : "Unknown",
      blockers: runtime.blockers,
    },
  ];
}

export function planStateIssueRows(planState?: PlanState): PlanStatusRow[] {
  return planStateRows(planState).filter((item) =>
    item.key === "approval"
      ? item.status !== "approved"
      : item.status === "blocked" || item.status === "unknown",
  );
}

export function planStateSeverity(planState?: PlanState): PlanStateSeverity {
  if (!planState) return "ok";
  const issues = planStateIssueRows(planState);
  if (issues.some((item) => item.status === "blocked" || item.status === "not_approved"))
    return "blocked";
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

function infoText(tag: string, value: string, ...classNames: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classNames.join(" ");
  node.textContent = value;
  return node;
}

function infoField(label: string, value: string, copyValue: string | null = null): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan-info-field";
  const name = document.createElement("span");
  name.className = "plan-info-label";
  name.textContent = label;
  const content = document.createElement("div");
  content.className = "plan-info-value";
  const valueText = document.createElement("span");
  valueText.textContent = value;
  content.append(valueText);
  if (copyValue !== null) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-button plan-info-copy";
    copy.dataset.tooltip = `复制${label}`;
    copy.setAttribute("aria-label", `复制${label}`);
    const icon = document.createElement("i");
    icon.dataset.lucide = "copy";
    icon.setAttribute("aria-hidden", "true");
    copy.append(icon);
    copy.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(copyValue);
        copy.dataset.copied = "true";
        copy.dataset.tooltip = `已复制${label}`;
        copy.setAttribute("aria-label", `已复制${label}`);
        window.setTimeout(() => {
          delete copy.dataset.copied;
          copy.dataset.tooltip = `复制${label}`;
          copy.setAttribute("aria-label", `复制${label}`);
        }, 1200);
      } catch {
        copy.dataset.tooltip = `复制${label}失败`;
      }
    });
    content.append(copy);
  }
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
  return lifecycle === "approved"
    ? "已批准"
    : lifecycle === "draft"
      ? "草稿"
      : (lifecycle ?? "未知");
}

function issueEntries(planState?: PlanState): { key: string; message: string }[] {
  const entries: { key: string; message: string }[] = [];
  for (const row of planStateIssueRows(planState)) {
    if (row.key === "approval" && row.status !== "approved") {
      entries.push({
        key: "approval",
        message:
          row.status === "unknown" ? "Owner approval 状态未知。" : "Owner approval 尚未完成。",
      });
    }
    for (const blocker of row.blockers) {
      entries.push({
        key: `${blocker.code}:${blocker.group_id ?? ""}`,
        message: blockerText(blocker),
      });
    }
    if (!row.blockers.length && row.key !== "approval") {
      entries.push({ key: row.key, message: `${row.label}：${row.value}` });
    }
  }
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
}

function packageLabel(
  name: string | null,
  version: string | null,
  fallback: string,
): { value: string; copy: string | null } {
  if (name && version) {
    const value = `${name}@${version}`;
    return { value, copy: value };
  }
  return { value: fallback, copy: null };
}

function runtimeSourceLabel(source: RuntimeMetadata["static_viewer"]["source"]): string {
  return source === "package"
    ? "package"
    : source === "legacy-bundle"
      ? "legacy bundle"
      : source === "custom-view"
        ? "custom view"
        : source === "source-preview"
          ? "source preview"
          : "unknown";
}

function compactPackage(
  name: string | null | undefined,
  version: string | null | undefined,
): string {
  return name && version ? `${name}@${version}` : "未知";
}

function compactComparison(
  staticValue: string | number | null | undefined,
  daemonValue: string | number | null | undefined,
): string {
  if (staticValue !== null && staticValue !== undefined && staticValue === daemonValue)
    return String(staticValue);
  if (staticValue === null || staticValue === undefined)
    return daemonValue === null || daemonValue === undefined ? "未知" : `Daemon ${daemonValue}`;
  if (daemonValue === null || daemonValue === undefined) return `Viewer ${staticValue}`;
  return `Viewer ${staticValue} · Daemon ${daemonValue}`;
}

function runtimeIdentityFields(
  staticViewer: RuntimeMetadata["static_viewer"] | undefined,
  daemon: RuntimeMetadata["daemon"] | undefined,
  staticPackage: { value: string; copy: string | null },
  daemonPackage: { value: string; copy: string | null },
): HTMLElement {
  const staticViewerContract =
    staticViewer?.viewer_contract === null || staticViewer?.viewer_contract === undefined
      ? "未知"
      : String(staticViewer.viewer_contract);
  const daemonViewerContract =
    daemon?.viewer_contract === null || daemon?.viewer_contract === undefined
      ? "未知"
      : String(daemon.viewer_contract);
  const body = document.createElement("div");
  body.className = "plan-info-identity-fields";
  body.append(
    infoField("静态 Viewer 包", staticPackage.value, staticPackage.copy),
    infoField("Daemon 包", daemonPackage.value, daemonPackage.copy),
    infoField(
      "静态兼容线",
      staticViewer?.compatibility_line ?? "未知（未声明兼容线）",
      staticViewer?.compatibility_line,
    ),
    infoField(
      "Daemon 兼容线",
      daemon?.compatibility_line ?? "未知（daemon 未提供兼容线）",
      daemon?.compatibility_line,
    ),
    infoField("静态 Skill", staticViewer?.skill_version ?? "未知", staticViewer?.skill_version),
    infoField("Daemon Skill", daemon?.skill_version ?? "未知", daemon?.skill_version),
    infoField(
      "静态 Viewer contract",
      staticViewerContract,
      staticViewer?.viewer_contract === null || staticViewer?.viewer_contract === undefined
        ? null
        : staticViewerContract,
    ),
    infoField(
      "Daemon Viewer contract",
      daemonViewerContract,
      daemon?.viewer_contract === null || daemon?.viewer_contract === undefined
        ? null
        : daemonViewerContract,
    ),
    infoField("Service contract", daemon?.service_contract ?? "未知", daemon?.service_contract),
    infoField("静态 build ID", staticViewer?.build_id ?? "未知", staticViewer?.build_id),
    infoField("Daemon build ID", daemon?.build_id ?? "未知", daemon?.build_id),
    infoField("静态 source SHA", staticViewer?.source_sha ?? "未知", staticViewer?.source_sha),
    infoField("Daemon source SHA", daemon?.source_sha ?? "未知", daemon?.source_sha),
  );
  return body;
}

function removeRuntimeIdentityTooltips(): void {
  for (const tooltip of document.querySelectorAll<HTMLElement>(".plan-info-identity-tooltip")) {
    closeAttachedTooltip(tooltip);
    tooltip.remove();
  }
}

export function closeRuntimeIdentityTooltips(): void {
  removeRuntimeIdentityTooltips();
}

function runtimeIdentityIsComplete(
  staticViewer: RuntimeMetadata["static_viewer"] | undefined,
  daemon: RuntimeMetadata["daemon"] | undefined,
): boolean {
  if (!staticViewer || !daemon) return false;
  if (staticViewer.source === "unknown") return false;
  return [
    staticViewer.package_name,
    staticViewer.package_version,
    staticViewer.compatibility_line,
    staticViewer.skill_version,
    staticViewer.viewer_contract,
    staticViewer.build_id,
    staticViewer.source_sha,
    daemon.package_name,
    daemon.package_version,
    daemon.compatibility_line,
    daemon.skill_version,
    daemon.viewer_contract,
    daemon.service_contract,
    daemon.build_id,
    daemon.source_sha,
  ].every((value) => value !== null && value !== undefined);
}

function runtimeIdentitySection(
  runtime: RuntimeMetadata | null,
  mobileDisclosureOpen = false,
): HTMLElement {
  removeRuntimeIdentityTooltips();
  const section = infoSection("运行时身份");
  const staticViewer = runtime?.static_viewer;
  const daemon = runtime?.daemon;
  const staticPackage = packageLabel(
    staticViewer?.package_name ?? null,
    staticViewer?.package_version ?? null,
    "未知（静态资源未声明 package 身份）",
  );
  const daemonPackage = packageLabel(
    daemon?.package_name ?? null,
    daemon?.package_version ?? null,
    "未知（daemon 未提供 package 身份）",
  );
  const staticPackageCompact = compactPackage(
    staticViewer?.package_name,
    staticViewer?.package_version,
  );
  const daemonPackageCompact = compactPackage(daemon?.package_name, daemon?.package_version);
  const warnings = [
    ...new Set(
      [runtime?.warning, runtime ? runtimeIdentityWarning(runtime) : null].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const identityStatus = warnings.length
    ? "check"
    : runtime && runtimeIdentityIsComplete(staticViewer, daemon)
      ? "aligned"
      : "unknown";
  const identitySummary = document.createElement("div");
  identitySummary.className = "plan-info-identity-summary";
  identitySummary.dataset.status = identityStatus;
  const identityPrimary = document.createElement("div");
  identityPrimary.className = "plan-info-identity-primary";
  const packageValue = document.createElement("strong");
  packageValue.className = "plan-info-identity-package";
  packageValue.textContent =
    staticPackageCompact === daemonPackageCompact
      ? staticPackageCompact
      : `Viewer ${staticPackageCompact} · Daemon ${daemonPackageCompact}`;
  const identityMeta = document.createElement("span");
  identityMeta.className = "plan-info-identity-meta";
  identityMeta.textContent = `来源 ${runtimeSourceLabel(staticViewer?.source ?? "unknown")} · 兼容线 ${compactComparison(staticViewer?.compatibility_line, daemon?.compatibility_line)}`;
  identityPrimary.append(packageValue, identityMeta);
  const identityState = document.createElement("span");
  identityState.className = "plan-info-identity-state";
  const stateIcon = document.createElement("i");
  stateIcon.dataset.lucide =
    identityStatus === "aligned"
      ? "circle-check"
      : identityStatus === "check"
        ? "circle-alert"
        : "circle-help";
  stateIcon.setAttribute("aria-hidden", "true");
  identityState.append(
    stateIcon,
    document.createTextNode(
      identityStatus === "aligned" ? "一致" : identityStatus === "check" ? "需核对" : "未知",
    ),
  );
  const desktopDetails = document.createElement("div");
  desktopDetails.className = "plan-info-identity-details-desktop";
  const desktopTrigger = document.createElement("button");
  desktopTrigger.type = "button";
  desktopTrigger.className = "icon-button plan-info-identity-trigger";
  desktopTrigger.setAttribute("aria-label", "查看版本详情");
  const arrow = document.createElement("i");
  arrow.dataset.lucide = "chevron-right";
  arrow.setAttribute("aria-hidden", "true");
  desktopTrigger.append(arrow);
  const tooltipContent = document.createElement("div");
  tooltipContent.className = "plan-info-identity-tooltip-content";
  tooltipContent.append(
    infoText("strong", "版本详情", "plan-info-identity-tooltip-title"),
    runtimeIdentityFields(staticViewer, daemon, staticPackage, daemonPackage),
  );
  let tooltip: HTMLElement | null = null;
  const mountTooltip = (): void => {
    if (tooltip && !tooltip.isConnected) document.body.append(tooltip);
  };
  desktopTrigger.addEventListener("pointerenter", mountTooltip);
  desktopTrigger.addEventListener("focus", mountTooltip);
  desktopTrigger.addEventListener("click", mountTooltip);
  tooltip = attachTooltip(desktopTrigger, tooltipContent, "查看版本详情", {
    interactive: true,
    placement: "right",
  });
  tooltip.classList.add("plan-info-identity-tooltip");
  desktopDetails.append(desktopTrigger);
  identitySummary.append(identityPrimary, identityState, desktopDetails);
  section.append(identitySummary);
  if (warnings.length) {
    const warning = document.createElement("p");
    warning.className = "plan-info-warning";
    warning.setAttribute("role", "alert");
    warning.textContent = warnings.join(" ");
    section.append(warning);
  }
  const disclosure = document.createElement("details");
  disclosure.className = "plan-info-disclosure plan-info-disclosure-mobile";
  disclosure.open = mobileDisclosureOpen;
  const disclosureSummary = document.createElement("summary");
  disclosureSummary.append(
    infoText("span", "查看完整身份"),
    infoText("span", "构建 / 契约 / SHA", "plan-info-disclosure-hint"),
  );
  const disclosureBody = runtimeIdentityFields(staticViewer, daemon, staticPackage, daemonPackage);
  disclosureBody.classList.add("plan-info-disclosure-body");
  disclosure.append(disclosureSummary, disclosureBody);
  section.append(disclosure);
  return section;
}

export function renderPlanInfoContent(
  container: HTMLElement,
  view: Pick<
    View,
    "orchestration" | "groups" | "tasks" | "selected_plan_id" | "execution_phase" | "plan_state"
  >,
  runtime: RuntimeMetadata | null = null,
): void {
  const mobileDisclosureOpen =
    container.querySelector<HTMLDetailsElement>(".plan-info-disclosure-mobile")?.open ?? false;
  container.replaceChildren();
  container.append(runtimeIdentitySection(runtime, mobileDisclosureOpen));
  const planState = view.plan_state;
  const overview = infoSection("这次编排");
  overview.append(
    infoField(
      "项目",
      `${view.orchestration.repository.owner} / ${view.orchestration.repository.name}`,
    ),
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
