import { z } from "zod";
import { requireCondition } from "../lib/errors";
import {
  effectiveProfile,
  materializeRecommendation,
  profileFreezeReason,
} from "../lib/execution-profile";
import { buildPlanRevision, revisionInput } from "../lib/revisions";
import {
  changeReason,
  collectCutAssignmentEvidence,
  group,
  id,
  isContributionKind,
  historicalLifecycleValidationOptions as lifecycleValidationOptions,
  plan,
  type Task,
  task,
  validateDevPlanHandoff,
  validateInitialRuntimeState,
  validateNewTaskKinds,
  validatePlan,
  validateTaskExecutionPolicies,
} from "../lib/schema";
import type { CommandContext } from "./engine-command-context";
import * as core from "./engine-support-core";
import * as support from "./engine-support-gates";
import { recoveryDigest } from "./initialization-recovery-attempt";

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
  parseProtectedActionDigest,
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
} = support;
export const coordinationCommands = [
  "binding-resolve",
  "link-verification",
  "plan-propose",
  "plan-approve",
  "protected-approve",
  "plan-abandon",
  "task-migrate",
  "dispatch-claim",
  "dispatch-group-claim",
  "dispatch-resolve",
] as const;
export function executeCoordinationCommand(context: CommandContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "binding-resolve": {
      onlyMain(request.actor);
      const decision = z
        .object({
          source: z.literal("owner"),
          previous_thread_id: z.string().min(1),
          next_thread_id: z.string().min(1),
          evidence: z.string().min(1),
        })
        .strict()
        .parse(payload.owner_decision);
      const observation = z
        .object({
          source: z.literal("native"),
          thread_id: z.string().min(1),
          state: z.enum(["stopped", "archived"]),
        })
        .strict()
        .parse(payload.previous_owner_observation);
      requireCondition(
        decision.previous_thread_id === ledger.control.owner_thread_id &&
          decision.next_thread_id === request.actor.thread_id &&
          observation.thread_id === ledger.control.owner_thread_id,
        "OWNER_UNCERTAIN",
        "Owner transfer needs an explicit decision and a stopped prior conversation",
        5,
      );
      requireCondition(
        !ledger.operations.some(activeOperation),
        "OPERATIONS_PENDING",
        "Resolve outstanding operations before changing owner",
        4,
      );
      ledger.control.owner_thread_id = request.actor.thread_id;
      ledger.control.ownership = "bound";
      addEvent(ledger, request, "binding_resolved", ledger.orchestration_id, {
        previous_thread_id: decision.previous_thread_id,
        next_thread_id: decision.next_thread_id,
        evidence: decision.evidence,
      });
      return { owner_thread_id: request.actor.thread_id };
    }
    case "link-verification": {
      onlyMain(request.actor);
      const verified = z.boolean().parse(payload.verified);
      const evidence = string(payload.evidence);
      ledger.config.conversation_links_verified = verified;
      addEvent(ledger, request, "link_verification", ledger.orchestration_id, {
        verified,
        evidence,
      });
      return { verified };
    }
    case "plan-propose": {
      onlyMain(request.actor);
      const proposed = parse(plan, payload.plan);
      requireCondition(
        proposed.approval_id === null,
        "INVALID_PLAN",
        "A proposed plan cannot already be approved",
      );
      requireCondition(
        proposed.actions.every((action) => action.target !== undefined),
        "LEGACY_PLAN_ACTION",
        "New plans must use structured action targets",
        3,
      );
      requireCondition(
        !ledger.plans.some((item) => item.id === proposed.id),
        "PLAN_EXISTS",
        "Plan already exists",
        3,
      );
      const groups = parse(z.array(group), payload.groups);
      const tasks = parse(z.array(task), payload.tasks);
      validateNewTaskKinds(tasks.filter((item) => !ledger.tasks.some((old) => old.id === item.id)));
      ensureSchedulable(ledger, proposed);
      for (const item of groups)
        if (!ledger.groups.some((old) => old.id === item.id) && !item.execution_profile_source)
          materializeRecommendation(ledger, item);
      for (const item of tasks)
        if (!ledger.tasks.some((old) => old.id === item.id) && !item.execution_profile_source)
          materializeRecommendation(ledger, item);
      const previous = executionPlan(ledger);
      requireCondition(
        ledger.active_plan_id === ledger.execution_plan_id,
        "REVISION_PENDING",
        "Resolve the current plan revision before proposing another",
        4,
      );
      requireCondition(
        !previous.plan_handoff || proposed.plan_handoff,
        "INVALID_PLAN_HANDOFF",
        "A multi-task-flow plan revision must retain its dev-plan handoff envelope",
      );
      requireCondition(
        proposed.supersedes_id === previous.id,
        "INVALID_PLAN",
        "A plan revision must supersede the current execution plan",
        3,
      );
      const revisionInputValue = revisionInput.parse(payload.revision ?? {});
      requireCondition(
        !ledger.operations.some(activeOperation),
        "OPERATIONS_PENDING",
        "Cannot replace the plan while operations are pending",
        4,
      );
      const revision = buildPlanRevision(
        ledger,
        previous,
        proposed,
        tasks,
        groups,
        revisionInputValue,
      );
      validateRevisionReason(revision);
      proposed.revision = revision;
      proposed.lifecycle = "proposed";
      validatePlan(proposed, lifecycleValidationOptions(ledger, ledger.contract_version >= 6));
      if (proposed.plan_handoff) {
        const cutAssignments = previous.plan_handoff
          ? collectCutAssignmentEvidence(ledger, previous)
          : undefined;
        validateDevPlanHandoff(
          proposed,
          groups,
          tasks,
          cutAssignments === undefined
            ? { allowDynamicAssignments: false }
            : {
                allowDynamicAssignments: true,
                assignmentEvidence: cutAssignments.assignments,
                dynamicGroupIds: cutAssignments.dynamicGroupIds,
              },
        );
      }
      for (const existing of ledger.tasks) {
        const incoming = tasks.find((item) => item.id === existing.id);
        requireCondition(
          incoming !== undefined,
          "TASK_CHANGED",
          `Plan revision removed runtime task ${existing.id}`,
          3,
        );
        requireCondition(
          stable(taskRuntimeState(existing)) === stable(taskRuntimeState(incoming)),
          "TASK_CHANGED",
          `Plan revision cannot overwrite runtime state for task ${existing.id}`,
          3,
        );
        if (
          profileFreezeReason(ledger, "task", existing.id) ||
          ledger.operations.some(
            (op) =>
              op.kind === "dispatch" &&
              op.request.target_type !== "group" &&
              op.target_id === existing.id &&
              activeOperation(op),
          )
        ) {
          requireCondition(
            stable(existing.execution_profile) === stable(incoming.execution_profile),
            "PROFILE_FROZEN",
            "Plan revisions cannot change a frozen or claimed execution profile",
            3,
          );
        }
        if (hasTaskStarted(ledger, existing.id)) {
          requireCondition(
            stable(taskBoundary(existing)) === stable(taskBoundary(incoming)),
            "TASK_MIGRATION_REQUIRED",
            `Started task ${existing.id} requires migration instead of in-place boundary edits`,
            3,
          );
        }
      }
      for (const existing of ledger.groups) {
        const incoming = groups.find((item) => item.id === existing.id);
        requireCondition(
          incoming !== undefined &&
            stable(groupRuntimeState(existing)) === stable(groupRuntimeState(incoming)),
          "GROUP_CHANGED",
          `Plan revision cannot overwrite runtime group ${existing.id}`,
          3,
        );
      }
      for (const existing of ledger.groups) {
        const incoming = groups.find((item) => item.id === existing.id)!;
        if (
          profileFreezeReason(ledger, "group", existing.id) ||
          ledger.operations.some(
            (op) =>
              op.kind === "dispatch" &&
              op.request.target_type === "group" &&
              op.target_id === existing.id &&
              activeOperation(op),
          )
        ) {
          requireCondition(
            stable(existing.execution_profile) === stable(incoming.execution_profile),
            "PROFILE_FROZEN",
            "Plan revisions cannot change a frozen or claimed execution profile",
            3,
          );
        }
      }
      for (const incoming of tasks.filter(
        (item) => !ledger.tasks.some((existing) => existing.id === item.id),
      )) {
        requireCondition(
          incoming.thread_id === null &&
            incoming.started_at === null &&
            incoming.state === "planned" &&
            incoming.disposition === "active",
          "INVALID_NEW_TASK",
          `New task ${incoming.id} must start as planned and unbound`,
          3,
        );
      }
      const newGroups = groups.filter(
        (incoming) => !ledger.groups.some((existing) => existing.id === incoming.id),
      );
      requireCondition(
        newGroups.every(
          (incoming) =>
            incoming.delivery_unit_kind === "regular" && incoming.owner_kind === "group",
        ),
        "INVALID_NEW_GROUP",
        "Bootstrap can only be created during run initialization",
        3,
      );
      const policyCompleteTasks = tasks.filter((incoming) => {
        const existing = ledger.tasks.find((item) => item.id === incoming.id);
        const legacyAbsent = (item: Task) =>
          item.execution_owner === null &&
          item.conversation_policy === null &&
          item.delivery_policy === null;
        return !(existing && legacyAbsent(existing) && legacyAbsent(incoming));
      });
      validateTaskExecutionPolicies(policyCompleteTasks, true);
      validateInitialRuntimeState(newGroups, []);
      if (revision.change_class === "implementation_low_impact") {
        requireCondition(
          previous.lifecycle === "approved" && previous.approval_id !== null,
          "PLAN_NOT_APPROVED",
          "Low-impact implementation revisions require an approved execution plan",
          4,
        );
        proposed.approval_id = previous.approval_id;
        proposed.lifecycle = "approved";
      }
      ledger.plans.push(proposed);
      ledger.groups = groups;
      ledger.tasks = tasks;
      ledger.active_plan_id = proposed.id;
      if (revision.change_class === "implementation_high_impact") {
        ledger.execution_plan_id = previous.id;
        ledger.control.approval_id = previous.approval_id;
      } else {
        ledger.execution_plan_id = proposed.id;
        ledger.control.approval_id =
          revision.change_class === "implementation_low_impact" ? proposed.approval_id : null;
      }
      addEvent(ledger, request, "plan_revision_proposed", proposed.id, {
        supersedes_plan_id: previous.id,
        revision: structuredClone(revision),
      });
      if (revision.change_class === "implementation_low_impact") {
        addEvent(
          ledger,
          { ...request, request_id: `${request.request_id}-revision-approved` },
          "plan_revision_approved",
          proposed.id,
          {
            supersedes_plan_id: previous.id,
            approval_id: proposed.approval_id,
          },
        );
        previous.lifecycle = "superseded";
        addEvent(
          ledger,
          {
            ...request,
            request_id: `${request.request_id}-revision-superseded`,
          },
          "plan_revision_superseded",
          previous.id,
          { replacement_plan_id: proposed.id },
        );
      }
      return {
        plan_id: proposed.id,
        change_class: revision.change_class,
        approval_required: revision.approval_required,
        paused_task_ids: revision.paused_task_ids,
      };
    }
    case "plan-approve": {
      onlyMain(request.actor);
      const current = find(ledger.plans, (item) => item.id === string(payload.plan_id), "Plan");
      requireCondition(
        current.id === ledger.active_plan_id &&
          current.lifecycle === "proposed" &&
          !current.approval_id,
        "INVALID_PLAN",
        "Only the active proposed plan can be approved",
      );
      ensureSchedulable(ledger, current);
      const previousExecution = current.supersedes_id
        ? (ledger.plans.find((item) => item.id === current.supersedes_id) ?? null)
        : ledger.execution_plan_id === current.id
          ? null
          : executionPlan(ledger);
      current.approval_id = string(payload.approval_id);
      current.lifecycle = "approved";
      const authorizedActionIds = z.array(id).parse(payload.authorized_action_ids);
      requireCondition(
        authorizedActionIds.every((actionId) =>
          current.actions.some((action) => action.id === actionId),
        ),
        "ACTION_NOT_PLANNED",
        "Approval includes an unknown action",
      );
      addEvent(ledger, request, "plan_approved", current.id, {
        approval_id: current.approval_id,
        authorized_actions: z
          .array(
            z.enum([
              "dispatch",
              "merge",
              "cut",
              "publish_branch",
              "publish_pr",
              "release",
              "deploy",
            ]),
          )
          .parse(payload.authorized_actions),
        authorized_action_ids: authorizedActionIds,
      });
      if (current.revision)
        addEvent(
          ledger,
          { ...request, request_id: `${request.request_id}-revision-approved` },
          "plan_revision_approved",
          current.id,
          {
            supersedes_plan_id: current.supersedes_id,
            approval_id: current.approval_id,
          },
        );
      if (previousExecution) {
        previousExecution.lifecycle = "superseded";
        addEvent(
          ledger,
          {
            ...request,
            request_id: `${request.request_id}-revision-superseded`,
          },
          "plan_revision_superseded",
          previousExecution.id,
          { replacement_plan_id: current.id },
        );
      }
      ledger.execution_plan_id = current.id;
      ledger.control.approval_id = current.approval_id;
      return { plan_id: current.id };
    }
    case "protected-approve": {
      onlyMain(request.actor);
      const kind = z
        .enum(["delivery_unit_merge", "delivery_unit_recovery", "release", "deploy"])
        .parse(payload.kind);
      const targetId = parse(id, payload.target_id);
      const approvalId = string(payload.approval_id);
      if (kind === "delivery_unit_merge" || kind === "delivery_unit_recovery")
        find(ledger.groups, (item) => item.id === targetId, "Delivery unit");
      else find(ledger.tasks, (item) => item.id === targetId, "Protected task");
      addEvent(ledger, request, "protected_action_approved", targetId, {
        kind,
        approval_id: approvalId,
        target_digest: parseProtectedActionDigest(payload.target_digest),
      });
      return { target_id: targetId, kind, approval_id: approvalId };
    }
    case "plan-abandon": {
      onlyMain(request.actor);
      const current = find(ledger.plans, (item) => item.id === string(payload.plan_id), "Plan");
      requireCondition(
        current.id === ledger.active_plan_id && current.lifecycle === "proposed",
        "INVALID_PLAN",
        "Only the active proposed plan can be abandoned",
      );
      const restore = find(
        ledger.plans,
        (item) => item.id === current.supersedes_id,
        "Superseded plan",
      );
      for (const owner of ledger.groups) {
        const definitions = restore.group_atoms.filter((atom) => atom.group_id === owner.id);
        if (definitions.length || current.group_atoms.some((atom) => atom.group_id === owner.id)) {
          const statuses = new Map(owner.atoms.map((atom) => [atom.id, atom.status]));
          owner.atoms = definitions.map(({ group_id, ...atom }) => ({
            ...atom,
            status: statuses.get(atom.id) ?? "planned",
          }));
        }
      }
      current.lifecycle = "abandoned";
      ledger.active_plan_id = restore.id;
      ledger.execution_plan_id = restore.id;
      ledger.control.approval_id = restore.approval_id;
      addEvent(ledger, request, "plan_revision_abandoned", current.id, {
        restored_plan_id: restore.id,
      });
      return { plan_id: current.id, restored_plan_id: restore.id };
    }
    case "task-migrate": {
      onlyMain(request.actor);
      const oldTaskId = parse(id, payload.old_task_id);
      const newTaskId = parse(id, payload.new_task_id);
      const oldTask = find(ledger.tasks, (item) => item.id === oldTaskId, "Old task");
      const newTask = find(ledger.tasks, (item) => item.id === newTaskId, "New task");
      requireCondition(
        oldTask.id !== newTask.id &&
          oldTask.disposition === "active" &&
          newTask.disposition === "active",
        "INVALID_MIGRATION",
        "Task migration requires two distinct active tasks",
        3,
      );
      requireCondition(
        hasTaskStarted(ledger, oldTask.id),
        "INVALID_MIGRATION",
        "Only a started task can be migrated",
        3,
      );
      requireCondition(
        newTask.state === "planned" && newTask.thread_id === null && newTask.started_at === null,
        "INVALID_MIGRATION",
        "Replacement task must be planned and unbound",
        3,
      );
      const revisionPlan = activePlan(ledger);
      requireCondition(
        revisionPlan.revision !== null,
        "INVALID_MIGRATION",
        "Task migration must be associated with a plan revision",
        3,
      );
      requireCondition(
        revisionPlan.revision.affected_task_ids.includes(oldTask.id) ||
          revisionPlan.revision.affected_task_ids.includes(newTask.id),
        "INVALID_MIGRATION",
        "Plan revision does not cover the migrated task",
        3,
      );
      const reason = parse(changeReason, payload.reason);
      requireCondition(
        reason.evidence_refs.length > 0,
        "REVISION_EVIDENCE_REQUIRED",
        "Task migration requires evidence references",
        5,
      );
      oldTask.disposition = "superseded";
      oldTask.superseded_by_task_id = newTask.id;
      addEvent(ledger, request, "task_migration_recorded", oldTask.id, {
        old_task_id: oldTask.id,
        new_task_id: newTask.id,
        reason,
        inherited_outputs: z.array(z.string().min(1)).parse(payload.inherited_outputs ?? []),
        uninherited_outputs: z.array(z.string().min(1)).parse(payload.uninherited_outputs ?? []),
        new_base_sha: newTask.base_sha,
        plan_id: ledger.active_plan_id,
        plan_revision: structuredClone(revisionPlan.revision),
        migration_at: now(),
      });
      return { old_task_id: oldTask.id, new_task_id: newTask.id };
    }
    case "dispatch-claim": {
      onlyMain(request.actor);
      authorizedAction(ledger, "dispatch");
      ensureSchedulable(ledger, approved(ledger));
      const target = find(ledger.tasks, (item) => item.id === string(payload.task_id), "Task");
      requireCondition(
        !core.isDeliveryVerification(target),
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
      if (["release", "deployment", "verification"].includes(target.kind)) {
        requireCondition(
          owner.state === "merged" && owner.merge_sha,
          "GROUP_NOT_MERGED",
          "Post-merge task must wait for its parent PR",
          4,
        );
      } else {
        requireCondition(
          owner.state === "active" ||
            support.isMergedContributionContinuation(ledger, owner, target),
          "GROUP_NOT_READY",
          "Task group is not active or approved for a post-merge continuation",
          4,
        );
      }
      if (isContributionKind(target.kind)) {
        support.requireContributionTaskDispatchGate(ledger, owner, target);
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
          (item) =>
            item.kind === "dispatch" && item.target_id === target.id && activeOperation(item),
        ),
        "OPERATION_PENDING",
        "Task already has a dispatch claim",
        4,
      );
      if (ledger.contract_version >= 3) {
        const readyEvent = ledger.events.findLast(
          (event) =>
            event.type === "task_ready" &&
            Array.isArray(event.data.task_ids) &&
            event.data.task_ids.includes(target.id),
        );
        // Initially ready tasks may be discovered directly by the coordinator.
        // Once a readiness transition emits an intent, only its recipient can release it.
        if (readyEvent)
          requireCondition(
            ledger.notifications.some(
              (notice) =>
                notice.event_id === readyEvent.id &&
                notice.recipient_thread_id === ledger.control.owner_thread_id &&
                notice.ledger_status === "committed" &&
                notice.delivery_status === "sent" &&
                notice.status === "acknowledged" &&
                notice.ack_status === "acknowledged",
            ),
            "READINESS_ACK_REQUIRED",
            "The latest task-ready notification requires recipient acknowledgement before dispatch",
            4,
          );
      }
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
      const op = addOperation(ledger, request, "dispatch", target.id, null);
      op.request.execution_profile = effectiveProfile(ledger, target);
      addEvent(ledger, request, "dispatch_claimed", target.id, {
        operation_id: op.id,
      });
      return { operation_id: op.id };
    }
    case "dispatch-group-claim": {
      onlyMain(request.actor);
      authorizedAction(ledger, "dispatch");
      ensureSchedulable(ledger, approved(ledger));
      const target = find(ledger.groups, (item) => item.id === string(payload.group_id), "Group");
      requireCondition(
        target.delivery_unit_kind !== "bootstrap" &&
          target.state === "planned" &&
          !target.agent_thread_id,
        "NOT_DISPATCHABLE",
        "Group already started or bound",
        4,
      );
      requireGroupDispatchGate(ledger, target);
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "dispatch" &&
            item.request.target_type === "group" &&
            item.target_id === target.id &&
            activeOperation(item),
        ),
        "OPERATION_PENDING",
        "Group already has a dispatch claim",
        4,
      );
      const op = addOperation(ledger, request, "dispatch", target.id, null);
      op.request.target_type = "group";
      op.request.execution_profile = effectiveProfile(ledger, target);
      addEvent(ledger, request, "dispatch_claimed", target.id, {
        operation_id: op.id,
        target_type: "group",
      });
      return { operation_id: op.id };
    }
    case "dispatch-resolve": {
      onlyMain(request.actor);
      const op = find(
        ledger.operations,
        (item) => item.id === string(payload.operation_id) && item.kind === "dispatch",
        "Dispatch",
      );
      requireCondition(
        activeOperation(op),
        "OPERATION_TERMINAL",
        "Dispatch is already resolved",
        3,
      );
      const outcome = z.enum(["succeeded", "failed", "unknown"]).parse(payload.outcome);
      const target =
        op.request.target_type === "group"
          ? null
          : find(ledger.tasks, (item) => item.id === op.target_id, "Task");
      const targetGroup =
        op.request.target_type === "group"
          ? find(ledger.groups, (item) => item.id === op.target_id, "Group")
          : null;
      if (target && outcome === "succeeded")
        requireCondition(
          !core.isDeliveryVerification(target),
          "DELIVERY_VERIFICATION_DISPATCH",
          "A delivery verification must use its bound delivery agent, not a task conversation",
          3,
        );
      if (targetGroup && ledger.contract_version >= 3 && outcome === "succeeded")
        requireGroupDispatchGate(ledger, targetGroup);
      const evidence = object(payload.native_evidence ?? {});
      const observed = creationObservations(op, payload);
      if (outcome === "failed")
        requireCondition(
          Object.keys(observed).length === 0,
          "UNKNOWN_REQUIRES_RECONCILIATION",
          "Known creation identity, resources or execution require reconciliation",
          5,
        );
      if (outcome === "succeeded" && evidence.native_tool_name === "codex exec")
        requireCondition(
          object(op.request.creation_parameters ?? {}).transport === "codex-exec",
          "TRANSPORT_REQUIRED",
          "Codex exec success requires bound native transport for baseline readiness",
          5,
        );
      if (op.request.execution_profile && outcome !== "unknown") {
        requireCondition(
          ["multi-task-flow-cli", "multi-task-flow-reconcile"].includes(String(evidence.source)) &&
            (ledger.contract_version < 3
              ? ["thread/start", "codex exec"].includes(String(evidence.native_tool_name))
              : evidence.native_tool_name === "codex exec") &&
            evidence.operation_id === op.id &&
            evidence.native_request_id === op.request.native_request_id &&
            typeof op.request.native_request_id === "string" &&
            stable({ model: evidence.model, thinking: evidence.thinking }) ===
              stable(op.request.execution_profile) &&
            typeof evidence.evidence_ref === "string" &&
            typeof evidence.created_at === "string",
          "EVIDENCE_REQUIRED",
          "Matching native request, CLI creation receipt and full execution profile required",
          5,
        );
      }
      if (
        (op.request.creation_parameters as any)?.transport === "codex-exec" &&
        outcome !== "unknown"
      )
        requireCondition(
          evidence.native_tool_name === "codex exec",
          "EVIDENCE_REQUIRED",
          "CLI dispatch requires real exec evidence",
          5,
        );
      if (ledger.contract_version >= 3 && outcome !== "unknown")
        requireCondition(
          ["multi-task-flow-cli", "multi-task-flow-reconcile"].includes(String(evidence.source)) &&
            evidence.native_tool_name === "codex exec" &&
            object(op.request.creation_parameters ?? {}).transport === "codex-exec",
          "EVIDENCE_REQUIRED",
          "Contract-3 dispatches must be created through the multi-task-flow codex exec path",
          5,
        );
      if (evidence.native_tool_name === "codex exec" && outcome === "failed")
        requireCondition(
          !op.request.observed_thread_id &&
            !payload.thread_id &&
            !evidence.thread_id &&
            !evidence.workspace_path &&
            !evidence.initial_head &&
            !evidence.turn_completed &&
            evidence.process_started === false &&
            evidence.resources_created === false,
          "UNKNOWN_REQUIRES_RECONCILIATION",
          "Only proven pre-creation failure may release a CLI dispatch; observed identities require reconciliation",
          5,
        );
      if (evidence.native_tool_name === "codex exec" && outcome === "succeeded") {
        if (op.request.initialization_recovery) {
          const attempt = object(op.request.initialization_recovery);
          const recovery = object(evidence.initialization_recovery ?? {});
          requireCondition(
            evidence.source === "multi-task-flow-reconcile" &&
              recovery.attempt_id === attempt.attempt_id &&
              recovery.original_turn_id === attempt.original_turn_id &&
              evidence.initialization_turn_id === attempt.original_turn_id &&
              typeof attempt.recovery_turn_id === "string" &&
              recovery.recovery_turn_id === attempt.recovery_turn_id &&
              recovery.prompt_digest === attempt.prompt_digest &&
              recovery.transport === "codex-app-server-private-unix" &&
              recovery.native_version === "0.169.0" &&
              !!object(attempt.permissions ?? {}).original &&
              recovery.restored_permissions_digest ===
                recoveryDigest(object(attempt.permissions).original) &&
              evidence.workspace_path === attempt.workspace_path &&
              evidence.initial_head === attempt.initial_head,
            "EVIDENCE_REQUIRED",
            "Recovery requires the registered original and completed recovery turn chain",
            5,
          );
        } else
          requireCondition(
            !evidence.initialization_recovery,
            "EVIDENCE_REQUIRED",
            "Unregistered recovery evidence",
            5,
          );
        const reconciled = evidence.source === "multi-task-flow-reconcile";
        requireCondition(
          (reconciled || evidence.exit_code === 0) &&
            evidence.turn_completed === true &&
            typeof evidence.workspace_path === "string" &&
            evidence.workspace_path.length > 0 &&
            typeof evidence.initial_head === "string" &&
            /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.initial_head) &&
            op.request.observed_thread_id === payload.thread_id &&
            evidence.thread_id === payload.thread_id,
          "EVIDENCE_REQUIRED",
          "CLI exit, initialization, observed identity and workspace evidence required",
          5,
        );
      }
      op.request.creation_observations = observed;
      if (outcome === "unknown" && observed.thread_id)
        op.request.observed_thread_id = observed.thread_id;
      op.request.creation_result = { ...payload, resolved_at: now() };
      addEvent(
        ledger,
        { ...request, request_id: `${request.request_id}-creation` },
        "dispatch_creation_resolved",
        op.target_id,
        { ...payload, execution_profile: op.request.execution_profile },
      );
      if (outcome === "succeeded") {
        const threadId = string(payload.thread_id);
        requireCondition(
          threadId !== ledger.control.owner_thread_id &&
            !ledger.tasks.some((item) => item.thread_id === threadId) &&
            !ledger.groups.some((item) => item.agent_thread_id === threadId),
          "THREAD_CONFLICT",
          "Conversation is already bound",
          3,
        );
        requireCondition(
          ledger.contract_version >= 3
            ? ["multi-task-flow-cli", "multi-task-flow-reconcile"].includes(
                String(object(payload.native_evidence).source),
              ) && object(payload.native_evidence).native_tool_name === "codex exec"
            : ["create_thread", "multi-task-flow-cli", "multi-task-flow-reconcile"].includes(
                String(object(payload.native_evidence).source),
              ),
          "EVIDENCE_REQUIRED",
          "Native creation evidence required",
          5,
        );
        if (target) {
          target.thread_id = threadId;
          target.state = "starting";
        }
        if (targetGroup) targetGroup.agent_thread_id = threadId;
      } else if (outcome === "failed") {
        const evidence = object(payload.native_evidence);
        requireCondition(
          typeof op.request.native_request_id === "string" &&
            ["create_thread", "multi-task-flow-cli"].includes(evidence.source) &&
            evidence.operation_id === op.id &&
            evidence.native_request_id === op.request.native_request_id &&
            (evidence.native_tool_name === "create_thread" ||
              evidence.native_tool_name === "thread/start" ||
              evidence.native_tool_name === "codex exec") &&
            typeof evidence.error === "string" &&
            evidence.error.length > 0,
          "EVIDENCE_REQUIRED",
          "Matching native request and failure evidence required",
          5,
        );
      }
      op.status = outcome;
      op.updated_at = now();
      const threadId = target?.thread_id ?? targetGroup?.agent_thread_id ?? null;
      addEvent(ledger, request, "thread_bound", op.target_id, {
        operation_id: op.id,
        outcome,
        thread_id: threadId,
        group_snapshot: targetGroup ? structuredClone(targetGroup) : null,
      });
      const handoffNotice =
        outcome === "succeeded" &&
        (op.request.creation_parameters as any)?.transport === "codex-exec"
          ? addNotificationIntent(
              ledger,
              { ...request, request_id: `${request.request_id}-creation` },
              threadId!,
            )
          : null;
      if (handoffNotice) op.request.handoff_notification_id = handoffNotice.id;
      return {
        operation_id: op.id,
        outcome,
        thread_id: threadId,
        ...(handoffNotice
          ? { notification_request: notificationDeliveryRequest(handoffNotice) }
          : {}),
      };
    }
    default:
      return undefined;
  }
}
