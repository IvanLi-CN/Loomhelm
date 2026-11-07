export const TASK_KIND_LABELS: Record<string, string> = {
  contribution: "贡献 contribution",
  release: "发布 release",
  deployment: "部署 deployment",
  verification: "验证 verification",
  coordination: "协调 coordination",
  development: "贡献 contribution（旧账本）",
  other: "协调 coordination（旧账本）",
  milestone: "里程碑 milestone",
};

export const DEPENDENCY_LABELS: Record<string, string> = {
  completed: "任务已完成 completed",
  integrated: "子 PR 已集成 integrated",
  merged: "父 PR 已合并 merged",
  published: "版本已发布 published",
  deployed: "运行环境已部署 deployed",
  verified: "验证已通过 verified",
  ci_passed: "CI 已通过 ci_passed",
  reviewed: "审查已完成 reviewed",
};

export const STATE_LABELS: Record<string, string> = {
  agent_idle: "Agent 空闲",
  planned: "待开始",
  ready: "就绪",
  starting: "启动中",
  running: "执行中",
  waiting: "等待中",
  unknown: "未知",
  idle: "空闲",
  blocked: "阻塞",
  integrated: "已集成",
  completed: "已完成",
  closed: "已收口",
  merged: "已合并",
  active: "进行中",
};

export type StateIconName = "loader-circle" | "hourglass" | "circle-alert" | "circle-check" | "circle-dot" | "circle-dashed";

export function stateIconName(state: string, ready = false): StateIconName {
  const normalized = ready && state === "planned" ? "ready" : state;
  if (["starting", "running", "active"].includes(normalized)) return "loader-circle";
  if (normalized === "waiting") return "hourglass";
  if (normalized === "blocked") return "circle-alert";
  if (["completed", "integrated", "closed", "merged"].includes(normalized)) return "circle-check";
  if (normalized === "ready") return "circle-dot";
  return "circle-dashed";
}

export function taskKindLabel(kind: string): string {
  return TASK_KIND_LABELS[kind] ?? kind;
}

export function dependencyLabel(requirement: string): string {
  return DEPENDENCY_LABELS[requirement] ?? requirement;
}

export function stateLabel(state: string, ready = false): string {
  const label = ready && state === "planned" ? STATE_LABELS.ready : STATE_LABELS[state];
  return label ?? state;
}

export function groupExecutionVisualState(groupState: string, executionState?: string): string {
  if (groupState === "closed") return groupState;
  if (executionState === "running" || executionState === "waiting" || executionState === "blocked") return executionState;
  if (groupState === "active" && (executionState === "unknown" || executionState === "idle")) return executionState;
  return groupState;
}
