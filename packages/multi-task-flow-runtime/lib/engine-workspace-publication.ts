import { z } from "zod";
import { requireCondition } from "../lib/errors";
import { baselineReceipt, externalRef, fact, id, milestone, providerReceipt } from "../lib/schema";
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
  isMergedGroupContinuation,
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

export const workspacePublicationCommands = [
  "lifecycle-record",
  "milestone-record",
  "publish-branch-claim",
  "publish-branch-resolve",
  "publish-pr-claim",
  "publish-pr-resolve",
] as const;

export function executeWorkspacePublicationCommand(context: CommandContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "lifecycle-record": {
      const targetType = z.enum(["group", "task"]).parse(payload.target_type);
      const targetId = parse(id, payload.target_id);
      const stage = z
        .enum(["workspace_ready", "workspace-ready"])
        .parse(payload.stage)
        .replace("-", "_") as "workspace_ready";
      const target = lifecycleTarget(ledger, targetType, targetId) as any;
      requireOwner(ledger, request, targetType, targetId);
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
        "Workspace readiness requires an active worktree bound to the target",
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
        "Workspace readiness requires an active branch bound to the target",
        4,
      );
      if (targetType === "group")
        requireCondition(
          target.parent_branch === null || target.parent_branch === branch,
          "TARGET_MISMATCH",
          "Workspace branch differs from the group branch",
          3,
        );
      else
        requireCondition(
          target.branch === null || target.branch === branch,
          "TARGET_MISMATCH",
          "Workspace branch differs from the task branch",
          3,
        );
      const cliDispatch = ledger.operations.find(
        (op) =>
          op.kind === "dispatch" &&
          op.target_id === targetId &&
          (op.request.target_type ?? "task") === targetType &&
          (op.request.creation_parameters as any)?.transport === "codex-exec" &&
          op.status === "succeeded",
      );
      if (cliDispatch) {
        const baseline = parse(baselineReceipt, payload.baseline);
        requireCondition(
          baseline.sha === baseline.head,
          "BASELINE_MISMATCH",
          "Align HEAD to the verified baseline before development",
          4,
        );
        requireCondition(
          !cliDispatch.request.development_baseline ||
            stable(cliDispatch.request.development_baseline) === stable(baseline),
          "BASELINE_CONFLICT",
          "Creation baseline is immutable; use the explicit synchronization workflow",
          4,
        );
        if (ledger.contract_version >= 3)
          requireCondition(
            !!cliDispatch.request.development_baseline,
            "BASELINE_REQUIRED",
            "Record the development baseline before lifecycle readiness",
            4,
          );
        if (targetType === "group") {
          requireCondition(
            !!baseline.fetched_at &&
              Date.parse(baseline.fetched_at) >= Date.parse(cliDispatch.created_at),
            "BASELINE_REQUIRED",
            "Group baseline requires a fresh remote fetch receipt after dispatch",
            4,
          );
          if (ledger.contract_version >= 3)
            requireCondition(
              target.current_sha === baseline.sha,
              "BASELINE_NOT_VERIFIED",
              "Workspace baseline no longer matches the current group lineage",
              4,
            );
          if (!cliDispatch.request.development_baseline && ledger.contract_version < 3)
            target.current_sha = baseline.sha;
        } else {
          const group = find(ledger.groups, (g) => g.id === target.group_id, "Group");
          const postMerge = ["release", "deployment", "verification"].includes(target.kind);
          requireCondition(
            postMerge
              ? group.state === "merged" && group.merge_sha === baseline.sha
              : group.current_sha === baseline.sha,
            "BASELINE_MISMATCH",
            postMerge
              ? "Post-merge task baseline must match the merged parent SHA"
              : "Task baseline must match its group parent SHA",
            4,
          );
          target.base_sha = baseline.sha;
        }
        if (ledger.contract_version < 3) cliDispatch.request.development_baseline = baseline;
      }
      if (targetType === "group") target.parent_branch ??= branch;
      else target.branch ??= branch;
      target.lifecycle[stage] = "passed";
      addEvent(ledger, request, "lifecycle_recorded", targetId, {
        target_type: targetType,
        stage,
        resource_ids: resourceIds,
        evidence_ref: string(payload.evidence_ref),
      });
      return { target_type: targetType, target_id: targetId, stage };
    }
    case "milestone-record": {
      const targetType = z.enum(["group", "task"]).parse(payload.target_type);
      const targetId = parse(id, payload.target_id);
      requireOwner(ledger, request, targetType, targetId);
      const recorded = milestone.parse({
        id: parse(id, payload.milestone_id),
        target_type: targetType,
        target_id: targetId,
        title: string(payload.title),
        evidence_ref: payload.evidence_ref ?? null,
        recorded_at: now(),
        recorded_by: request.actor.thread_id,
      });
      requireCondition(
        !ledger.milestones.some((item) => item.id === recorded.id),
        "MILESTONE_EXISTS",
        "Milestone already exists",
        3,
      );
      ledger.milestones.push(recorded);
      addEvent(ledger, request, "milestone_recorded", targetId, {
        target_type: targetType,
        milestone_id: recorded.id,
      });
      return { milestone_id: recorded.id };
    }
    case "publish-branch-claim": {
      const targetType = z.enum(["group", "task"]).parse(payload.target_type);
      const targetId = parse(id, payload.target_id);
      requireOwner(ledger, request, targetType, targetId);
      requireDevelopmentTarget(ledger, targetType, targetId);
      if (targetType === "task") {
        const taskTarget = find(ledger.tasks, (item) => item.id === targetId, "Task");
        requireCondition(
          !isSharedDeliveryTask(ledger, taskTarget),
          "SHARED_DELIVERY_UNIT_PR",
          "A shared delivery task reuses the delivery-unit PR and cannot publish a task PR",
          3,
        );
      }
      requireLifecycle(ledger, targetType, targetId, "workspace_ready");
      const target = lifecycleTarget(ledger, targetType, targetId) as any;
      const mergedContinuation =
        targetType === "group" && isMergedGroupContinuation(ledger, target);
      const branch = string(payload.branch);
      exactApprovedAction(
        ledger,
        parse(id, payload.action_id),
        "publish_branch",
        targetType,
        targetId,
        `branch:${branch}`,
      );
      const expectedSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.expected_head_sha);
      requireCondition(
        targetType === "group"
          ? target.state === "active" || mergedContinuation
          : taskExecutionState(target) === "running",
        "TARGET_NOT_ACTIVE",
        "Publication target is not active",
        4,
      );
      if (targetType === "group")
        requireCondition(
          target.cut_sha === null,
          "GROUP_CUT",
          "A cut delivery unit cannot publish a new branch",
          4,
        );
      requireCondition(
        targetType === "group"
          ? !target.parent_branch || target.parent_branch === branch
          : !target.branch || target.branch === branch,
        "TARGET_MISMATCH",
        "Publication branch differs from the bound branch",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "publish_branch" && item.target_id === targetId && activeOperation(item),
        ),
        "OPERATION_PENDING",
        "Branch publication is already pending",
        4,
      );
      requireCondition(
        targetType !== "group" ||
          !ledger.operations.some(
            (item) => item.kind === "merge" && item.target_id === targetId && activeOperation(item),
          ),
        "MERGE_PENDING",
        "A merge into this group is already pending",
        4,
      );
      const op = addOperation(ledger, request, "publish_branch", targetId, expectedSha);
      op.request.target_type = targetType;
      op.request.branch = branch;
      op.request.expected_head_sha = expectedSha;
      op.request.expected_base_sha = targetType === "group" ? target.current_sha : target.base_sha;
      op.request.action_id = payload.action_id;
      op.request.continuation = mergedContinuation;
      addEvent(ledger, request, "publish_branch_claimed", targetId, {
        operation_id: op.id,
        target_type: targetType,
        branch,
        expected_head_sha: expectedSha,
      });
      return { operation_id: op.id };
    }
    case "publish-branch-resolve": {
      const op = find(
        ledger.operations,
        (item) => item.id === string(payload.operation_id) && item.kind === "publish_branch",
        "Branch publication",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "Branch publication claim is not active or belongs to another actor",
        3,
      );
      const outcome = z.enum(["succeeded", "failed", "unknown"]).parse(payload.outcome);
      if (outcome === "succeeded") {
        const receipt = providerReceipt.parse(
          payload.provider_receipt ?? payload.provider_observation,
        );
        requireCondition(
          receipt.provider === ledger.repository.provider &&
            receipt.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
            receipt.resource_type === "branch" &&
            receipt.resource_id === op.request.branch &&
            receipt.branch === op.request.branch &&
            receipt.target_branch === null &&
            (receipt.base_sha === null || receipt.base_sha === op.request.expected_base_sha) &&
            receipt.head_sha === op.expected_sha &&
            receipt.state === "exists",
          "EVIDENCE_MISMATCH",
          "Provider branch receipt does not match the claim",
          5,
        );
        const observed = fact.parse({
          id: parse(id, payload.fact_id),
          kind: "branch_published",
          subject_id: op.target_id,
          status: "passed",
          source: receipt.provider,
          observed_at: now(),
          sha: receipt.head_sha,
          evidence_ref: receipt.evidence_ref,
          receipt,
        });
        ledger.facts.push(observed);
        op.receipt_fact_id = observed.id;
        const targetType = z.enum(["group", "task"]).parse(op.request.target_type);
        const target = lifecycleTarget(ledger, targetType, op.target_id) as any;
        requireCondition(
          (targetType === "group" ? target.current_sha : target.base_sha) ===
            op.request.expected_base_sha,
          "BASE_CHANGED",
          "Branch lineage changed while publication was pending",
          5,
        );
        if (targetType === "group") {
          target.parent_branch = receipt.branch;
          target.current_sha = receipt.head_sha;
        } else target.branch = receipt.branch;
      } else {
        const receipt = providerReceipt.parse(
          payload.provider_receipt ?? payload.provider_observation,
        );
        requireCondition(
          receipt.provider === ledger.repository.provider &&
            receipt.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
            receipt.resource_type === "branch" &&
            receipt.resource_id === op.request.branch &&
            receipt.branch === op.request.branch &&
            receipt.target_branch === null &&
            receipt.state === (outcome === "failed" ? "absent" : "unknown") &&
            receipt.head_sha === null,
          "EVIDENCE_MISMATCH",
          "Provider branch observation does not match the claim",
          5,
        );
        const observed = fact.parse({
          id: parse(id, payload.fact_id),
          kind: "branch_published",
          subject_id: op.target_id,
          status: outcome,
          source: receipt.provider,
          observed_at: now(),
          sha: null,
          evidence_ref: receipt.evidence_ref,
          receipt,
        });
        ledger.facts.push(observed);
        op.receipt_fact_id = observed.id;
      }
      requireCondition(
        outcome !== "failed" || payload.verified_no_effect === true,
        "EVIDENCE_REQUIRED",
        "Failed publication requires verified no-effect evidence",
        5,
      );
      op.status = outcome;
      op.updated_at = now();
      addEvent(ledger, request, "publish_branch_resolved", op.target_id, {
        operation_id: op.id,
        outcome,
        fact_id: op.receipt_fact_id,
      });
      return { operation_id: op.id, outcome };
    }
    case "publish-pr-claim": {
      const targetType = z.enum(["group", "task"]).parse(payload.target_type);
      const targetId = parse(id, payload.target_id);
      requireOwner(ledger, request, targetType, targetId);
      requireDevelopmentTarget(ledger, targetType, targetId);
      requireLifecycle(ledger, targetType, targetId, "workspace_ready");
      const target = lifecycleTarget(ledger, targetType, targetId) as any;
      const mergedContinuation =
        targetType === "group" && isMergedGroupContinuation(ledger, target);
      const branch = string(payload.branch);
      const headSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.expected_head_sha);
      requireCondition(
        targetType === "group"
          ? target.state === "active" || mergedContinuation
          : taskExecutionState(target) === "running",
        "TARGET_NOT_ACTIVE",
        "Publication target is not active",
        4,
      );
      if (targetType === "group")
        requireCondition(
          target.cut_sha === null,
          "GROUP_CUT",
          "A cut delivery unit cannot publish a new PR",
          4,
        );
      const baseSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.expected_base_sha);
      requireCondition(
        branchReceipt(ledger, targetId, branch, headSha),
        "BRANCH_NOT_PUBLISHED",
        "A successful provider branch receipt is required before PR publication",
        4,
      );
      requireCondition(
        targetType === "group" ? target.current_sha === headSha : target.base_sha === baseSha,
        "BASE_CHANGED",
        "PR publication does not match the current branch lineage",
        5,
      );
      const pr = parse(externalRef, payload.pr);
      checkPR(ledger, pr);
      if (mergedContinuation)
        requireCondition(
          payload.target_branch === ledger.repository.target_branch,
          "TARGET_MISMATCH",
          "A post-merge continuation PR must target the repository branch",
          3,
        );
      exactApprovedAction(
        ledger,
        parse(id, payload.action_id),
        "publish_pr",
        targetType,
        targetId,
        `pr:${pr.id}`,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "publish_pr" && item.target_id === targetId && activeOperation(item),
        ),
        "OPERATION_PENDING",
        "PR publication is already pending",
        4,
      );
      requireCondition(
        targetType !== "group" ||
          !ledger.operations.some(
            (item) => item.kind === "merge" && item.target_id === targetId && activeOperation(item),
          ),
        "MERGE_PENDING",
        "A merge into this group is already pending",
        4,
      );
      const op = addOperation(ledger, request, "publish_pr", targetId, headSha);
      op.request.target_type = targetType;
      op.request.branch = branch;
      op.request.pr = pr;
      op.request.target_branch = string(payload.target_branch);
      op.request.expected_base_sha = baseSha;
      op.request.expected_head_sha = headSha;
      op.request.action_id = payload.action_id;
      op.request.continuation = mergedContinuation;
      addEvent(ledger, request, "publish_pr_claimed", targetId, {
        operation_id: op.id,
        target_type: targetType,
        branch,
        pr,
        target_branch: op.request.target_branch,
        expected_base_sha: baseSha,
        expected_head_sha: headSha,
      });
      return { operation_id: op.id };
    }
    case "publish-pr-resolve": {
      const op = find(
        ledger.operations,
        (item) => item.id === string(payload.operation_id) && item.kind === "publish_pr",
        "PR publication",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "PR publication claim is not active or belongs to another actor",
        3,
      );
      const outcome = z.enum(["succeeded", "failed", "unknown"]).parse(payload.outcome);
      if (outcome === "succeeded") {
        const receipt = providerReceipt.parse(
          payload.provider_receipt ?? payload.provider_observation,
        );
        const requestedPr = parse(externalRef, op.request.pr);
        requireCondition(
          receipt.provider === ledger.repository.provider &&
            receipt.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
            receipt.resource_type === "pr" &&
            receipt.resource_id === requestedPr.id &&
            receipt.pr &&
            stable(receipt.pr) === stable(requestedPr) &&
            receipt.branch === op.request.branch &&
            receipt.target_branch === op.request.target_branch &&
            receipt.base_sha === op.request.expected_base_sha &&
            receipt.head_sha === op.request.expected_head_sha &&
            receipt.state === "open",
          "EVIDENCE_MISMATCH",
          "Provider PR receipt does not match the claim",
          5,
        );
        const observed = fact.parse({
          id: parse(id, payload.fact_id),
          kind: "pr_published",
          subject_id: op.target_id,
          status: "passed",
          source: receipt.provider,
          observed_at: now(),
          sha: receipt.head_sha,
          evidence_ref: receipt.evidence_ref,
          receipt,
          ...(op.request.continuation === true ? { continuation: true } : {}),
        });
        ledger.facts.push(observed);
        op.receipt_fact_id = observed.id;
        const targetType = z.enum(["group", "task"]).parse(op.request.target_type);
        const target = lifecycleTarget(ledger, targetType, op.target_id) as any;
        requireCondition(
          (targetType === "group" ? target.current_sha : target.base_sha) ===
            (targetType === "group" ? op.request.expected_head_sha : op.request.expected_base_sha),
          "BASE_CHANGED",
          "PR lineage changed while publication was pending",
          5,
        );
        if (targetType === "group") {
          if (ledger.contract_version < 3) target.parent_pr = receipt.pr;
          else if (op.request.continuation === true)
            requireCondition(
              target.state === "merged",
              "GROUP_STATE_CHANGED",
              "Post-merge continuation publication cannot change the delivery-unit state",
              5,
            );
          else
            target.pr = {
              state: "published",
              pr: receipt.pr,
              parent_branch: op.request.branch,
            };
        } else {
          requireCondition(
            typeof target.branch === "string" &&
              target.branch.length > 0 &&
              typeof op.request.target_branch === "string" &&
              op.request.target_branch.length > 0,
            "TASK_PR_BINDING_INCOMPLETE",
            "Task PR publication requires task branch and base branch facts",
            4,
          );
          target.pr =
            ledger.contract_version < 3
              ? receipt.pr
              : {
                  state: "open",
                  pr: receipt.pr,
                  branch: target.branch,
                  base_branch: op.request.target_branch,
                };
        }
        target.lifecycle.pr_created = "passed";
      } else {
        const receipt = providerReceipt.parse(
          payload.provider_receipt ?? payload.provider_observation,
        );
        const requestedPr = parse(externalRef, op.request.pr);
        requireCondition(
          receipt.provider === ledger.repository.provider &&
            receipt.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
            receipt.resource_type === "pr" &&
            receipt.resource_id === requestedPr.id &&
            receipt.branch === op.request.branch &&
            receipt.target_branch === op.request.target_branch &&
            receipt.state === (outcome === "failed" ? "absent" : "unknown") &&
            receipt.head_sha === null &&
            (!receipt.pr || stable(receipt.pr) === stable(requestedPr)),
          "EVIDENCE_MISMATCH",
          "Provider PR observation does not match the claim",
          5,
        );
        const observed = fact.parse({
          id: parse(id, payload.fact_id),
          kind: "pr_published",
          subject_id: op.target_id,
          status: outcome,
          source: receipt.provider,
          observed_at: now(),
          sha: null,
          evidence_ref: receipt.evidence_ref,
          receipt,
        });
        ledger.facts.push(observed);
        op.receipt_fact_id = observed.id;
        const targetType = z.enum(["group", "task"]).parse(op.request.target_type);
        const target = lifecycleTarget(ledger, targetType, op.target_id) as any;
        target.lifecycle.pr_created = outcome === "unknown" ? "unknown" : "blocked";
      }
      requireCondition(
        outcome !== "failed" || payload.verified_no_effect === true,
        "EVIDENCE_REQUIRED",
        "Failed publication requires verified no-effect evidence",
        5,
      );
      op.status = outcome;
      op.updated_at = now();
      addEvent(ledger, request, "publish_pr_resolved", op.target_id, {
        operation_id: op.id,
        outcome,
        fact_id: op.receipt_fact_id,
      });
      return { operation_id: op.id, outcome };
    }

    default:
      return undefined;
  }
}
