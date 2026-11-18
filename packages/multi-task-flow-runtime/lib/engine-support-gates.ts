import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { lifecycleStageOf } from "../lib/atomic-orchestration";
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
import type { Request } from "./engine-support-core";
import * as core from "./engine-support-core";

const {
  parse,
  object,
  string,
  now,
  find,
  stable,
  activePlan,
  executionPlan,
  approved,
  atomicDependenciesReady,
  atomicNodeSatisfied,
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

export function addEvent(
  ledger: Ledger,
  request: Request,
  type: Ledger["events"][number]["type"],
  subject: string,
  data: Record<string, unknown>,
  occurredAt: string | null = now(),
  eventId = request.request_id,
): void {
  ledger.events.push({
    id: eventId,
    type,
    subject_id: subject,
    actor_id: request.actor.thread_id,
    occurred_at: occurredAt,
    recorded_at: now(),
    data,
  });
}
export function boundConversation(ledger: Ledger, threadId: string): boolean {
  return (
    ledger.control.owner_thread_id === threadId ||
    ledger.groups.some((item) => item.agent_thread_id === threadId) ||
    ledger.tasks.some((item) => item.thread_id === threadId)
  );
}
export function notificationDirective(
  ledger: Ledger,
  request: Request,
  payload: Record<string, any>,
  autoDefault: boolean,
): { enabled: boolean; recipient_thread_id: string | null } {
  const legacy = payload.notify_main === true;
  const raw = payload.notification;
  if (raw !== undefined && legacy)
    requireCondition(
      false,
      "INVALID_NOTIFICATION",
      "notification and notify_main cannot be combined",
      2,
    );
  const option = raw === undefined ? null : parse(notificationOption, raw);
  const mode = option?.mode ?? (legacy ? "deliver" : "auto");
  const enabled = mode === "deliver" || (mode === "auto" && autoDefault);
  if (!enabled) return { enabled: false, recipient_thread_id: null };
  if (mode === "auto" && !ledger.control.owner_thread_id && option?.recipient === undefined)
    return { enabled: false, recipient_thread_id: null };
  const recipient = option?.recipient ?? "owner";
  const threadId = recipient === "owner" ? ledger.control.owner_thread_id : recipient.thread_id;
  requireCondition(!!threadId, "RECIPIENT_UNBOUND", "Notification recipient is not bound", 3);
  requireCondition(
    boundConversation(ledger, threadId!),
    "RECIPIENT_UNBOUND",
    "Notification recipient is not bound to this run",
    3,
  );
  requireNotificationRecipientActive(ledger, threadId!);
  return { enabled: true, recipient_thread_id: threadId! };
}
export function requireNotificationRecipientActive(ledger: Ledger, threadId: string): void {
  requireCondition(
    !ledger.resources.some(
      (resource) =>
        resource.kind === "conversation" &&
        resource.target === threadId &&
        ["closed", "archive_unknown", "unarchive_unknown", "unarchive_failed"].includes(
          resource.status,
        ),
    ),
    "CONVERSATION_ARCHIVED",
    "通知接收对话已归档或归档状态未知，请先手动取消归档或完成对账",
    4,
  );
}
export function addNotificationIntent(
  ledger: Ledger,
  request: Request,
  recipientThreadId: string,
): Ledger["notifications"][number] {
  const created = notification.parse({
    id: randomUUID(),
    event_id: request.request_id,
    recipient_thread_id: recipientThreadId,
    ledger_status: "committed",
    status: "pending",
    delivery_status: "pending",
    ack_status: "unacknowledged",
    attempts: 0,
    last_attempt_id: null,
    last_reconciliation_id: null,
    last_error: null,
    updated_at: now(),
  });
  ledger.notifications.push(created);
  return created;
}
export function requiresNativeDelivery(ledger: Ledger, notificationId: string): boolean {
  return (
    ledger.operations.some((op) => op.request.handoff_notification_id === notificationId) ||
    ledger.events.some(
      (event) =>
        event.data.notification_id === notificationId && event.data.provider === "codex-app-tools",
    )
  );
}
export function notificationDeliveryRequest(
  notice: Ledger["notifications"][number] | null,
): Record<string, string> | null {
  return notice
    ? {
        notification_id: notice.id,
        event_id: notice.event_id,
        recipient_thread_id: notice.recipient_thread_id,
      }
    : null;
}
export function addOperation(
  ledger: Ledger,
  request: Request,
  kind: Ledger["operations"][number]["kind"],
  target: string,
  expectedSha: string | null,
): Ledger["operations"][number] {
  const operationId = parse(id, request.payload.operation_id);
  requireCondition(
    !ledger.operations.some((item) => item.id === operationId),
    "OPERATION_EXISTS",
    "Operation identity already exists",
    3,
  );
  const date = now();
  const created = operation.parse({
    id: operationId,
    kind,
    actor_id: request.actor.thread_id,
    target_id: target,
    status: "claimed",
    request: structuredClone(request.payload),
    expected_sha: expectedSha,
    receipt_fact_id: null,
    created_at: date,
    updated_at: date,
  });
  ledger.operations.push(created);
  return created;
}
export function activeOperation(item: Ledger["operations"][number]): boolean {
  return item.status === "claimed" || item.status === "unknown";
}
export function creationObservations(
  op: Ledger["operations"][number],
  payload: Record<string, any>,
) {
  const observed: Record<string, any> = { ...object(op.request.creation_observations ?? {}) };
  const previous = object(op.request.creation_result ?? {});
  for (const report of [
    { thread_id: op.request.observed_thread_id },
    previous,
    object(previous.native_evidence ?? {}),
    payload,
    object(payload.native_evidence ?? {}),
  ]) {
    for (const key of ["thread_id", "workspace_path", "initial_head"]) {
      const value = report[key];
      if (typeof value !== "string" || !value) continue;
      requireCondition(
        !observed[key] || observed[key] === value,
        "CREATION_EVIDENCE_CONFLICT",
        "Known creation identity and resources cannot change",
        5,
      );
      observed[key] = value;
    }
    if (
      report.process_started === true ||
      report.resources_created === true ||
      report.turn_completed === true ||
      report.exit_code != null ||
      (Array.isArray(report.events) && report.events.length > 0)
    )
      observed.process_observed = true;
  }
  return observed;
}
export function publicationPendingForGroup(ledger: Ledger, groupId: string): boolean {
  const taskIds = ledger.tasks.filter((item) => item.group_id === groupId).map((item) => item.id);
  return ledger.operations.some(
    (item) =>
      [groupId, ...taskIds].includes(item.target_id) &&
      ["publish_branch", "publish_pr"].includes(item.kind) &&
      activeOperation(item),
  );
}
export function checkPR(ledger: Ledger, pr: z.infer<typeof externalRef>): void {
  requireCondition(
    pr.provider === ledger.repository.provider &&
      pr.repository === `${ledger.repository.owner}/${ledger.repository.name}`,
    "PR_MISMATCH",
    "PR must belong to this orchestration's repository",
    3,
  );
  if (pr.url) {
    const url = new URL(pr.url);
    requireCondition(
      url.protocol === "https:" &&
        url.hostname === ledger.repository.host &&
        !url.username &&
        !url.password,
      "PR_MISMATCH",
      "PR URL must belong to the bound provider host",
      3,
    );
  }
}

export const groupBaseReconciliation = z
  .object({
    operation: z.literal("update-branch"),
    branch: z.string().min(1),
    previous_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    parent_pr: externalRef,
    source: z.string().min(1),
    evidence_ref: z.string().min(1),
  })
  .strict();
export function currentRuleGroup(ledger: Ledger, initialGroup: string): string {
  let groupId = initialGroup;
  for (const event of ledger.events) {
    if (
      event.type === "cut_applied" &&
      event.data.old_group_id === groupId &&
      typeof event.data.new_group_id === "string"
    )
      groupId = event.data.new_group_id;
  }
  return groupId;
}

type PlanNode = Ledger["plans"][number]["nodes"][number];
type PlanEdge = Ledger["plans"][number]["edges"][number];

export function subjectSha(ledger: Ledger, subjectId: string): string | null {
  const group = ledger.groups.find((item) => item.id === subjectId);
  if (group) return group.merge_sha ?? group.current_sha;
  const task = ledger.tasks.find((item) => item.id === subjectId);
  if (!task) return null;
  const owner = ledger.groups.find((item) => item.id === task.group_id);
  return owner?.merge_sha ?? owner?.current_sha ?? task.base_sha;
}

export function latestFact(
  ledger: Ledger,
  subjectId: string,
  kind: Ledger["facts"][number]["kind"],
): Ledger["facts"][number] | null {
  return (
    ledger.facts
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.subject_id === subjectId && item.kind === kind)
      .sort(
        (left, right) =>
          left.item.observed_at.localeCompare(right.item.observed_at) || left.index - right.index,
      )
      .at(-1)?.item ?? null
  );
}

