import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ContractError, requireCondition } from "../lib/errors";
import {
  effectiveProfile,
  materializeRecommendation,
  profileFreezeReason,
  RECOMMENDATION_VERSION,
} from "../lib/execution-profile";
import { migrateProfile } from "../lib/profile-migration";
import {
  buildPlanRevision,
  deriveExecutionPhase,
  evidenceRequired,
  reasonRequired,
  revisionInput,
} from "../lib/revisions";
import * as schema from "../lib/schema";
import {
  baselineReceipt,
  changeReason,
  collectCutAssignmentEvidence,
  cutEvidence,
  defaultGroupAtoms,
  deliveryTopologyForGroup,
  executionProfile,
  externalRef,
  fact,
  group,
  id,
  isContributionKind,
  type Ledger,
  ledgerSchema,
  milestone,
  notification,
  notificationOption,
  operation,
  type Plan,
  plan,
  providerReceipt,
  recommendedExecutionProfile,
  type Task,
  task,
  theoreticalScheduleIssues,
  validateDeliveryTopologies,
  validateDevPlanHandoff,
  validateInitialRuntimeState,
  validateLedger,
  validateNewTaskKinds,
  validatePlan,
  validateSchedulablePlan,
  validateTaskExecutionPolicies,
} from "../lib/schema";
import type { Request } from "./engine-support-core";
import * as core from "./engine-support-core";
import * as support from "./engine-support-gates";

const {
  parse,
  onlyMain,
  approved,
  authorizedAction,
  object,
  string,
  now,
  find,
  stable,
  activePlan,
  executionPlan,
  requireDevelopmentTarget,
  developmentDispatch,
  lineageEventMatches,
  legacyLedger,
  deliveryUnitPr,
  taskPrRef,
  isSharedDeliveryTask,
  requireContributionDispatchGate,
  ensureSchedulable,
  lifecycleTarget,
  ownsGroup,
  groupOwnerThread,
  requireOwner,
  requireLifecycle,
  exactApprovedAction,
  protectedActionApproved,
  historicalGroupLineageContains,
  externalMergeFactId,
  latestPublication,
  branchReceipt,
  prReceipt,
} = core;
const {
  addEvent,
  boundConversation,
  notificationDirective,
  requireNotificationRecipientActive,
  addNotificationIntent,
  requiresNativeDelivery,
  notificationDeliveryRequest,
  addOperation,
  activeOperation,
  creationObservations,
  publicationPendingForGroup,
  checkPR,
  currentRuleGroup,
  subjectSha,
  latestFact,
  factSatisfied,
  factKind,
  nodeSatisfied,
  edgeSatisfied,
  ready,
  deliveryUnitPrMerged,
  deliveryUnitPrMergedFromLedger,
  requireHandoffAcknowledged,
  requireGroupDispatchGate,
  ownerOfTask,
  taskExecutionState,
  taskRuntimeState,
  taskBoundary,
  hasTaskStarted,
  groupRuntimeState,
  validateRevisionReason,
  groupBaseReconciliation,
} = support;

export type ExecutionContext = {
  ledger: Ledger;
  command: string;
  request: Request;
  payload: Record<string, any>;
  currentPlan: () => Plan;
};

