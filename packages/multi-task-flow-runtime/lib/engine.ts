import { migrateProfile } from "../lib/profile-migration";
import {
  effectiveProfile,
  profileFreezeReason,
  materializeRecommendation,
  RECOMMENDATION_VERSION,
} from "../lib/execution-profile";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { ContractError, requireCondition } from "../lib/errors";
import {
  changeReason,
  collectCutAssignmentEvidence,
  cutEvidence,
  baselineReceipt,
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
  task,
  validateDevPlanHandoff,
  validateInitialRuntimeState,
  validateNewTaskKinds,
  validateLedger,
  validateSchedulablePlan,
  validatePlan,
  deliveryTopologyForGroup,
  validateDeliveryTopologies,
  defaultGroupAtoms,
  executionProfile,
  recommendedExecutionProfile,
  type Ledger,
  type Plan,
  type Task,
  validateTaskExecutionPolicies,
} from "../lib/schema";
import {
  buildPlanRevision,
  deriveExecutionPhase,
  reasonRequired,
  evidenceRequired,
  revisionInput,
} from "../lib/revisions";

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

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
function object(value: unknown): Record<string, any> {
  return z.record(z.string(), z.unknown()).parse(value);
}
function string(value: unknown): string {
  return z.string().min(1).parse(value);
}
function now(): string {
  return new Date().toISOString();
}
function find<T>(
  items: T[],
  predicate: (item: T) => boolean,
  label: string,
): T {
  const found = items.find(predicate);
  requireCondition(found, "NOT_FOUND", `${label} not found`);
  return found;
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function authorize(ledger: Ledger, actor: Request["actor"]): void {
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
function onlyMain(actor: Request["actor"]): void {
  requireCondition(
    actor.role === "main",
    "FORBIDDEN",
    "Only the main conversation can perform this action",
    3,
  );
}
function activePlan(ledger: Ledger): Plan {
  return find(
    ledger.plans,
    (item) => item.id === ledger.active_plan_id,
    "Active plan",
  );
}
function executionPlan(ledger: Ledger): Plan {
  return find(
    ledger.plans,
    (item) => item.id === ledger.execution_plan_id,
    "Execution plan",
  );
}
function approved(ledger: Ledger): Plan {
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
function authorizedAction(ledger: Ledger, action: string): void {
  const current = approved(ledger);
  const approval = ledger.events.find(
    (event) =>
      event.type === "plan_approved" &&
      event.subject_id === current.id &&
      event.data.approval_id === current.approval_id,
  );
  requireCondition(
    approval,
    "ACTION_NOT_APPROVED",
    `Action ${action} is not approved`,
    4,
  );
}
function legacyLedger(ledger: Ledger): boolean {
  return ledger.source_schema_version === 1 && ledger.contract_version !== 2;
}
function deliveryUnitPr(owner: Ledger["groups"][number]): ExternalRef | null {
  if (owner.pr && "state" in owner.pr) {
    if ("pr" in owner.pr && owner.pr.pr) return owner.pr.pr;
    if (owner.pr.state === "unpublished" && owner.parent_pr) return owner.parent_pr;
    return null;
  }
  return owner.parent_pr;
}
function taskPrRef(task: Ledger["tasks"][number]): ExternalRef | null {
  if (task.pr && "state" in task.pr) return "pr" in task.pr ? task.pr.pr : null;
  return task.pr;
}
function isSharedDeliveryTask(
  ledger: Ledger,
  task: Ledger["tasks"][number],
): boolean {
  return (
    isContributionKind(task.kind) &&
    deliveryTopologyForGroup(ledger.tasks, task.group_id) === "shared_delivery"
  );
}
function requireContributionDispatchGate(
  ledger: Ledger,
  owner: Ledger["groups"][number],
  requireParentPr = true,
  retryAction: "dispatch-claim" | "task-update" = "dispatch-claim",
): void {
  if (legacyLedger(ledger)) return;
  const workspaceAtom = owner.atoms.find((atom) => atom.lifecycle_stage === "workspace_ready");
  const prAtom = owner.atoms.find((atom) => atom.lifecycle_stage === "pr_created");
  const missing: string[] = [];
  if (owner.lifecycle.workspace_ready !== "passed" || workspaceAtom?.status !== "completed")
    missing.push("workspace_ready");
  const parentPrRequired = requireParentPr || !parentPrDefinitivelyAbsent(ledger, owner);
  if (parentPrRequired && !parentPrReady(ledger, owner, prAtom))
    missing.push("parent_pr");
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
          ...(missing.includes("workspace_ready") ? [
            "lifecycle-record workspace_ready",
            "group-atom-update workspace_ready completed",
          ] : []),
          ...(missing.includes("parent_pr") ? [
            "publish-pr-claim + publish-pr-resolve for the parent PR",
            "group-atom-update pr_created completed",
            `retry ${retryAction}`,
          ] : [`retry ${retryAction}`]),
        ],
      },
    );
  if (owner.delivery_unit_kind === "regular")
    requireHandoffAcknowledged(ledger, owner);
}
function ensureSchedulable(ledger: Ledger, candidate: Plan): void {
  if (legacyLedger(ledger) || ledger.source_schema_version === 1) return;
  validateTaskExecutionPolicies(ledger.tasks);
  validateSchedulablePlan(candidate);
  if (ledger.schema_version !== 2) return;
  const contributionTasks = ledger.tasks.filter(
    (item) => item.disposition === "active" && isContributionKind(item.kind),
  );
  if (ledger.contract_version >= 3)
    validateDeliveryTopologies(contributionTasks, true);
  const groupIds = new Set(contributionTasks.map((item) => item.group_id));
  const missing: string[] = [];
  for (const groupId of groupIds) {
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      const planned = candidate.actions.some(
        (action) =>
          action.kind === kind &&
          action.group_id === groupId &&
          action.task_id === null,
      );
      if (!planned) missing.push(`${kind}:group:${groupId}`);
    }
  }
  for (const task of contributionTasks) {
    const topology = deliveryTopologyForGroup(contributionTasks, task.group_id);
    const hasTaskPublication = candidate.actions.some(
      (action) => action.task_id === task.id,
    );
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
        (action) =>
          action.kind === kind &&
          action.task_id === task.id &&
          action.group_id === null,
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
function lifecycleTarget(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
): Ledger["groups"][number] | Ledger["tasks"][number] {
  return targetType === "group"
    ? find(ledger.groups, (item) => item.id === targetId, "Group")
    : find(ledger.tasks, (item) => item.id === targetId, "Task");
}
function ownsGroup(
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
function groupOwnerThread(
  ledger: Ledger,
  owner: Ledger["groups"][number],
): string | null {
  return owner.delivery_unit_kind === "bootstrap"
    ? ledger.control.owner_thread_id
    : owner.agent_thread_id;
}
function requireOwner(
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
        (target as Ledger["tasks"][number]).thread_id ===
          request.actor.thread_id,
      "FORBIDDEN",
      "Task publication belongs to its Task Agent",
      3,
    );
}
function requireLifecycle(
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
function exactApprovedAction(
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
function protectedActionApproved(
  ledger: Ledger,
  kind: "delivery_unit_merge" | "release" | "deploy",
  targetId: string,
  approvalId: string,
): void {
  requireCondition(
    ledger.events.some(
      (event) =>
        event.type === "protected_action_approved" &&
        event.subject_id === targetId &&
        event.data.kind === kind &&
        event.data.approval_id === approvalId,
    ),
    "PROTECTED_ACTION_NOT_APPROVED",
    `Protected action ${kind} is not approved`,
    4,
  );
}
function latestPublication(
  ledger: Ledger,
  targetId: string,
  kind: "branch_published" | "pr_published",
): Ledger["facts"][number] | null {
  return (
    ledger.facts
      .filter((item) => item.kind === kind && item.subject_id === targetId)
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
      .at(-1) ?? null
  );
}
function branchReceipt(
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
function prReceipt(
  ledger: Ledger,
  targetId: string,
  prValue: z.infer<typeof externalRef>,
  baseSha?: string,
  headSha?: string,
  receiptState?: z.infer<typeof providerReceipt>["state"],
): boolean {
  const latest = latestPublication(ledger, targetId, "pr_published");
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
function parentPrReady(
  ledger: Ledger,
  owner: Ledger["groups"][number],
  prAtom = owner.atoms.find((atom) => atom.lifecycle_stage === "pr_created"),
): boolean {
  const pr = deliveryUnitPr(owner);
  const canonicalState = owner.pr && "state" in owner.pr ? owner.pr.state : null;
  return (
    owner.lifecycle.pr_created === "passed" &&
    prAtom?.status === "completed" &&
    !!pr &&
    (canonicalState === null || canonicalState === "published") &&
    prReceipt(ledger, owner.id, pr, undefined, undefined, "open")
  );
}
function parentPrDefinitivelyAbsent(
  ledger: Ledger,
  owner: Ledger["groups"][number],
): boolean {
  const latest = latestPublication(ledger, owner.id, "pr_published");
  const publicationPending = ledger.operations.some(
    (item) =>
      item.kind === "publish_pr" &&
      item.target_id === owner.id &&
      activeOperation(item),
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
function requireDevelopmentTarget(
  ledger: Ledger,
  targetType: "group" | "task",
  targetId: string,
): void {
  if (targetType === "task")
    requireCondition(
      isContributionKind(
        find(ledger.tasks, (item) => item.id === targetId, "Task").kind,
      ),
      "TASK_MISMATCH",
      "Lifecycle publication applies only to contribution tasks",
      3,
    );
}

function developmentDispatch(
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

function lineageEventMatches(
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
    return ["group_updated", "group_base_reconciled", "merge_resolved", "cut_applied"].includes(event.type) &&
      [event.data.sha, event.data.current_sha, event.data.merge_sha, event.data.cut_sha,
        snapshot.current_sha, snapshot.merge_sha, snapshot.cut_sha].includes(shaValue);
  return ["task_rebased", "merge_resolved"].includes(event.type) &&
    [event.data.sha, event.data.base_sha, event.data.merge_sha,
      snapshot.current_sha, snapshot.merge_sha].includes(shaValue);
}
function addEvent(
  ledger: Ledger,
  request: Request,
  type: Ledger["events"][number]["type"],
  subject: string,
  data: Record<string, unknown>,
  occurredAt: string | null = now(),
): void {
  ledger.events.push({
    id: request.request_id,
    type,
    subject_id: subject,
    actor_id: request.actor.thread_id,
    occurred_at: occurredAt,
    recorded_at: now(),
    data,
  });
}
function boundConversation(ledger: Ledger, threadId: string): boolean {
  return (
    ledger.control.owner_thread_id === threadId ||
    ledger.groups.some((item) => item.agent_thread_id === threadId) ||
    ledger.tasks.some((item) => item.thread_id === threadId)
  );
}
function notificationDirective(
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
  if (
    mode === "auto" &&
    !ledger.control.owner_thread_id &&
    option?.recipient === undefined
  )
    return { enabled: false, recipient_thread_id: null };
  const recipient = option?.recipient ?? "owner";
  const threadId =
    recipient === "owner"
      ? ledger.control.owner_thread_id
      : recipient.thread_id;
  requireCondition(
    !!threadId,
    "RECIPIENT_UNBOUND",
    "Notification recipient is not bound",
    3,
  );
  requireCondition(
    boundConversation(ledger, threadId!),
    "RECIPIENT_UNBOUND",
    "Notification recipient is not bound to this run",
    3,
  );
  requireNotificationRecipientActive(ledger, threadId!);
  return { enabled: true, recipient_thread_id: threadId! };
}
function requireNotificationRecipientActive(ledger: Ledger, threadId: string): void {
  requireCondition(!ledger.resources.some(resource => resource.kind === "conversation" && resource.target === threadId && ["closed", "archive_unknown", "unarchive_unknown", "unarchive_failed"].includes(resource.status)), "CONVERSATION_ARCHIVED", "通知接收对话已归档或归档状态未知，请先手动取消归档或完成对账", 4);
}
function addNotificationIntent(
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
function requiresNativeDelivery(ledger: Ledger, notificationId: string): boolean {
  return ledger.operations.some(op => op.request.handoff_notification_id === notificationId) ||
    ledger.events.some(event => event.data.notification_id === notificationId && event.data.provider === "codex-app-tools");
}
function notificationDeliveryRequest(
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
function addOperation(
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
function activeOperation(item: Ledger["operations"][number]): boolean {
  return item.status === "claimed" || item.status === "unknown";
}
function creationObservations(op: Ledger["operations"][number], payload: Record<string, any>) {
  const observed: Record<string, any> = { ...object(op.request.creation_observations ?? {}) };
  const previous = object(op.request.creation_result ?? {});
  for (const report of [{ thread_id: op.request.observed_thread_id }, previous,
    object(previous.native_evidence ?? {}), payload, object(payload.native_evidence ?? {})]) {
    for (const key of ["thread_id", "workspace_path", "initial_head"]) {
      const value = report[key];
      if (typeof value !== "string" || !value) continue;
      requireCondition(!observed[key] || observed[key] === value, "CREATION_EVIDENCE_CONFLICT",
        "Known creation identity and resources cannot change", 5);
      observed[key] = value;
    }
    if (report.process_started === true || report.resources_created === true ||
      report.turn_completed === true || report.exit_code != null ||
      (Array.isArray(report.events) && report.events.length > 0)) observed.process_observed = true;
  }
  return observed;
}
function publicationPendingForGroup(ledger: Ledger, groupId: string): boolean {
  const taskIds = ledger.tasks
    .filter((item) => item.group_id === groupId)
    .map((item) => item.id);
  return ledger.operations.some(
    (item) =>
      [groupId, ...taskIds].includes(item.target_id) &&
      ["publish_branch", "publish_pr"].includes(item.kind) &&
      activeOperation(item),
  );
}
function checkPR(ledger: Ledger, pr: z.infer<typeof externalRef>): void {
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

const groupBaseReconciliation = z
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
function currentRuleGroup(ledger: Ledger, initialGroup: string): string {
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

function subjectSha(ledger: Ledger, subjectId: string): string | null {
  const group = ledger.groups.find((item) => item.id === subjectId);
  if (group) return group.merge_sha ?? group.current_sha;
  const task = ledger.tasks.find((item) => item.id === subjectId);
  if (!task) return null;
  const owner = ledger.groups.find((item) => item.id === task.group_id);
  return owner?.merge_sha ?? owner?.current_sha ?? task.base_sha;
}

function latestFact(
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
          left.item.observed_at.localeCompare(right.item.observed_at) ||
          left.index - right.index,
      )
      .at(-1)?.item ?? null
  );
}

function factSatisfied(
  ledger: Ledger,
  subjectId: string,
  kind: Ledger["facts"][number]["kind"],
): boolean {
  const latest = latestFact(ledger, subjectId, kind);
  if (latest?.status !== "passed" || !latest.sha) return false;
  const task = ledger.tasks.find((item) => item.id === subjectId);
  if (!task) {
    const expectedSha = subjectSha(ledger, subjectId);
    return !!expectedSha && latest.sha === expectedSha;
  }
  if (kind === "pr_merged") {
    return ledger.operations.some(
      (item) =>
        item.kind === "merge" &&
        item.target_id === task.group_id &&
        item.status === "succeeded" &&
        item.receipt_fact_id === latest.id &&
        item.request.mode === "child" &&
        item.request.task_id === subjectId,
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
    return receipt
      ? receipt.expected_sha === sourceSha
      : latest.sha === sourceSha;
  }
  return latest.sha === sourceSha;
}

function factKind(
  requires: PlanEdge["requires"],
): Ledger["facts"][number]["kind"] | null {
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

function nodeSatisfied(
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

function edgeSatisfied(
  ledger: Ledger,
  edge: PlanEdge,
  nodes: Map<string, PlanNode>,
  edges: PlanEdge[],
  visiting: Set<string>,
): boolean {
  const source = nodes.get(edge.from_node_id);
  if (!source) return false;
  if (source.kind === "main_start")
    return nodeSatisfied(ledger, source, nodes, edges, visiting);
  if (source.kind === "task" && source.ref_id) {
    const sourceTask = ledger.tasks.find((item) => item.id === source.ref_id);
    if (!sourceTask) return false;
    if (edge.requires === "integrated")
      return ["integrated", "closed"].includes(sourceTask.state);
    if (edge.requires === "completed")
      return ["completed", "closed"].includes(sourceTask.state);
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
  const target = currentPlan.nodes.find(
    (item) => item.kind === "task" && item.ref_id === taskId,
  );
  if (!target) return false;
  const nodes = new Map(currentPlan.nodes.map((item) => [item.id, item]));
  return nodeSatisfied(ledger, target, nodes, currentPlan.edges, new Set());
}

function deliveryUnitPrMerged(group: Ledger["groups"][number]): boolean {
  const canonicalPrState = group.pr && "state" in group.pr ? group.pr.state : null;
  return Boolean(
    group.state === "merged" &&
      group.merge_sha &&
      group.lifecycle.pr_merged === "passed" &&
      (canonicalPrState === null || canonicalPrState === "merged"),
  );
}

function requireHandoffAcknowledged(
  ledger: Ledger,
  group: Ledger["groups"][number],
): void {
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
export function requireGroupDispatchGate(
  ledger: Ledger,
  target: Ledger["groups"][number],
): void {
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
      if (source?.group_id && source.group_id !== target.id)
        upstreamGroupIds.add(source.group_id);
    }
  }
  const missingUpstream = [...upstreamGroupIds].filter((groupId) => {
    const upstream = ledger.groups.find((item) => item.id === groupId);
    return !upstream || !deliveryUnitPrMerged(upstream);
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
        recovery: ["complete the upstream delivery-unit PR merge lifecycle", "retry dispatch-group-claim"],
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

function ownerOfTask(ledger: Ledger, request: Request, taskId: string): void {
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
    const owner = find(
      ledger.groups,
      (item) => item.id === target.group_id,
      "Group",
    );
    requireCondition(
      owner.agent_thread_id === request.actor.thread_id,
      "FORBIDDEN",
      "Task belongs to another group",
      3,
    );
  }
}

function taskExecutionState(task: { state: string; agent_resume_state?: "starting" | "running" }): string {
  return task.state === "agent_idle" ? task.agent_resume_state ?? "running" : task.state;
}

function taskRuntimeState(task: Task): Record<string, unknown> {
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

function taskBoundary(task: Task): Record<string, unknown> {
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

function hasTaskStarted(ledger: Ledger, taskId: string): boolean {
  return ledger.events.some(
    (event) =>
      event.type === "task_started" &&
      (event.subject_id === taskId || event.data.task_id === taskId),
  );
}

function groupRuntimeState(
  item: Ledger["groups"][number],
): Record<string, unknown> {
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

function validateRevisionReason(revision: NonNullable<Plan["revision"]>): void {
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

export function execute(
  ledger: Ledger,
  command: string,
  request: Request,
): unknown {
  if (command !== "binding-resolve") authorize(ledger, request.actor);
  const payload = request.payload;
  const currentPlan = () => approved(ledger);
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
        if (
          !ledger.groups.some((old) => old.id === item.id) &&
          !item.execution_profile_source
        )
          materializeRecommendation(ledger, item);
      for (const item of tasks)
        if (
          !ledger.tasks.some((old) => old.id === item.id) &&
          !item.execution_profile_source
        )
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
      validatePlan(proposed);
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
          stable(taskRuntimeState(existing)) ===
            stable(taskRuntimeState(incoming)),
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
            stable(existing.execution_profile) ===
              stable(incoming.execution_profile),
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
            stable(groupRuntimeState(existing)) ===
              stable(groupRuntimeState(incoming)),
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
            stable(existing.execution_profile) ===
              stable(incoming.execution_profile),
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
        (incoming) =>
          !ledger.groups.some((existing) => existing.id === incoming.id),
      );
      requireCondition(
        newGroups.every(
          (incoming) =>
            incoming.delivery_unit_kind === "regular" &&
            incoming.owner_kind === "group",
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
          revision.change_class === "implementation_low_impact"
            ? proposed.approval_id
            : null;
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
      const current = find(
        ledger.plans,
        (item) => item.id === string(payload.plan_id),
        "Plan",
      );
      requireCondition(
        current.id === ledger.active_plan_id &&
          current.lifecycle === "proposed" &&
          !current.approval_id,
        "INVALID_PLAN",
        "Only the active proposed plan can be approved",
      );
      ensureSchedulable(ledger, current);
      const previousExecution = current.supersedes_id
        ? (ledger.plans.find((item) => item.id === current.supersedes_id) ??
          null)
        : ledger.execution_plan_id === current.id
          ? null
          : executionPlan(ledger);
      current.approval_id = string(payload.approval_id);
      current.lifecycle = "approved";
      const authorizedActionIds = z
        .array(id)
        .parse(payload.authorized_action_ids);
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
        .enum(["delivery_unit_merge", "release", "deploy"])
        .parse(payload.kind);
      const targetId = parse(id, payload.target_id);
      const approvalId = string(payload.approval_id);
      if (kind === "delivery_unit_merge")
        find(ledger.groups, (item) => item.id === targetId, "Delivery unit");
      else
        find(ledger.tasks, (item) => item.id === targetId, "Protected task");
      addEvent(ledger, request, "protected_action_approved", targetId, {
        kind,
        approval_id: approvalId,
        target_digest: payload.target_digest ?? null,
      });
      return { target_id: targetId, kind, approval_id: approvalId };
    }
    case "plan-abandon": {
      onlyMain(request.actor);
      const current = find(
        ledger.plans,
        (item) => item.id === string(payload.plan_id),
        "Plan",
      );
      requireCondition(
        current.id === ledger.active_plan_id &&
          current.lifecycle === "proposed",
        "INVALID_PLAN",
        "Only the active proposed plan can be abandoned",
      );
      const restore = find(
        ledger.plans,
        (item) => item.id === current.supersedes_id,
        "Superseded plan",
      );
      for (const owner of ledger.groups) {
        const definitions = restore.group_atoms.filter(
          (atom) => atom.group_id === owner.id,
        );
        if (
          definitions.length ||
          current.group_atoms.some((atom) => atom.group_id === owner.id)
        ) {
          const statuses = new Map(
            owner.atoms.map((atom) => [atom.id, atom.status]),
          );
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
      const oldTask = find(
        ledger.tasks,
        (item) => item.id === oldTaskId,
        "Old task",
      );
      const newTask = find(
        ledger.tasks,
        (item) => item.id === newTaskId,
        "New task",
      );
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
        newTask.state === "planned" &&
          newTask.thread_id === null &&
          newTask.started_at === null,
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
        inherited_outputs: z
          .array(z.string().min(1))
          .parse(payload.inherited_outputs ?? []),
        uninherited_outputs: z
          .array(z.string().min(1))
          .parse(payload.uninherited_outputs ?? []),
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
      const target = find(
        ledger.tasks,
        (item) => item.id === string(payload.task_id),
        "Task",
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
      const owner = find(
        ledger.groups,
        (item) => item.id === target.group_id,
        "Group",
      );
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
          owner.state === "active",
          "GROUP_NOT_READY",
          "Task group is not active",
          4,
        );
      }
      if (isContributionKind(target.kind)) {
        requireContributionDispatchGate(ledger, owner);
        requireCondition(
          owner.parent_branch &&
            target.base_sha &&
            owner.current_sha === target.base_sha,
          "BASE_NOT_READY",
          "Contribution task requires the current delivery-unit base",
          4,
        );
        requireCondition(
          legacyLedger(ledger) ||
            (owner.lifecycle.workspace_ready === "passed" &&
              branchReceipt(
                ledger,
                owner.id,
                owner.parent_branch,
                owner.current_sha,
              )),
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
            item.kind === "dispatch" &&
            item.target_id === target.id &&
            activeOperation(item),
        ),
        "OPERATION_PENDING",
        "Task already has a dispatch claim",
        4,
      );
      const running = ledger.tasks.filter((item) =>
        ["starting", "running", "agent_idle"].includes(item.state),
      ).length;
      const pending = ledger.operations.filter(
        (item) =>
          item.kind === "dispatch" &&
          item.request.target_type !== "group" &&
          activeOperation(item),
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
      const target = find(
        ledger.groups,
        (item) => item.id === string(payload.group_id),
        "Group",
      );
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
        (item) =>
          item.id === string(payload.operation_id) && item.kind === "dispatch",
        "Dispatch",
      );
      requireCondition(
        activeOperation(op),
        "OPERATION_TERMINAL",
        "Dispatch is already resolved",
        3,
      );
      const outcome = z
        .enum(["succeeded", "failed", "unknown"])
        .parse(payload.outcome);
      const target =
        op.request.target_type === "group"
          ? null
          : find(ledger.tasks, (item) => item.id === op.target_id, "Task");
      const targetGroup =
        op.request.target_type === "group"
          ? find(ledger.groups, (item) => item.id === op.target_id, "Group")
          : null;
      if (targetGroup && ledger.contract_version >= 3)
        requireGroupDispatchGate(ledger, targetGroup);
      const evidence = object(payload.native_evidence ?? {});
      const observed = creationObservations(op, payload);
      if (outcome === "failed") requireCondition(Object.keys(observed).length === 0,
        "UNKNOWN_REQUIRES_RECONCILIATION", "Known creation identity, resources or execution require reconciliation", 5);
      if (outcome === "succeeded" && evidence.native_tool_name === "codex exec") requireCondition(
        object(op.request.creation_parameters ?? {}).transport === "codex-exec",
        "TRANSPORT_REQUIRED", "Codex exec success requires bound native transport for baseline readiness", 5);
      if (op.request.execution_profile && outcome !== "unknown") {
        requireCondition(
          evidence.source === "multi-task-flow-cli" &&
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
      if ((op.request.creation_parameters as any)?.transport === "codex-exec" && outcome !== "unknown")
        requireCondition(evidence.native_tool_name === "codex exec", "EVIDENCE_REQUIRED", "CLI dispatch requires real exec evidence", 5);
      if (ledger.contract_version >= 3 && outcome !== "unknown")
        requireCondition(
          evidence.source === "multi-task-flow-cli" &&
            evidence.native_tool_name === "codex exec" &&
            object(op.request.creation_parameters ?? {}).transport === "codex-exec",
          "EVIDENCE_REQUIRED",
          "Contract-3 dispatches must be created through the multi-task-flow codex exec path",
          5,
        );
      if (evidence.native_tool_name === "codex exec" && outcome === "failed") requireCondition(!op.request.observed_thread_id &&
        !payload.thread_id && !evidence.thread_id && !evidence.workspace_path && !evidence.initial_head && !evidence.turn_completed &&
        evidence.process_started === false && evidence.resources_created === false,
        "UNKNOWN_REQUIRES_RECONCILIATION", "Only proven pre-creation failure may release a CLI dispatch; observed identities require reconciliation", 5);
      if (evidence.native_tool_name === "codex exec" && outcome === "succeeded") {
        requireCondition(evidence.exit_code === 0 && evidence.turn_completed === true &&
          typeof evidence.workspace_path === "string" && evidence.workspace_path.length > 0 &&
          typeof evidence.initial_head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.initial_head) &&
          op.request.observed_thread_id === payload.thread_id && evidence.thread_id === payload.thread_id,
          "EVIDENCE_REQUIRED", "CLI exit, initialization, observed identity and workspace evidence required", 5);
      }
      op.request.creation_observations = observed;
      if (outcome === "unknown" && observed.thread_id) op.request.observed_thread_id = observed.thread_id;
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
            ? object(payload.native_evidence).source === "multi-task-flow-cli" &&
              object(payload.native_evidence).native_tool_name === "codex exec"
            : ["create_thread", "multi-task-flow-cli"].includes(object(payload.native_evidence).source),
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
            ["create_thread", "multi-task-flow-cli"].includes(
              evidence.source,
            ) &&
            evidence.operation_id === op.id &&
            evidence.native_request_id === op.request.native_request_id &&
            (evidence.native_tool_name === "create_thread" ||
              evidence.native_tool_name === "thread/start" || evidence.native_tool_name === "codex exec") &&
            typeof evidence.error === "string" &&
            evidence.error.length > 0,
          "EVIDENCE_REQUIRED",
          "Matching native request and failure evidence required",
          5,
        );
      }
      op.status = outcome;
      op.updated_at = now();
      const threadId =
        target?.thread_id ?? targetGroup?.agent_thread_id ?? null;
      addEvent(ledger, request, "thread_bound", op.target_id, {
        operation_id: op.id,
        outcome,
        thread_id: threadId,
        group_snapshot: targetGroup ? structuredClone(targetGroup) : null,
      });
      const handoffNotice = outcome === "succeeded" && (op.request.creation_parameters as any)?.transport === "codex-exec"
        ? addNotificationIntent(ledger, { ...request, request_id: `${request.request_id}-creation` }, threadId!) : null;
      if (handoffNotice) op.request.handoff_notification_id = handoffNotice.id;
      return { operation_id: op.id, outcome, thread_id: threadId,
        ...(handoffNotice ? { notification_request: notificationDeliveryRequest(handoffNotice) } : {}) };
    }
    case "execution-profile-migrate": {
      onlyMain(request.actor);
      migrateProfile(ledger, payload.execution_profile);
      addEvent(
        ledger,
        request,
        "execution_profile_migrated",
        ledger.orchestration_id,
        { execution_profile: ledger.config.execution_profile },
      );
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
          if (
            !target.execution_profile &&
            profileFreezeReason(ledger, type, target.id)
          )
            target.execution_profile = effectiveProfile(ledger, target);
        }
      }
      ledger.config.execution_profile = profile;
      for (const op of ledger.operations.filter(
        (item) =>
          item.kind === "dispatch" &&
          activeOperation(item) &&
          !item.request.native_request_id,
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
      addEvent(
        ledger,
        request,
        "execution_profile_default_updated",
        ledger.orchestration_id,
        { previous_profile: previous, execution_profile: profile },
      );
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
          (item.request.target_type === "group" ? "group" : "task") ===
            targetType &&
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
            reason: recommendation
              ? "recommendation_reapplied"
              : "execution_profile_changed",
            previous_profile: previous,
            previous_effective_profile: effectiveProfile(ledger, target),
            execution_profile: profile,
            requires_new_claim: true,
          },
        );
      }
      target.execution_profile = profile;
      target.execution_profile_source = recommendation
        ? "recommendation"
        : "manual";
      target.execution_profile_rule = recommendation
        ? RECOMMENDATION_VERSION
        : null;
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
      const op = find(ledger.operations, item => item.id === string(payload.operation_id) && item.kind === "dispatch", "Dispatch");
      requireCondition(activeOperation(op) && op.request.native_request_id === payload.native_request_id,
        "NATIVE_REQUEST_CONFLICT", "Progress must match the active creation request", 3);
      const threadId = string(payload.thread_id);
      requireCondition(!op.request.observed_thread_id || op.request.observed_thread_id === threadId,
        "THREAD_CONFLICT", "Creation reported conflicting thread identities", 3);
      op.request.observed_thread_id = threadId;
      addEvent(ledger, request, "dispatch_thread_observed", op.target_id, { operation_id: op.id, thread_id: threadId });
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
        !op.request.native_request_id ||
          op.request.native_request_id === nativeId,
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
            find(ledger.groups, (item) => item.id === (dispatchTarget as Ledger["tasks"][number]).group_id, "Group"),
          );
        requireCondition(
          object(payload.creation_parameters ?? {}).transport === "codex-exec",
          "TRANSPORT_REQUIRED",
          "Contract-3 dispatches must bind the multi-task-flow codex exec transport",
          5,
        );
      }
      requireCondition(
        stable(op.request.execution_profile) ===
          stable(effectiveProfile(ledger, dispatchTarget)),
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
        requireCondition(!op.request.native_request_id || stable(op.request.creation_parameters) === stable(parameters),
          "NATIVE_REQUEST_CONFLICT", "Creation parameters are frozen after native request binding", 3);
        op.request.creation_parameters = parameters;
      }
      op.request.native_request_id = nativeId;
      if ((op.request.creation_parameters as any)?.transport === "codex-exec") op.status = "unknown";
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
      const dispatch = developmentDispatch(
        ledger,
        targetType,
        targetId,
        dispatchOperationId,
      );
      const baseline = parse(baselineReceipt, payload.baseline);
      requireCondition(
        baseline.sha === baseline.head,
        "BASELINE_MISMATCH",
        "Workspace HEAD must match the verified development baseline",
        4,
      );
      const currentBaseline = dispatch.request.development_baseline;
      const expectedPrevious = payload.expected_previous_baseline === null
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
      const owner = targetType === "group"
        ? target
        : find(ledger.groups, (item) => item.id === target.group_id, "Group");
      const postMerge =
        targetType === "task" &&
        ["release", "deployment", "verification"].includes(target.kind);
      const expectedLineage = targetType === "group"
        ? target.current_sha
        : postMerge
          ? owner.merge_sha
          : owner.current_sha;
      const expectedLineageSha = payload.expected_lineage_sha === null
        ? null
        : parse(z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), payload.expected_lineage_sha);
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
          targetLineageEvent || groupLineageEvent,
        "LINEAGE_MISMATCH",
        "Synchronization must reference the fact that established the target lineage",
        5,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            (item.target_id === targetId || (targetType === "task" && item.target_id === owner.id)) &&
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
        resources.some((resource) => resource.kind === "worktree" && resource.target === targetId && resource.status === "active"),
        "WORKSPACE_NOT_READY",
        "Baseline synchronization requires an active target worktree",
        4,
      );
      requireCondition(
        resources.some((resource) => resource.kind === "branch" && resource.target === branch && resource.status === "active"),
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
      const previousBaseline = currentBaseline === undefined ? null : parse(baselineReceipt, currentBaseline);
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
        find(
          ledger.resources,
          (resource) => resource.id === resourceId,
          "Workspace resource",
        ),
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
      const cliDispatch = ledger.operations.find(op => op.kind === "dispatch" && op.target_id === targetId && (op.request.target_type ?? "task") === targetType &&
        (op.request.creation_parameters as any)?.transport === "codex-exec" && op.status === "succeeded");
      if (cliDispatch) {
        const baseline = parse(baselineReceipt, payload.baseline);
        requireCondition(baseline.sha === baseline.head, "BASELINE_MISMATCH", "Align HEAD to the verified baseline before development", 4);
        requireCondition(!cliDispatch.request.development_baseline || stable(cliDispatch.request.development_baseline) === stable(baseline),
          "BASELINE_CONFLICT", "Creation baseline is immutable; use the explicit synchronization workflow", 4);
        if (ledger.contract_version === 3)
          requireCondition(!!cliDispatch.request.development_baseline,
            "BASELINE_REQUIRED", "Record the development baseline before lifecycle readiness", 4);
        if (targetType === "group") {
          requireCondition(!!baseline.fetched_at && Date.parse(baseline.fetched_at) >= Date.parse(cliDispatch.created_at),
            "BASELINE_REQUIRED", "Group baseline requires a fresh remote fetch receipt after dispatch", 4);
          if (ledger.contract_version === 3)
            requireCondition(target.current_sha === baseline.sha,
              "BASELINE_NOT_VERIFIED", "Workspace baseline no longer matches the current group lineage", 4);
          if (!cliDispatch.request.development_baseline && ledger.contract_version !== 3) target.current_sha = baseline.sha;
        } else {
          const group = find(ledger.groups, g => g.id === target.group_id, "Group");
          const postMerge = ["release", "deployment", "verification"].includes(target.kind);
          requireCondition(
            postMerge ? group.state === "merged" && group.merge_sha === baseline.sha : group.current_sha === baseline.sha,
            "BASELINE_MISMATCH",
            postMerge ? "Post-merge task baseline must match the merged parent SHA" : "Task baseline must match its group parent SHA",
            4,
          );
          target.base_sha = baseline.sha;
        }
        if (ledger.contract_version !== 3) cliDispatch.request.development_baseline = baseline;
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
          ? target.state === "active"
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
            item.kind === "publish_branch" &&
            item.target_id === targetId &&
            activeOperation(item),
        ),
        "OPERATION_PENDING",
        "Branch publication is already pending",
        4,
      );
      const op = addOperation(
        ledger,
        request,
        "publish_branch",
        targetId,
        expectedSha,
      );
      op.request.target_type = targetType;
      op.request.branch = branch;
      op.request.expected_head_sha = expectedSha;
      op.request.expected_base_sha =
        targetType === "group" ? target.current_sha : target.base_sha;
      op.request.action_id = payload.action_id;
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
        (item) =>
          item.id === string(payload.operation_id) &&
          item.kind === "publish_branch",
        "Branch publication",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "Branch publication claim is not active or belongs to another actor",
        3,
      );
      const outcome = z
        .enum(["succeeded", "failed", "unknown"])
        .parse(payload.outcome);
      if (outcome === "succeeded") {
        const receipt = providerReceipt.parse(
          payload.provider_receipt ?? payload.provider_observation,
        );
        requireCondition(
          receipt.provider === ledger.repository.provider &&
            receipt.repository ===
              `${ledger.repository.owner}/${ledger.repository.name}` &&
            receipt.resource_type === "branch" &&
            receipt.resource_id === op.request.branch &&
            receipt.branch === op.request.branch &&
            receipt.target_branch === null &&
            (receipt.base_sha === null ||
              receipt.base_sha === op.request.expected_base_sha) &&
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
        const targetType = z
          .enum(["group", "task"])
          .parse(op.request.target_type);
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
            receipt.repository ===
              `${ledger.repository.owner}/${ledger.repository.name}` &&
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
      const branch = string(payload.branch);
      const headSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.expected_head_sha);
      requireCondition(
        targetType === "group"
          ? target.state === "active"
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
        targetType === "group"
          ? target.current_sha === headSha
          : target.base_sha === baseSha,
        "BASE_CHANGED",
        "PR publication does not match the current branch lineage",
        5,
      );
      const pr = parse(externalRef, payload.pr);
      checkPR(ledger, pr);
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
            item.kind === "publish_pr" &&
            item.target_id === targetId &&
            activeOperation(item),
        ),
        "OPERATION_PENDING",
        "PR publication is already pending",
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
        (item) =>
          item.id === string(payload.operation_id) &&
          item.kind === "publish_pr",
        "PR publication",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "PR publication claim is not active or belongs to another actor",
        3,
      );
      const outcome = z
        .enum(["succeeded", "failed", "unknown"])
        .parse(payload.outcome);
      if (outcome === "succeeded") {
        const receipt = providerReceipt.parse(
          payload.provider_receipt ?? payload.provider_observation,
        );
        const requestedPr = parse(externalRef, op.request.pr);
        requireCondition(
          receipt.provider === ledger.repository.provider &&
            receipt.repository ===
              `${ledger.repository.owner}/${ledger.repository.name}` &&
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
        });
        ledger.facts.push(observed);
        op.receipt_fact_id = observed.id;
        const targetType = z
          .enum(["group", "task"])
          .parse(op.request.target_type);
        const target = lifecycleTarget(ledger, targetType, op.target_id) as any;
        requireCondition(
          (targetType === "group" ? target.current_sha : target.base_sha) ===
            (targetType === "group"
              ? op.request.expected_head_sha
              : op.request.expected_base_sha),
          "BASE_CHANGED",
          "PR lineage changed while publication was pending",
          5,
        );
        if (targetType === "group") {
          if (ledger.contract_version !== 3) target.parent_pr = receipt.pr;
          else target.pr = {
              state: "published",
              pr: receipt.pr,
              parent_branch: op.request.branch,
            };
        } else {
          requireCondition(
            typeof target.branch === "string" && target.branch.length > 0 &&
              typeof op.request.target_branch === "string" && op.request.target_branch.length > 0,
            "TASK_PR_BINDING_INCOMPLETE",
            "Task PR publication requires task branch and base branch facts",
            4,
          );
          target.pr = ledger.contract_version !== 3
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
            receipt.repository ===
              `${ledger.repository.owner}/${ledger.repository.name}` &&
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
        const targetType = z
          .enum(["group", "task"])
          .parse(op.request.target_type);
        const target = lifecycleTarget(ledger, targetType, op.target_id) as any;
        target.lifecycle.pr_created =
          outcome === "unknown" ? "unknown" : "blocked";
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
    case "task-runtime-observe": {
      onlyMain(request.actor);
      const target = find(ledger.tasks, item => item.id === parse(id, payload.task_id), "Task");
      const observedThread = isSharedDeliveryTask(ledger, target)
        ? ledger.groups.find((item) => item.id === target.group_id)?.agent_thread_id
        : target.thread_id;
      requireCondition(observedThread === payload.thread_id, "RESOURCE_MISMATCH", "Runtime observation thread does not match task", 4);
      const runtime = z.enum(["active", "idle", "unknown"]).parse(payload.runtime);
      const observedAt = z.iso.datetime().parse(payload.observed_at);
      if (runtime === "idle") requireCondition(typeof payload.turn_id === "string" && payload.turn_id.length > 0, "EVIDENCE_REQUIRED", "Idle observation requires a confirmed terminal turn identity", 4);
      if (target.disposition !== "active" || !["starting", "running", "agent_idle"].includes(target.state)) return { state: target.state };
      const previous = target.state;
      if (runtime === "idle" && target.state !== "agent_idle") {
        target.agent_resume_state = target.state as "starting" | "running";
        target.state = "agent_idle";
      } else if (runtime !== "idle" && target.state === "agent_idle") {
        target.state = target.agent_resume_state ?? "running";
        delete target.agent_resume_state;
      }
      if (previous !== target.state) addEvent(ledger, request, "task_runtime_observed", target.id, { task_id: target.id, thread_id: observedThread, turn_id: payload.turn_id ?? null, observed_at: observedAt, runtime, state: target.state, previous_state: previous });
      return { state: target.state };
    }
    case "task-update": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const mainOwned = target.execution_owner === "main" &&
        target.conversation_policy === "main_owned" &&
        request.actor.role === "main" &&
        request.actor.thread_id === ledger.control.owner_thread_id;
      const sharedOwned =
        isSharedDeliveryTask(ledger, target) &&
        request.actor.role === "group" &&
        ledger.groups.find((item) => item.id === target.group_id)?.agent_thread_id ===
          request.actor.thread_id;
      const state = z
        .enum(["running", "waiting", "blocked", "completed", "closed"])
        .parse(payload.state);
      const allowed: Record<string, string[]> = {
        planned: mainOwned || sharedOwned ? ["running", "waiting", "blocked"] : [],
        starting: ["running", "waiting", "blocked"],
        running: ["waiting", "blocked"],
        agent_idle: ["running", "waiting", "blocked"],
        waiting: ["running"],
        blocked: ["running"],
        integrated: ["closed"],
        completed: ["closed"],
      };
      requireCondition(
        allowed[target.state]?.includes(state) ||
          (state === "completed" &&
            !isContributionKind(target.kind) &&
            taskExecutionState(target) === "running"),
        "INVALID_TRANSITION",
        `Cannot move ${target.state} to ${state}`,
        3,
      );
      if (state === "running" && ledger.operations.some(op => op.kind === "dispatch" && op.request.target_type !== "group" && op.target_id === taskId &&
        (op.request.creation_parameters as any)?.transport === "codex-exec")) {
        const op = ledger.operations.find(op => op.kind === "dispatch" && op.request.target_type !== "group" && op.target_id === taskId && op.status === "succeeded");
        requireCondition(target.lifecycle.workspace_ready === "passed" && !!op?.request.development_baseline,
          "BASELINE_REQUIRED", "Record verified workspace baseline before running", 4);
        if (ledger.contract_version === 3 && op?.request.development_baseline) {
          const group = find(ledger.groups, (item) => item.id === target.group_id, "Group");
          const postMerge = ["release", "deployment", "verification"].includes(target.kind);
          const lineage = postMerge ? group.merge_sha : group.current_sha;
          requireCondition(
            op.request.development_baseline.sha === lineage,
            "BASELINE_NOT_VERIFIED",
            "Task workspace baseline no longer matches the current lineage",
            4,
          );
        }
      }
      const previousState = taskExecutionState(target);
      const occupiedSlot = target.state === "agent_idle";
      if (state === "running" && isContributionKind(target.kind)) {
        const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
        const bootstrapMainOwnedStart =
          mainOwned &&
          owner.delivery_unit_kind === "bootstrap" &&
          owner.owner_kind === "main";
        requireCondition(
          owner.state === "active",
          "GROUP_NOT_READY",
          "Task group is not active",
          4,
        );
        requireContributionDispatchGate(
          ledger,
          owner,
          !bootstrapMainOwnedStart,
          "task-update",
        );
      }
      if (state === "running" && previousState !== "starting" && !occupiedSlot) {
        requireCondition(
          ready(ledger, target.id),
          "DEPENDENCIES_PENDING",
          "Task dependencies are not satisfied",
          4,
        );
        const used =
          ledger.tasks.filter((item) =>
            ["starting", "running", "agent_idle"].includes(item.state),
          ).length +
          ledger.operations.filter(
            (item) =>
              item.kind === "dispatch" &&
              item.request.target_type !== "group" &&
              activeOperation(item),
          ).length;
        requireCondition(
          used < ledger.config.max_running_tasks,
          "CAPACITY",
          "No execution slot available",
          4,
        );
      }
      if (state === "running" && previousState === "planned")
        requireCondition(
          (mainOwned || sharedOwned) && ready(ledger, target.id),
          "MAIN_TASK_REQUIRED",
          "Only the task owner can start a planned task directly",
          3,
        );
      if (state === "completed")
        requireCondition(
          typeof payload.evidence === "string" && payload.evidence.length > 0,
          "EVIDENCE_REQUIRED",
          "Completion evidence required",
          5,
        );
      if (state === "completed")
        requireCondition(
          target.atoms.every((atom) => atom.status === "completed"),
          "ATOMS_PENDING",
          "Complete the task's atoms before finishing",
          4,
        );
      if (state === "closed") {
        requireCondition(
          !ledger.follow_prs.some(
            (item) => item.origin_task_id === taskId && item.state !== "merged",
          ),
          "FOLLOW_PR_PENDING",
          "Follow PR is not merged",
          4,
        );
        if (isContributionKind(target.kind))
          requireCondition(
            legacyLedger(ledger) ||
              target.lifecycle.pr_merged === "passed" ||
              (isSharedDeliveryTask(ledger, target) &&
                ledger.groups.find((item) => item.id === target.group_id)?.lifecycle.pr_merged === "passed"),
            "PR_NOT_MERGED",
            "Contribution task PR must merge before closeout",
            4,
          );
      }
      target.state = state;
      delete target.agent_resume_state;
      target.blocker =
        state === "blocked" || state === "waiting"
          ? string(payload.detail)
          : null;
      if (state === "closed" && target.lifecycle && !legacyLedger(ledger))
        target.lifecycle.closed = "passed";
      if (state === "running" && (previousState === "starting" || previousState === "planned"))
        target.started_at = z.iso
          .datetime({ offset: false })
          .parse(payload.occurred_at);
      if (state === "completed")
        target.finished_at = payload.occurred_at
          ? z.iso.datetime({ offset: false }).parse(payload.occurred_at)
          : null;
      if ((state === "completed" || state === "closed") && target.thread_id) {
        const resourceId = `conversation-${createHash("sha256").update(target.thread_id).digest("hex").slice(0, 32)}`;
        const resource = ledger.resources.find((item) => item.kind === "conversation" && item.target === target.thread_id);
        if (!resource) {
          ledger.resources.push({
            id: resourceId,
            kind: "conversation",
            target: target.thread_id,
            status: "pending",
            evidence_ref: null,
            error: null,
            last_attempt_at: null,
            operation_id: null,
          });
        }
      }
      const eventType =
        state === "running"
          ? previousState === "starting" || previousState === "planned"
            ? "task_started"
            : "task_resumed"
          : state === "waiting"
            ? "task_waiting"
            : state === "blocked"
              ? "task_blocked"
              : state === "completed"
                ? "task_completed"
                : "task_closed";
      addEvent(
        ledger,
        request,
        eventType,
        taskId,
        {
          task_id: taskId,
          group_id: target.group_id,
          state,
          reason: target.blocker,
        },
        payload.occurred_at
          ? z.iso.datetime({ offset: false }).parse(payload.occurred_at)
          : null,
      );
      const directive = notificationDirective(
        ledger,
        request,
        payload,
        state === "completed" || state === "closed",
      );
      const notice = directive.enabled
        ? addNotificationIntent(ledger, request, directive.recipient_thread_id!)
        : null;
      return {
        task_id: taskId,
        state,
        notification_id: notice?.id ?? null,
        notification_status: notice?.delivery_status ?? "none",
        notification_request: notificationDeliveryRequest(notice),
      };
    }
    case "task-equivalent-integrate": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const owner = find(ledger.groups, (item) => item.id === target.group_id, "Group");
      requireCondition(isContributionKind(target.kind), "TASK_MISMATCH", "Only contribution tasks can be equivalently integrated", 3);
      requireCondition(!isSharedDeliveryTask(ledger, target), "SHARED_DELIVERY_UNIT_PR", "Shared delivery tasks do not have a child PR to integrate", 3);
      requireCondition(["blocked", "agent_idle", "running"].includes(target.state), "INVALID_TRANSITION", "Task is not awaiting integration", 3);
      requireCondition(target.atoms.every((atom) => atom.status === "completed"), "ATOMS_PENDING", "Complete the task atoms before integration", 4);
      const taskPr = parse(externalRef, payload.task_pr);
      const parentPr = parse(externalRef, payload.parent_pr);
      checkPR(ledger, taskPr);
      checkPR(ledger, parentPr);
      requireCondition(target.pr && stable(taskPrRef(target)) === stable(taskPr), "PR_MISMATCH", "Equivalent integration task PR does not match the registered PR", 3);
      requireCondition(deliveryUnitPr(owner) && stable(deliveryUnitPr(owner)) === stable(parentPr), "PR_MISMATCH", "Equivalent integration parent PR does not match the delivery unit", 3);
      const taskHeadSha = z.string().regex(/^[a-f0-9]{40}$/).parse(payload.task_head_sha);
      const parentMergeSha = z.string().regex(/^[a-f0-9]{40}$/).parse(payload.parent_merge_sha);
      const commits = z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).parse(payload.integration_commits);
      const evidenceRef = z.string().min(1).parse(payload.evidence_ref);
      target.state = "integrated";
      target.finished_at = now();
      addEvent(ledger, request, "task_integrated", taskId, {
        task_id: taskId,
        task_pr: taskPr,
        task_head_sha: taskHeadSha,
        parent_pr: parentPr,
        parent_merge_sha: parentMergeSha,
        integration_commits: commits,
        evidence_ref: evidenceRef,
        equivalent_integration: true,
        child_pr_state: "open",
      });
      return { task_id: taskId, state: target.state, equivalent_integration: true };
    }
    case "atom-update": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const mainOwned = target.execution_owner === "main" &&
        target.conversation_policy === "main_owned" &&
        request.actor.role === "main" &&
        request.actor.thread_id === ledger.control.owner_thread_id;
      const sharedOwned =
        isSharedDeliveryTask(ledger, target) &&
        request.actor.role === "group" &&
        ledger.groups.find((item) => item.id === target.group_id)?.agent_thread_id ===
          request.actor.thread_id;
      requireCondition(
        (request.actor.role === "task" || mainOwned || sharedOwned) && taskExecutionState(target) === "running",
        "FORBIDDEN",
        "The running task owner updates its atoms",
        3,
      );
      const index = target.atoms.findIndex(
        (item) => item.id === parse(id, payload.atom_id),
      );
      requireCondition(index >= 0, "NOT_FOUND", "Atom not found");
      const atom = target.atoms[index]!;
      const state = z
        .enum(["running", "blocked", "completed"])
        .parse(payload.state);
      requireCondition(
        target.atoms
          .slice(0, index)
          .every((item) => item.status === "completed"),
        "ATOMS_PENDING",
        "Earlier atoms must complete first",
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
          (request.actor.role === "group" &&
            owner.agent_thread_id === request.actor.thread_id),
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
          stable(
            activePlan(ledger).group_atoms.filter(
              (atom) => atom.group_id === groupId,
            ),
          ) ===
            stable(
              executionPlan(ledger).group_atoms.filter(
                (atom) => atom.group_id === groupId,
              ),
            ),
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
      const state = z
        .enum(["running", "blocked", "completed"])
        .parse(payload.state);
      requireCondition(
        owner.atoms
          .slice(0, index)
          .every((item) => item.status === "completed"),
        "ATOMS_PENDING",
        "Earlier delivery-unit atoms must complete first",
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
      requireCondition(
        !(state === "completed" && atom.lifecycle_stage === "closed"),
        "GROUP_CLOSE_REQUIRED",
        "The closeout atom completes with group-close",
        4,
      );
      if (state === "completed" && atom.lifecycle_stage)
        requireCondition(
          legacyLedger(ledger) ||
            owner.lifecycle[atom.lifecycle_stage] === "passed",
          "LIFECYCLE_BLOCKED",
          `Delivery-unit lifecycle stage ${atom.lifecycle_stage} is not passed`,
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
        payload.occurred_at
          ? z.iso.datetime({ offset: false }).parse(payload.occurred_at)
          : null,
      );
      return { group_id: groupId, atom_id: atom.id, state };
    }
    case "group-execution-update": {
      const groupId = parse(id, payload.group_id);
      const owner = find(ledger.groups, (item) => item.id === groupId, "Group");
      requireCondition(
        (request.actor.role === "main" &&
          request.actor.thread_id === ledger.control.owner_thread_id) ||
          (request.actor.role === "group" &&
            owner.agent_thread_id === request.actor.thread_id),
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
        state === "unknown" || owner.state === "active" ||
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
      const cliDispatches = ledger.operations.filter(op => op.kind === "dispatch" && op.target_id === groupId &&
        op.request.target_type === "group" && (op.request.creation_parameters as any)?.transport === "codex-exec");
      const cliDispatch = cliDispatches.find(op => op.status === "succeeded");
      if (state === "running" && cliDispatches.length) requireCondition(
        owner.lifecycle.workspace_ready === "passed" && !!cliDispatch?.request.development_baseline,
        "BASELINE_REQUIRED", "Record verified group workspace baseline before running", 4);
      if (state === "running" && ledger.contract_version >= 3 && owner.delivery_unit_kind === "regular")
      {
        requireGroupDispatchGate(ledger, owner);
        requireHandoffAcknowledged(ledger, owner);
      }
      if (state === "running" && cliDispatch?.request.development_baseline && ledger.contract_version === 3)
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
        executionTransitions[owner.coordination_execution.state]?.includes(
          state,
        ),
        "INVALID_TRANSITION",
        "Invalid delivery-unit coordination execution transition",
        3,
      );
      const waitingFor = z.array(id).parse(payload.waiting_for_task_ids ?? []);
      requireCondition(
        waitingFor.every((taskId) => {
          const task = ledger.tasks.find((item) => item.id === taskId);
          return (
            task !== undefined &&
            task.group_id === groupId &&
            isContributionKind(task.kind)
          );
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
        state !== "blocked" ||
          (typeof payload.reason === "string" && payload.reason.length > 0),
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
          payload.reason === null || payload.reason === undefined
            ? null
            : string(payload.reason),
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
        payload.occurred_at
          ? z.iso.datetime({ offset: false }).parse(payload.occurred_at)
          : null,
      );
      return {
        group_id: groupId,
        coordination_execution: owner.coordination_execution,
      };
    }
    case "group-update": {
      const incoming = parse(group, payload.group);
      if (incoming.parent_pr) checkPR(ledger, incoming.parent_pr);
      const current = find(
        ledger.groups,
        (item) => item.id === incoming.id,
        "Group",
      );
      if (incoming.parent_pr)
        requireCondition(
          legacyLedger(ledger) ||
            prReceipt(ledger, incoming.id, incoming.parent_pr),
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
          current.delivery_unit_kind === "bootstrap" &&
            current.owner_kind === "main",
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
        (current.state === "planned" &&
          ["planned", "active", "blocked"].includes(incoming.state)) ||
          (current.state === "active" &&
            ["active", "blocked"].includes(incoming.state)) ||
          (current.state === "blocked" &&
            ["blocked", "active"].includes(incoming.state)),
        "INVALID_TRANSITION",
        "Group merge and closeout require verified operations",
        3,
      );
      requireCondition(
        stable(current.atoms) === stable(incoming.atoms) &&
          stable(current.coordination_execution) ===
            stable(incoming.coordination_execution),
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
        owner.parent_branch === null ||
          owner.parent_branch === observation.branch,
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
        (event) =>
          event.type === "cut_applied" && event.data.new_group_id === groupId,
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
      const observation = parse(
        groupBaseReconciliation,
        payload.provider_observation,
      );
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
    case "task-pr": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(
        ledger.tasks,
        (item) => item.id === taskId && isContributionKind(item.kind),
        "Contribution task",
      );
      const pr = parse(externalRef, payload.pr);
      checkPR(ledger, pr);
      requireCondition(
        taskExecutionState(target) === "running" &&
          (!taskPrRef(target) || stable(taskPrRef(target)) === stable(pr)),
        "PR_MISMATCH",
        "Task PR cannot be replaced",
        3,
      );
      requireCondition(
        legacyLedger(ledger) || prReceipt(ledger, taskId, pr),
        "PR_NOT_PUBLISHED",
        "Task PR must be bound to a successful provider publication receipt",
        4,
      );
      if (ledger.contract_version !== 3) target.pr = pr;
      else {
        const owner = find(ledger.groups, (item) => item.id === target.group_id, "DeliveryUnit");
        requireCondition(
          typeof target.branch === "string" && target.branch.length > 0 &&
            typeof owner.parent_branch === "string" && owner.parent_branch.length > 0,
          "TASK_PR_BINDING_INCOMPLETE",
          "Task PR binding requires task branch and DeliveryUnit parent branch facts",
          4,
        );
        target.pr = {
          state: "open",
          pr,
          branch: target.branch,
          base_branch: owner.parent_branch,
        };
      }
      if (target.lifecycle && !legacyLedger(ledger))
        target.lifecycle.pr_created = "passed";
      return { task_id: taskId, pr };
    }
    case "task-base": {
      const taskId = parse(id, payload.task_id);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      const owner = find(
        ledger.groups,
        (item) => item.id === target.group_id,
        "Group",
      );
      const baseSha = z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .parse(payload.base_sha);
      requireCondition(
        owner.current_sha === baseSha,
        "BASE_CHANGED",
        "Task base must match the current parent SHA",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "merge" &&
            activeOperation(item) &&
            item.request.task_id === taskId,
        ),
        "MERGE_PENDING",
        "Cannot change base while merge is pending",
        4,
      );
      if (target.thread_id)
        requireCondition(
          request.actor.role === "task" &&
            target.thread_id === request.actor.thread_id &&
            typeof payload.evidence === "string" &&
            payload.evidence.length > 0,
          "EVIDENCE_REQUIRED",
          "The task owner must verify its updated base",
          5,
        );
      target.base_sha = baseSha;
      addEvent(ledger, request, "task_rebased", taskId, {
        task_id: taskId,
        base_sha: baseSha,
        evidence: payload.evidence ?? null,
      });
      return { task_id: taskId, base_sha: baseSha };
    }
    case "task-quality-record": {
      const taskId = parse(id, payload.task_id);
      requireCondition(request.actor.role === "task", "FORBIDDEN", "Only the task Agent may record task quality", 3);
      ownerOfTask(ledger, request, taskId);
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      requireCondition(
        target.pr &&
          taskExecutionState(target) === "running" &&
          (legacyLedger(ledger) || target.lifecycle.pr_created === "passed"),
        "PR_NOT_READY",
        "Task PR must be provider-published and running",
        4,
      );
      const owner = find(
        ledger.groups,
        (item) => item.id === target.group_id,
        "Group",
      );
      requireCondition(
        payload.base_sha === owner.current_sha &&
          target.base_sha === owner.current_sha,
        "BASE_CHANGED",
        "Quality proof must bind the task and current parent base",
        3,
      );
      const review = parse(fact, payload.evidence);
      requireCondition(
        review.kind === "task_quality" &&
          review.subject_id === taskId &&
          review.status === "passed" &&
          review.sha &&
          review.evidence_ref &&
        review.source === request.actor.thread_id &&
        review.quality?.task_id === taskId &&
        review.quality.thread_id === request.actor.thread_id &&
        stable(review.quality.pr) === stable(taskPrRef(target)) &&
        review.quality.base_sha === owner.current_sha &&
        review.quality.head_sha === review.sha,
        "EVIDENCE_REQUIRED",
        "Task quality evidence must identify the exact task, PR, head, base, acceptance and checks",
        5,
      );
      ledger.facts.push(review);
      addEvent(ledger, request, "fact_observed", taskId, {
        fact_id: review.id,
        base_sha: owner.current_sha,
      });
      return { fact_id: review.id };
    }
    case "follow-pr-update": {
      const followId = parse(id, payload.follow_pr_id);
      const originTaskId = parse(id, payload.origin_task_id);
      const target = find(
        ledger.tasks,
        (item) => item.id === originTaskId,
        "Origin task",
      );
      const groupId = parse(id, payload.origin_group_id);
      const owner = find(
        ledger.groups,
        (item) => item.id === groupId,
        "Origin group",
      );
      requireCondition(
        target.group_id === groupId ||
          target.assignment_history.some((item) => item.group_id === groupId) ||
          ledger.events.some(
            (event) =>
              event.type === "cut_applied" &&
              event.data.old_group_id === groupId &&
              Array.isArray(event.data.reassigned_task_ids) &&
              event.data.reassigned_task_ids.includes(originTaskId),
          ),
        "GROUP_MISMATCH",
        "Task has no assignment in the origin group",
        3,
      );
      if (request.actor.role === "task")
        requireCondition(
          target.thread_id === request.actor.thread_id,
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
      const expectedBranch =
        owner.state === "merged" || owner.state === "closed"
          ? ledger.repository.target_branch
          : owner.parent_branch;
      requireCondition(
        expectedBranch && payload.target_branch === expectedBranch,
        "TARGET_MISMATCH",
        "Follow PR target does not match the origin group state",
        3,
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "merge" &&
            item.target_id === groupId &&
            activeOperation(item),
        ),
        "MERGE_PENDING",
        "Cannot register a follow PR while group merge is pending",
        4,
      );
      requireCondition(
        !ledger.follow_prs.some((item) => item.id === followId),
        "FOLLOW_PR_EXISTS",
        "Follow PR already recorded",
        3,
      );
      const follow = ledgerSchema.shape.follow_prs.element.parse({
        id: followId,
        origin_task_id: originTaskId,
        origin_group_id: groupId,
        pr: payload.pr,
        target_branch: expectedBranch,
        state: "open",
        merge_fact_id: null,
        affected_task_ids: z.array(id).parse(payload.affected_task_ids),
      });
      checkPR(ledger, follow.pr);
      requireCondition(
        follow.affected_task_ids.every((taskId) =>
          ledger.tasks.some((item) => item.id === taskId),
        ),
        "UNKNOWN_TASK",
        "Follow PR references an unknown task",
      );
      ledger.follow_prs.push(follow);
      addEvent(ledger, request, "follow_pr_recorded", originTaskId, {
        follow_pr_id: followId,
      });
      return { follow_pr_id: followId, target_branch: expectedBranch };
    }
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
          target.atoms.every((atom) => atom.status === "completed"),
          "ATOMS_PENDING",
          "Complete the task's atoms before merging",
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
        requireCondition(
          owner.state === "active",
          "GROUP_NOT_ACTIVE",
          "Only an active group can merge its parent PR",
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
          const originalParent = parse(externalRef, payload.original_parent_pr);
          requireCondition(
            deliveryUnitPr(owner) && stable(deliveryUnitPr(owner)) === stable(originalParent),
            "PR_MISMATCH",
            "Follow-up merge must identify the registered parent PR",
            3,
          );
          requireCondition(
            pr.id !== originalParent.id &&
              pr.provider === ledger.repository.provider &&
              pr.repository === `${ledger.repository.owner}/${ledger.repository.name}`,
            "PR_MISMATCH",
            "Follow-up merge must identify a distinct PR in the bound repository",
            3,
          );
          requireCondition(
            typeof payload.original_parent_merge_sha === "string" &&
              /^[a-f0-9]{40}$/.test(payload.original_parent_merge_sha),
            "EVIDENCE_REQUIRED",
            "Follow-up merge must retain the original parent merge SHA",
            5,
          );
        }
        if (mode === "parent") requireCondition(
          legacyLedger(ledger) ||
            (owner.lifecycle.pr_created === "passed" &&
              prReceipt(ledger, groupId, pr, expectedSha, headSha)),
          "PR_NOT_READY",
          "Parent PR must be provider-published before merge",
          4,
        );
        requireCondition(
          ledger.tasks
            .filter(
              (item) =>
                item.group_id === groupId && isContributionKind(item.kind),
            )
            .every((item) =>
              ["integrated", "closed"].includes(item.state) ||
              (item.execution_owner === "main" &&
                item.conversation_policy === "main_owned" &&
                item.state === "running" &&
                item.atoms.every((atom) => atom.status === "completed"))),
          "TASKS_PENDING",
          "Contribution tasks are not integrated",
          4,
        );
        requireCondition(
          !ledger.follow_prs.some(
            (item) =>
              item.origin_group_id === groupId && item.state !== "merged",
          ),
          "FOLLOW_PR_PENDING",
          "Known follow PRs must merge first",
          4,
        );
        targetBranch = ledger.repository.target_branch;
      } else {
        const follow = find(
          ledger.follow_prs,
          (item) =>
            item.id === string(payload.follow_pr_id) &&
            item.origin_group_id === groupId,
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
                item.id === follow.origin_task_id &&
                item.thread_id === request.actor.thread_id,
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
          (item) =>
            item.kind === "cut" &&
            item.target_id === groupId &&
            activeOperation(item),
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
          (item) =>
            item.kind === "merge" &&
            item.target_id === groupId &&
            activeOperation(item),
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
      if (mode === "parent")
        protectedActionApproved(
          ledger,
          "delivery_unit_merge",
          groupId,
          string(payload.owner_approval_id),
        );
      const op = addOperation(ledger, request, "merge", groupId, expectedSha);
      op.request.mode = mode;
      addEvent(ledger, request, "merge_claimed", groupId, {
        operation_id: op.id,
      });
      return { operation_id: op.id };
    }
    case "merge-resolve": {
      const op = find(
        ledger.operations,
        (item) =>
          item.id === string(payload.operation_id) && item.kind === "merge",
        "Merge",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "Merge claim is not active or belongs to another actor",
        3,
      );
      const outcome = z
        .enum(["succeeded", "failed", "unknown"])
        .parse(payload.outcome);
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
        const owner = find(
          ledger.groups,
          (item) => item.id === op.target_id,
          "Group",
        );
        if (op.request.target_branch === owner.parent_branch)
          requireCondition(
            owner.current_sha === op.expected_sha,
            "BASE_CHANGED",
            "Parent SHA changed while merge was pending",
            3,
          );
        const subject =
          (op.request.mode === "parent" || op.request.mode === "parent-followup")
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
              (item) =>
                item.origin_group_id === owner.id && item.state !== "merged",
            ),
            "FOLLOW_PR_PENDING",
            "Known follow PRs must merge first",
            4,
          );
          owner.state = "merged";
          if (op.request.mode === "parent-followup") owner.current_sha = evidence.sha;
          if (op.request.mode === "parent") {
            if (ledger.contract_version !== 3) owner.parent_pr = op.request.pr;
            else owner.pr = {
                state: "merged",
                pr: op.request.pr,
                parent_branch: owner.parent_branch,
                merge_sha: evidence.sha,
              };
          }
          owner.merge_sha = evidence.sha;
          if (owner.lifecycle && !legacyLedger(ledger))
            owner.lifecycle.pr_merged = "passed";
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
          const follow = find(
            ledger.follow_prs,
            (item) => item.id === subject,
            "Follow PR",
          );
          follow.state = "merged";
          follow.merge_fact_id = evidence.id;
          if (op.request.target_branch === owner.parent_branch)
            owner.current_sha = evidence.sha;
        } else {
          const target = find(
            ledger.tasks,
            (item) => item.id === subject,
            "Task",
          );
          owner.current_sha = evidence.sha;
          target.state = "integrated";
          if (!legacyLedger(ledger)) {
            const owner = find(ledger.groups, (item) => item.id === target.group_id, "DeliveryUnit");
            target.pr = ledger.contract_version !== 3
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
          if (target.lifecycle && !legacyLedger(ledger))
            target.lifecycle.pr_merged = "passed";
        }
        ledger.facts.push(evidence);
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
        ? (ledger.facts.find((item) => item.id === op.receipt_fact_id)
            ?.observed_at ?? null)
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
          group_snapshot: structuredClone(
            ledger.groups.find((item) => item.id === op.target_id)!,
          ),
        },
        observedAt,
      );
      const directive = notificationDirective(
        ledger,
        request,
        payload,
        outcome === "succeeded",
      );
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
      const owner = find(
        ledger.groups,
        (item) => item.id === string(payload.group_id),
        "Group",
      );
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
            item.kind === "cut" &&
            item.request.rule_id === rule.id &&
            item.status === "succeeded",
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
                op.kind === "cut" &&
                op.request.rule_id === item.id &&
                op.status === "succeeded",
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
          (item) =>
            item.kind === "cut" &&
            item.target_id === owner.id &&
            activeOperation(item),
        ),
        "CUT_PENDING",
        "Cut already pending",
        4,
      );
      const op = addOperation(
        ledger,
        request,
        "cut",
        owner.id,
        owner.current_sha,
      );
      const drained = !ledger.operations.some(
        (item) =>
          item.kind === "merge" &&
          item.target_id === owner.id &&
          activeOperation(item),
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
          item.id === string(payload.operation_id) &&
          item.kind === "cut" &&
          activeOperation(item),
        "Cut",
      );
      requireCondition(
        !ledger.operations.some(
          (item) =>
            item.kind === "merge" &&
            item.target_id === op.target_id &&
            activeOperation(item),
        ),
        "MERGE_PENDING",
        "Resolve pending merges before cutting",
        4,
      );
      const owner = find(
        ledger.groups,
        (item) => item.id === op.target_id,
        "Group",
      );
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
      const rule = find(
        current.cut_rules,
        (item) => item.id === op.request.rule_id,
        "Cut rule",
      );
      const integrated = ledger.tasks.filter(
        (item) =>
          item.group_id === owner.id &&
          isContributionKind(item.kind) &&
          ["integrated", "closed"].includes(item.state),
      );
      const included = z.array(id).parse(payload.included_task_ids);
      requireCondition(
        stable([...included].sort()) ===
          stable(integrated.map((item) => item.id).sort()),
        "CUT_SCOPE_MISMATCH",
        "Included tasks differ from current integrated tasks",
        3,
      );
      const taskSnapshots = ledger.tasks
        .filter(
          (item) => item.group_id === owner.id && isContributionKind(item.kind),
        )
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
    case "fact-record": {
      const observed = parse(fact, payload.fact);
      requireCondition(
        ![
          "pr_merged",
          "task_quality",
          "branch_published",
          "pr_published",
        ].includes(observed.kind),
        "INVALID_FACT",
        "Quality, merge and publication facts require their dedicated operation",
        3,
      );
      requireCondition(
        observed.evidence_ref &&
          observed.source &&
          observed.status !== "unknown",
        "EVIDENCE_REQUIRED",
        "Observed fact requires a source and evidence",
        5,
      );
      const owner = ledger.groups.find(
        (item) => item.id === observed.subject_id,
      );
      const target = ledger.tasks.find(
        (item) => item.id === observed.subject_id,
      );
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
        const operationKind =
          observed.kind === "published" ? "release" : "deploy";
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
      protectedActionApproved(
        ledger,
        action,
        taskId,
        string(payload.owner_approval_id),
      );
      const current = currentPlan();
      const actionId = parse(id, payload.action_id);
      const planned = find(
        current.actions,
        (item) =>
          item.id === actionId &&
          item.kind === action &&
          item.task_id === taskId,
        "Planned action",
      );
      const target = find(ledger.tasks, (item) => item.id === taskId, "Task");
      requireCondition(
        taskExecutionState(target) === "running" &&
          (action === "release"
            ? target.kind === "release"
            : target.kind === "deployment"),
        "TASK_MISMATCH",
        "Active task does not match the action",
        3,
      );
      const owner = find(
        ledger.groups,
        (item) => item.id === target.group_id,
        "Group",
      );
      requireCondition(
        owner.state === "merged" &&
          owner.merge_sha &&
          payload.expected_sha === owner.merge_sha,
        "BASE_CHANGED",
        "Action must bind the group's merged SHA",
        5,
      );
      requireCondition(
        !ledger.operations.some(
          (item) => item.target_id === taskId && activeOperation(item),
        ),
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
          item.id === string(payload.operation_id) &&
          ["release", "deploy"].includes(item.kind),
        "Action",
      );
      requireCondition(
        op.actor_id === request.actor.thread_id && activeOperation(op),
        "FORBIDDEN",
        "Action claim is not active or belongs to another actor",
        3,
      );
      const outcome = z
        .enum(["succeeded", "failed", "unknown"])
        .parse(payload.outcome);
      if (outcome === "succeeded") {
        const evidence = parse(fact, payload.provider_evidence);
        requireCondition(
          evidence.kind ===
            (op.kind === "release" ? "published" : "deployed") &&
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
            lineage.source_sha === op.expected_sha &&
              lineage.publication_sha === evidence.sha,
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
        original.actor_id === request.actor.thread_id || (request.actor.role === "main" &&
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
      const outcome = z
        .enum(["sent", "failed", "unknown"])
        .parse(payload.outcome);
      requireCondition((!requiresNativeDelivery(ledger, notice.id) || object(payload.provider_receipt).provider === "codex-app-tools") &&
        (object(payload.provider_receipt).provider !== "codex-app-tools" || outcome === "unknown"),
        "NATIVE_RECEIPT_REQUIRED", "Native delivery must claim an unknown attempt before reconciling the platform receipt", 5);
      requireNotificationRecipientActive(ledger, notice.recipient_thread_id);
      const attemptId = parse(id, payload.delivery_attempt_id);
      requireCondition(
        !ledger.events.some(
          (event) =>
            ["notification_delivery_resolved", "notification_sent"].includes(
              event.type,
            ) && event.data.delivery_attempt_id === attemptId,
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
          prompt_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        })
        .strict()
        .parse(payload.provider_receipt);
      if (receipt.provider === "codex-app-tools") {
        requireCondition(receipt.recipient_thread_id === notice.recipient_thread_id && !!receipt.prompt_digest,
          "NATIVE_RECEIPT_REQUIRED", "Native delivery must bind the claimed recipient and prompt", 5);
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
      addEvent(
        ledger,
        request,
        "notification_delivery_resolved",
        notice.event_id,
        {
          notification_id: notice.id,
          delivery_attempt_id: attemptId,
          outcome,
          provider: receipt.provider,
          evidence_ref: receipt.evidence_ref,
          message_id: receipt.message_id ?? null,
          recipient_thread_id: receipt.recipient_thread_id ?? null,
          prompt_digest: receipt.prompt_digest ?? null,
        },
      );
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
        request.actor.role === "main" ||
          original.actor_id === request.actor.thread_id,
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
      const nativeClaim = ledger.events.find(event => event.type === "notification_delivery_resolved" &&
        event.data.delivery_attempt_id === notice.last_attempt_id && event.data.provider === "codex-app-tools" && event.data.outcome === "unknown");
      const nativeAttempt = !!nativeClaim;
      if (nativeAttempt || payload.delivery_attempt_id !== undefined) requireCondition(payload.delivery_attempt_id === notice.last_attempt_id,
        "ATTEMPT_MISMATCH", "Receipt must match the active delivery attempt", 3);
      const reconciliationId = parse(id, payload.reconciliation_id);
      requireCondition(
        !ledger.events.some(
          (event) =>
            [
              "notification_delivery_resolved",
              "notification_delivery_reconciled",
            ].includes(event.type) &&
            (event.data.delivery_attempt_id === reconciliationId ||
              event.data.reconciliation_id === reconciliationId),
        ),
        "RECONCILIATION_EXISTS",
        "Reconciliation identity already exists",
        3,
      );
      const outcome = z
        .enum(["sent", "failed", "unknown"])
        .parse(payload.outcome);
      const receipt = z
        .object({
          provider: z.string().min(1),
          evidence_ref: z.string().min(1),
          message_id: z.string().min(1).nullable().optional(),
          recipient_thread_id: z.string().min(1).optional(),
          prompt_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        })
        .strict()
        .parse(payload.provider_receipt);
      if (nativeAttempt || receipt.provider === "codex-app-tools") requireCondition(nativeAttempt && receipt.provider === "codex-app-tools",
        "NATIVE_RECEIPT_REQUIRED", "Native attempt requires a matching platform provider", 5);
      if (nativeClaim?.data.prompt_digest) requireCondition(
        receipt.recipient_thread_id === nativeClaim.data.recipient_thread_id &&
        receipt.prompt_digest === nativeClaim.data.prompt_digest,
        "NATIVE_RECEIPT_REQUIRED", "Platform receipt does not match the claimed recipient and prompt", 5);
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
      addEvent(
        ledger,
        request,
        "notification_delivery_reconciled",
        notice.event_id,
        {
          notification_id: notice.id,
          reconciliation_id: reconciliationId,
          outcome,
          provider: receipt.provider,
          evidence_ref: receipt.evidence_ref,
          message_id: receipt.message_id ?? null,
          recipient_thread_id: receipt.recipient_thread_id ?? null,
          prompt_digest: receipt.prompt_digest ?? null,
        },
      );
      return {
        notification_id: notice.id,
        reconciliation_id: reconciliationId,
        ledger_status: notice.ledger_status,
        delivery_status: notice.delivery_status,
        ack_status: notice.ack_status,
      };
    }
    case "notification-sent": {
      requireCondition(object(payload.provider_receipt).provider !== "codex-app-tools",
        "NATIVE_RECEIPT_REQUIRED", "Native delivery requires a claimed attempt and reconciled platform receipt", 5);
      const notice = find(
        ledger.notifications,
        (item) => item.id === string(payload.notification_id),
        "Notification",
      );
      requireCondition(!requiresNativeDelivery(ledger, notice.id), "NATIVE_RECEIPT_REQUIRED",
        "Native delivery requires a claimed attempt and reconciled platform receipt", 5);
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
      const incoming = ledgerSchema.shape.resources.element.parse(
        payload.resource,
      );
      const existing = ledger.resources.find((item) => item.id === incoming.id);
      if (existing) {
        requireCondition(
          existing.kind === incoming.kind &&
            existing.target === incoming.target,
          "RESOURCE_MISMATCH",
          "Resource identity cannot change",
          3,
        );
        requireCondition(
          existing.status !== "closed" && existing.status !== "not_applicable" ||
            existing.kind === "conversation" && existing.status === "closed" &&
            incoming.status === "unarchive_unknown" && incoming.archive_policy === "manual" &&
            !!incoming.operation_id && incoming.operation_id !== existing.operation_id && !!incoming.evidence_ref,
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
        ledger.groups.length > 0 &&
          ledger.groups.every((item) => item.state === "closed"),
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
        !closeout || closeout.lifecycle_stage !== "closed"
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
      if (owner.lifecycle && !legacyLedger(ledger))
        owner.lifecycle.closed = "passed";
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
    default:
      throw new ContractError(
        "UNKNOWN_COMMAND",
        `Unsupported command: ${command}`,
      );
  }
}

export function apply(
  ledger: Ledger,
  command: string,
  request: Request,
): unknown {
  const normalized = validateLedger(ledger);
  if ((ledger as any).schema_version === 1)
    Object.assign(ledger, structuredClone(normalized));
  requireCondition(
    request.run_id === ledger.orchestration_id,
    "RUN_MISMATCH",
    "Request refers to another run",
    3,
  );
  if (command !== "binding-resolve") authorize(ledger, request.actor);
  const canonical = stable({
    run_id: request.run_id,
    actor: request.actor,
    command,
    payload: request.payload,
  });
  const prior = ledger.requests.find(
    (item) => item.request_id === request.request_id,
  );
  if (prior) {
    requireCondition(
      prior.command === command && prior.canonical_input === canonical,
      "ID_CONFLICT",
      "Request ID has different content",
      3,
    );
    return {
      ok: true,
      code: "REPLAYED",
      revision: prior.committed_revision,
      result: prior.result,
    };
  }
  requireCondition(
    ledger.revision === request.expected_revision,
    "REVISION_CONFLICT",
    "Ledger version changed",
    3,
  );
  requireCondition(
    !!normalized.config.execution_profile ||
      command === "execution-profile-migrate",
    "PROFILE_MIGRATION_REQUIRED",
    "Run is read-only until explicit execution-profile-migrate",
    4,
  );
  const candidate = structuredClone(normalized);
  const result = execute(candidate, command, request);
  candidate.revision += 1;
  candidate.updated_at = now();
  candidate.requests.push({
    request_id: request.request_id,
    command,
    canonical_input: canonical,
    result,
    committed_revision: candidate.revision,
  });
  validateLedger(candidate);
  Object.assign(ledger, candidate);
  return { ok: true, code: "APPLIED", revision: ledger.revision, result };
}