export function factSatisfied(
  ledger: Ledger,
  subjectId: string,
  kind: Ledger["facts"][number]["kind"],
): boolean {
  const latest = latestFact(ledger, subjectId, kind);
  if (latest?.status !== "passed" || !latest.sha) return false;
  if (kind === "pr_merged" && ledger.groups.some((item) => item.id === subjectId)) {
    const group = ledger.groups.find((item) => item.id === subjectId)!;
    return ledger.contract_version < 3
      ? deliveryUnitPrMerged(group)
      : deliveryUnitPrMergedFromLedger(ledger, group);
  }
  const task = ledger.tasks.find((item) => item.id === subjectId);
  if (!task) {
    const expectedSha = subjectSha(ledger, subjectId);
    return !!expectedSha && latest.sha === expectedSha;
  }
  if (kind === "pr_merged") {
    const operationSatisfied = ledger.operations.some(
      (item) =>
        item.kind === "merge" &&
        item.target_id === task.group_id &&
        item.status === "succeeded" &&
        item.receipt_fact_id === latest.id &&
        item.request.mode === "child" &&
        item.request.task_id === subjectId,
    );
    if (operationSatisfied || ledger.contract_version < 3) return operationSatisfied;
    const binding = task.pr && "state" in task.pr && task.pr.state === "merged" ? task.pr : null;
    const receipt = latest.receipt;
    return Boolean(
      task.lifecycle.pr_merged === "passed" &&
        ["integrated", "closed"].includes(task.state) &&
        binding?.merge_sha === latest.sha &&
        receipt?.resource_type === "pr" &&
        receipt.state === "merged" &&
        receipt.merge_sha === latest.sha &&
        receipt.pr !== null &&
        stable(receipt.pr) === stable(taskPrRef(task)) &&
        receipt.branch === task.branch,
    );
  }
  const sourceSha = subjectSha(ledger, subjectId);
  if (!sourceSha) return false;
  if (["published", "deployed"].includes(kind)) {
    const actionKind = kind === "published" ? "release" : "deploy";
    const receipt = ledger.operations.find(
      (item) =>
        item.kind === actionKind &&
        item.target_id === subjectId &&
        item.status === "succeeded" &&
        item.receipt_fact_id === latest.id,
    );
    return receipt ? receipt.expected_sha === sourceSha : latest.sha === sourceSha;
  }
  return latest.sha === sourceSha;
}

