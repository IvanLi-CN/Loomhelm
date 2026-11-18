import { z } from "zod";
import { lifecycleRoleOf, lifecycleStageOf } from "../lib/atomic-orchestration";
import { requireCondition } from "../lib/errors";
import { externalRef, fact, group, id, isContributionKind, providerReceipt } from "../lib/schema";
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
  atomicNodeSatisfied,
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
  taskCanUpdateAtoms,
  taskMergePrerequisitesComplete,
  completeTaskLifecycleAtom,
  taskRuntimeState,
  taskBoundary,
  hasTaskStarted,
  groupRuntimeState,
  validateRevisionReason,
  groupBaseReconciliation,
} = support;

export const groupLifecycleCommands = [
  "atom-update",
  "group-atom-update",
  "group-execution-update",
  "group-update",
  "group-base",
  "group-base-reconcile",
  "task-external-merge-reconcile",
] as const;

function deliveryUnitAtomDependenciesReady(
  ledger: any,
  plan: any,
  owner: any,
  atom: any,
  index: number,
): boolean {
  const nodes = (plan.atomic_nodes?.length ? plan.atomic_nodes : ledger.atomic_nodes) ?? [];
  const edgeSource = plan.atomic_edges?.some((edge: any) => "from_node_id" in edge)
    ? plan.atomic_edges
    : ledger.atomic_edges;
  const edges = (edgeSource ?? []).filter(
    (edge: any) => "from_node_id" in edge && "to_node_id" in edge,
  );
  const node = nodes.find(
    (candidate: any) =>
      candidate.id === atom.id &&
      candidate.kind === "work" &&
      candidate.scope?.kind === "delivery_unit" &&
      candidate.scope.delivery_unit_id === owner.id,
  );
  if (node)
    return edges
      .filter((edge: any) => edge.to_node_id === node.id)
      .every((edge: any) =>
        atomicNodeSatisfied(
          ledger,
          nodes.find((item: any) => item.id === edge.from_node_id),
        ),
      );
  return owner.atoms.slice(0, index).every((item: any) => item.status === "completed");
}

