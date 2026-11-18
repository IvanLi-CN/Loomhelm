import {
  activePlan,
  approved,
  authorizedAction,
  branchReceipt,
  ensureSchedulable,
  find,
  groupOwnerThread,
  isDeliveryVerification,
  isSharedDeliveryTask,
  legacyLedger,
} from "./engine-support-core";
import {
  activeOperation,
  isMergedContributionContinuation,
  ready,
  requireContributionTaskDispatchGate,
} from "./engine-support-gates";
import { ContractError, requireCondition } from "./errors";
import type { Ledger, Task } from "./schema";
import { isContributionKind } from "./schema";

export function requireTaskCapacity(ledger: Ledger): void {
  const running = ledger.tasks.filter((item) =>
    ["starting", "running", "agent_idle"].includes(item.state),
  ).length;
  const pending = ledger.operations.filter(
    (item) =>
      item.kind === "dispatch" && item.request.target_type !== "group" && activeOperation(item),
  ).length;
  requireCondition(
    running + pending < ledger.config.max_running_tasks,
    "CAPACITY",
    "No execution slot available",
    4,
  );
}

export function requireTaskDispatch(ledger: Ledger, target: Task): void {
  authorizedAction(ledger, "dispatch");
  ensureSchedulable(ledger, approved(ledger));
  requireCondition(
    !isDeliveryVerification(target),
    "DELIVERY_VERIFICATION_DISPATCH",
    "A delivery verification must use its bound delivery agent, not a task conversation",
    3,
  );
  requireCondition(
    target.disposition === "active",
    "TASK_NOT_ACTIVE",
    "Task is no longer an active responsibility",
    3,
  );
  requireCondition(
    ["planned", "ready"].includes(target.state) && !target.thread_id,
    "NOT_DISPATCHABLE",
    "Task already started or bound",
    4,
  );
  const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
  requireCondition(
    !isSharedDeliveryTask(ledger, target),
    "SHARED_DELIVERY_UNIT_DISPATCH",
    "A single-contribution delivery unit is dispatched through its delivery-unit conversation; do not create a task conversation",
    3,
    {
      recovery: ["dispatch-group-claim", "dispatch-resolve", "task-update"],
    },
  );
  requireCondition(
    groupOwnerThread(ledger, owner),
    "GROUP_NOT_READY",
    "Task group is not bound",
    4,
  );
  const mergedContinuation = isMergedContributionContinuation(ledger, owner, target);
  if (["release", "deployment", "verification"].includes(target.kind)) {
    requireCondition(
      owner.state === "merged" && owner.merge_sha,
      "GROUP_NOT_MERGED",
      "Post-merge task must wait for its parent PR",
      4,
    );
  } else {
    requireCondition(
      owner.state === "active" || mergedContinuation,
      "GROUP_NOT_READY",
      "Task group is not active or approved for a post-merge continuation",
      4,
    );
  }
  if (isContributionKind(target.kind)) {
    requireContributionTaskDispatchGate(ledger, owner, target);
    requireCondition(
      owner.parent_branch && target.base_sha && owner.current_sha === target.base_sha,
      "BASE_NOT_READY",
      "Contribution task requires the current delivery-unit base",
      4,
    );
    requireCondition(
      legacyLedger(ledger) ||
        (owner.lifecycle.workspace_ready === "passed" &&
          branchReceipt(ledger, owner.id, owner.parent_branch, owner.current_sha)),
      "BRANCH_NOT_PUBLISHED",
      "Contribution dispatch requires a provider-published delivery-unit branch",
      4,
    );
  }
  const pendingRevision = activePlan(ledger);
  requireCondition(
    !(
      pendingRevision.id !== ledger.execution_plan_id &&
      pendingRevision.lifecycle === "proposed" &&
      pendingRevision.revision?.paused_task_ids.includes(target.id)
    ),
    "PLAN_REVISION_HOLD",
    "Task is paused by a pending high-impact plan revision",
    4,
  );
  requireCondition(
    ready(ledger, target.id),
    "DEPENDENCIES_PENDING",
    "Task dependencies are not satisfied",
    4,
  );
  requireCondition(
    !ledger.operations.some(
      (item) => activeOperation(item) && item.kind === "dispatch" && item.target_id === target.id,
    ),
    "OPERATION_PENDING",
    "Task already has a dispatch claim",
    4,
  );
  const branchOperation = isContributionKind(target.kind)
    ? ledger.operations.find(
        (item) =>
          activeOperation(item) &&
          item.target_id === owner.id &&
          (item.kind === "merge" || item.kind === "cut"),
      )
    : undefined;
  if (branchOperation)
    throw new ContractError("OPERATION_PENDING", "Delivery branch has an unresolved operation", 4, {
      target_id: owner.id,
      operation_id: branchOperation.id,
      recovery: ["Reconcile the existing operation"],
    });
  requireTaskCapacity(ledger);
}

export function taskDispatchEligibility(ledger: Ledger, target: Task) {
  try {
    requireTaskDispatch(ledger, target);
    return { allowed: true, blocker: null };
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return {
      allowed: false,
      blocker: {
        code: error.code,
        message: error.message,
        target_id: target.id,
        details: error.details ?? null,
      },
    };
  }
}