export function factKind(requires: PlanEdge["requires"]): Ledger["facts"][number]["kind"] | null {
  if (requires === "merged") return "pr_merged";
  if (
    requires === "ci_passed" ||
    requires === "published" ||
    requires === "deployed" ||
    requires === "verified"
  )
    return requires;
  return null;
}

export function nodeSatisfied(
  ledger: Ledger,
  node: PlanNode,
  nodes: Map<string, PlanNode>,
  edges: PlanEdge[],
  visiting: Set<string>,
): boolean {
  if (visiting.has(node.id)) return false;
  visiting.add(node.id);
  const result = edges
    .filter((item) => item.to_node_id === node.id)
    .every((edge) => edgeSatisfied(ledger, edge, nodes, edges, visiting));
  visiting.delete(node.id);
  return result;
}

export function edgeSatisfied(
  ledger: Ledger,
  edge: PlanEdge,
  nodes: Map<string, PlanNode>,
  edges: PlanEdge[],
  visiting: Set<string>,
): boolean {
  const source = nodes.get(edge.from_node_id);
  if (!source) return false;
  if (source.kind === "main_start") return nodeSatisfied(ledger, source, nodes, edges, visiting);
  if (source.kind === "task" && source.ref_id) {
    const sourceTask = ledger.tasks.find((item) => item.id === source.ref_id);
    if (!sourceTask) return false;
    if (edge.requires === "integrated") return ["integrated", "closed"].includes(sourceTask.state);
    if (edge.requires === "completed") return ["completed", "closed"].includes(sourceTask.state);
    const kind = factKind(edge.requires);
    return kind ? factSatisfied(ledger, source.ref_id, kind) : false;
  }
  if (source.kind === "milestone" && source.ref_id) {
    const kind = factKind(edge.requires);
    return kind
      ? factSatisfied(ledger, source.ref_id, kind)
      : nodeSatisfied(ledger, source, nodes, edges, visiting);
  }
  return nodeSatisfied(ledger, source, nodes, edges, visiting);
}

