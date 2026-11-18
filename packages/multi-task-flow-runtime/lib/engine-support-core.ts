import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type AtomicEdge, type AtomicNode, lifecycleStageOf } from "../lib/atomic-orchestration";
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
  type externalRef,
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
  type providerReceipt,
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
import { latestPublicationFact } from "./publication-facts";

export const actorSchema = z
  .object({
    role: z.enum(["main", "group", "task"]),
    thread_id: z.string().min(1),
  })
  .strict();
export const requestSchema = z
  .object({
    run_id: id,
    actor: actorSchema,
    request_id: id,
    expected_revision: z.number().int().nonnegative(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Request = z.infer<typeof requestSchema>;

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
export function object(value: unknown): Record<string, any> {
  return z.record(z.string(), z.unknown()).parse(value);
}
export function string(value: unknown): string {
  return z.string().min(1).parse(value);
}
export function now(): string {
  return new Date().toISOString();
}
export function find<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const found = items.find(predicate);
  requireCondition(found, "NOT_FOUND", `${label} not found`);
  return found;
}
export function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function protectedActionTargetDigest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
export function parseProtectedActionDigest(value: unknown): string | null {
  if (value == null) return null;
  return z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(value);
}
function activeOperation(item: Ledger["operations"][number]): boolean {
  return item.status === "claimed" || item.status === "unknown";
}
function taskExecutionState(task: {
  state: string;
  agent_resume_state?: "starting" | "running";
}): string {
  return task.state === "agent_idle" ? (task.agent_resume_state ?? "running") : task.state;
}
function requireHandoffAcknowledged(ledger: Ledger, group: Ledger["groups"][number]): void {
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

export function authorize(ledger: Ledger, actor: Request["actor"]): void {
  requireCondition(
    ledger.control.ownership === "bound",
    "OWNER_UNCERTAIN",
    "Orchestration ownership is not resolved",
    5,
  );
  if (actor.role === "main")
    requireCondition(
      actor.thread_id === ledger.control.owner_thread_id,
      "ACTOR_MISMATCH",
      "Main conversation does not own this orchestration",
      3,
    );
  if (actor.role === "group")
    requireCondition(
      ledger.groups.some((g) => g.agent_thread_id === actor.thread_id),
      "ACTOR_MISMATCH",
      "Group conversation is not bound",
      3,
    );
  if (actor.role === "task")
    requireCondition(
      ledger.tasks.some((t) => t.thread_id === actor.thread_id),
      "ACTOR_MISMATCH",
      "Task conversation is not bound",
      3,
    );
}
export function onlyMain(actor: Request["actor"]): void {
  requireCondition(
    actor.role === "main",
    "FORBIDDEN",
    "Only the main conversation can perform this action",
    3,
  );
}
export function activePlan(ledger: Ledger): Plan {
  return find(ledger.plans, (item) => item.id === ledger.active_plan_id, "Active plan");
}
export function executionPlan(ledger: Ledger): Plan {
  return find(ledger.plans, (item) => item.id === ledger.execution_plan_id, "Execution plan");
}
export function atomicNodeSatisfied(ledger: Ledger, node: any): boolean {
  if (!node) return false;
  if (node.kind === "boundary")
    return (
      node.boundary === "start" || ledger.events.some((event) => event.type === "run_completed")
    );
  if (node.kind === "milestone") return node.state === "completed";
  const scope = node.scope;
  const atoms =
    scope?.kind === "task"
      ? ledger.tasks.find((task) => task.id === scope.task_id)?.atoms
      : ledger.groups.find((group) => group.id === scope?.delivery_unit_id)?.atoms;
  const atom = atoms?.find((candidate) => candidate.id === node.id);
  return atom ? atom.status === "completed" : false;
}
export function atomicConditionEvaluator(ledger: Ledger, plan: Plan) {
  const nodes = new Map(plan.atomic_nodes.map((node): [string, AtomicNode] => [node.id, node]));
  const edges = plan.atomic_edges.filter((edge): edge is AtomicEdge => "from_node_id" in edge);
  const inbound = new Map<string, AtomicEdge[]>();
  for (const edge of edges) {
    const incoming = inbound.get(edge.to_node_id);
    if (incoming) incoming.push(edge);
    else inbound.set(edge.to_node_id, [edge]);
  }
  const visiting = new Set<string>();
  const cache = new Map<string, boolean>();
  type Criterion = Extract<AtomicNode, { kind: "milestone" }>["acceptance"][number];
  function criterionSatisfied(criterion: Criterion): boolean {
    if (criterion.kind === "node_satisfied") return nodeSatisfied(criterion.node_id);
    if (criterion.kind === "pr_published" || criterion.kind === "pr_merged") {
      const fact = ledger.facts.findLast(
        (item) =>
          item.kind === criterion.kind && stable(item.receipt?.pr) === stable(criterion.pr_ref),
      );
      return (
        fact?.status === "passed" &&
        (criterion.kind === "pr_published"
          ? fact.receipt?.state === "open" || fact.receipt?.state === "merged"
          : fact.receipt?.state === "merged" &&
            fact.sha === criterion.merge_sha &&
            fact.receipt.merge_sha === criterion.merge_sha)
      );
    }
    // A standalone external gate cannot be satisfied by an atom status report.
    return false;
  }
  function edgeSatisfied(edge: AtomicEdge): boolean {
    return (
      nodeSatisfied(edge.from_node_id) &&
      (edge.requires.kind !== "source_evidence" || criterionSatisfied(edge.requires.criterion))
    );
  }
  function nodeSatisfied(id: string): boolean {
    if (cache.has(id)) return cache.get(id) ?? false;
    const node = nodes.get(id);
    if (!node || visiting.has(id)) return false;
    const incoming = inbound.get(id) ?? [];
    visiting.add(id);
    const satisfied =
      (node.kind === "milestone"
        ? node.state === "planned" &&
          incoming.length + node.acceptance.length > 0 &&
          node.acceptance.every(criterionSatisfied)
        : atomicNodeSatisfied(ledger, node)) && incoming.every(edgeSatisfied);
    visiting.delete(id);
    cache.set(id, satisfied);
    return satisfied;
  }
  return { nodes, edges, edgeSatisfied, criterionSatisfied };
}
export function atomicPredecessorsPending(ledger: Ledger, plan: Plan, atomId: string): string[] {
  const { nodes, edges, edgeSatisfied } = atomicConditionEvaluator(ledger, plan);
  if (nodes.get(atomId)?.kind !== "work") return [atomId];
  return edges.flatMap((edge) =>
    edge.to_node_id === atomId && !edgeSatisfied(edge) ? [edge.from_node_id] : [],
  );
}
export function atomicDependenciesReady(ledger: Ledger, plan: Plan, taskId: string): boolean {
  const nodes = (plan.atomic_nodes ?? []) as any[];
  const edges = (plan.atomic_edges ?? []).filter((edge: any) => "from_node_id" in edge) as any[];
  const task = ledger.tasks.find((candidate) => candidate.id === taskId);
  if (!nodes.length && !edges.length)
    return !(
      ledger.contract_version >= 3 && task?.atoms.some((atom) => atom.status !== "completed")
    );
  if (!nodes.length) return false;
  const targets = nodes.filter(
    (node) => node.kind === "work" && node.scope?.kind === "task" && node.scope.task_id === taskId,
  );
  if (!targets.length) return !(task?.atoms.length && nodes.length);
  if (!edges.length && task?.atoms.length !== 1) return false;
  const taskNodes = nodes.filter(
    (node) => node.kind === "work" && node.scope?.kind === "task" && node.scope.task_id === taskId,
  );
  if (
    !task ||
    task.atoms.some((atom) => !taskNodes.some((node) => node.id === atom.id)) ||
    taskNodes.some((node) => {
      const atom = task.atoms.find((candidate) => candidate.id === node.id);
      return (
        !atom ||
        (ledger.contract_version < 6 && node.state === "completed" && atom.status !== "completed")
      );
    })
  )
    return false;
  if (
    edges.some(
      (edge) =>
        !nodes.some((node) => node.id === edge.from_node_id) ||
        !nodes.some((node) => node.id === edge.to_node_id),
    )
  )
    return false;
  if (
    ledger.contract_version < 6 &&
    task.atoms.some((atom, index) => {
      if (index === 0) return false;
      const node = taskNodes.find((candidate) => candidate.id === atom.id);
      return !node || !edges.some((edge) => edge.to_node_id === node.id);
    })
  )
    return false;
  const resumableTask = ["waiting", "blocked"].includes(taskExecutionState(task));
  return targets.some((target) => {
    if (atomicNodeSatisfied(ledger, target)) return false;
    const atom = task.atoms.find((candidate) => candidate.id === target.id);
    if (
      !atom ||
      (atom.status !== "planned" &&
        !(resumableTask && ["running", "blocked"].includes(atom.status)))
    )
      return false;
    const targetIndex = task.atoms.findIndex((candidate) => candidate.id === target.id);
    if (ledger.contract_version >= 6)
      return atomicPredecessorsPending(ledger, plan, target.id).length === 0;
    const incoming = edges.filter((edge) => edge.to_node_id === target.id);
    if (targetIndex > 0 && !incoming.length) return false;
    return incoming.every((edge) =>
      atomicNodeSatisfied(
        ledger,
        nodes.find((node) => node.id === edge.from_node_id),
      ),
    );
  });
}
export function approved(ledger: Ledger): Plan {
  const current = executionPlan(ledger);
  requireCondition(
    current.approval_id &&
      current.approval_id === ledger.control.approval_id &&
      current.lifecycle === "approved",
    "PLAN_NOT_APPROVED",
    "Execution plan is not approved",
    4,
  );
  if (deriveExecutionPhase(ledger) === "planning")
    requireCondition(
      ledger.active_plan_id === ledger.execution_plan_id,
      "PLAN_NOT_APPROVED",
      "A planning revision is awaiting approval",
      4,
    );
  return current;
}
export function authorizedAction(ledger: Ledger, action: string): void {
  const current = approved(ledger);
  const approval = ledger.events.find(
    (event) =>
      event.type === "plan_approved" &&
      event.subject_id === current.id &&
      event.data.approval_id === current.approval_id,
  );
  requireCondition(approval, "ACTION_NOT_APPROVED", `Action ${action} is not approved`, 4);
  if (ledger.contract_version >= 3)
    requireCondition(
      Array.isArray(approval.data.authorized_actions) &&
        approval.data.authorized_actions.includes(action),
      "ACTION_NOT_APPROVED",
      `Action ${action} is not approved`,
      4,
    );
}
export function legacyLedger(ledger: Ledger): boolean {
  return ledger.source_schema_version === 1 && ledger.contract_version !== 2;
}
export function deliveryUnitPr(owner: Ledger["groups"][number]): ExternalRef | null {
  if (owner.pr && "state" in owner.pr) {
    if ("pr" in owner.pr && owner.pr.pr) return owner.pr.pr;
    if (owner.pr.state === "unpublished" && owner.parent_pr) return owner.parent_pr;
    return null;
  }
  return owner.parent_pr;
}
export function taskPrRef(task: Ledger["tasks"][number]): ExternalRef | null {
  if (task.pr && "state" in task.pr) return "pr" in task.pr ? task.pr.pr : null;
  return task.pr;
}
export function isSharedDeliveryTask(ledger: Ledger, task: Ledger["tasks"][number]): boolean {
  return (
    isContributionKind(task.kind) &&
    deliveryTopologyForGroup(ledger.tasks, task.group_id) === "shared_delivery"
  );
}
/** Evidence verification uses the delivery conversation without becoming a contribution. */
export function isDeliveryVerification(task: Task): boolean {
  return (
    task.kind === "verification" &&
    task.execution_owner === "delivery_agent" &&
    task.conversation_policy === "delivery_owned" &&
    task.delivery_policy === "evidence"
  );
}
export function ownsDeliveryVerification(
  ledger: Ledger,
  task: Task,
  actor: Request["actor"],
): boolean {
  return (
    isDeliveryVerification(task) &&
    task.thread_id === null &&
    actor.role === "group" &&
    ledger.groups.some(
      (group) => group.id === task.group_id && group.agent_thread_id === actor.thread_id,
    )
  );
}
export function requireContributionDispatchGate(
  ledger: Ledger,
  owner: Ledger["groups"][number],
  requireParentPr = false,
  requireParentPrAbsenceEvidence = false,
  retryAction: "dispatch-claim" | "task-update" = "dispatch-claim",
  allowMergedContinuation = false,
): void {
  if (legacyLedger(ledger)) return;
  const workspaceAtom = owner.atoms.find((atom) => lifecycleStageOf(atom) === "workspace_ready");
  const prAtom = owner.atoms.find((atom) => lifecycleStageOf(atom) === "pr_created");
  const missing: string[] = [];
  if (owner.lifecycle.workspace_ready !== "passed" || workspaceAtom?.status !== "completed")
    missing.push("workspace_ready");
  const parentPrRequired =
    !allowMergedContinuation &&
    (requireParentPr ||
      (requireParentPrAbsenceEvidence && !parentPrDefinitivelyAbsent(ledger, owner)));
  if (parentPrRequired && !parentPrReady(ledger, owner, prAtom)) missing.push("parent_pr");
  if (missing.length)
    throw new ContractError(
      "DELIVERY_GATE_PENDING",
      missing.includes("parent_pr")
        ? "Contribution task cannot start before the delivery-unit parent PR is created and verified"
        : "Contribution task cannot start before the delivery-unit workspace is ready",
      4,
      {
        target_type: "group",
        target_id: owner.id,
        missing,
        recovery: [
          ...(missing.includes("workspace_ready")
            ? ["lifecycle-record workspace_ready", "group-atom-update workspace_ready completed"]
            : []),
          ...(missing.includes("parent_pr")
            ? [
                "publish-pr-claim + publish-pr-resolve for the parent PR",
                "group-atom-update pr_created completed",
                `retry ${retryAction}`,
              ]
            : [`retry ${retryAction}`]),
        ],
      },
    );
  if (owner.delivery_unit_kind === "regular") requireHandoffAcknowledged(ledger, owner);
}
export function ensureSchedulable(ledger: Ledger, candidate: Plan): void {
  if (legacyLedger(ledger) || ledger.source_schema_version === 1) return;
  validateTaskExecutionPolicies(ledger.tasks);
  validateSchedulablePlan(candidate);
  const scheduleIssue = theoreticalScheduleIssues(candidate)[0];
  requireCondition(
    !scheduleIssue,
    scheduleIssue?.code ?? "PLAN_NOT_SCHEDULABLE",
    scheduleIssue?.message ?? "理论排期不完整。",
    3,
  );
  if (ledger.schema_version !== 2) return;
  const contributionTasks = ledger.tasks.filter(
    (item) => item.disposition === "active" && isContributionKind(item.kind),
  );
  if (ledger.contract_version >= 3) validateDeliveryTopologies(contributionTasks, true);
  const groupIds = new Set(contributionTasks.map((item) => item.group_id));
  const missing: string[] = [];
  for (const groupId of groupIds) {
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      const planned = candidate.actions.some(
        (action) => action.kind === kind && action.group_id === groupId && action.task_id === null,
      );
      if (!planned) missing.push(`${kind}:group:${groupId}`);
    }
  }
  for (const task of contributionTasks) {
    const topology = deliveryTopologyForGroup(contributionTasks, task.group_id);
    const hasTaskPublication = candidate.actions.some((action) => action.task_id === task.id);
    if (topology === "shared_delivery") {
      requireCondition(
        !hasTaskPublication,
        "PLAN_NOT_DISPATCHABLE",
        `Shared delivery task ${task.id} must not declare a task-level PR action`,
        3,
      );
      continue;
    }
    if (!hasTaskPublication) continue;
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      const planned = candidate.actions.some(
        (action) => action.kind === kind && action.task_id === task.id && action.group_id === null,
      );
      if (!planned) missing.push(`${kind}:task:${task.id}`);
    }
  }
  requireCondition(
    missing.length === 0,
    "PLAN_NOT_DISPATCHABLE",
    `Contribution execution requires approved publication actions: ${missing.join(", ")}`,
    3,
  );
}
export function lifecycleTarget(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
): Ledger["groups"][number] | Ledger["tasks"][number] {
  return targetType === "group"
    ? find(ledger.groups, (item) => item.id === targetId, "Group")
    : find(ledger.tasks, (item) => item.id === targetId, "Task");
}
export function ownsGroup(
  ledger: Ledger,
  actor: Request["actor"],
  owner: Ledger["groups"][number],
): boolean {
  return owner.delivery_unit_kind === "bootstrap"
    ? actor.role === "main" &&
        owner.owner_kind === "main" &&
        actor.thread_id === ledger.control.owner_thread_id
    : actor.role === "group" && owner.agent_thread_id === actor.thread_id;
}
export function groupOwnerThread(ledger: Ledger, owner: Ledger["groups"][number]): string | null {
  return owner.delivery_unit_kind === "bootstrap"
    ? ledger.control.owner_thread_id
    : owner.agent_thread_id;
}
export function requireOwner(
  ledger: Ledger,
  request: Request,
  targetType: "group" | "task",
  targetId: string,
): void {
  const target = lifecycleTarget(ledger, targetType, targetId);
  if (targetType === "group")
    requireCondition(
      ownsGroup(ledger, request.actor, target as Ledger["groups"][number]),
      "FORBIDDEN",
      "Delivery-unit lifecycle belongs to its owner",
      3,
    );
  else
    requireCondition(
      request.actor.role === "task" &&
        (target as Ledger["tasks"][number]).thread_id === request.actor.thread_id,
      "FORBIDDEN",
      "Task publication belongs to its Task Agent",
      3,
    );
}
export function requireLifecycle(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
  stage: keyof Ledger["groups"][number]["lifecycle"],
): void {
  if (legacyLedger(ledger)) return;
  const target = lifecycleTarget(ledger, targetType, targetId) as any;
  requireCondition(
    target.lifecycle?.[stage] === "passed",
    "LIFECYCLE_BLOCKED",
    `${targetType} lifecycle stage ${stage} is not passed`,
    4,
  );
}
export function exactApprovedAction(
  ledger: Ledger,
  actionId: string,
  kind: "publish_branch" | "publish_pr",
  targetType: "group" | "task",
  targetId: string,
  targetIdentity: string,
): void {
  authorizedAction(ledger, kind);
  const current = approved(ledger);
  const planned = find(
    current.actions,
    (item) =>
      item.id === actionId &&
      item.kind === kind &&
      item.group_id === (targetType === "group" ? targetId : null) &&
      item.task_id === (targetType === "task" ? targetId : null) &&
      (item.target
        ? item.target.type === targetType && item.target.id === targetId
        : item.target_identity === targetIdentity),
    "Planned publication action",
  );
  // Every publication action already present in an approved implementation
  // plan inherits the implementation approval.
}
export function protectedActionApproved(
  ledger: Ledger,
  kind: "delivery_unit_merge" | "delivery_unit_recovery" | "release" | "deploy",
  targetId: string,
  approvalId: string,
  targetDigest: string | null = null,
): void {
  requireCondition(
    ledger.events.some(
      (event) =>
        event.type === "protected_action_approved" &&
        event.subject_id === targetId &&
        event.data.kind === kind &&
        event.data.approval_id === approvalId &&
        (event.data.target_digest ?? null) === targetDigest,
    ),
    "PROTECTED_ACTION_NOT_APPROVED",
    `Protected action ${kind} is not approved`,
    4,
  );
  if (kind === "delivery_unit_merge")
    requireCondition(
      !ledger.operations.some(
        (operation) =>
          operation.kind === "merge" &&
          operation.request.owner_approval_id === approvalId &&
          operation.status !== "failed",
      ),
      "PROTECTED_ACTION_REPLAY",
      `Protected action ${kind} approval has already been used`,
      4,
    );
}

export function historicalGroupLineageContains(
  ledger: Ledger,
  groupId: string,
  shaValue: string,
): boolean {
  return ledger.events.some(
    (event) =>
      event.subject_id === groupId &&
      ["group_base_reconciled", "merge_resolved", "external_merge_reconciled"].includes(
        event.type,
      ) &&
      [event.data.sha, event.data.merge_sha, event.data.current_sha].includes(shaValue),
  );
}

export function externalMergeFactId(requestId: string, suffix: "published" | "merged"): string {
  return `${requestId}-${suffix}`;
}
export function latestPublication(
  ledger: Ledger,
  targetId: string,
  kind: "branch_published" | "pr_published",
  includeContinuation = true,
): Ledger["facts"][number] | null {
  return latestPublicationFact(ledger, targetId, kind, includeContinuation);
}
export function branchReceipt(
  ledger: Ledger,
  targetId: string,
  branch: string,
  shaValue: string,
): boolean {
  const latest = latestPublication(ledger, targetId, "branch_published");
  return (
    latest?.status === "passed" &&
    latest.sha === shaValue &&
    latest.receipt?.resource_type === "branch" &&
    latest.receipt.branch === branch
  );
}
export function prReceipt(
  ledger: Ledger,
  targetId: string,
  prValue: z.infer<typeof externalRef>,
  baseSha?: string,
  headSha?: string,
  receiptState?: z.infer<typeof providerReceipt>["state"],
  includeContinuation = true,
): boolean {
  const latest = latestPublication(ledger, targetId, "pr_published", includeContinuation);
  return (
    latest?.status === "passed" &&
    latest.receipt?.resource_type === "pr" &&
    latest.receipt.pr !== null &&
    latest.receipt.pr !== undefined &&
    latest.receipt.resource_id === prValue.id &&
    stable(latest.receipt.pr) === stable(prValue) &&
    (baseSha === undefined || latest.receipt.base_sha === baseSha) &&
    (headSha === undefined || latest.receipt.head_sha === headSha) &&
    (receiptState === undefined || latest.receipt.state === receiptState)
  );
}
export function parentPrReady(
  ledger: Ledger,
  owner: Ledger["groups"][number],
  prAtom = owner.atoms.find((atom) => lifecycleStageOf(atom) === "pr_created"),
): boolean {
  const pr = deliveryUnitPr(owner);
  const canonicalState = owner.pr && "state" in owner.pr ? owner.pr.state : null;
  const receipt = latestPublication(ledger, owner.id, "pr_published", false)?.receipt;
  return (
    owner.lifecycle.pr_created === "passed" &&
    prAtom?.status === "completed" &&
    !!pr &&
    (canonicalState === null || canonicalState === "published") &&
    prReceipt(ledger, owner.id, pr, undefined, undefined, "open", false) &&
    (ledger.contract_version < 3 ||
      !receipt ||
      owner.current_sha === null ||
      receipt.target_branch === null ||
      receipt.head_sha === null ||
      (receipt.target_branch === ledger.repository.target_branch &&
        receipt.head_sha === owner.current_sha))
  );
}
function parentPrDefinitivelyAbsent(ledger: Ledger, owner: Ledger["groups"][number]): boolean {
  const latest = latestPublication(ledger, owner.id, "pr_published", false);
  const publicationPending = ledger.operations.some(
    (item) => item.kind === "publish_pr" && item.target_id === owner.id && activeOperation(item),
  );
  return Boolean(
    !publicationPending &&
      latest &&
      latest.status === "failed" &&
      latest.receipt?.resource_type === "pr" &&
      latest.receipt.state === "absent" &&
      !deliveryUnitPr(owner),
  );
}
export function requireDevelopmentTarget(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
): void {
  if (targetType === "task")
    requireCondition(
      isContributionKind(find(ledger.tasks, (item) => item.id === targetId, "Task").kind),
      "TASK_MISMATCH",
      "Lifecycle publication applies only to contribution tasks",
      3,
    );
}

export function developmentDispatch(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
  operationId: string,
): Ledger["operations"][number] {
  const operation = find(
    ledger.operations,
    (item) =>
      item.id === operationId &&
      item.kind === "dispatch" &&
      item.target_id === targetId &&
      (item.request.target_type ?? "task") === targetType,
    "Codex dispatch",
  );
  requireCondition(
    operation.status === "succeeded" &&
      operation.request.native_request_id &&
      object(operation.request.creation_parameters).transport === "codex-exec",
    "DISPATCH_NOT_READY",
    "Baseline synchronization requires a succeeded codex-exec dispatch",
    4,
  );
  const evidence = object(operation.request.creation_result).native_evidence;
  requireCondition(
    object(evidence).native_request_id === operation.request.native_request_id &&
      typeof object(evidence).workspace_path === "string" &&
      typeof object(evidence).initial_head === "string" &&
      typeof object(evidence).thread_id === "string",
    "EVIDENCE_REQUIRED",
    "Baseline synchronization requires immutable native workspace evidence",
    5,
  );
  return operation;
}

export function lineageEventMatches(
  ledger: Ledger,
  eventId: string,
  targetType: "group" | "task",
  targetId: string,
  shaValue: string,
): boolean {
  const event = ledger.events.find((item) => item.id === eventId);
  if (!event || event.subject_id !== targetId) return false;
  const snapshot = event.data.group_snapshot ? object(event.data.group_snapshot) : {};
  if (targetType === "group")
    return (
      [
        "group_updated",
        "group_base_reconciled",
        "merge_resolved",
        "external_merge_reconciled",
        "cut_applied",
      ].includes(event.type) &&
      [
        event.data.sha,
        event.data.current_sha,
        event.data.merge_sha,
        event.data.cut_sha,
        snapshot.current_sha,
        snapshot.merge_sha,
        snapshot.cut_sha,
      ].includes(shaValue)
    );
  return (
    ["task_rebased", "merge_resolved"].includes(event.type) &&
    [
      event.data.sha,
      event.data.base_sha,
      event.data.merge_sha,
      snapshot.current_sha,
      snapshot.merge_sha,
    ].includes(shaValue)
  );
}
