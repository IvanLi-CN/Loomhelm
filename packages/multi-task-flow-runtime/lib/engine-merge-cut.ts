import { z } from "zod";
import { requireCondition } from "../lib/errors";
import {
  cutEvidence,
  defaultGroupAtoms,
  externalRef,
  fact,
  group,
  id,
  isContributionKind,
} from "../lib/schema";
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
  protectedActionTargetDigest,
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
  deliveryUnitOriginalParentMergeSha,
  isMergedGroupContinuation,
  requireHandoffAcknowledged,
  requireGroupDispatchGate,
  ownerOfTask,
  taskExecutionState,
  taskMergePrerequisitesComplete,
  completeTaskLifecycleAtom,
  taskRuntimeState,
  taskBoundary,
  hasTaskStarted,
  groupRuntimeState,
  validateRevisionReason,
  groupBaseReconciliation,
} = support;

export const mergeCutCommands = ["merge-claim", "merge-resolve", "cut-claim", "cut-apply"] as const;

export function executeMergeCutCommand(context: CommandContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "merge-claim": {
      authorizedAction(ledger, "merge");
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      const mode = z
        .enum(["child", "parent", "parent-followup", "follow"])
        .default("child")
        .parse(payload.mode);
      const pr = parse(externalRef, payload.pr);
      checkPR(ledger, pr);
      const headSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.expected_head_sha);
      const expectedSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.expected_base_sha);
      let targetBranch: string | null = owner.parent_branch;
      let originalParentPr: z.infer<typeof externalRef> | null = null;
      let originalParentMergeSha: string | null = null;
      if (mode === "child") {
        const taskId = parse(id, payload.task_id);
        ownerOfTask(ledger, request, taskId);
        const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
        requireCondition(
          target.group_id === groupId &&
            isContributionKind(target.kind) &&
            taskExecutionState(target) === "running" &&
            target.pr,
          "TASK_MISMATCH",
          "Active contribution task must belong to the target delivery unit",
          3,
        );
        requireCondition(
          taskMergePrerequisitesComplete(ledger, target),
          "ATOMS_PENDING",
          "Complete the task's pre-merge atoms before merging",
          4,
        );
        requireCondition(
          stable(taskPrRef(target)) === stable(pr),
          "PR_MISMATCH",
          "Merge PR differs from the registered child PR",
          3,
        );
        requireCondition(
          legacyLedger(ledger) ||
            (target.lifecycle.pr_created === "passed" &&
              prReceipt(ledger, taskId, pr, expectedSha, headSha)),
          "PR_NOT_READY",
          "Child PR must be provider-published before merge",
          4,
        );
        requireCondition(
          target.base_sha === owner.current_sha &&
            ledger.facts.some(
              (item) =>
                item.kind === "task_quality" &&
                item.subject_id === taskId &&
                item.status === "passed" &&
                item.sha === headSha &&
                item.source === target.thread_id &&
                item.quality?.task_id === taskId &&
                item.quality.thread_id === target.thread_id &&
                item.quality.base_sha === owner.current_sha &&
                item.quality.head_sha === headSha &&
                stable(item.quality.pr) === stable(taskPrRef(target)) &&
                ledger.events.some(
                  (event) =>
                    event.type === "fact_observed" &&
                    event.data.fact_id === item.id &&
                    event.data.base_sha === owner.current_sha,
                ),
            ),
          "QUALITY_REQUIRED",
          "Task Agent quality proof for the exact child head and current parent base is required",
          4,
        );
        requireCondition(
          !ledger.operations.some(
            (item) =>
              item.target_id === taskId &&
              ["publish_branch", "publish_pr"].includes(item.kind) &&
              activeOperation(item),
          ),
          "PUBLICATION_PENDING",
          "Task publication is still pending",
          4,
        );
      } else if (mode === "parent" || mode === "parent-followup") {
        requireCondition(
          ownsGroup(ledger, request.actor, owner),
          "FORBIDDEN",
          "The Delivery coordinator owns parent PR integration",
          3,
        );
        const mergedContinuation = isMergedGroupContinuation(ledger, owner);
        requireCondition(
          mode === "parent-followup"
            ? ledger.contract_version >= 3 && mergedContinuation
            : owner.state === "active",
          "GROUP_NOT_ACTIVE",
          "Only an active parent merge or an approved post-merge continuation can merge this PR",
          4,
        );
        if (mode === "parent") {
          requireCondition(
            deliveryUnitPr(owner) &&
              stable(deliveryUnitPr(owner)) === stable(pr) &&
              owner.current_sha === headSha,
            "PR_MISMATCH",
            "Parent PR and current head must match",
            3,
          );
        } else {
          originalParentPr = parse(externalRef, payload.original_parent_pr);
          requireCondition(
            deliveryUnitPr(owner) && stable(deliveryUnitPr(owner)) === stable(originalParentPr),
            "PR_MISMATCH",
            "Follow-up merge must identify the registered parent PR",
            3,
          );
          requireCondition(
            pr.id !== originalParentPr.id &&
              pr.provider === ledger.repository.provider &&
              pr.repository === `${ledger.repository.owner}/${ledger.repository.name}`,
            "PR_MISMATCH",
            "Follow-up merge must identify a distinct PR in the bound repository",
            3,
          );
          originalParentMergeSha = z
            .string()
            .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
            .parse(payload.original_parent_merge_sha);
          if (ledger.contract_version >= 3)
            requireCondition(
              mergedContinuation &&
                originalParentMergeSha === deliveryUnitOriginalParentMergeSha(ledger, owner),
              "EVIDENCE_REQUIRED",
              "Follow-up merge must retain the verified original parent merge SHA",
              5,
            );
          requireCondition(
            ledger.contract_version < 3 || owner.current_sha === headSha,
            "BASE_CHANGED",
            "Follow-up PR head must match the current delivery-unit branch",
            5,
          );
        }
        if (mode === "parent")
          requireCondition(
            legacyLedger(ledger) ||
              (owner.lifecycle.pr_created === "passed" &&
                prReceipt(ledger, groupId, pr, expectedSha, headSha)),
            "PR_NOT_READY",
            "Parent PR must be provider-published before merge",
            4,
          );
        if (mode === "parent-followup")
          requireCondition(
            ledger.contract_version < 3 ||
              (owner.lifecycle.pr_created === "passed" &&
                prReceipt(ledger, groupId, pr, expectedSha, headSha, "open")),
            "PR_NOT_READY",
            "Follow-up PR must be provider-published before merge",
            4,
          );
        requireCondition(
          ledger.tasks
            .filter((item) => item.group_id === groupId && isContributionKind(item.kind))
            .every(
              (item) =>
                ["integrated", "closed"].includes(item.state) ||
                (item.execution_owner === "main" &&
                  item.conversation_policy === "main_owned" &&
                  item.state === "running" &&
                  item.atoms.every((atom) => atom.status === "completed")),
            ),
          "TASKS_PENDING",
          "Contribution tasks are not integrated",
          4,
        );
        requireCondition(
          !ledger.follow_prs.some(
            (item) => item.origin_group_id === groupId && item.state !== "merged",
          ),
          "FOLLOW_PR_PENDING",
          "Known follow PRs must merge first",
          4,
        );
        targetBranch = ledger.repository.target_branch;
      } else {
        const follow = find(
          ledger.follow_prs,
          (item) => item.id === string(payload.follow_pr_id) && item.origin_group_id === groupId,
          "Follow PR",
        );
        requireCondition(
          follow.state === "open" && stable(follow.pr) === stable(pr),
          "PR_MISMATCH",
          "Follow PR must match an open recorded PR",
          3,
        );
        const expectedTarget =
          owner.state === "merged" || owner.state === "closed"
            ? ledger.repository.target_branch
            : owner.parent_branch;
        requireCondition(
          follow.target_branch === expectedTarget,
          "TARGET_MISMATCH",
          "Follow PR target must be reconciled with the current group state",
          3,
        );
        if (request.actor.role === "task")
          requireCondition(
            ledger.tasks.some(
              (item) =>
                item.id === follow.origin_task_id && item.thread_id === request.actor.thread_id,
            ),
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
        targetBranch = follow.target_branch;
      }
      requireCondition(
        targetBranch && targetBranch === payload.target_branch,
        "TARGET_MISMATCH",
        "PR target does not match its assigned branch",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) => item.kind === "cut" && item.target_id === groupId && activeOperation(item),
        ),
        "CUT_PENDING",
        "The parent branch is being cut",
        4,
      );
      requireCondition(
        !publicationPendingForGroup(ledger, groupId),
        "PUBLICATION_PENDING",
        "Publication is still pending for this group",
        4,
      );
      requireCondition(
        !ledger.operations.some(
          (item) => item.kind === "merge" && item.target_id === groupId && activeOperation(item),
        ),
        "MERGE_PENDING",
        "A merge into this group is already pending",
        4,
      );
      if (targetBranch === owner.parent_branch)
        requireCondition(
          owner.current_sha === expectedSha,
          "BASE_CHANGED",
          "Parent SHA differs from the claimed base",
          3,
        );
      if (mode === "parent" || mode === "parent-followup") {
        const ownerApprovalId = string(payload.owner_approval_id);
        const ownerApprovalTargetDigest =
          mode === "parent-followup"
            ? protectedActionTargetDigest({
                kind: "delivery_unit_merge",
                mode,
                group_id: groupId,
                pr,
                expected_head_sha: headSha,
                expected_base_sha: expectedSha,
                target_branch: targetBranch,
                original_parent_pr: originalParentPr,
                original_parent_merge_sha: originalParentMergeSha,
              })
            : null;
        protectedActionApproved(
          ledger,
          "delivery_unit_merge",
          groupId,
          ownerApprovalId,
          ownerApprovalTargetDigest,
        );
      }
      const op = addOperation(ledger, request, "merge", groupId, expectedSha);
      op.request.mode = mode;
      if (mode === "parent-followup")
        op.request.owner_approval_target_digest = protectedActionTargetDigest({
          kind: "delivery_unit_merge",
          mode,
          group_id: groupId,
          pr,
          expected_head_sha: headSha,
          expected_base_sha: expectedSha,
          target_branch: targetBranch,
          original_parent_pr: originalParentPr,
          original_parent_merge_sha: originalParentMergeSha,
        });
      addEvent(ledger, request, "merge_claimed", groupId, {
        operation_id: op.id,
      });
      return { operation_id: op.id };
    }
    case "merge-resolve": {
      const op = find(
        ledger.operations,
        (item) => item.id === string(payload.operation_id) && item.kind === "merge",
        "Merge",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "Merge claim is not active or belongs to another actor",
        3,
      );
      const outcome = z.enum(["succeeded", "failed", "unknown"]).parse(payload.outcome);
      if (outcome === "succeeded") {
        const evidence = parse(fact, payload.provider_evidence);
        requireCondition(
          evidence.kind === "pr_merged" &&
            evidence.status === "passed" &&
            evidence.sha &&
            evidence.evidence_ref,
          "EVIDENCE_REQUIRED",
          "Verified merge fact and SHA required",
          5,
        );
        const observation = z
          .object({
            pr: externalRef,
            head_sha: z.string(),
            base_sha: z.string(),
            merge_sha: z.string(),
            state: z.literal("merged"),
          })
          .strict()
          .parse(payload.provider_observation);
        requireCondition(
          stable(observation.pr) === stable(op.request.pr) &&
            observation.head_sha === op.request.expected_head_sha &&
            observation.base_sha === op.expected_sha &&
            observation.merge_sha === evidence.sha,
          "EVIDENCE_MISMATCH",
          "Provider observation does not match the merge claim",
          5,
        );
        if (ledger.contract_version >= 3 && op.request.mode === "child") {
          const receipt = evidence.receipt;
          const childTask = find(ledger.tasks, (item) => item.id === op.request.task_id, "Task");
          requireCondition(
            receipt !== null &&
              receipt !== undefined &&
              evidence.source === ledger.repository.provider &&
              receipt.provider === ledger.repository.provider &&
              receipt.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
              receipt.resource_type === "pr" &&
              receipt.resource_id === op.request.pr.id &&
              receipt.pr !== null &&
              stable(receipt.pr) === stable(op.request.pr) &&
              receipt.state === "merged" &&
              receipt.branch === childTask.branch &&
              receipt.target_branch === op.request.target_branch &&
              receipt.base_sha === op.expected_sha &&
              receipt.head_sha === op.request.expected_head_sha &&
              receipt.merge_sha === evidence.sha &&
              receipt.evidence_ref === evidence.evidence_ref,
            "EVIDENCE_MISMATCH",
            "Provider merge receipt does not match the configured repository and merge claim",
            5,
          );
        }
        if (ledger.contract_version >= 3 && op.request.mode === "parent-followup") {
          const receipt = evidence.receipt;
          const followUpOwner = find(ledger.groups, (item) => item.id === op.target_id, "Group");
          requireCondition(
            receipt !== null &&
              receipt !== undefined &&
              evidence.source === ledger.repository.provider &&
              receipt.provider === ledger.repository.provider &&
              receipt.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
              receipt.resource_type === "pr" &&
              receipt.resource_id === op.request.pr.id &&
              receipt.pr !== null &&
              stable(receipt.pr) === stable(op.request.pr) &&
              receipt.state === "merged" &&
              receipt.branch === followUpOwner.parent_branch &&
              receipt.target_branch === op.request.target_branch &&
              receipt.base_sha === op.expected_sha &&
              receipt.head_sha === op.request.expected_head_sha &&
              receipt.merge_sha === evidence.sha &&
              receipt.evidence_ref === evidence.evidence_ref,
            "EVIDENCE_MISMATCH",
            "Provider follow-up merge receipt does not match the configured repository and merge claim",
            5,
          );
        }
        const owner = find(ledger.groups, (item) => item.id === op.target_id, "Group");
        if (op.request.target_branch === owner.parent_branch)
          requireCondition(
            owner.current_sha === op.expected_sha,
            "BASE_CHANGED",
            "Parent SHA changed while merge was pending",
            3,
          );
        const subject =
          op.request.mode === "parent" || op.request.mode === "parent-followup"
            ? owner.id
            : op.request.mode === "follow"
              ? op.request.follow_pr_id
              : op.request.task_id;
        requireCondition(
          evidence.subject_id === subject,
          "EVIDENCE_MISMATCH",
          "Merge fact does not match the claimed PR",
          5,
        );
        if (op.request.mode === "parent" || op.request.mode === "parent-followup") {
          requireCondition(
            !ledger.follow_prs.some(
              (item) => item.origin_group_id === owner.id && item.state !== "merged",
            ),
            "FOLLOW_PR_PENDING",
            "Known follow PRs must merge first",
            4,
          );
          owner.state = "merged";
          if (op.request.mode === "parent-followup")
            owner.current_sha = op.request.expected_head_sha;
          if (op.request.mode === "parent") {
            if (ledger.contract_version < 3) owner.parent_pr = op.request.pr;
            else
              owner.pr = {
                state: "merged",
                pr: op.request.pr,
                parent_branch: owner.parent_branch,
                merge_sha: evidence.sha,
              };
          }
          owner.merge_sha = evidence.sha;
          if (owner.lifecycle && !legacyLedger(ledger)) owner.lifecycle.pr_merged = "passed";
          for (const task of ledger.tasks.filter(
            (item) =>
              item.group_id === owner.id &&
              item.execution_owner === "main" &&
              item.conversation_policy === "main_owned" &&
              item.state === "running",
          )) {
            task.state = "integrated";
            task.finished_at = evidence.observed_at;
          }
        } else if (op.request.mode === "follow") {
          const follow = find(ledger.follow_prs, (item) => item.id === subject, "Follow PR");
          follow.state = "merged";
          follow.merge_fact_id = evidence.id;
          if (op.request.target_branch === owner.parent_branch) owner.current_sha = evidence.sha;
        } else {
          const target = find(ledger.tasks, (item) => item.id === subject, "Task");
          owner.current_sha = evidence.sha;
          target.state = "integrated";
          if (!legacyLedger(ledger)) {
            const owner = find(
              ledger.groups,
              (item) => item.id === target.group_id,
              "DeliveryUnit",
            );
            target.pr =
              ledger.contract_version < 3
                ? op.request.pr
                : {
                    state: "merged",
                    pr: op.request.pr,
                    branch: target.branch,
                    merge_sha: evidence.sha,
                  };
            if (owner.pr?.state === "published") owner.pr = { ...owner.pr };
          }
          target.finished_at = evidence.observed_at;
          if (target.lifecycle && !legacyLedger(ledger)) target.lifecycle.pr_merged = "passed";
        }
        ledger.facts.push(evidence);
        if (op.request.mode === "child") {
          const target = find(ledger.tasks, (item) => item.id === op.request.task_id, "Task");
          completeTaskLifecycleAtom(ledger, request, target, "pr_merged", {
            fact_id: evidence.id,
            evidence_ref: evidence.evidence_ref,
            occurred_at: evidence.observed_at,
          });
        }
        op.receipt_fact_id = evidence.id;
      } else if (outcome === "failed") {
        const observation = z
          .object({
            pr: externalRef,
            state: z.enum(["open", "closed"]),
            verified_no_merge: z.literal(true),
            evidence_ref: z.string().min(1),
          })
          .strict()
          .parse(payload.provider_observation);
        requireCondition(
          stable(observation.pr) === stable(op.request.pr),
          "EVIDENCE_MISMATCH",
          "Failure observation must identify the claimed PR",
          5,
        );
      }
      op.status = outcome;
      op.updated_at = now();
      const observedAt = op.receipt_fact_id
        ? (ledger.facts.find((item) => item.id === op.receipt_fact_id)?.observed_at ?? null)
        : null;
      addEvent(
        ledger,
        request,
        "merge_resolved",
        op.target_id,
        {
          operation_id: op.id,
          task_id: op.request.task_id ?? null,
          outcome,
          fact_id: op.receipt_fact_id,
          group_snapshot: structuredClone(ledger.groups.find((item) => item.id === op.target_id)!),
        },
        observedAt,
      );
      const directive = notificationDirective(ledger, request, payload, outcome === "succeeded");
      const notice = directive.enabled
        ? addNotificationIntent(ledger, request, directive.recipient_thread_id!)
        : null;
      return {
        operation_id: op.id,
        outcome,
        notification_id: notice?.id ?? null,
        notification_status: notice?.delivery_status ?? "none",
        notification_request: notificationDeliveryRequest(notice),
      };
    }
    case "cut-claim": {
      onlyMain(request.actor);
      authorizedAction(ledger, "cut");
      const current = currentPlan();
      const owner = find(ledger.groups, (item) => item.id === string(payload.group_id), "Group");
      requireCondition(
        owner.state === "active" && owner.current_sha,
        "GROUP_NOT_READY",
        "Only an active group with a known parent SHA can be cut",
        4,
      );
      requireCondition(
        !publicationPendingForGroup(ledger, owner.id),
        "PUBLICATION_PENDING",
        "Publication is still pending for this group",
        4,
      );
      const rule = find(
        current.cut_rules,
        (item) =>
          item.id === string(payload.rule_id) &&
          currentRuleGroup(ledger, item.group_id) === owner.id,
        "Cut rule",
      );
      requireCondition(
        rule.status === "pending",
        "CUT_ALREADY_CLAIMED",
        "Cut rule is not pending",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "cut" && item.request.rule_id === rule.id && item.status === "succeeded",
        ),
        "CUT_ALREADY_APPLIED",
        "Cut rule was already applied",
        3,
      );
      requireCondition(
        !current.cut_rules.some(
          (item) =>
            item.group_id === rule.group_id &&
            item.priority < rule.priority &&
            item.status !== "cancelled" &&
            !ledger.operations.some(
              (op) =>
                op.kind === "cut" && op.request.rule_id === item.id && op.status === "succeeded",
            ),
        ),
        "CUT_ORDER",
        "An earlier cut rule has not completed",
        4,
      );
      requireCondition(
        rule.required_task_ids.every((taskId) =>
          ledger.tasks.some(
            (item) =>
              item.id === taskId &&
              item.group_id === owner.id &&
              ["integrated", "completed", "closed"].includes(item.state),
          ),
        ),
        "CUT_NOT_READY",
        "Cut requirements are not satisfied in this group",
        4,
      );
      requireCondition(
        !ledger.operations.some(
          (item) => item.kind === "cut" && item.target_id === owner.id && activeOperation(item),
        ),
        "CUT_PENDING",
        "Cut already pending",
        4,
      );
      const op = addOperation(ledger, request, "cut", owner.id, owner.current_sha);
      const drained = !ledger.operations.some(
        (item) => item.kind === "merge" && item.target_id === owner.id && activeOperation(item),
      );
      addEvent(ledger, request, "cut_claimed", owner.id, {
        operation_id: op.id,
        group_id: owner.id,
        rule_id: rule.id,
        expected_sha: op.expected_sha,
        drained,
      });
      return { operation_id: op.id, drained };
    }
    case "cut-apply": {
      onlyMain(request.actor);
      const current = currentPlan();
      const op = find(
        ledger.operations,
        (item) =>
          item.id === string(payload.operation_id) && item.kind === "cut" && activeOperation(item),
        "Cut",
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "merge" && item.target_id === op.target_id && activeOperation(item),
        ),
        "MERGE_PENDING",
        "Resolve pending merges before cutting",
        4,
      );
      const owner = find(ledger.groups, (item) => item.id === op.target_id, "Group");
      requireCondition(
        !publicationPendingForGroup(ledger, owner.id),
        "PUBLICATION_PENDING",
        "Publication is still pending for this group",
        4,
      );
      requireCondition(
        owner.state === "active",
        "GROUP_NOT_READY",
        "A merged group cannot be cut",
        4,
      );
      const cutSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.cut_sha);
      const evidence = parse(cutEvidence, payload.provider_evidence);
      requireCondition(
        owner.current_sha === cutSha && evidence.sha === cutSha,
        "BASE_CHANGED",
        "Cut SHA needs current platform evidence",
        5,
      );
      const next = parse(group, payload.next_group);
      requireCondition(
        next.delivery_unit_kind === "regular" && next.owner_kind === "group",
        "INVALID_NEXT_GROUP",
        "Bootstrap can only be created during run initialization",
        3,
      );
      if (next.atoms.length === 0) next.atoms = defaultGroupAtoms(next.id);
      requireCondition(
        !ledger.groups.some((item) => item.id === next.id),
        "GROUP_EXISTS",
        "Next group already exists",
        3,
      );
      requireCondition(
        next.state === "planned" &&
          next.agent_thread_id === null &&
          next.parent_branch === null &&
          next.parent_pr === null &&
          next.current_sha === null &&
          next.merge_sha === null &&
          next.cut_sha === null &&
          next.requirements_path === null &&
          next.atoms.every((atom) => atom.status === "planned") &&
          next.coordination_execution.state === "unknown" &&
          next.coordination_execution.reason === null &&
          next.coordination_execution.waiting_for_task_ids.length === 0 &&
          Object.values(next.lifecycle).every((stage) => stage === "unknown"),
        "INVALID_NEXT_GROUP",
        "Next group must not have pre-existing runtime identities",
        3,
      );
      const rule = find(current.cut_rules, (item) => item.id === op.request.rule_id, "Cut rule");
      const integrated = ledger.tasks.filter(
        (item) =>
          item.group_id === owner.id &&
          isContributionKind(item.kind) &&
          ["integrated", "closed"].includes(item.state),
      );
      const included = z.array(id).parse(payload.included_task_ids);
      requireCondition(
        stable([...included].sort()) === stable(integrated.map((item) => item.id).sort()),
        "CUT_SCOPE_MISMATCH",
        "Included tasks differ from current integrated tasks",
        3,
      );
      const taskSnapshots = ledger.tasks
        .filter((item) => item.group_id === owner.id && isContributionKind(item.kind))
        .map((item) => structuredClone(item));
      const reassigned = ledger.tasks.filter(
        (item) =>
          item.group_id === owner.id &&
          isContributionKind(item.kind) &&
          !["integrated", "completed", "closed"].includes(item.state),
      );
      for (const item of reassigned) {
        item.group_id = next.id;
        item.assignment_history.push({
          group_id: next.id,
          effective_at: now(),
          reason: "dynamic cut",
          cut_operation_id: op.id,
        });
      }
      owner.cut_sha = cutSha;
      ledger.groups.push(next);
      rule.status = "applied";
      op.expected_sha = cutSha;
      op.status = "succeeded";
      op.updated_at = now();
      addEvent(ledger, request, "cut_applied", owner.id, {
        operation_id: op.id,
        cut_sha: cutSha,
        cut_evidence: evidence,
        old_group_id: owner.id,
        old_group_current_sha: cutSha,
        old_group_snapshot: structuredClone(owner),
        new_group_id: next.id,
        new_group_state: next.state,
        new_group_agent_thread_id: next.agent_thread_id,
        new_group_parent_branch: next.parent_branch,
        new_group_parent_pr: next.parent_pr,
        new_group_cut_sha: next.cut_sha,
        new_group_current_sha: next.current_sha,
        new_group_merge_sha: next.merge_sha,
        new_group_requirements_path: next.requirements_path,
        new_group_snapshot: structuredClone(next),
        included_task_ids: included,
        reassigned_task_ids: reassigned.map((item) => item.id),
        task_snapshots: taskSnapshots,
      });
      return {
        operation_id: op.id,
        next_group_id: next.id,
        reassigned_task_ids: reassigned.map((item) => item.id),
      };
    }

    default:
      return undefined;
  }
}
