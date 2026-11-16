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

import * as schema from "../lib/schema";
import * as core from "./engine-support-core";
import * as support from "./engine-support-gates";
import type { Request } from "./engine-support-core";
import type { Ledger, Plan } from "../lib/schema";

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
} = support;
const {
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
  ledgerSchema,
  milestone,
  notification,
  notificationOption,
  operation,
  plan,
  providerReceipt,
  recommendedExecutionProfile,
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
} = schema;

export type ExecutionContext = {
  ledger: Ledger;
  command: string;
  request: Request;
  payload: Record<string, any>;
  currentPlan: () => Plan;
};

export function executeCommandB(context: ExecutionContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
        case "execution-profile-migrate": {
          onlyMain(request.actor);
          migrateProfile(ledger, payload.execution_profile);
          addEvent(ledger, request, "execution_profile_migrated", ledger.orchestration_id, {
            execution_profile: ledger.config.execution_profile,
          });
          return { execution_profile: ledger.config.execution_profile };
        }
        case "execution-profile-default-update": {
          onlyMain(request.actor);
          const profile = parse(executionProfile, payload.execution_profile);
          const previous = ledger.config.execution_profile;
          // Preserve the pair already captured by any native request; bound targets
          // must never change their effective profile through a new run default.
          for (const [type, targets] of [
            ["group", ledger.groups],
            ["task", ledger.tasks],
          ] as const) {
            for (const target of targets) {
              if (!target.execution_profile && profileFreezeReason(ledger, type, target.id))
                target.execution_profile = effectiveProfile(ledger, target);
            }
          }
          ledger.config.execution_profile = profile;
          for (const op of ledger.operations.filter(
            (item) =>
              item.kind === "dispatch" && activeOperation(item) && !item.request.native_request_id,
          )) {
            const target =
              op.request.target_type === "group"
                ? ledger.groups.find((item) => item.id === op.target_id)
                : ledger.tasks.find((item) => item.id === op.target_id);
            if (target?.execution_profile) continue;
            op.status = "failed";
            op.updated_at = now();
            addEvent(
              ledger,
              { ...request, request_id: `${request.request_id}-${op.id}` },
              "dispatch_claim_replaced",
              op.target_id,
              {
                operation_id: op.id,
                previous_profile: previous,
                execution_profile: profile,
                reason: "run_default_changed",
                requires_new_claim: true,
              },
            );
          }
          addEvent(ledger, request, "execution_profile_default_updated", ledger.orchestration_id, {
            previous_profile: previous,
            execution_profile: profile,
          });
          return { execution_profile: profile };
        }
        case "execution-profile-update":
        case "execution-profile-recommend": {
          onlyMain(request.actor);
          const targetType = z.enum(["group", "task"]).parse(payload.target_type);
          const targetId = parse(id, payload.target_id);
          const target =
            targetType === "group"
              ? find(ledger.groups, (item) => item.id === targetId, "Group")
              : find(ledger.tasks, (item) => item.id === targetId, "Task");
          requireCondition(
            !profileFreezeReason(ledger, targetType, targetId),
            "PROFILE_FROZEN",
            "Execution profile is frozen after native request binding",
            3,
          );
          const recommendation = command === "execution-profile-recommend";
          const profile = recommendation
            ? recommendedExecutionProfile(
                "kind" in target ? target.kind : "other",
                effectiveProfile(ledger, { execution_profile: null }),
              )
            : payload.execution_profile === null
              ? null
              : parse(executionProfile, payload.execution_profile);
          const previous = target.execution_profile ?? null;
          for (const operation of ledger.operations.filter(
            (item) =>
              item.kind === "dispatch" &&
              item.target_id === targetId &&
              (item.request.target_type === "group" ? "group" : "task") === targetType &&
              activeOperation(item),
          )) {
            operation.status = "failed";
            operation.updated_at = now();
            addEvent(
              ledger,
              { ...request, request_id: `${request.request_id}-${operation.id}` },
              "dispatch_claim_replaced",
              targetId,
              {
                operation_id: operation.id,
                reason: recommendation ? "recommendation_reapplied" : "execution_profile_changed",
                previous_profile: previous,
                previous_effective_profile: effectiveProfile(ledger, target),
                execution_profile: profile,
                requires_new_claim: true,
              },
            );
          }
          target.execution_profile = profile;
          target.execution_profile_source = recommendation ? "recommendation" : "manual";
          target.execution_profile_rule = recommendation ? RECOMMENDATION_VERSION : null;
          addEvent(ledger, request, "execution_profile_updated", targetId, {
            target_type: targetType,
            target_id: targetId,
            previous_profile: previous,
            execution_profile: profile,
            recommendation,
            rule_version: target.execution_profile_rule,
          });
          return {
            target_type: targetType,
            target_id: targetId,
            execution_profile: profile,
          };
        }
        case "dispatch-progress": {
          onlyMain(request.actor);
          const op = find(
            ledger.operations,
            (item) => item.id === string(payload.operation_id) && item.kind === "dispatch",
            "Dispatch",
          );
          requireCondition(
            activeOperation(op) && op.request.native_request_id === payload.native_request_id,
            "NATIVE_REQUEST_CONFLICT",
            "Progress must match the active creation request",
            3,
          );
          const threadId = string(payload.thread_id);
          requireCondition(
            !op.request.observed_thread_id || op.request.observed_thread_id === threadId,
            "THREAD_CONFLICT",
            "Creation reported conflicting thread identities",
            3,
          );
          op.request.observed_thread_id = threadId;
          addEvent(ledger, request, "dispatch_thread_observed", op.target_id, {
            operation_id: op.id,
            thread_id: threadId,
          });
          return { operation_id: op.id, thread_id: threadId };
        }
        case "dispatch-bind-request": {
          onlyMain(request.actor);
          const op = find(
            ledger.operations,
            (item) =>
              item.id === string(payload.operation_id) &&
              item.kind === "dispatch" &&
              activeOperation(item),
            "Dispatch",
          );
          const nativeId = string(payload.native_request_id);
          requireCondition(
            !op.request.native_request_id || op.request.native_request_id === nativeId,
            "NATIVE_REQUEST_CONFLICT",
            "Native request identity changed",
            3,
          );
          requireCondition(
            !ledger.operations.some(
              (item) =>
                item.id !== op.id &&
                item.kind === "dispatch" &&
                item.request.native_request_id === nativeId,
            ),
            "NATIVE_REQUEST_CONFLICT",
            "Native request identity is already claimed",
            3,
          );
          requireCondition(
            op.status === "claimed" || op.request.native_request_id === nativeId,
            "NATIVE_REQUEST_CONFLICT",
            "Unknown creation requires reconciliation",
            3,
          );
          const dispatchTarget =
            op.request.target_type === "group"
              ? find(ledger.groups, (item) => item.id === op.target_id, "Group")
              : find(ledger.tasks, (item) => item.id === op.target_id, "Task");
          if (ledger.contract_version >= 3) {
            if (op.request.target_type === "group")
              requireGroupDispatchGate(ledger, dispatchTarget as Ledger["groups"][number]);
            else if (isContributionKind((dispatchTarget as Ledger["tasks"][number]).kind))
              requireContributionDispatchGate(
                ledger,
                find(
                  ledger.groups,
                  (item) => item.id === (dispatchTarget as Ledger["tasks"][number]).group_id,
                  "Group",
                ),
              );
            requireCondition(
              object(payload.creation_parameters ?? {}).transport === "codex-exec",
              "TRANSPORT_REQUIRED",
              "Contract-3 dispatches must bind the multi-task-flow codex exec transport",
              5,
            );
          }
          requireCondition(
            stable(op.request.execution_profile) === stable(effectiveProfile(ledger, dispatchTarget)),
            "PROFILE_CONFLICT",
            "Claim execution profile changed; claim again",
            3,
          );
          if (payload.creation_parameters !== undefined) {
            const parameters = parse(
              z
                .object({
                  title: z.string().min(1),
                  prompt: z.string().min(1),
                  cwd: z.string().min(1),
                  execution_profile: executionProfile,
                  transport: z.literal("codex-exec").optional(),
                })
                .strict(),
              payload.creation_parameters,
            );
            requireCondition(
              !op.request.native_request_id ||
                stable(op.request.creation_parameters) === stable(parameters),
              "NATIVE_REQUEST_CONFLICT",
              "Creation parameters are frozen after native request binding",
              3,
            );
            op.request.creation_parameters = parameters;
          }
          op.request.native_request_id = nativeId;
          if ((op.request.creation_parameters as any)?.transport === "codex-exec")
            op.status = "unknown";
          addEvent(ledger, request, "dispatch_request_bound", op.target_id, {
            operation_id: op.id,
            native_request_id: nativeId,
            creation_parameters: op.request.creation_parameters,
            execution_profile: op.request.execution_profile,
          });
          op.updated_at = now();
          return { operation_id: op.id, native_request_id: nativeId };
        }
        case "development-baseline-sync": {
          requireCondition(
            ledger.contract_version === 3,
            "INCOMPATIBLE_LEDGER",
            "Baseline synchronization requires an explicit contract-3 migration",
            4,
          );
          const targetType = z.enum(["group", "task"]).parse(payload.target_type);
          const targetId = parse(id, payload.target_id);
          const target = lifecycleTarget(ledger, targetType, targetId) as any;
          requireOwner(ledger, request, targetType, targetId);
          const mode = z.enum(["initial", "refresh"]).parse(payload.mode);
          const dispatchOperationId = parse(id, payload.dispatch_operation_id);
          const dispatch = developmentDispatch(ledger, targetType, targetId, dispatchOperationId);
          const baseline = parse(baselineReceipt, payload.baseline);
          requireCondition(
            baseline.sha === baseline.head,
            "BASELINE_MISMATCH",
            "Workspace HEAD must match the verified development baseline",
            4,
          );
          const currentBaseline = dispatch.request.development_baseline;
          const expectedPrevious =
            payload.expected_previous_baseline === null
              ? null
              : parse(baselineReceipt, payload.expected_previous_baseline);
          if (mode === "initial") {
            requireCondition(
              currentBaseline === undefined && expectedPrevious === null,
              "BASELINE_CONFLICT",
              "Initial synchronization requires an empty development baseline",
              4,
            );
          } else {
            requireCondition(
              currentBaseline !== undefined &&
                expectedPrevious !== null &&
                stable(currentBaseline) === stable(expectedPrevious),
              "BASE_CHANGED",
              "Refresh synchronization must bind the current development baseline",
              5,
            );
          }
          const owner =
            targetType === "group"
              ? target
              : find(ledger.groups, (item) => item.id === target.group_id, "Group");
          const postMerge =
            targetType === "task" && ["release", "deployment", "verification"].includes(target.kind);
          const expectedLineage =
            targetType === "group"
              ? target.current_sha
              : postMerge
                ? owner.merge_sha
                : owner.current_sha;
          const expectedLineageSha =
            payload.expected_lineage_sha === null
              ? null
              : parse(
                  z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
                  payload.expected_lineage_sha,
                );
          requireCondition(
            expectedLineageSha === expectedLineage,
            "BASE_CHANGED",
            "Synchronization must bind the current target lineage",
            5,
          );
          requireCondition(
            expectedLineage !== null && baseline.sha === expectedLineage,
            "BASELINE_MISMATCH",
            "Workspace baseline must match the current target lineage",
            4,
          );
          if (targetType === "task")
            requireCondition(
              target.base_sha === expectedLineage,
              "TASK_BASE_REQUIRED",
              "Synchronize only after task-base establishes the current parent lineage",
              4,
            );
          const lineageEventId = string(payload.lineage_event_id);
          const targetLineageEvent = lineageEventMatches(
            ledger,
            lineageEventId,
            targetType,
            targetId,
            baseline.sha,
          );
          const groupLineageEvent =
            targetType === "task" &&
            lineageEventMatches(ledger, lineageEventId, "group", owner.id, baseline.sha);
          requireCondition(
            (mode === "initial" && lineageEventId === "initial") ||
              targetLineageEvent ||
              groupLineageEvent,
            "LINEAGE_MISMATCH",
            "Synchronization must reference the fact that established the target lineage",
            5,
          );
          requireCondition(
            !ledger.operations.some(
              (item) =>
                (item.target_id === targetId ||
                  (targetType === "task" && item.target_id === owner.id)) &&
                activeOperation(item) &&
                ["merge", "cut"].includes(item.kind),
            ),
            "OPERATION_PENDING",
            "Cannot synchronize a workspace while merge or cut is pending",
            4,
          );
          const branch = string(payload.branch);
          const resourceIds = z.array(id).min(1).parse(payload.resource_ids);
          const resources = resourceIds.map((resourceId) =>
            find(ledger.resources, (resource) => resource.id === resourceId, "Workspace resource"),
          );
          requireCondition(
            resources.some(
              (resource) =>
                resource.kind === "worktree" &&
                resource.target === targetId &&
                resource.status === "active",
            ),
            "WORKSPACE_NOT_READY",
            "Baseline synchronization requires an active target worktree",
            4,
          );
          requireCondition(
            resources.some(
              (resource) =>
                resource.kind === "branch" &&
                resource.target === branch &&
                resource.status === "active",
            ),
            "WORKSPACE_NOT_READY",
            "Baseline synchronization requires an active target branch resource",
            4,
          );
          const expectedBranch = targetType === "group" ? target.parent_branch : target.branch;
          requireCondition(
            expectedBranch === null || expectedBranch === branch,
            "TARGET_MISMATCH",
            "Synchronization branch differs from the target branch",
            3,
          );
          const nativeEvidence = object(dispatch.request.creation_result).native_evidence;
          const nativeThreadId = string(object(nativeEvidence).thread_id);
          requireCondition(
            (targetType === "group" ? target.agent_thread_id : target.thread_id) === nativeThreadId,
            "NATIVE_REQUEST_CONFLICT",
            "Synchronization target is not bound to the dispatch workspace thread",
            5,
          );
          const evidenceRef = string(payload.evidence_ref);
          const previousBaseline =
            currentBaseline === undefined ? null : parse(baselineReceipt, currentBaseline);
          if (targetType === "group" && expectedLineage === null) target.current_sha = baseline.sha;
          dispatch.request.development_baseline = baseline;
          const factId = `${request.request_id}-fact`;
          ledger.facts.push({
            id: factId,
            kind: "baseline_verified",
            subject_id: targetId,
            status: "passed",
            source: baseline.source,
            observed_at: baseline.fetched_at ?? now(),
            sha: baseline.sha,
            evidence_ref: evidenceRef,
            baseline: {
              target_type: targetType,
              target_id: targetId,
              dispatch_operation_id: dispatchOperationId,
              native_request_id: dispatch.request.native_request_id,
              thread_id: nativeThreadId,
              mode,
              previous_baseline: previousBaseline,
              lineage_event_id: lineageEventId,
              lineage_sha: baseline.sha,
              branch,
              resource_ids: resourceIds,
              receipt: baseline,
              observed_at: now(),
            },
          });
          addEvent(ledger, request, "development_baseline_synchronized", targetId, {
            fact_id: factId,
            target_type: targetType,
            target_id: targetId,
            dispatch_operation_id: dispatchOperationId,
            native_request_id: dispatch.request.native_request_id,
            mode,
            previous_sha: previousBaseline?.sha ?? null,
            sha: baseline.sha,
            lineage_event_id: lineageEventId,
            evidence_ref: evidenceRef,
            target_snapshot: structuredClone(target),
          });
          return {
            target_type: targetType,
            target_id: targetId,
            mode,
            previous_sha: previousBaseline?.sha ?? null,
            sha: baseline.sha,
            fact_id: factId,
          };
        }
    
    default:
      return undefined;
  }
}

