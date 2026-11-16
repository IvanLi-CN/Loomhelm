import { z } from "zod";
import { requireCondition } from "../lib/errors";
import { externalRef, id, isContributionKind, ledgerSchema } from "../lib/schema";
import type { CommandContext } from "./engine-command-context";
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

export const closeoutCommands = [
  "notification-sent",
  "notification-ack",
  "resource-update",
  "run-complete",
  "group-close",
  "group-closeout-reconcile",
  "group-reopen",
] as const;

export function executeCloseoutCommand(context: CommandContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "notification-sent": {
      requireCondition(
        object(payload.provider_receipt).provider !== "codex-app-tools",
        "NATIVE_RECEIPT_REQUIRED",
        "Native delivery requires a claimed attempt and reconciled platform receipt",
        5,
      );
      const notice = find(
        ledger.notifications,
        (item) => item.id === string(payload.notification_id),
        "Notification",
      );
      requireCondition(
        !requiresNativeDelivery(ledger, notice.id),
        "NATIVE_RECEIPT_REQUIRED",
        "Native delivery requires a claimed attempt and reconciled platform receipt",
        5,
      );
      const original = find(
        ledger.events,
        (item) => item.id === notice.event_id,
        "Notification event",
      );
      requireCondition(
        original.actor_id === request.actor.thread_id,
        "FORBIDDEN",
        "Only the event sender or native main coordinator can record notification delivery",
        3,
      );
      requireCondition(
        notice.status !== "acknowledged",
        "NOTIFICATION_TERMINAL",
        "Notification is already acknowledged",
        3,
      );
      requireCondition(
        notice.delivery_status !== "unknown",
        "UNKNOWN_REQUIRES_RECONCILIATION",
        "Unknown delivery must be reconciled before another delivery attempt",
        5,
      );
      notice.status = "sent";
      notice.delivery_status = "sent";
      notice.ack_status = "unacknowledged";
      notice.attempts += 1;
      notice.last_attempt_id = `legacy-${request.request_id}`;
      notice.last_reconciliation_id = null;
      notice.last_error = null;
      notice.updated_at = now();
      addEvent(ledger, request, "notification_sent", notice.event_id, {
        notification_id: notice.id,
        delivery_attempt_id: notice.last_attempt_id,
        legacy: true,
      });
      return {
        notification_id: notice.id,
        ledger_status: notice.ledger_status,
        delivery_status: notice.delivery_status,
        ack_status: notice.ack_status,
      };
    }
    case "notification-ack": {
      const notice = find(
        ledger.notifications,
        (item) => item.id === string(payload.notification_id),
        "Notification",
      );
      requireCondition(
        notice.recipient_thread_id === request.actor.thread_id,
        "FORBIDDEN",
        "Only the recipient can acknowledge a notification",
        3,
      );
      requireCondition(
        notice.delivery_status === "sent" && notice.status === "sent",
        "NOTIFICATION_NOT_SENT",
        "Notification has not been sent",
        4,
      );
      notice.status = "acknowledged";
      notice.delivery_status = "sent";
      notice.ack_status = "acknowledged";
      notice.updated_at = now();
      addEvent(ledger, request, "notification_acknowledged", notice.event_id, {
        notification_id: notice.id,
        handling_evidence: string(payload.handling_evidence),
      });
      return {
        notification_id: notice.id,
        status: notice.status,
        ledger_status: notice.ledger_status,
        delivery_status: notice.delivery_status,
        ack_status: notice.ack_status,
      };
    }
    case "resource-update": {
      onlyMain(request.actor);
      const incoming = ledgerSchema.shape.resources.element.parse(payload.resource);
      const existing = ledger.resources.find((item) => item.id === incoming.id);
      if (existing) {
        requireCondition(
          existing.kind === incoming.kind && existing.target === incoming.target,
          "RESOURCE_MISMATCH",
          "Resource identity cannot change",
          3,
        );
        requireCondition(
          (existing.status !== "closed" && existing.status !== "not_applicable") ||
            (existing.kind === "conversation" &&
              existing.status === "closed" &&
              incoming.status === "unarchive_unknown" &&
              incoming.archive_policy === "manual" &&
              !!incoming.operation_id &&
              incoming.operation_id !== existing.operation_id &&
              !!incoming.evidence_ref),
          "RESOURCE_TERMINAL",
          "Resource is already terminal",
          3,
        );
        Object.assign(existing, incoming);
      } else ledger.resources.push(incoming);
      if (["closed", "not_applicable"].includes(incoming.status))
        requireCondition(
          incoming.evidence_ref,
          "EVIDENCE_REQUIRED",
          "Resource closeout requires evidence",
          5,
        );
      addEvent(
        ledger,
        request,
        incoming.status === "closed" ? "resource_closed" : "resource_updated",
        ledger.orchestration_id,
        { resource_id: incoming.id, status: incoming.status },
      );
      return { resource_id: incoming.id, status: incoming.status };
    }
    case "run-complete": {
      onlyMain(request.actor);
      requireCondition(
        ledger.groups.length > 0 && ledger.groups.every((item) => item.state === "closed"),
        "GROUPS_PENDING",
        "All groups must be closed",
        4,
      );
      requireCondition(
        !ledger.follow_prs.some((item) => item.state !== "merged") &&
          !ledger.operations.some(activeOperation),
        "OPERATIONS_PENDING",
        "Follow PRs or operations remain unresolved",
        4,
      );
      requireCondition(
        !ledger.events.some((item) => item.type === "run_completed"),
        "RUN_ALREADY_COMPLETE",
        "Run is already complete",
        3,
      );
      addEvent(ledger, request, "run_completed", ledger.orchestration_id, {
        evidence: string(payload.evidence),
      });
      return { state: "completed" };
    }
    case "group-close": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        ownsGroup(ledger, request.actor, owner),
        "FORBIDDEN",
        "The Delivery coordinator owns delivery-unit closeout",
        3,
      );
      requireCondition(
        owner.state === "merged" && owner.merge_sha,
        "GROUP_NOT_MERGED",
        "Group PR has not merged",
        4,
      );
      requireCondition(
        legacyLedger(ledger) || owner.lifecycle.pr_merged === "passed",
        "PR_NOT_MERGED",
        "Group PR merge lifecycle stage is not passed",
        4,
      );
      const ci = ledger.facts
        .filter(
          (item) =>
            item.kind === "ci_passed" &&
            item.subject_id === groupId &&
            item.sha === owner.merge_sha,
        )
        .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
      requireCondition(
        ci?.status === "passed",
        "CI_PENDING",
        "Latest merged SHA CI is not confirmed passing",
        4,
      );
      requireCondition(
        ledger.tasks
          .filter((item) => item.group_id === groupId)
          .every((item) =>
            isContributionKind(item.kind)
              ? ["integrated", "closed"].includes(item.state)
              : ["completed", "closed"].includes(item.state),
          ),
        "TASKS_PENDING",
        "Group tasks are incomplete",
        4,
      );
      requireCondition(
        owner.atoms.slice(0, -1).every((atom) => atom.status === "completed"),
        "ATOMS_PENDING",
        "Delivery-unit atoms are incomplete",
        4,
      );
      const closeout = owner.atoms.at(-1);
      requireCondition(
        closeout?.lifecycle_stage !== "closed"
          ? owner.atoms.every((atom) => atom.status === "completed")
          : ["planned", "running"].includes(closeout.status),
        "ATOMS_PENDING",
        "Delivery-unit closeout atom is incomplete",
        4,
      );
      requireCondition(
        ["unknown", "idle"].includes(owner.coordination_execution.state),
        "EXECUTION_PENDING",
        "Delivery-unit coordination execution is still active",
        4,
      );
      requireCondition(
        !ledger.follow_prs.some(
          (item) => item.origin_group_id === groupId && item.state !== "merged",
        ),
        "FOLLOW_PR_PENDING",
        "Known follow PRs are incomplete",
        4,
      );
      owner.state = "closed";
      if (owner.lifecycle && !legacyLedger(ledger)) owner.lifecycle.closed = "passed";
      if (closeout?.lifecycle_stage === "closed") closeout.status = "completed";
      addEvent(ledger, request, "group_updated", groupId, {
        group_id: groupId,
        state: "closed",
        group_snapshot: structuredClone(owner),
      });
      const directive = notificationDirective(ledger, request, payload, true);
      const notice = directive.enabled
        ? addNotificationIntent(ledger, request, directive.recipient_thread_id!)
        : null;
      return {
        group_id: groupId,
        state: "closed",
        notification_id: notice?.id ?? null,
        notification_status: notice?.delivery_status ?? "none",
        notification_request: notificationDeliveryRequest(notice),
      };
    }
    case "group-closeout-reconcile": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        ownsGroup(ledger, request.actor, owner),
        "FORBIDDEN",
        "Only the bound Delivery coordinator can reconcile closeout",
        3,
      );
      const planId = parse(id, payload.plan_id);
      requireCondition(
        planId === ledger.execution_plan_id,
        "PLAN_MISMATCH",
        "Closeout reconciliation must target the execution plan",
        4,
      );
      const outcome = z.enum(["valid", "invalid", "unknown"]).parse(payload.outcome);
      const observation = z
        .object({
          pr: externalRef,
          provider_state: z.enum(["merged", "closed", "open", "unknown"]),
          merge_sha: z.string().nullable(),
          source: z.string().min(1),
          observed_at: z.iso.datetime({ offset: false }),
          evidence_ref: z.string().min(1),
        })
        .strict()
        .parse(payload.provider_observation);
      const canonicalPr = deliveryUnitPr(owner);
      requireCondition(
        !canonicalPr || stable(canonicalPr) === stable(observation.pr),
        "TARGET_MISMATCH",
        "Closeout observation PR does not match the DeliveryUnit PR",
        5,
      );
      requireCondition(
        observation.source === ledger.repository.provider,
        "EVIDENCE_MISMATCH",
        "Closeout evidence source does not match the bound repository",
        5,
      );
      const closeoutEventId = parse(id, payload.closeout_event_id);
      requireCondition(
        ledger.events.some(
          (event) =>
            event.id === closeoutEventId &&
            event.subject_id === groupId &&
            event.data.state === "closed",
        ),
        "EVIDENCE_REQUIRED",
        "Original closeout event is not present",
        5,
      );
      const previousState = owner.state;
      if (outcome === "invalid") {
        owner.state = "blocked";
        owner.lifecycle.closed = "blocked";
      }
      addEvent(ledger, request, "group_updated", groupId, {
        operation: "closeout-reconcile",
        group_id: groupId,
        plan_id: planId,
        closeout_event_id: closeoutEventId,
        reconciliation_id: parse(id, payload.reconciliation_id),
        outcome,
        reason: string(payload.reason),
        evidence_refs: z.array(z.string().min(1)).parse(payload.evidence_refs),
        provider_observation: observation,
        previous_state: previousState,
        state: owner.state,
        group_snapshot: structuredClone(owner),
      });
      return {
        group_id: groupId,
        state: owner.state,
        outcome,
        reconciliation_id: payload.reconciliation_id,
      };
    }
    case "group-reopen": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        ownsGroup(ledger, request.actor, owner),
        "FORBIDDEN",
        "Only the bound Delivery coordinator can reopen a DeliveryUnit",
        3,
      );
      requireCondition(
        owner.state === "blocked",
        "INVALID_TRANSITION",
        "Only a blocked DeliveryUnit can be reopened",
        3,
      );
      const planId = parse(id, payload.plan_id);
      requireCondition(
        planId === ledger.execution_plan_id && approved(ledger).lifecycle === "approved",
        "PLAN_NOT_APPROVED",
        "Recovery requires the approved execution plan",
        4,
      );
      protectedActionApproved(
        ledger,
        "delivery_unit_recovery",
        groupId,
        string(payload.recovery_id),
      );
      requireCondition(
        !ledger.operations.some((item) => item.target_id === groupId && activeOperation(item)),
        "OPERATION_PENDING",
        "DeliveryUnit has unresolved operations",
        4,
      );
      const latest = ledger.events
        .filter(
          (event) => event.subject_id === groupId && event.data.operation === "closeout-reconcile",
        )
        .at(-1);
      requireCondition(
        latest?.data.outcome !== "unknown",
        "RECONCILIATION_REQUIRED",
        "Closeout reconciliation is still unknown",
        5,
      );
      owner.state = "active";
      owner.lifecycle.closed = "unknown";
      addEvent(ledger, request, "group_updated", groupId, {
        operation: "protected-recovery",
        group_id: groupId,
        plan_id: planId,
        recovery_id: parse(id, payload.recovery_id),
        reason: string(payload.reason),
        evidence_refs: z.array(z.string().min(1)).parse(payload.evidence_refs),
        previous_state: "blocked",
        state: "active",
        group_snapshot: structuredClone(owner),
      });
      return { group_id: groupId, state: owner.state, recovery_id: payload.recovery_id };
    }

    default:
      return undefined;
  }
}