export function ready(ledger: Ledger, taskId: string): boolean {
  const targetTask = ledger.tasks.find((item) => item.id === taskId);
  if (!targetTask || targetTask.disposition !== "active") return false;
  const currentPlan = (() => {
    try {
      return approved(ledger);
    } catch {
      return null;
    }
  })();
  if (!currentPlan) return false;
  const active = activePlan(ledger);
  const revision =
    active.id !== ledger.execution_plan_id && active.lifecycle === "proposed"
      ? active.revision
      : null;
  if (revision?.paused_task_ids.includes(taskId)) return false;
  const target = currentPlan.nodes.find((item) => item.kind === "task" && item.ref_id === taskId);
  if (!target) return false;
  const nodes = new Map(currentPlan.nodes.map((item) => [item.id, item]));
  return (
    nodeSatisfied(ledger, target, nodes, currentPlan.edges, new Set()) &&
    atomicDependenciesReady(ledger, currentPlan, taskId)
  );
}

export function deliveryUnitPrMerged(group: Ledger["groups"][number]): boolean {
  const canonicalPrState = group.pr && "state" in group.pr ? group.pr.state : null;
  return Boolean(
    ["merged", "closed"].includes(group.state) &&
      group.merge_sha &&
      group.lifecycle.pr_merged === "passed" &&
      (canonicalPrState === null || canonicalPrState === "merged"),
  );
}

export function deliveryUnitPrMergedFromLedger(
  ledger: Ledger,
  group: Ledger["groups"][number],
): boolean {
  const reconciliation = ledger.events.findLast(
    (event) => event.subject_id === group.id && event.data.operation === "closeout-reconcile",
  );
  if (reconciliation?.data.outcome === "unknown") return false;
  if (legacyLedger(ledger)) return deliveryUnitPrMerged(group);
  const latest = latestFact(ledger, group.id, "pr_merged");
  const canonicalPr = group.pr && "state" in group.pr ? group.pr.pr : group.pr;
  const canonicalState = group.pr && "state" in group.pr ? group.pr.state : null;
  return Boolean(
    ["merged", "closed"].includes(group.state) &&
      group.merge_sha &&
      group.lifecycle.pr_merged === "passed" &&
      latest?.status === "passed" &&
      latest.sha === group.merge_sha &&
      (canonicalState === null || canonicalState === "merged" || canonicalState === "closed") &&
      ledger.operations.some(
        (item) =>
          item.kind === "merge" &&
          item.target_id === group.id &&
          item.status === "succeeded" &&
          item.receipt_fact_id === latest.id,
      ) &&
      canonicalPr &&
      latest.receipt?.resource_type === "pr" &&
      latest.receipt.resource_id === canonicalPr.id &&
      latest.receipt.pr &&
      stable(canonicalPr) === stable(latest.receipt.pr),
  );
}

