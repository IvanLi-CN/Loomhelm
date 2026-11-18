import type { Task } from "./model";

const reasonLabels: Record<string, string> = {
  CAPACITY: "执行名额已满",
  DEPENDENCIES_PENDING: "等待前置依赖",
  GROUP_NOT_READY: "交付单元尚未就绪",
  GROUP_NOT_MERGED: "等待交付单元 PR 合并",
  BASE_NOT_READY: "等待同步交付基线",
  BRANCH_NOT_PUBLISHED: "等待发布交付分支",
  PLAN_REVISION_HOLD: "等待计划修订批准",
  OPERATION_PENDING: "等待未决操作对账",
};

export function taskDispatchStatus(task: Task, compact = false): string | null {
  const eligibility = task.dispatch_eligibility;
  if (!eligibility) return null;
  if (eligibility.allowed) return "可派发";

  const blocker = eligibility.blocker;
  if (compact) {
    switch (blocker?.code) {
      case "CAPACITY":
        return "名额已满";
      case "DEPENDENCIES_PENDING":
        return "等待依赖";
      case "OPERATION_PENDING":
        return "等待对账";
      default:
        return "暂不可派发";
    }
  }
  const reason = blocker && reasonLabels[blocker.code];
  const readiness = task.is_ready ? "依赖已就绪 · " : "";
  return `${readiness}暂不可派发：${reason || blocker?.message || "原因未知"}`;
}