export function executeCommandD2(context: ExecutionContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "task-pr": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(
        ledger.tasks,
        (item) => item.id === taskId && isContributionKind(item.kind),
        "Contribution task",
      );
      const pr = parse(externalRef, payload.pr);
      checkPR(ledger, pr);
      requireCondition(
        taskExecutionState(target) === "running" &&
          (!taskPrRef(target) || stable(taskPrRef(target)) === stable(pr)),
        "PR_MISMATCH",
        "Task PR cannot be replaced",
        3,
      );
      requireCondition(
        legacyLedger(ledger) || prReceipt(ledger, taskId, pr),
        "PR_NOT_PUBLISHED",
        "Task PR must be bound to a successful provider publication receipt",
        4,
      );
      if (ledger.contract_version !== 3) target.pr = pr;
      else {
        const owner = find(ledger.groups, (item) => item.id === target.group_id, "DeliveryUnit");
        requireCondition(
          typeof target.branch === "string" &&
            target.branch.length > 0 &&
            typeof owner.parent_branch === "string" &&
            owner.parent_branch.length > 0,
          "TASK_PR_BINDING_INCOMPLETE",
          "Task PR binding requires task branch and DeliveryUnit parent branch facts",
          4,
        );
        target.pr = {
          state: "open",
          pr,
          branch: target.branch,
          base_branch: owner.parent_branch,
        };
      }
      if (target.lifecycle && !legacyLedger(ledger)) target.lifecycle.pr_created = "passed";
      return { task_id: taskId, pr };
    }
    case "task-base": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
      const baseSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.base_sha);
      requireCondition(
        owner.current_sha === baseSha,
        "BASE_CHANGED",
        "Task base must match the current parent SHA",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "merge" && activeOperation(item) && item.request.task_id === taskId,
        ),
        "MERGE_PENDING",
        "Cannot change base while merge is pending",
        4,
      );
      if (target.thread_id)
        requireCondition(
          request.actor.role === "task" &&
            target.thread_id === request.actor.thread_id &&
            typeof payload.evidence === "string" &&
            payload.evidence.length > 0,
          "EVIDENCE_REQUIRED",
          "The task owner must verify its updated base",
          5,
        );
      target.base_sha = baseSha;
      addEvent(ledger, request, "task_rebased", taskId, {
        task_id: taskId,
        base_sha: baseSha,
        evidence: payload.evidence ?? null,
      });
      return { task_id: taskId, base_sha: baseSha };
    }
    case "task-quality-record": {
      const taskId = parse(id, payload.task_id);
      requireCondition(
        request.actor.role === "task",
        "FORBIDDEN",
        "Only the task Agent may record task quality",
        3,
      );
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      requireCondition(
        target.pr &&
          taskExecutionState(target) === "running" &&
          (legacyLedger(ledger) || target.lifecycle.pr_created === "passed"),
        "PR_NOT_READY",
        "Task PR must be provider-published and running",
        4,
      );
      const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
      requireCondition(
        payload.base_sha === owner.current_sha && target.base_sha === owner.current_sha,
        "BASE_CHANGED",
        "Quality proof must bind the task and current parent base",
        3,
      );
      const review = parse(fact, payload.evidence);
      requireCondition(
        review.kind === "task_quality" &&
          review.subject_id === taskId &&
          review.status === "passed" &&
          review.sha &&
          review.evidence_ref &&
          review.source === request.actor.thread_id &&
          review.quality?.task_id === taskId &&
          review.quality.thread_id === request.actor.thread_id &&
          stable(review.quality.pr) === stable(taskPrRef(target)) &&
          review.quality.base_sha === owner.current_sha &&
          review.quality.head_sha === review.sha,
        "EVIDENCE_REQUIRED",
        "Task quality evidence must identify the exact task, PR, head, base, acceptance and checks",
        5,
      );
      ledger.facts.push(review);
      addEvent(ledger, request, "fact_observed", taskId, {
        fact_id: review.id,
        base_sha: owner.current_sha,
      });
      return { fact_id: review.id };
    }
    case "follow-pr-update": {
      const followId = parse(id, payload.follow_pr_id);
      const originTaskId = parse(id, payload.origin_task_id);
      const target = find(ledger.tasks, (item) => item.id === originTaskId, "Origin task");
      const groupId = parse(id, payload.origin_group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Origin group");
      requireCondition(
        target.group_id === groupId ||
          target.assignment_history.some((item) => item.group_id === groupId) ||
          ledger.events.some(
            (event) =>
              event.type === "cut_applied" &&
              event.data.old_group_id === groupId &&
              Array.isArray(event.data.reassigned_task_ids) &&
              event.data.reassigned_task_ids.includes(originTaskId),
          ),
        "GROUP_MISMATCH",
        "Task has no assignment in the origin group",
        3,
      );
      if (request.actor.role === "task")
        requireCondition(
          target.thread_id === request.actor.thread_id,
          "FORBIDDEN",
          "Follow PR belongs to another task",
          3,
        );
      if (request.actor.role === "group")
        requireCondition(
          owner.agent_thread_id === request.actor.thread_id,
          "FORBIDDEN",
          "Follow PR belongs to another group",
          3,
        );
      const expectedBranch =
        owner.state === "merged" || owner.state === "closed"
          ? ledger.repository.target_branch
          : owner.parent_branch;
      requireCondition(
        expectedBranch && payload.target_branch === expectedBranch,
        "TARGET_MISMATCH",
        "Follow PR target does not match the origin group state",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) => item.kind === "merge" && item.target_id === groupId && activeOperation(item),
        ),
        "MERGE_PENDING",
        "Cannot register a follow PR while group merge is pending",
        4,
      );
      requireCondition(
        !ledger.follow_prs.some((item) => item.id === followId),
        "FOLLOW_PR_EXISTS",
        "Follow PR already recorded",
        3,
      );
      const follow = ledgerSchema.shape.follow_prs.element.parse({
        id: followId,
        origin_task_id: originTaskId,
        origin_group_id: groupId,
        pr: payload.pr,
        target_branch: expectedBranch,
        state: "open",
        merge_fact_id: null,
        affected_task_ids: z.array(id).parse(payload.affected_task_ids),
      });
      checkPR(ledger, follow.pr);
      requireCondition(
        follow.affected_task_ids.every((taskId) => ledger.tasks.some((item) => item.id === taskId)),
        "UNKNOWN_TASK",
        "Follow PR references an unknown task",
      );
      ledger.follow_prs.push(follow);
      addEvent(ledger, request, "follow_pr_recorded", originTaskId, {
        follow_pr_id: followId,
      });
      return { follow_pr_id: followId, target_branch: expectedBranch };
    }

    default:
      return undefined;
  }
}