export function requireHandoffAcknowledged(ledger: Ledger, group: Ledger["groups"][number]): void {
  const dispatch = ledger.operations.find(
    (item) =>
      item.kind === "dispatch" &&
      item.request.target_type === "group" &&
      item.target_id === group.id &&
      item.status === "succeeded",
  );
  const notificationId = dispatch?.request.handoff_notification_id;
  const notice = notificationId
    ? ledger.notifications.find((item) => item.id === notificationId)
    : null;
  requireCondition(
    !!notice,
    "HANDOFF_PENDING",
    "Delivery-unit formal handoff has not been recorded",
    4,
  );
  requireCondition(
    notice!.delivery_status !== "unknown",
    "RECONCILIATION_REQUIRED",
    "Delivery-unit handoff delivery is unknown; reconcile it before execution",
    5,
  );
  requireCondition(
    notice!.status === "acknowledged",
    "HANDOFF_PENDING",
    "Delivery Agent must acknowledge the formal handoff before execution",
    4,
  );
}

/**
 * A regular Delivery Agent may be created only when the execution graph has a
 * ready task and every upstream delivery unit has completed its parent PR
 * merge. The task dispatch gate alone cannot enforce this because group
 * conversation creation happens before any task is selected.
 */
export function requireGroupDispatchGate(ledger: Ledger, target: Ledger["groups"][number]): void {
  if (legacyLedger(ledger)) return;
  const currentPlan = executionPlan(ledger);
  const nodes = new Map(currentPlan.nodes.map((item) => [item.id, item]));
  const taskNodes = currentPlan.nodes.filter(
    (item) => item.kind === "task" && item.group_id === target.id && item.ref_id,
  );
  const upstreamGroupIds = new Set<string>();
  for (const taskNode of taskNodes) {
    for (const edge of currentPlan.edges.filter((item) => item.to_node_id === taskNode.id)) {
      const source = nodes.get(edge.from_node_id);
      if (source?.group_id && source.group_id !== target.id) upstreamGroupIds.add(source.group_id);
    }
  }
  const missingUpstream = [...upstreamGroupIds].filter((groupId) => {
    const upstream = ledger.groups.find((item) => item.id === groupId);
    return !upstream || !deliveryUnitPrMergedFromLedger(ledger, upstream);
  });
  if (missingUpstream.length)
    throw new ContractError(
      "DELIVERY_GATE_PENDING",
      "Regular delivery-unit conversation cannot be created before upstream delivery-unit PRs are merged",
      4,
      {
        target_type: "group",
        target_id: target.id,
        missing: missingUpstream.map((groupId) => `upstream_pr_merged:${groupId}`),
        recovery: [
          "complete the upstream delivery-unit PR merge lifecycle",
          "retry dispatch-group-claim",
        ],
      },
    );
  const readyTask = taskNodes.some((node) => {
    const task = ledger.tasks.find((item) => item.id === node.ref_id);
    return Boolean(
      task &&
        task.disposition === "active" &&
        ["planned", "ready"].includes(task.state) &&
        ready(ledger, task.id),
    );
  });
  requireCondition(
    readyTask,
    "DEPENDENCIES_PENDING",
    "Regular delivery-unit conversation cannot be created before one of its tasks is dependency-ready",
    4,
  );
}