export function executeGroupLifecycleCommand(context: CommandContext): unknown | undefined {
  const { ledger, command, request, payload, currentPlan } = context;
  switch (command) {
    case "atom-update": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      if (core.isDeliveryVerification(target))
        requireCondition(
          core.ownsDeliveryVerification(ledger, target, request.actor),
          "FORBIDDEN",
          "Only the bound delivery agent owns verification",
          3,
        );
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
      requireCondition(
        (request.actor.role === "task" ||
          mainOwned ||
          sharedOwned ||
          core.ownsDeliveryVerification(ledger, target, request.actor)) &&
          taskCanUpdateAtoms(ledger, target),
        "FORBIDDEN",
        "The task owner updates atoms while execution is active or completing closeout",
        3,
      );
      const index = target.atoms.findIndex((item) => item.id === parse(id, payload.atom_id));
      requireCondition(index >= 0, "NOT_FOUND", "Atom not found");
      const atom = target.atoms[index]!;
      const state = z.enum(["running", "blocked", "completed"]).parse(payload.state);
      requireCondition(
        ledger.contract_version >= 6
          ? core.atomicPredecessorsPending(ledger, executionPlan(ledger), atom.id).length === 0
          : target.atoms.slice(0, index).every((item) => item.status === "completed"),
        "ATOMS_PENDING",
        "Earlier atoms must complete first",
        4,
      );
      requireCondition(
        !(
          ledger.contract_version >= 3 &&
          lifecycleStageOf(atom) === "pr_merged" &&
          state === "completed"
        ),
        "EVIDENCE_REQUIRED",
        "The task merge atom is completed by provider merge evidence",
        5,
      );
      const allowed: Record<string, string[]> = {
        planned: ["running"],
        running: ["blocked", "completed"],
        blocked: ["running"],
      };
      requireCondition(
        allowed[atom.status]?.includes(state),
        "INVALID_TRANSITION",
        "Invalid atom transition",
        3,
      );
      atom.status = state;
      addEvent(ledger, request, "atom_updated", taskId, {
        task_id: taskId,
        atom_id: atom.id,
        state,
      });
      return { task_id: taskId, atom_id: atom.id, state };
    }
    case "group-atom-update": {
      currentPlan();
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        (request.actor.role === "main" &&
          request.actor.thread_id === ledger.control.owner_thread_id) ||
          (request.actor.role === "group" && owner.agent_thread_id === request.actor.thread_id),
        "FORBIDDEN",
        "Only the Delivery coordinator or main conversation can update delivery-unit atoms",
        3,
      );
      requireCondition(
        owner.state !== "closed",
        "GROUP_CLOSED",
        "Closed delivery units cannot update atoms",
        3,
      );
      if (ledger.active_plan_id !== ledger.execution_plan_id)
        requireCondition(
          stable(activePlan(ledger).group_atoms.filter((atom) => atom.group_id === groupId)) ===
            stable(executionPlan(ledger).group_atoms.filter((atom) => atom.group_id === groupId)),
          "PLAN_REVISION_PENDING",
          "Delivery-unit atom changes await plan approval",
          4,
        );
      const atom = find(
        owner.atoms,
        (item) => item.id === parse(id, payload.atom_id),
        "Delivery-unit atom",
      );
      const index = owner.atoms.indexOf(atom);
      const state = z.enum(["running", "blocked", "completed"]).parse(payload.state);
      requireCondition(
        ledger.contract_version >= 6
          ? core.atomicPredecessorsPending(ledger, executionPlan(ledger), atom.id).length === 0
          : deliveryUnitAtomDependenciesReady(ledger, currentPlan(), owner, atom, index),
        "ATOMS_PENDING",
        "Earlier delivery-unit atoms must complete first",
        4,
      );
      if (lifecycleRoleOf({ ...atom, group_id: groupId }) === "integrate")
        requireCondition(
          ledger.tasks
            .filter(
              (task) =>
                task.group_id === groupId &&
                task.disposition === "active" &&
                isContributionKind(task.kind),
            )
            .every((task) => task.atoms.every((item) => item.status === "completed")),
          "ATOMS_PENDING",
          "Contribution task atoms must complete before delivery-unit integration",
          4,
        );
      const allowed: Record<string, string[]> = {
        planned: ["running"],
        running: ["blocked", "completed"],
        blocked: ["running"],
      };
      requireCondition(
        allowed[atom.status]?.includes(state),
        "INVALID_TRANSITION",
        "Invalid delivery-unit atom transition",
        3,
      );
      const lifecycleStage = lifecycleStageOf(atom);
      requireCondition(
        !(state === "completed" && lifecycleStage === "closed"),
        "GROUP_CLOSE_REQUIRED",
        "The closeout atom completes with group-close",
        4,
      );
      if (state === "completed" && lifecycleStage)
        requireCondition(
          legacyLedger(ledger) || owner.lifecycle[lifecycleStage] === "passed",
          "LIFECYCLE_BLOCKED",
          `Delivery-unit lifecycle stage ${lifecycleStage} is not passed`,
          4,
        );
      atom.status = state;
      addEvent(
        ledger,
        request,
        "group_atom_updated",
        groupId,
        {
          group_id: groupId,
          atom_id: atom.id,
          state,
          reason: state === "blocked" ? string(payload.detail) : null,
        },
        payload.occurred_at ? z.iso.datetime({ offset: false }).parse(payload.occurred_at) : null,
      );
      return { group_id: groupId, atom_id: atom.id, state };
    }
    case "group-execution-update": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        (request.actor.role === "main" &&
          request.actor.thread_id === ledger.control.owner_thread_id) ||
          (request.actor.role === "group" && owner.agent_thread_id === request.actor.thread_id),
        "FORBIDDEN",
        "Only the Delivery coordinator or main conversation can update execution state",
        3,
      );
      requireCondition(
        owner.state !== "closed",
        "GROUP_CLOSED",
        "Closed delivery units cannot execute",
        3,
      );
      const state = z
        .enum(["unknown", "idle", "running", "waiting", "blocked"])
        .parse(payload.state);
      requireCondition(
        state === "unknown" || ledger.control.ownership === "bound",
        "CONTROL_OWNERSHIP_UNKNOWN",
        "Runtime execution requires bound orchestration control ownership",
        4,
      );
      requireCondition(
        state === "unknown" ||
          owner.state === "active" ||
          (owner.state === "merged" && state === "idle"),
        "GROUP_NOT_ACTIVE",
        "Only active delivery units can record runtime execution, except merged closeout idle",
        4,
      );
      requireCondition(
        state === "unknown" || owner.delivery_unit_kind === "bootstrap" || !!owner.agent_thread_id,
        "GROUP_NOT_READY",
        "Regular delivery unit requires a bound Delivery coordinator before runtime execution",
        4,
      );
      const cliDispatches = ledger.operations.filter(
        (op) =>
          op.kind === "dispatch" &&
          op.target_id === groupId &&
          op.request.target_type === "group" &&
          (op.request.creation_parameters as any)?.transport === "codex-exec",
      );
      const cliDispatch = cliDispatches.find((op) => op.status === "succeeded");
      if (state === "running" && cliDispatches.length)
        requireCondition(
          owner.lifecycle.workspace_ready === "passed" &&
            !!cliDispatch?.request.development_baseline,
          "BASELINE_REQUIRED",
          "Record verified group workspace baseline before running",
          4,
        );
      if (
        state === "running" &&
        ledger.contract_version >= 3 &&
        owner.delivery_unit_kind === "regular"
      ) {
        requireGroupDispatchGate(ledger, owner);
        requireHandoffAcknowledged(ledger, owner);
      }
      if (
        state === "running" &&
        cliDispatch?.request.development_baseline &&
        ledger.contract_version >= 3
      )
        requireCondition(
          cliDispatch.request.development_baseline.sha === owner.current_sha,
          "BASELINE_NOT_VERIFIED",
          "Group workspace baseline no longer matches the current lineage",
          4,
        );
      const executionTransitions: Record<string, string[]> = {
        unknown: ["unknown", "idle", "running", "waiting", "blocked"],
        idle: ["idle", "running", "waiting", "blocked"],
        running: ["running", "idle", "waiting", "blocked"],
        waiting: ["waiting", "idle", "running", "blocked"],
        blocked: ["blocked", "idle", "running"],
      };
      requireCondition(
        executionTransitions[owner.coordination_execution.state]?.includes(state),
        "INVALID_TRANSITION",
        "Invalid delivery-unit coordination execution transition",
        3,
      );
      const waitingFor = z.array(id).parse(payload.waiting_for_task_ids ?? []);
      requireCondition(
        waitingFor.every((taskId) => {
          const task = ledger.tasks.find((item) => item.id === taskId);
          return task !== undefined && task.group_id === groupId && isContributionKind(task.kind);
        }),
        "INVALID_WAIT_TARGET",
        "Waiting task references must be contribution tasks in the same delivery unit",
        3,
      );
      requireCondition(
        state !== "waiting" ||
          (waitingFor.length > 0 &&
            typeof payload.reason === "string" &&
            payload.reason.length > 0),
        "WAIT_REASON_REQUIRED",
        "Waiting for contribution tasks requires task references and a reason",
        3,
      );
      requireCondition(
        state !== "blocked" || (typeof payload.reason === "string" && payload.reason.length > 0),
        "BLOCK_REASON_REQUIRED",
        "Blocked execution requires a reason",
        3,
      );
      requireCondition(
        !(
          state === "idle" &&
          owner.state === "active" &&
          ledger.tasks.some(
            (task) =>
              task.group_id === groupId &&
              isContributionKind(task.kind) &&
              ["planned", "ready"].includes(task.state) &&
              ready(ledger, task.id) &&
              !task.thread_id,
          )
        ),
        "ACTIVE_GROUP_IDLE",
        "An active delivery unit with a ready contribution task must be running, waiting, or blocked",
        3,
      );
      owner.coordination_execution = {
        state,
        reason:
          payload.reason === null || payload.reason === undefined ? null : string(payload.reason),
        waiting_for_task_ids: waitingFor,
      };
      addEvent(
        ledger,
        request,
        "group_execution_updated",
        groupId,
        {
          group_id: groupId,
          state,
          reason: owner.coordination_execution.reason,
          waiting_for_task_ids: waitingFor,
        },
        payload.occurred_at ? z.iso.datetime({ offset: false }).parse(payload.occurred_at) : null,
      );
      return {
        group_id: groupId,
        coordination_execution: owner.coordination_execution,
      };
    }
    case "group-update": {
      const incoming = parse(group, payload.group);
      if (incoming.parent_pr) checkPR(ledger, incoming.parent_pr);
      const current = find(ledger.groups, (item) => item.id === incoming.id, "Group");
      if (incoming.parent_pr)
        requireCondition(
          legacyLedger(ledger) || prReceipt(ledger, incoming.id, incoming.parent_pr),
          "PR_NOT_PUBLISHED",
          "Parent PR must be bound to a successful provider publication receipt",
          4,
        );
      if (request.actor.role === "group")
        requireCondition(
          current.agent_thread_id === request.actor.thread_id &&
            incoming.agent_thread_id === current.agent_thread_id,
          "FORBIDDEN",
          "Group identity cannot be changed by this actor",
          3,
        );
      else {
        onlyMain(request.actor);
        requireCondition(
          current.delivery_unit_kind === "bootstrap" && current.owner_kind === "main",
          "FORBIDDEN",
          "Main conversation may update only the bootstrap delivery unit",
          3,
        );
      }
      requireCondition(
        incoming.delivery_unit_kind === current.delivery_unit_kind &&
          incoming.owner_kind === current.owner_kind &&
          incoming.agent_thread_id === current.agent_thread_id,
        "IDENTITY_IMMUTABLE",
        "Delivery-unit kind and owner cannot be changed by group-update",
        3,
      );
      requireCondition(
        current.cut_sha === incoming.cut_sha &&
          current.merge_sha === incoming.merge_sha &&
          current.current_sha === incoming.current_sha,
        "EVIDENCE_REQUIRED",
        "Group lineage changes require a verified operation",
        5,
      );
      requireCondition(
        stable(current.parent_branch) === stable(incoming.parent_branch) &&
          stable(current.branch) === stable(incoming.branch) &&
          stable(current.parent_pr) === stable(incoming.parent_pr) &&
          stable(current.pr) === stable(incoming.pr) &&
          stable(current.lifecycle) === stable(incoming.lifecycle),
        "EVIDENCE_REQUIRED",
        "Provider identity and lifecycle changes require a verified publication or merge operation",
        5,
      );
      requireCondition(
        (current.state === "planned" &&
          ["planned", "active", "blocked"].includes(incoming.state)) ||
          (current.state === "active" && ["active", "blocked"].includes(incoming.state)) ||
          (current.state === "blocked" && ["blocked"].includes(incoming.state)),
        "INVALID_TRANSITION",
        "Group merge and closeout require verified operations",
        3,
      );
      requireCondition(
        stable(current.atoms) === stable(incoming.atoms) &&
          stable(current.coordination_execution) === stable(incoming.coordination_execution),
        "GROUP_EXECUTION_SEPARATE",
        "Use delivery-unit atom or execution commands for execution state",
        3,
      );
      requireCondition(
        incoming.state !== "active" ||
          incoming.delivery_unit_kind === "bootstrap" ||
          !!incoming.agent_thread_id,
        "GROUP_NOT_READY",
        "Active regular delivery unit requires a group conversation",
        4,
      );
      requireCondition(
        !(
          incoming.state === "active" &&
          incoming.coordination_execution.state === "idle" &&
          ledger.tasks.some(
            (task) =>
              task.group_id === incoming.id &&
              isContributionKind(task.kind) &&
              ["planned", "ready"].includes(task.state) &&
              ready(ledger, task.id) &&
              !task.thread_id,
          )
        ),
        "ACTIVE_GROUP_IDLE",
        "An active delivery unit with a ready contribution task must be running, waiting, or blocked",
        3,
      );
      Object.assign(current, incoming);
      addEvent(ledger, request, "group_updated", current.id, {
        group_id: current.id,
        state: current.state,
        group_snapshot: structuredClone(current),
      });
      return { group_id: current.id, state: current.state };
    }
    case "group-base": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      if (request.actor.role === "group")
        requireCondition(
          owner.agent_thread_id === request.actor.thread_id,
          "FORBIDDEN",
          "Group belongs to another conversation",
          3,
        );
      else onlyMain(request.actor);
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.target_id === groupId &&
            activeOperation(item) &&
            ["merge", "cut"].includes(item.kind),
        ),
        "OPERATION_PENDING",
        "Group has an unresolved merge or cut",
        4,
      );
      const observation = z
        .object({
          branch: z.string().min(1),
          sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
          source: z.string().min(1),
          evidence_ref: z.string().min(1),
          ancestor_sha: z
            .string()
            .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
            .nullable()
            .optional(),
        })
        .strict()
        .parse(payload.provider_observation);
      requireCondition(
        owner.parent_branch === null || owner.parent_branch === observation.branch,
        "TARGET_MISMATCH",
        "Group parent branch cannot be silently changed",
        3,
      );
      requireCondition(
        owner.current_sha === null || owner.current_sha === observation.sha,
        "BASE_CHANGED",
        "An established group lineage needs explicit reconciliation",
        5,
      );
      const cut = ledger.events.find(
        (event) => event.type === "cut_applied" && event.data.new_group_id === groupId,
      );
      if (cut) {
        const previous = find(
          ledger.groups,
          (item) => item.id === cut.data.old_group_id,
          "Previous group",
        );
        requireCondition(
          previous.merge_sha && ["merged", "closed"].includes(previous.state),
          "PREVIOUS_GROUP_NOT_MERGED",
          "Previous parent PR has not merged",
          4,
        );
        requireCondition(
          observation.ancestor_sha === previous.merge_sha,
          "LINEAGE_MISMATCH",
          "Next group base must include the previous parent merge",
          5,
        );
      }
      owner.parent_branch = observation.branch;
      owner.current_sha = observation.sha;
      addEvent(ledger, request, "group_updated", groupId, {
        group_id: groupId,
        state: owner.state,
        branch: observation.branch,
        sha: observation.sha,
        evidence_ref: observation.evidence_ref,
        group_snapshot: structuredClone(owner),
      });
      return { group_id: groupId, current_sha: owner.current_sha };
    }
    case "group-base-reconcile": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        ownsGroup(ledger, request.actor, owner),
        "FORBIDDEN",
        "Only the bound Delivery coordinator can reconcile its parent branch",
        3,
      );
      requireCondition(
        owner.state === "active",
        "GROUP_NOT_READY",
        "Only an active group can reconcile a parent branch update",
        4,
      );
      requireCondition(
        owner.parent_branch !== null &&
          deliveryUnitPr(owner) !== null &&
          owner.current_sha !== null,
        "GROUP_NOT_READY",
        "Group parent branch, PR, and SHA must already be established",
        4,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.target_id === groupId &&
            activeOperation(item) &&
            ["merge", "cut"].includes(item.kind),
        ),
        "OPERATION_PENDING",
        "Group has an unresolved merge or cut",
        4,
      );
      const observation = parse(groupBaseReconciliation, payload.provider_observation);
      requireCondition(
        observation.source === ledger.repository.provider,
        "EVIDENCE_MISMATCH",
        "Provider evidence source does not match the bound repository",
        5,
      );
      checkPR(ledger, observation.parent_pr);
      requireCondition(
        observation.branch === owner.parent_branch,
        "TARGET_MISMATCH",
        "Reconciliation branch must match the group's parent branch",
        3,
      );
      requireCondition(
        stable(observation.parent_pr) === stable(deliveryUnitPr(owner)),
        "TARGET_MISMATCH",
        "Reconciliation PR must match the group's registered parent PR",
        3,
      );
      requireCondition(
        observation.previous_sha === owner.current_sha,
        "BASE_CHANGED",
        "Reconciliation must start from the ledger's current parent SHA",
        5,
      );
      requireCondition(
        observation.sha !== observation.previous_sha,
        "BASE_UNCHANGED",
        "Reconciliation must advance the parent SHA",
        3,
      );
      owner.current_sha = observation.sha;
      addEvent(ledger, request, "group_base_reconciled", groupId, {
        group_id: groupId,
        operation: observation.operation,
        branch: observation.branch,
        previous_sha: observation.previous_sha,
        sha: observation.sha,
        parent_pr: observation.parent_pr,
        source: observation.source,
        evidence_ref: observation.evidence_ref,
        group_snapshot: structuredClone(owner),
      });
      return {
        group_id: groupId,
        previous_sha: observation.previous_sha,
        current_sha: owner.current_sha,
      };
    }
    case "task-external-merge-reconcile": {
      onlyMain(request.actor);
      const taskId = parse(id, payload.task_id);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
      requireCondition(
        isContributionKind(target.kind),
        "TASK_MISMATCH",
        "Only contribution tasks can be reconciled",
        3,
      );
      requireCondition(
        !isSharedDeliveryTask(ledger, target),
        "SHARED_DELIVERY_UNIT_PR",
        "Shared delivery tasks do not have a child PR to reconcile",
        3,
      );
      requireCondition(owner.state === "active", "GROUP_NOT_READY", "Task group is not active", 4);
      protectedActionApproved(
        ledger,
        "delivery_unit_recovery",
        owner.id,
        string(payload.recovery_approval_id),
      );
      requireCondition(
        ["waiting", "blocked", "running"].includes(target.state),
        "INVALID_TRANSITION",
        "Task is not awaiting external merge reconciliation",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            activeOperation(item) && (item.target_id === taskId || item.target_id === owner.id),
        ),
        "OPERATION_PENDING",
        "Task has an unresolved operation",
        4,
      );
      requireCondition(
        taskMergePrerequisitesComplete(ledger, target),
        "ATOMS_PENDING",
        "Complete the task's pre-merge atoms before recording the merge",
        4,
      );

      const pr = parse(externalRef, payload.pr);
      const observation = providerReceipt.parse(payload.provider_observation);
      requireCondition(
        observation.provider === ledger.repository.provider &&
          observation.repository === `${ledger.repository.owner}/${ledger.repository.name}` &&
          observation.resource_type === "pr" &&
          observation.resource_id === pr.id &&
          observation.pr !== null &&
          stable(observation.pr) === stable(pr) &&
          observation.state === "merged" &&
          observation.base_sha !== null &&
          observation.head_sha !== null &&
          observation.merge_sha !== null &&
          observation.target_branch === owner.parent_branch &&
          observation.evidence_ref.length > 0,
        "EVIDENCE_MISMATCH",
        "Historical merge observation does not match the task PR and target branch",
        5,
      );
      const baseSha = observation.base_sha;
      const headSha = observation.head_sha;
      const mergeSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.merge_sha);
      requireCondition(
        observation.merge_sha === mergeSha,
        "EVIDENCE_MISMATCH",
        "Historical merge SHA must match the provider receipt",
        5,
      );
      const taskPr =
        target.pr && "state" in target.pr && target.pr.state === "unbound"
          ? null
          : taskPrRef(target);
      requireCondition(
        target.base_sha === baseSha,
        "BASE_CHANGED",
        "Historical merge base does not match the task base",
        5,
      );
      requireCondition(
        !taskPr || stable(taskPr) === stable(pr),
        "PR_MISMATCH",
        "Historical merge PR does not match the registered task PR",
        3,
      );
      requireCondition(
        target.branch === observation.branch,
        "BRANCH_MISMATCH",
        "Historical merge branch does not match the task branch",
        3,
      );
      requireCondition(
        owner.current_sha === baseSha ||
          owner.current_sha === mergeSha ||
          historicalGroupLineageContains(ledger, owner.id, mergeSha),
        "BASE_CHANGED",
        "Historical merge is not present in the group's verified lineage",
        5,
      );

      const quality = parse(fact, payload.quality_evidence);
      requireCondition(
        quality.kind === "task_quality" &&
          quality.subject_id === taskId &&
          quality.status === "passed" &&
          quality.source === target.thread_id &&
          quality.sha === headSha &&
          quality.evidence_ref &&
          quality.quality?.task_id === taskId &&
          quality.quality.thread_id === target.thread_id &&
          stable(quality.quality.pr) === stable(pr) &&
          quality.quality.base_sha === baseSha &&
          quality.quality.head_sha === headSha,
        "EVIDENCE_REQUIRED",
        "Historical reconciliation requires source-bound task quality evidence",
        5,
      );
      const existingQuality = ledger.facts.find((item) => item.id === quality.id);
      requireCondition(
        !existingQuality || stable(existingQuality) === stable(quality),
        "ID_CONFLICT",
        "Quality fact ID already has different content",
        3,
      );
      if (!existingQuality) ledger.facts.push(quality);

      const publicationFact = fact.parse({
        id: externalMergeFactId(request.request_id, "published"),
        kind: "pr_published",
        subject_id: taskId,
        status: "passed",
        source: observation.provider,
        observed_at: quality.observed_at,
        sha: headSha,
        evidence_ref: observation.evidence_ref,
        receipt: observation,
      });
      const mergeFact = fact.parse({
        id: externalMergeFactId(request.request_id, "merged"),
        kind: "pr_merged",
        subject_id: taskId,
        status: "passed",
        source: observation.provider,
        observed_at: quality.observed_at,
        sha: mergeSha,
        evidence_ref: observation.evidence_ref,
        receipt: observation,
      });
      const priorPublication = ledger.facts.find((item) => item.id === publicationFact.id);
      const priorMerge = ledger.facts.find((item) => item.id === mergeFact.id);
      requireCondition(
        !priorPublication || stable(priorPublication) === stable(publicationFact),
        "ID_CONFLICT",
        "Publication fact ID already has different content",
        3,
      );
      requireCondition(
        !priorMerge || stable(priorMerge) === stable(mergeFact),
        "ID_CONFLICT",
        "Merge fact ID already has different content",
        3,
      );
      if (!priorPublication) ledger.facts.push(publicationFact);
      if (!priorMerge) ledger.facts.push(mergeFact);
      completeTaskLifecycleAtom(ledger, request, target, "pr_merged", {
        fact_id: mergeFact.id,
        evidence_ref: mergeFact.evidence_ref,
        occurred_at: mergeFact.observed_at,
      });

      target.pr =
        ledger.contract_version >= 3
          ? { state: "merged", pr, branch: target.branch, merge_sha: mergeSha }
          : pr;
      target.lifecycle.pr_created = "passed";
      target.lifecycle.pr_merged = "passed";
      target.state = "integrated";
      target.finished_at = quality.observed_at;
      const previousGroupSha = owner.current_sha;
      if (owner.current_sha === baseSha) owner.current_sha = mergeSha;
      addEvent(
        ledger,
        request,
        "external_merge_reconciled",
        taskId,
        {
          task_id: taskId,
          group_id: owner.id,
          pr,
          provider_observation: observation,
          quality_fact_id: quality.id,
          publication_fact_id: publicationFact.id,
          merge_fact_id: mergeFact.id,
          previous_group_sha: previousGroupSha,
          current_group_sha: owner.current_sha,
          state: target.state,
          task_snapshot: structuredClone(target),
          group_snapshot: structuredClone(owner),
        },
        quality.observed_at,
      );
      return {
        task_id: taskId,
        state: target.state,
        pr,
        quality_fact_id: quality.id,
        publication_fact_id: publicationFact.id,
        merge_fact_id: mergeFact.id,
        current_group_sha: owner.current_sha,
      };
    }

    default:
      return undefined;
  }
}
