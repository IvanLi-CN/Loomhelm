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

export function executeCommandC2(context: ExecutionContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "task-runtime-observe": {
      onlyMain(request.actor);
      const target = find(ledger.tasks, (item) => item.id === parse(id, payload.task_id), "Task");
      const observedThread = isSharedDeliveryTask(ledger, target)
        ? ledger.groups.find((item) => item.id === target.group_id)?.agent_thread_id
        : target.thread_id;
      requireCondition(
        observedThread === payload.thread_id,
        "RESOURCE_MISMATCH",
        "Runtime observation thread does not match task",
        4,
      );
      const runtime = z.enum(["active", "idle", "unknown"]).parse(payload.runtime);
      const observedAt = z.iso.datetime().parse(payload.observed_at);
      if (runtime === "idle")
        requireCondition(
          typeof payload.turn_id === "string" && payload.turn_id.length > 0,
          "EVIDENCE_REQUIRED",
          "Idle observation requires a confirmed terminal turn identity",
          4,
        );
      if (
        target.disposition !== "active" ||
        !["starting", "running", "agent_idle"].includes(target.state)
      )
        return { state: target.state };
      const previous = target.state;
      if (runtime === "idle" && target.state !== "agent_idle") {
        target.agent_resume_state = target.state as "starting" | "running";
        target.state = "agent_idle";
      } else if (runtime !== "idle" && target.state === "agent_idle") {
        target.state = target.agent_resume_state ?? "running";
        delete target.agent_resume_state;
      }
      if (previous !== target.state)
        addEvent(ledger, request, "task_runtime_observed", target.id, {
          task_id: target.id,
          thread_id: observedThread,
          turn_id: payload.turn_id ?? null,
          observed_at: observedAt,
          runtime,
          state: target.state,
          previous_state: previous,
        });
      return { state: target.state };
    }
    case "task-update": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const mainOwned =
        target.execution_owner === "main" &&
        target.conversation_policy === "main_owned" &&
        request.actor.role === "main" &&
        request.actor.thread_id === ledger.control.owner_thread_id;
      const sharedOwned =
        isSharedDeliveryTask(ledger, target) &&
        request.actor.role === "group" &&
        ledger.groups.find((item) => item.id === target.group_id)?.agent_thread_id ===
          request.actor.thread_id;
      const state = z
        .enum(["running", "waiting", "blocked", "completed", "closed"])
        .parse(payload.state);
      const allowed: Record<string, string[]> = {
        planned: mainOwned || sharedOwned ? ["running", "waiting", "blocked"] : [],
        starting: ["running", "waiting", "blocked"],
        running: ["waiting", "blocked"],
        agent_idle: ["running", "waiting", "blocked"],
        waiting: ["running"],
        blocked: ["running"],
        integrated: ["closed"],
        completed: ["closed"],
      };
      requireCondition(
        allowed[target.state]?.includes(state) ||
          (state === "completed" &&
            !isContributionKind(target.kind) &&
            taskExecutionState(target) === "running"),
        "INVALID_TRANSITION",
        `Cannot move ${target.state} to ${state}`,
        3,
      );
      if (
        state === "running" &&
        ledger.operations.some(
          (op) =>
            op.kind === "dispatch" &&
            op.request.target_type !== "group" &&
            op.target_id === taskId &&
            (op.request.creation_parameters as any)?.transport === "codex-exec",
        )
      ) {
        const op = ledger.operations.find(
          (op) =>
            op.kind === "dispatch" &&
            op.request.target_type !== "group" &&
            op.target_id === taskId &&
            op.status === "succeeded",
        );
        requireCondition(
          target.lifecycle.workspace_ready === "passed" && !!op?.request.development_baseline,
          "BASELINE_REQUIRED",
          "Record verified workspace baseline before running",
          4,
        );
        if (ledger.contract_version === 3 && op?.request.development_baseline) {
          const group = find(ledger.groups, (item) => item.id === target.group_id, "Group");
          const postMerge = ["release", "deployment", "verification"].includes(target.kind);
          const lineage = postMerge ? group.merge_sha : group.current_sha;
          requireCondition(
            op.request.development_baseline.sha === lineage,
            "BASELINE_NOT_VERIFIED",
            "Task workspace baseline no longer matches the current lineage",
            4,
          );
        }
      }
      const previousState = taskExecutionState(target);
      const occupiedSlot = target.state === "agent_idle";
      if (state === "running" && isContributionKind(target.kind)) {
        const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
        const bootstrapMainOwnedStart =
          mainOwned && owner.delivery_unit_kind === "bootstrap" && owner.owner_kind === "main";
        requireCondition(
          owner.state === "active",
          "GROUP_NOT_READY",
          "Task group is not active",
          4,
        );
        requireContributionDispatchGate(ledger, owner, !bootstrapMainOwnedStart, "task-update");
      }
      if (state === "running" && previousState !== "starting" && !occupiedSlot) {
        requireCondition(
          ready(ledger, target.id),
          "DEPENDENCIES_PENDING",
          "Task dependencies are not satisfied",
          4,
        );
        const used =
          ledger.tasks.filter((item) => ["starting", "running", "agent_idle"].includes(item.state))
            .length +
          ledger.operations.filter(
            (item) =>
              item.kind === "dispatch" &&
              item.request.target_type !== "group" &&
              activeOperation(item),
          ).length;
        requireCondition(
          used < ledger.config.max_running_tasks,
          "CAPACITY",
          "No execution slot available",
          4,
        );
      }
      if (state === "running" && previousState === "planned")
        requireCondition(
          (mainOwned || sharedOwned) && ready(ledger, target.id),
          "MAIN_TASK_REQUIRED",
          "Only the task owner can start a planned task directly",
          3,
        );
      if (state === "completed")
        requireCondition(
          typeof payload.evidence === "string" && payload.evidence.length > 0,
          "EVIDENCE_REQUIRED",
          "Completion evidence required",
          5,
        );
      if (state === "completed")
        requireCondition(
          target.atoms.every((atom) => atom.status === "completed"),
          "ATOMS_PENDING",
          "Complete the task's atoms before finishing",
          4,
        );
      if (state === "closed") {
        requireCondition(
          !ledger.follow_prs.some(
            (item) => item.origin_task_id === taskId && item.state !== "merged",
          ),
          "FOLLOW_PR_PENDING",
          "Follow PR is not merged",
          4,
        );
        if (isContributionKind(target.kind))
          requireCondition(
            legacyLedger(ledger) ||
              target.lifecycle.pr_merged === "passed" ||
              (isSharedDeliveryTask(ledger, target) &&
                ledger.groups.find((item) => item.id === target.group_id)?.lifecycle.pr_merged ===
                  "passed"),
            "PR_NOT_MERGED",
            "Contribution task PR must merge before closeout",
            4,
          );
      }
      target.state = state;
      delete target.agent_resume_state;
      target.blocker = state === "blocked" || state === "waiting" ? string(payload.detail) : null;
      if (state === "closed" && target.lifecycle && !legacyLedger(ledger))
        target.lifecycle.closed = "passed";
      if (state === "running" && (previousState === "starting" || previousState === "planned"))
        target.started_at = z.iso.datetime({ offset: false }).parse(payload.occurred_at);
      if (state === "completed")
        target.finished_at = payload.occurred_at
          ? z.iso.datetime({ offset: false }).parse(payload.occurred_at)
          : null;
      if ((state === "completed" || state === "closed") && target.thread_id) {
        const resourceId = `conversation-${createHash("sha256").update(target.thread_id).digest("hex").slice(0, 32)}`;
        const resource = ledger.resources.find(
          (item) => item.kind === "conversation" && item.target === target.thread_id,
        );
        if (!resource) {
          ledger.resources.push({
            id: resourceId,
            kind: "conversation",
            target: target.thread_id,
            status: "pending",
            evidence_ref: null,
            error: null,
            last_attempt_at: null,
            operation_id: null,
          });
        }
      }
      const eventType =
        state === "running"
          ? previousState === "starting" || previousState === "planned"
            ? "task_started"
            : "task_resumed"
          : state === "waiting"
            ? "task_waiting"
            : state === "blocked"
              ? "task_blocked"
              : state === "completed"
                ? "task_completed"
                : "task_closed";
      addEvent(
        ledger,
        request,
        eventType,
        taskId,
        {
          task_id: taskId,
          group_id: target.group_id,
          state,
          reason: target.blocker,
        },
        payload.occurred_at ? z.iso.datetime({ offset: false }).parse(payload.occurred_at) : null,
      );
      const directive = notificationDirective(
        ledger,
        request,
        payload,
        state === "completed" || state === "closed",
      );
      const notice = directive.enabled
        ? addNotificationIntent(ledger, request, directive.recipient_thread_id!)
        : null;
      return {
        task_id: taskId,
        state,
        notification_id: notice?.id ?? null,
        notification_status: notice?.delivery_status ?? "none",
        notification_request: notificationDeliveryRequest(notice),
      };
    }
    case "task-equivalent-integrate": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
      requireCondition(
        isContributionKind(target.kind),
        "TASK_MISMATCH",
        "Only contribution tasks can be equivalently integrated",
        3,
      );
      requireCondition(
        !isSharedDeliveryTask(ledger, target),
        "SHARED_DELIVERY_UNIT_PR",
        "Shared delivery tasks do not have a child PR to integrate",
        3,
      );
      requireCondition(
        ["blocked", "agent_idle", "running"].includes(target.state),
        "INVALID_TRANSITION",
        "Task is not awaiting integration",
        3,
      );
      requireCondition(
        target.atoms.every((atom) => atom.status === "completed"),
        "ATOMS_PENDING",
        "Complete the task atoms before integration",
        4,
      );
      const taskPr = parse(externalRef, payload.task_pr);
      const parentPr = parse(externalRef, payload.parent_pr);
      checkPR(ledger, taskPr);
      checkPR(ledger, parentPr);
      requireCondition(
        target.pr && stable(taskPrRef(target)) === stable(taskPr),
        "PR_MISMATCH",
        "Equivalent integration task PR does not match the registered PR",
        3,
      );
      requireCondition(
        deliveryUnitPr(owner) && stable(deliveryUnitPr(owner)) === stable(parentPr),
        "PR_MISMATCH",
        "Equivalent integration parent PR does not match the delivery unit",
        3,
      );
      const taskHeadSha = z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(payload.task_head_sha);
      const parentMergeSha = z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(payload.parent_merge_sha);
      const commits = z
        .array(z.string().regex(/^[a-f0-9]{40}$/))
        .min(1)
        .parse(payload.integration_commits);
      const evidenceRef = z.string().min(1).parse(payload.evidence_ref);
      target.state = "integrated";
      target.finished_at = now();
      addEvent(ledger, request, "task_integrated", taskId, {
        task_id: taskId,
        task_pr: taskPr,
        task_head_sha: taskHeadSha,
        parent_pr: parentPr,
        parent_merge_sha: parentMergeSha,
        integration_commits: commits,
        evidence_ref: evidenceRef,
        equivalent_integration: true,
        child_pr_state: "open",
      });
      return { task_id: taskId, state: target.state, equivalent_integration: true };
    }

    default:
      return undefined;
  }
}
