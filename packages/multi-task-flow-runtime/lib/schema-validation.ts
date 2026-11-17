import type { z } from "zod";
import {
  deliveryUnitExternalFacts,
  taskPrBinding,
  validateAtomicGraph,
} from "../lib/atomic-orchestration";
import { requireCondition } from "../lib/errors";
import { sameRunIdentity } from "./orchestration-identity";
import { collectCutAssignmentEvidence } from "./schema-cut";
import { canonicalJson, validateDevPlanHandoff, validatePlan } from "./schema-handoff";
import { type Ledger, ledgerSchema, type Task } from "./schema-models";
import { normalizeLegacyLedger } from "./schema-normalization";
import {
  isContributionKind,
  validateDeliveryTopologies,
  validateTaskExecutionPolicies,
} from "./schema-policies";

function parseLedger(value: unknown): Ledger {
  return ledgerSchema.parse(normalizeLegacyLedger(value));
}

function validateDeliveryUnits(ledger: Ledger): void {
  const bootstrap = ledger.groups.filter((item) => item.delivery_unit_kind === "bootstrap");
  requireCondition(
    bootstrap.length <= 1,
    "INVALID_DELIVERY_UNIT",
    "At most one bootstrap delivery unit is allowed",
  );
  for (const item of ledger.groups) {
    if (item.delivery_unit_kind === "bootstrap") {
      requireCondition(
        item.owner_kind === "main" &&
          item.agent_thread_id === null &&
          !!ledger.control.owner_thread_id,
        "INVALID_DELIVERY_UNIT",
        "Bootstrap must be owned by the bound main conversation without a group binding",
      );
    } else {
      requireCondition(
        item.owner_kind === "group" &&
          (!item.agent_thread_id || item.agent_thread_id !== ledger.control.owner_thread_id),
        "INVALID_DELIVERY_UNIT",
        "Regular delivery unit must use an independent group conversation",
      );
    }
  }
  if (!bootstrap.length) return;
  const bootstrapId = bootstrap[0]!.id;
  for (const plan of ledger.plans) {
    const nodes = new Map(plan.nodes.map((item) => [item.id, item]));
    for (const edge of plan.edges) {
      const source = nodes.get(edge.from_node_id);
      const target = nodes.get(edge.to_node_id);
      if (target?.group_id !== bootstrapId) continue;
      const pending = [source];
      const seen = new Set<string>();
      while (pending.length) {
        const node = pending.pop();
        if (!node || seen.has(node.id)) continue;
        seen.add(node.id);
        requireCondition(
          !node.group_id || node.group_id === bootstrapId,
          "INVALID_DELIVERY_UNIT",
          "Bootstrap cannot depend on another delivery unit",
        );
        for (const incoming of plan.edges.filter((item) => item.to_node_id === node.id))
          pending.push(nodes.get(incoming.from_node_id));
      }
    }
  }
}