export function ownerOfTask(ledger: Ledger, request: Request, taskId: string): void {
  const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
  requireCondition(
    target.disposition === "active",
    "TASK_NOT_ACTIVE",
    "Task is no longer an active responsibility",
    3,
  );
  if (request.actor.role === "task")
    requireCondition(
      target.thread_id === request.actor.thread_id,
      "FORBIDDEN",
      "Task is owned by another conversation",
      3,
    );
  if (request.actor.role === "group") {
    const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
    requireCondition(
      owner.agent_thread_id === request.actor.thread_id,
      "FORBIDDEN",
      "Task belongs to another group",
      3,
    );
  }
}

export function taskExecutionState(task: {
  state: string;
  agent_resume_state?: "starting" | "running";
}): string {
  return task.state === "agent_idle" ? (task.agent_resume_state ?? "running") : task.state;
}

function lifecycleAtomEventId(requestId: string, atomId: string): string {
  return `atom-${createHash("sha256")
    .update(`${requestId}\0${atomId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function taskMergePrerequisitesComplete(ledger: Ledger, task: Task): boolean {
  if (legacyLedger(ledger)) return true;
  if (ledger.contract_version < 3) return task.atoms.every((atom) => atom.status === "completed");
  const mergeIndex = task.atoms.findIndex((atom) => lifecycleStageOf(atom) === "pr_merged");
  if (mergeIndex < 0 || ["blocked", "completed"].includes(task.atoms[mergeIndex]?.status ?? ""))
    return false;
  let currentPlan: Plan;
  try {
    currentPlan = executionPlan(ledger);
  } catch {
    return false;
  }
  const nodes = (
    currentPlan.atomic_nodes?.length ? currentPlan.atomic_nodes : ledger.atomic_nodes
  ) as any[];
  const edgeSource = currentPlan.atomic_edges?.some((edge: any) => "from_node_id" in edge)
    ? currentPlan.atomic_edges
    : ledger.atomic_edges;
  const edges = edgeSource.filter((edge: any) => "from_node_id" in edge) as any[];
  const mergeNode = nodes.find(
    (node) =>
      node.id === task.atoms[mergeIndex]!.id &&
      node.kind === "work" &&
      node.scope?.kind === "task" &&
      node.scope.task_id === task.id,
  );
  if (!mergeNode) return false;
  const incoming = new Map<string, any[]>();
  for (const edge of edges)
    incoming.set(edge.to_node_id, [...(incoming.get(edge.to_node_id) ?? []), edge]);
  const pending = [...(incoming.get(mergeNode.id) ?? [])];
  if (!pending.length) return false;
  const visited = new Set<string>();
  while (pending.length) {
    const edge = pending.pop()!;
    if (visited.has(edge.from_node_id)) continue;
    visited.add(edge.from_node_id);
    const source = nodes.find((node) => node.id === edge.from_node_id);
    if (!source || !atomicNodeSatisfied(ledger, source)) return false;
    pending.push(...(incoming.get(source.id) ?? []));
  }
  return true;
}

function providerMergeAtomCompletionRecorded(
  ledger: Ledger,
  taskId: string,
  atomId: string,
  evidence: { fact_id: string; evidence_ref: string | null },
): boolean {
  return ledger.events.some(
    (event) =>
      event.type === "atom_updated" &&
      event.subject_id === taskId &&
      event.data.task_id === taskId &&
      event.data.atom_id === atomId &&
      event.data.state === "completed" &&
      event.data.source === "provider-merge" &&
      event.data.fact_id === evidence.fact_id &&
      event.data.evidence_ref === evidence.evidence_ref,
  );
}

export function completeTaskLifecycleAtom(
  ledger: Ledger,
  request: Request,
  task: Task,
  lifecycleStage: "pr_merged",
  evidence: { fact_id: string; evidence_ref: string | null; occurred_at: string },
): void {
  if (ledger.contract_version < 3) return;
  const index = task.atoms.findIndex((atom) => lifecycleStageOf(atom) === lifecycleStage);
  requireCondition(index >= 0, "ATOMS_PENDING", "Contract 3 task must declare a pr_merged atom", 4);
  const atom = task.atoms[index]!;
  if (atom.status === "completed") {
    requireCondition(
      providerMergeAtomCompletionRecorded(ledger, task.id, atom.id, evidence),
      "EVIDENCE_MISMATCH",
      "The task merge atom was not completed by this provider merge evidence",
      5,
    );
    return;
  }
  requireCondition(
    taskMergePrerequisitesComplete(ledger, task),
    "ATOMS_PENDING",
    "Complete the task's pre-merge atoms before recording the merge",
    4,
  );
  requireCondition(
    ["planned", "running"].includes(atom.status),
    "INVALID_TRANSITION",
    "The task merge atom cannot be completed from its current state",
    3,
  );
  atom.status = "completed";
  addEvent(
    ledger,
    request,
    "atom_updated",
    task.id,
    {
      task_id: task.id,
      atom_id: atom.id,
      state: "completed",
      source: "provider-merge",
      fact_id: evidence.fact_id,
      evidence_ref: evidence.evidence_ref,
    },
    evidence.occurred_at,
    lifecycleAtomEventId(request.request_id, atom.id),
  );
}

export function taskCanUpdateAtoms(ledger: Ledger, task: Task): boolean {
  return (
    taskExecutionState(task) === "running" ||
    (ledger.contract_version >= 3 &&
      task.state === "integrated" &&
      task.lifecycle.pr_merged === "passed")
  );
}

export function taskRuntimeState(task: Task): Record<string, unknown> {
  return {
    thread_id: task.thread_id,
    state: task.state,
    agent_resume_state: task.agent_resume_state,
    disposition: task.disposition,
    superseded_by_task_id: task.superseded_by_task_id,
    atoms: task.atoms,
    base_sha: task.base_sha,
    pr: task.pr,
    requirements_path: task.requirements_path,
    started_at: task.started_at,
    finished_at: task.finished_at,
    blocker: task.blocker,
    assignment_history: task.assignment_history,
    execution_owner: task.execution_owner,
    conversation_policy: task.conversation_policy,
    delivery_policy: task.delivery_policy,
  };
}

export function taskBoundary(task: Task): Record<string, unknown> {
  return {
    kind: task.kind,
    group_id: task.group_id,
    owned_surfaces: task.owned_surfaces,
    atoms: task.atoms.map(({ id, title }) => ({ id, title })),
    execution_owner: task.execution_owner,
    conversation_policy: task.conversation_policy,
    delivery_policy: task.delivery_policy,
  };
}

export function hasTaskStarted(ledger: Ledger, taskId: string): boolean {
  return ledger.events.some(
    (event) =>
      event.type === "task_started" &&
      (event.subject_id === taskId || event.data.task_id === taskId),
  );
}

export function groupRuntimeState(item: Ledger["groups"][number]): Record<string, unknown> {
  return {
    delivery_unit_kind: item.delivery_unit_kind,
    owner_kind: item.owner_kind,
    agent_thread_id: item.agent_thread_id,
    state: item.state,
    parent_branch: item.parent_branch,
    parent_pr: item.parent_pr,
    cut_sha: item.cut_sha,
    current_sha: item.current_sha,
    merge_sha: item.merge_sha,
    requirements_path: item.requirements_path,
    atoms: item.atoms.filter((atom) => atom.status !== "planned"),
    coordination_execution: item.coordination_execution,
  };
}

export function validateRevisionReason(revision: NonNullable<Plan["revision"]>): void {
  requireCondition(
    revision.change_set.added.length +
      revision.change_set.removed.length +
      revision.change_set.modified.length >
      0,
    "PLAN_REVISION_EMPTY",
    "Plan revision must contain a non-empty canonical diff",
    3,
  );
  if (reasonRequired(revision))
    requireCondition(
      revision.reason !== null,
      "REVISION_REASON_REQUIRED",
      "Implementation plan revisions require a structured reason",
      3,
    );
  if (evidenceRequired(revision))
    requireCondition(
      !!revision.reason?.evidence_refs.length,
      "REVISION_EVIDENCE_REQUIRED",
      "High-impact plan revisions require evidence references",
      5,
    );
}
