import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ContractError, requireCondition } from "../lib/errors";
import { fact, id } from "../lib/schema";
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

export const evidenceDeliveryCommands = [
  "fact-record",
  "action-claim",
  "action-resolve",
  "notification-deliver",
  "notification-reconcile",
] as const;

export function executeEvidenceDeliveryCommand(context: CommandContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "fact-record": {
      const observed = parse(fact, payload.fact);
      requireCondition(
        !["pr_merged", "task_quality", "branch_published", "pr_published"].includes(observed.kind),
        "INVALID_FACT",
        "Quality, merge and publication facts require their dedicated operation",
        3,
      );
      requireCondition(
        observed.evidence_ref && observed.source && observed.status !== "unknown",
        "EVIDENCE_REQUIRED",
        "Observed fact requires a source and evidence",
        5,
      );
      const owner = ledger.groups.find((item) => item.id === observed.subject_id);
      const target = ledger.tasks.find((item) => item.id === observed.subject_id);
      requireCondition(owner || target, "NOT_FOUND", "Fact subject not found");
      if (target) ownerOfTask(ledger, request, target.id);
      if (owner && request.actor.role === "group")
        requireCondition(
          owner.agent_thread_id === request.actor.thread_id,
          "FORBIDDEN",
          "Fact belongs to another delivery unit",
          3,
        );
      if (owner && request.actor.role === "task")
        throw new ContractError(
          "FORBIDDEN",
          "Delivery-unit facts belong to the Delivery coordinator",
          3,
        );
      if (owner && observed.kind === "ci_passed")
        requireCondition(
          owner.merge_sha && observed.sha === owner.merge_sha,
          "EVIDENCE_MISMATCH",
          "Group CI must bind the merged SHA",
          5,
        );
      if (observed.kind === "published" || observed.kind === "deployed") {
        const operationKind = observed.kind === "published" ? "release" : "deploy";
        requireCondition(
          ledger.operations.some(
            (item) =>
              item.kind === operationKind &&
              item.target_id === observed.subject_id &&
              item.status === "succeeded" &&
              item.receipt_fact_id === observed.id,
          ),
          "INVALID_FACT",
          "Release and deployment facts must be bound to a successful operation receipt",
          4,
        );
      }
      ledger.facts.push(observed);
      addEvent(ledger, request, "fact_observed", observed.subject_id, {
        fact_id: observed.id,
      });
      return { fact_id: observed.id };
    }
    case "action-claim": {
      const action = z.enum(["release", "deploy"]).parse(payload.kind);
      authorizedAction(ledger, action);
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      protectedActionApproved(ledger, action, taskId, string(payload.owner_approval_id));
      const current = currentPlan();
      const actionId = parse(id, payload.action_id);
      const planned = find(
        current.actions,
        (item) => item.id === actionId && item.kind === action && item.task_id === taskId,
        "Planned action",
      );
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      requireCondition(
        taskExecutionState(target) === "running" &&
          (action === "release" ? target.kind === "release" : target.kind === "deployment"),
        "TASK_MISMATCH",
        "Active task does not match the action",
        3,
      );
      const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
      requireCondition(
        owner.state === "merged" && owner.merge_sha && payload.expected_sha === owner.merge_sha,
        "BASE_CHANGED",
        "Action must bind the group's merged SHA",
        5,
      );
      requireCondition(
        !ledger.operations.some((item) => item.target_id === taskId && activeOperation(item)),
        "OPERATION_PENDING",
        "Task already has an unresolved action",
        4,
      );
      const destination = object(payload.target);
      requireCondition(
        destination.identity === planned.target_identity,
        "TARGET_MISMATCH",
        "Action target differs from the approved plan",
        3,
      );
      const op = addOperation(ledger, request, action, taskId, owner.merge_sha);
      addEvent(ledger, request, "action_claimed", taskId, {
        operation_id: op.id,
      });
      return { operation_id: op.id };
    }
    case "action-resolve": {
      const op = find(
        ledger.operations,
        (item) =>
          item.id === string(payload.operation_id) && ["release", "deploy"].includes(item.kind),
        "Action",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "Action claim is not active or belongs to another actor",
        3,
      );
      const outcome = z.enum(["succeeded", "failed", "unknown"]).parse(payload.outcome);
      if (outcome === "succeeded") {
        const evidence = parse(fact, payload.provider_evidence);
        requireCondition(
          evidence.kind === (op.kind === "release" ? "published" : "deployed") &&
            evidence.status === "passed" &&
            evidence.subject_id === op.target_id &&
            evidence.sha &&
            evidence.evidence_ref,
          "EVIDENCE_MISMATCH",
          "Action evidence must bind the exact task and publication SHA",
          5,
        );
        if (evidence.sha !== op.expected_sha) {
          const lineage = z
            .object({
              source_sha: z.string(),
              publication_sha: z.string(),
              evidence_ref: z.string().min(1),
            })
            .strict()
            .parse(payload.lineage_evidence);
          requireCondition(
            lineage.source_sha === op.expected_sha && lineage.publication_sha === evidence.sha,
            "LINEAGE_MISMATCH",
            "Publication lineage does not match the source and actual SHA",
            5,
          );
        }
        ledger.facts.push(evidence);
        op.receipt_fact_id = evidence.id;
      } else if (outcome === "failed") {
        const observation = z
          .object({
            operation_id: id,
            target_identity: z.string().min(1),
            verified_no_effect: z.literal(true),
            evidence_ref: z.string().min(1),
          })
          .strict()
          .parse(payload.provider_observation);
        requireCondition(
          observation.operation_id === op.id &&
            observation.target_identity === object(op.request.target).identity,
          "EVIDENCE_MISMATCH",
          "Failure observation must identify the claimed action and target",
          5,
        );
        const failure = fact.parse({
          id: randomUUID(),
          kind: op.kind === "release" ? "published" : "deployed",
          subject_id: op.target_id,
          status: "failed",
          source: "provider",
          observed_at: now(),
          sha: null,
          evidence_ref: observation.evidence_ref,
        });
        ledger.facts.push(failure);
        op.receipt_fact_id = failure.id;
      } else {
        const observation = z
          .object({
            operation_id: id,
            target_identity: z.string().min(1),
            evidence_ref: z.string().min(1),
          })
          .strict()
          .parse(payload.provider_observation);
        requireCondition(
          observation.operation_id === op.id &&
            observation.target_identity === object(op.request.target).identity,
          "EVIDENCE_MISMATCH",
          "Unknown observation must identify the claimed action and target",
          5,
        );
        const unknown = fact.parse({
          id: randomUUID(),
          kind: op.kind === "release" ? "published" : "deployed",
          subject_id: op.target_id,
          status: "unknown",
          source: "provider",
          observed_at: now(),
          sha: null,
          evidence_ref: observation.evidence_ref,
        });
        ledger.facts.push(unknown);
        op.receipt_fact_id = unknown.id;
      }
      op.status = outcome;
      op.updated_at = now();
      addEvent(ledger, request, "action_resolved", op.target_id, {
        operation_id: op.id,
        outcome,
        fact_id: op.receipt_fact_id,
      });
      return { operation_id: op.id, outcome };
    }
    case "notification-deliver": {
      const notice = find(
        ledger.notifications,
        (item) => item.id === string(payload.notification_id),
        "Notification",
      );
      const original = find(
        ledger.events,
        (item) => item.id === notice.event_id,
        "Notification event",
      );
      requireCondition(
        original.actor_id === request.actor.thread_id ||
          (request.actor.role === "main" &&
            object(payload.provider_receipt).provider === "codex-app-tools"),
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
      const outcome = z.enum(["sent", "failed", "unknown"]).parse(payload.outcome);
      requireCondition(
        (!requiresNativeDelivery(ledger, notice.id) ||
          object(payload.provider_receipt).provider === "codex-app-tools") &&
          (object(payload.provider_receipt).provider !== "codex-app-tools" ||
            outcome === "unknown"),
        "NATIVE_RECEIPT_REQUIRED",
        "Native delivery must claim an unknown attempt before reconciling the platform receipt",
        5,
      );
      requireNotificationRecipientActive(ledger, notice.recipient_thread_id);
      const attemptId = parse(id, payload.delivery_attempt_id);
      requireCondition(
        !ledger.events.some(
          (event) =>
            ["notification_delivery_resolved", "notification_sent"].includes(event.type) &&
            event.data.delivery_attempt_id === attemptId,
        ),
        "ATTEMPT_EXISTS",
        "Delivery attempt identity already exists",
        3,
      );
      requireCondition(
        notice.delivery_status !== "sent",
        "NOTIFICATION_ALREADY_SENT",
        "Sent delivery cannot be attempted again",
        5,
      );
      const receipt = z
        .object({
          provider: z.string().min(1),
          evidence_ref: z.string().min(1),
          message_id: z.string().min(1).nullable().optional(),
          recipient_thread_id: z.string().min(1).optional(),
          prompt_digest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(payload.provider_receipt);
      if (receipt.provider === "codex-app-tools") {
        requireCondition(
          receipt.recipient_thread_id === notice.recipient_thread_id && !!receipt.prompt_digest,
          "NATIVE_RECEIPT_REQUIRED",
          "Native delivery must bind the claimed recipient and prompt",
          5,
        );
      }
      notice.status = outcome;
      notice.delivery_status = outcome;
      notice.ack_status = "unacknowledged";
      notice.attempts += 1;
      notice.last_attempt_id = attemptId;
      notice.last_reconciliation_id = null;
      notice.last_error =
        outcome === "failed"
          ? payload.error === undefined
            ? "Delivery failed"
            : string(payload.error)
          : null;
      notice.updated_at = now();
      addEvent(ledger, request, "notification_delivery_resolved", notice.event_id, {
        notification_id: notice.id,
        delivery_attempt_id: attemptId,
        outcome,
        provider: receipt.provider,
        evidence_ref: receipt.evidence_ref,
        message_id: receipt.message_id ?? null,
        recipient_thread_id: receipt.recipient_thread_id ?? null,
        prompt_digest: receipt.prompt_digest ?? null,
      });
      return {
        notification_id: notice.id,
        delivery_attempt_id: attemptId,
        ledger_status: notice.ledger_status,
        delivery_status: notice.delivery_status,
        ack_status: notice.ack_status,
      };
    }
    case "notification-reconcile": {
      const notice = find(
        ledger.notifications,
        (item) => item.id === string(payload.notification_id),
        "Notification",
      );
      const original = find(
        ledger.events,
        (item) => item.id === notice.event_id,
        "Notification event",
      );
      requireCondition(
        request.actor.role === "main" || original.actor_id === request.actor.thread_id,
        "FORBIDDEN",
        "Only the sender or main conversation can reconcile delivery",
        3,
      );
      requireCondition(
        notice.status !== "acknowledged",
        "NOTIFICATION_TERMINAL",
        "Notification is already acknowledged",
        3,
      );
      requireCondition(
        notice.delivery_status === "unknown",
        "NOTIFICATION_NOT_UNKNOWN",
        "Only an unknown delivery can be reconciled",
        4,
      );
      const nativeClaim = ledger.events.find(
        (event) =>
          event.type === "notification_delivery_resolved" &&
          event.data.delivery_attempt_id === notice.last_attempt_id &&
          event.data.provider === "codex-app-tools" &&
          event.data.outcome === "unknown",
      );
      const nativeAttempt = !!nativeClaim;
      if (nativeAttempt || payload.delivery_attempt_id !== undefined)
        requireCondition(
          payload.delivery_attempt_id === notice.last_attempt_id,
          "ATTEMPT_MISMATCH",
          "Receipt must match the active delivery attempt",
          3,
        );
      const reconciliationId = parse(id, payload.reconciliation_id);
      requireCondition(
        !ledger.events.some(
          (event) =>
            ["notification_delivery_resolved", "notification_delivery_reconciled"].includes(
              event.type,
            ) &&
            (event.data.delivery_attempt_id === reconciliationId ||
              event.data.reconciliation_id === reconciliationId),
        ),
        "RECONCILIATION_EXISTS",
        "Reconciliation identity already exists",
        3,
      );
      const outcome = z.enum(["sent", "failed", "unknown"]).parse(payload.outcome);
      const receipt = z
        .object({
          provider: z.string().min(1),
          evidence_ref: z.string().min(1),
          message_id: z.string().min(1).nullable().optional(),
          recipient_thread_id: z.string().min(1).optional(),
          prompt_digest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(payload.provider_receipt);
      if (nativeAttempt || receipt.provider === "codex-app-tools")
        requireCondition(
          nativeAttempt && receipt.provider === "codex-app-tools",
          "NATIVE_RECEIPT_REQUIRED",
          "Native attempt requires a matching platform provider",
          5,
        );
      if (nativeClaim?.data.prompt_digest)
        requireCondition(
          receipt.recipient_thread_id === nativeClaim.data.recipient_thread_id &&
            receipt.prompt_digest === nativeClaim.data.prompt_digest,
          "NATIVE_RECEIPT_REQUIRED",
          "Platform receipt does not match the claimed recipient and prompt",
          5,
        );
      notice.status = outcome;
      notice.delivery_status = outcome;
      notice.ack_status = "unacknowledged";
      notice.last_reconciliation_id = reconciliationId;
      notice.last_error =
        outcome === "failed"
          ? payload.error === undefined
            ? "Delivery failed"
            : string(payload.error)
          : null;
      notice.updated_at = now();
      addEvent(ledger, request, "notification_delivery_reconciled", notice.event_id, {
        notification_id: notice.id,
        reconciliation_id: reconciliationId,
        outcome,
        provider: receipt.provider,
        evidence_ref: receipt.evidence_ref,
        message_id: receipt.message_id ?? null,
        recipient_thread_id: receipt.recipient_thread_id ?? null,
        prompt_digest: receipt.prompt_digest ?? null,
      });
      return {
        notification_id: notice.id,
        reconciliation_id: reconciliationId,
        ledger_status: notice.ledger_status,
        delivery_status: notice.delivery_status,
        ack_status: notice.ack_status,
      };
    }

    default:
      return undefined;
  }
}