export function validateLedger(value: unknown): Ledger {
  const parsed = parseLedger(value);
  if (parsed.contract_version >= 4) {
    requireCondition(
      Boolean(parsed.runtime_identity),
      "RUN_IDENTITY_REQUIRED",
      "Identity-bound contracts require an immutable run identity",
      4,
    );
    const upgrade = parsed.upgrade;
    requireCondition(
      parsed.contract_version < 5 || !upgrade || Boolean(upgrade.migration_audit),
      "MIGRATION_AUDIT_REQUIRED",
      "Identity-bound contract upgrades require a persisted mechanical migration audit",
      4,
    );
    const expected = upgrade?.phase === "prepared" ? upgrade.source : upgrade?.target;
    requireCondition(
      !expected || sameRunIdentity(parsed.runtime_identity, expected),
      "UPGRADE_STATE_CONFLICT",
      "Upgrade phase and ledger identity disagree",
      4,
    );
    requireCondition(
      upgrade?.phase === "prepared" ||
        parsed.runtime_identity?.ledger_contract === parsed.contract_version,
      "INCOMPATIBLE_LEDGER",
      "Runtime identity must implement the ledger contract",
      4,
    );
  } else {
    requireCondition(
      !parsed.runtime_identity && !parsed.upgrade,
      "INCOMPATIBLE_LEDGER",
      "Lifecycle fields require contract 4 or later",
      4,
    );
  }
  validateDeliveryUnits(parsed);
  if (parsed.atomic_nodes.length || parsed.atomic_edges.some((edge) => "from_node_id" in edge)) {
    requireCondition(
      parsed.atomic_edges.every((edge) => "from_node_id" in edge && "to_node_id" in edge),
      "ATOMIC_CONTRACT_REQUIRED",
      "Root contract-3 atomic snapshot must use node-based atomic edges",
    );
    validateAtomicGraph(parsed.atomic_nodes, parsed.atomic_edges as any);
    for (const group of parsed.groups) {
      requireCondition(
        deliveryUnitExternalFacts.safeParse(group.pr).success,
        "ATOMIC_CONTRACT_REQUIRED",
        "Contract-3 DeliveryUnit PR must use DeliveryUnitExternalFacts",
        3,
      );
    }
    for (const task of parsed.tasks.filter((item) => isContributionKind(item.kind))) {
      requireCondition(
        taskPrBinding.safeParse(task.pr).success,
        "ATOMIC_CONTRACT_REQUIRED",
        "Contract-3 contribution Task PR must use TaskPrBinding",
        3,
      );
      if (task.pr?.state === "shared_delivery_unit")
        requireCondition(
          task.pr.delivery_unit_id === task.group_id,
          "DELIVERY_TOPOLOGY_CONFLICT",
          "Shared task PR binding must reference its delivery unit",
          3,
        );
    }
  }
  for (const collection of [
    parsed.plans,
    parsed.groups,
    parsed.tasks,
    parsed.facts,
    parsed.operations,
    parsed.events,
    parsed.notifications,
    parsed.resources,
    parsed.follow_prs,
  ]) {
    requireCondition(
      new Set(collection.map((item) => item.id)).size === collection.length,
      "DUPLICATE_ID",
      "Ledger IDs must be unique within each collection",
    );
  }
  requireCondition(
    new Set(parsed.requests.map((item) => item.request_id)).size === parsed.requests.length,
    "DUPLICATE_REQUEST",
    "Request IDs must be unique",
  );
  const factIds = new Set(parsed.facts.map((item) => item.id));
  const taskIds = new Set(parsed.tasks.map((item) => item.id));
  const groupIds = new Set(parsed.groups.map((item) => item.id));
  for (const operation of parsed.operations) {
    requireCondition(
      operation.receipt_fact_id === null || factIds.has(operation.receipt_fact_id),
      "MISSING_FACT",
      "Operation receipt_fact_id must reference an existing fact",
    );
  }
  for (const fact of parsed.facts) {
    requireCondition(
      taskIds.has(fact.subject_id) || groupIds.has(fact.subject_id),
      "UNKNOWN_FACT_SUBJECT",
      "Fact subject must reference a task or group",
    );
  }
  for (const notice of parsed.notifications) {
    requireCondition(
      notice.ledger_status === "committed",
      "INVALID_NOTIFICATION_STATE",
      "Notification intent must be committed before delivery",
    );
    requireCondition(
      notice.status === "acknowledged"
        ? notice.delivery_status === "sent" && notice.ack_status === "acknowledged"
        : notice.status === notice.delivery_status && notice.ack_status === "unacknowledged",
      "INVALID_NOTIFICATION_STATE",
      "Notification status fields are inconsistent",
    );
  }
  requireCondition(
    parsed.plans.some((item) => item.id === parsed.active_plan_id),
    "MISSING_PLAN",
    "Active plan not found",
  );
  requireCondition(
    parsed.plans.some((item) => item.id === parsed.execution_plan_id),
    "MISSING_PLAN",
    "Execution plan not found",
  );
  const activePlan = parsed.plans.find((item) => item.id === parsed.active_plan_id)!;
  const executionPlan = parsed.plans.find((item) => item.id === parsed.execution_plan_id)!;
  requireCondition(
    activePlan.lifecycle !== "superseded" && activePlan.lifecycle !== "abandoned",
    "INVALID_PLAN_LIFECYCLE",
    "Active plan cannot be superseded or abandoned",
  );
  requireCondition(
    parsed.active_plan_id === parsed.execution_plan_id ||
      activePlan.supersedes_id === parsed.execution_plan_id,
    "INVALID_PLAN_LIFECYCLE",
    "A candidate plan must supersede the current execution plan",
  );
  requireCondition(
    executionPlan.lifecycle === "approved" ||
      (executionPlan.lifecycle === "proposed" &&
        executionPlan.approval_id === null &&
        parsed.control.approval_id === null &&
        parsed.active_plan_id === parsed.execution_plan_id),
    "INVALID_PLAN_LIFECYCLE",
    "Execution plan must be approved unless the run is still awaiting its initial approval",
  );
  requireCondition(
    parsed.active_plan_id === parsed.execution_plan_id || activePlan.lifecycle === "proposed",
    "INVALID_PLAN_LIFECYCLE",
    "A different active and execution plan requires a proposed active revision",
  );
  requireCondition(
    parsed.control.approval_id === executionPlan.approval_id,
    "APPROVAL_MISMATCH",
    "Control approval must match the execution plan approval",
  );
  const historicalLifecycleRoleInference =
    parsed.contract_version < 6 ||
    (parsed.contract_version === 6 && (parsed.upgrade?.migration_audit?.source_contract ?? 6) < 6);
  for (const item of parsed.plans) {
    validatePlan(item, {
      allowLegacyLifecycleRoleInference: historicalLifecycleRoleInference,
      requireCanonicalLifecycleGraph: false,
    });
    if (item.lifecycle === "proposed")
      requireCondition(
        item.approval_id === null,
        "INVALID_PLAN_LIFECYCLE",
        "A proposed plan cannot carry an approval",
      );
    if (item.lifecycle === "approved")
      requireCondition(
        item.approval_id !== null,
        "INVALID_PLAN_LIFECYCLE",
        "An approved plan must carry an approval",
      );
  }
  requireCondition(
    parsed.tasks.every((item) => parsed.groups.some((group) => group.id === item.group_id)),
    "MISSING_GROUP",
    "Task references an unknown group",
  );
  const runtimeThreadIds = [
    parsed.control.owner_thread_id,
    ...parsed.groups.map((group) => group.agent_thread_id),
    ...parsed.tasks.map((task) => task.thread_id),
  ].filter((threadId): threadId is string => threadId !== null);
  requireCondition(
    new Set(runtimeThreadIds).size === runtimeThreadIds.length,
    "THREAD_CONFLICT",
    "Runtime conversations must have unique identities",
  );
  const active = parsed.plans.find((item) => item.id === parsed.active_plan_id)!;
  if (active.plan_handoff) {
    const cutEvidence = collectCutAssignmentEvidence(parsed, active);
    validateDevPlanHandoff(active, parsed.groups, parsed.tasks, {
      allowDynamicAssignments: true,
      assignmentEvidence: cutEvidence.assignments,
      dynamicGroupIds: cutEvidence.dynamicGroupIds,
    });
  }
  requireCondition(
    active.nodes
      .filter((item) => item.kind === "task")
      .every((item) => parsed.tasks.some((task) => task.id === item.ref_id)),
    "UNKNOWN_TASK",
    "Active plan references an unknown task",
  );
  const planTaskIds = new Set(
    active.nodes.filter((item) => item.kind === "task").map((item) => item.ref_id),
  );
  const planGroupIds = new Set(
    active.nodes
      .map((node) => node.group_id)
      .filter((groupId): groupId is string => groupId !== null),
  );
  for (const event of parsed.events)
    if (event.type === "cut_applied" && typeof event.data.new_group_id === "string")
      planGroupIds.add(event.data.new_group_id);
  requireCondition(
    parsed.groups.every((group) => planGroupIds.has(group.id)),
    "ORPHAN_GROUP",
    "Runtime group is not present in the active plan",
  );
  const executionPlanTaskIds = new Set(
    (parsed.plans.find((item) => item.id === parsed.execution_plan_id)?.nodes ?? [])
      .filter((item) => item.kind === "task")
      .map((item) => item.ref_id),
  );
  requireCondition(
    parsed.tasks.every((task) => planTaskIds.has(task.id) || executionPlanTaskIds.has(task.id)),
    "UNKNOWN_PLAN_TASK",
    "Runtime task is not present in the active plan",
  );
  const groups = new Map(parsed.groups.map((item) => [item.id, item]));
  for (const node of active.nodes.filter((item) => item.kind === "task")) {
    const task = parsed.tasks.find((item) => item.id === node.ref_id);
    requireCondition(
      Boolean(node.group_id && groups.has(node.group_id)),
      "MISSING_GROUP",
      "Plan task node references an unknown group",
    );
    const reassignedByCut = Boolean(
      task &&
        task.group_id !== node.group_id &&
        task.assignment_history.some((item) => item.group_id === task.group_id) &&
        parsed.events.some(
          (event) =>
            event.type === "cut_applied" &&
            event.data.new_group_id === task.group_id &&
            Array.isArray(event.data.reassigned_task_ids) &&
            event.data.reassigned_task_ids.includes(task.id),
        ),
    );
    requireCondition(
      Boolean(task && (task.group_id === node.group_id || reassignedByCut)),
      "GROUP_MISMATCH",
      "Plan task node group must match its runtime task or a verified cut reassignment",
    );
  }
  for (const owner of parsed.groups) {
    const cut = parsed.events.find(
      (event) => event.type === "cut_applied" && event.data.new_group_id === owner.id,
    );
    const snapshot = cut?.data.new_group_snapshot as z.infer<typeof group> | undefined;
    const configured = active.group_atoms.filter((atom) => atom.group_id === owner.id);
    const expected = configured.length
      ? configured.map(({ group_id, ...atom }) => atom)
      : (snapshot?.atoms.map(({ status, ...atom }) => atom) ?? []);
    requireCondition(
      canonicalJson(expected) === canonicalJson(owner.atoms.map(({ status, ...atom }) => atom)),
      "GROUP_ATOM_MISMATCH",
      "Delivery-unit atoms must match their plan or verified cut configuration in serial order",
    );
  }
  for (const task of parsed.tasks) {
    const expected = active.atoms.filter((atom) => atom.task_id === task.id).map((atom) => atom.id);
    requireCondition(
      JSON.stringify(expected) === JSON.stringify(task.atoms.map((atom) => atom.id)),
      "ATOM_MISMATCH",
      "Task atoms must match the active plan in serial order",
    );
  }
  for (const target of [
    ...parsed.groups.map((item) => ({ type: "group" as const, item })),
    ...parsed.tasks
      .filter((item) => isContributionKind(item.kind))
      .map((item) => ({ type: "task" as const, item })),
  ]) {
    const item = target.item as any;
    if (item.lifecycle.workspace_ready === "passed")
      requireCondition(
        parsed.events.some(
          (event) =>
            event.type === "lifecycle_recorded" &&
            event.subject_id === item.id &&
            event.data.stage === "workspace_ready",
        ),
        "INVALID_LIFECYCLE",
        "workspace_ready must be backed by a lifecycle event",
      );
    if (item.lifecycle.pr_created === "passed") {
      const binding = target.type === "group" ? item.pr : item.pr;
      const pr =
        binding && typeof binding === "object" && "state" in binding
          ? binding.state === "published" ||
            binding.state === "open" ||
            binding.state === "merged" ||
            binding.state === "closed"
            ? binding.pr
            : null
          : target.type === "group"
            ? item.parent_pr
            : item.pr;
      const latest = parsed.facts
        .filter(
          (candidate) => candidate.kind === "pr_published" && candidate.subject_id === item.id,
        )
        .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
        .at(-1);
      requireCondition(
        pr &&
          latest?.status === "passed" &&
          latest.receipt?.resource_type === "pr" &&
          latest.receipt.resource_id === pr.id &&
          latest.receipt.pr &&
          canonicalJson(latest.receipt.pr) === canonicalJson(pr),
        "INVALID_LIFECYCLE",
        "pr_created must be backed by the latest successful provider PR receipt",
      );
    }
    if (item.lifecycle.pr_merged === "passed")
      requireCondition(
        parsed.facts.some(
          (candidate) =>
            candidate.kind === "pr_merged" &&
            candidate.subject_id === item.id &&
            candidate.status === "passed" &&
            candidate.sha,
        ),
        "INVALID_LIFECYCLE",
        "pr_merged must be backed by a merge receipt",
      );
    if (item.lifecycle.closed === "passed")
      requireCondition(
        item.state === "closed",
        "INVALID_LIFECYCLE",
        "closed must match the runtime closeout state",
      );
  }
  if (parsed.events.some((event) => event.type === "cut_applied"))
    collectCutAssignmentEvidence(parsed, active);
  return parsed;
}
