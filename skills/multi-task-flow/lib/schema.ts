import { normalizeRetiredPlanAlias } from "../lib/legacy-plan-alias";
import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { z } from "zod";
import { topologicalOrder, validateGrouping } from "../lib/graph";
import { requireCondition } from "../lib/errors";

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const text = z.string().trim().min(1);
export const executionProfile = z
  .object({ model: text, thinking: text })
  .strict();
export const optionalExecutionProfile = executionProfile
  .nullable()
  .default(null);
const defaultExecutionProfile = { model: "gpt-5.6-luna", thinking: "max" };
const timestamp = z.iso.datetime({ offset: false });
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nullableText = text.nullable();
const requirementsPath = nullableText.refine(
  (value) =>
    value === null ||
    /^requirements\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.md$/.test(value),
  "requirements_path must reference a Markdown file under requirements/",
);
const stringMap = z.record(z.string(), z.unknown());
export const executionPhase = z.enum(["planning", "implementation"]);
export const planLifecycle = z.enum([
  "proposed",
  "approved",
  "superseded",
  "abandoned",
]);
export const changeClass = z.enum([
  "planning_revision",
  "implementation_low_impact",
  "implementation_high_impact",
]);
export const changeReasonCategory = z.enum([
  "discovered_constraint",
  "dependency_correction",
  "scope_change",
  "blocker_recovery",
  "owner_direction",
  "provider_or_environment_change",
]);
export const changeEntry = z
  .object({
    path: text,
    old_value: z.unknown().optional(),
    new_value: z.unknown().optional(),
  })
  .strict();
export const changeReason = z
  .object({
    category: changeReasonCategory,
    summary: text,
    evidence_refs: z.array(text),
    impact: text,
  })
  .strict();
export const planChangeSet = z
  .object({
    added: z.array(changeEntry),
    removed: z.array(changeEntry),
    modified: z.array(changeEntry),
  })
  .strict();
export const planRevision = z
  .object({
    execution_phase: executionPhase,
    change_class: changeClass,
    affected_task_ids: z.array(id),
    affected_node_ids: z.array(id),
    affected_edge_ids: z.array(id),
    change_set: planChangeSet,
    reason: changeReason.nullable(),
    approval_required: z.boolean(),
    paused_task_ids: z.array(id),
  })
  .strict();
export const devPlanTaskSurface = z
  .object({ task_id: id, owned_surfaces: z.array(text).min(1) })
  .strict();
export const devPlanAcceptanceScope = z
  .object({
    acceptance_id: id,
    scope: z
      .string()
      .regex(/^(?:batch|task):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    owner_id: id,
  })
  .strict();
export const planHandoffSource = z
  .object({
    raw_plan_digest: sha256,
    task_surfaces: z.array(devPlanTaskSurface).min(2),
    acceptance_scopes: z.array(devPlanAcceptanceScope).min(2),
  })
  .strict();
export const planHandoff = z
  .object({
    flow_type: z.literal("multi-task-flow"),
    raw_plan_digest: sha256,
    acceptance_digest: sha256,
    task_ids: z.array(id).min(2),
    task_surfaces: z.array(devPlanTaskSurface).min(2),
    acceptance_scopes: z.array(devPlanAcceptanceScope).min(2),
  })
  .strict();

export const externalRef = z
  .object({
    provider: text,
    repository: text,
    id: text,
    url: z.url().nullable(),
  })
  .strict();
export const atomPlan = z
  .object({ id, title: text, task_id: id, purpose: text, output: text })
  .strict();
export const groupAtomPlan = z
  .object({
    id,
    title: text,
    group_id: id,
    purpose: text,
    output: text,
    lifecycle_stage: z
      .enum(["workspace_ready", "pr_created", "pr_merged", "closed"])
      .nullable()
      .default(null),
  })
  .strict();
export const atomEdge = z
  .object({ id, from_atom_id: id, to_atom_id: id })
  .strict();
export const node = z
  .object({
    id,
    kind: z.enum([
      "main_start",
      "main_end",
      "group_start",
      "group_end",
      "task",
      "milestone",
    ]),
    ref_id: id.nullable(),
    group_id: id.nullable(),
    label: text,
    estimate_minutes: z.number().int().nonnegative().nullable(),
    estimate_basis: nullableText,
    estimate_confidence: z.enum(["low", "medium", "high"]).nullable(),
  })
  .strict();
export const edge = z
  .object({
    id,
    from_node_id: id,
    to_node_id: id,
    requires: z.enum([
      "integrated",
      "completed",
      "merged",
      "ci_passed",
      "published",
      "deployed",
      "verified",
    ]),
  })
  .strict();
export const cutRule = z
  .object({
    id,
    group_id: id,
    priority: z.number().int().nonnegative(),
    required_task_ids: z.array(id),
    status: z.enum(["pending", "claimed", "applied", "cancelled"]),
  })
  .strict();
export const lifecycleStage = z.enum([
  "unknown",
  "pending",
  "passed",
  "blocked",
]);
export const lifecycle = z
  .object({
    workspace_ready: lifecycleStage,
    pr_created: lifecycleStage,
    pr_merged: lifecycleStage,
    closed: lifecycleStage,
  })
  .strict();
export const milestone = z
  .object({
    id,
    target_type: z.enum(["group", "task"]),
    target_id: id,
    title: text,
    evidence_ref: nullableText,
    recorded_at: timestamp,
    recorded_by: text,
  })
  .strict();
export const plannedAction = z
  .object({
    id,
    kind: z.enum(["publish_branch", "publish_pr", "release", "deploy"]),
    task_id: id.nullable().default(null),
    group_id: id.nullable().default(null),
    target_identity: text,
  })
  .strict();
export const plan = z
  .object({
    id,
    supersedes_id: id.nullable(),
    approval_id: nullableText,
    lifecycle: planLifecycle.default("proposed"),
    revision: planRevision.nullable().default(null),
    created_at: timestamp,
    start_at: timestamp.nullable(),
    atoms: z.array(atomPlan),
    group_atoms: z.array(groupAtomPlan).default([]),
    atomic_edges: z.array(atomEdge),
    nodes: z.array(node),
    edges: z.array(edge),
    cut_rules: z.array(cutRule),
    actions: z.array(plannedAction),
    plan_handoff: planHandoff.optional(),
  })
  .strict();
export const group = z
  .object({
    id,
    title: text,
    delivery_unit_kind: z.enum(["bootstrap", "regular"]).default("regular"),
    owner_kind: z.enum(["main", "group"]).default("group"),
    agent_thread_id: nullableText,
    state: z.enum(["planned", "active", "merged", "closed", "blocked"]),
    parent_branch: nullableText,
    parent_pr: externalRef.nullable(),
    cut_sha: sha.nullable(),
    current_sha: sha.nullable(),
    merge_sha: sha.nullable(),
    requirements_path: requirementsPath,
    atoms: z
      .array(
        z
          .object({
            id,
            title: text,
            purpose: text,
            output: text,
            lifecycle_stage: z
              .enum(["workspace_ready", "pr_created", "pr_merged", "closed"])
              .nullable(),
            status: z.enum(["planned", "running", "completed", "blocked"]),
          })
          .strict(),
      )
      .default([]),
    coordination_execution: z
      .object({
        state: z.enum(["unknown", "idle", "running", "waiting", "blocked"]),
        reason: nullableText,
        waiting_for_task_ids: z.array(id),
      })
      .strict()
      .default({ state: "unknown", reason: null, waiting_for_task_ids: [] }),
    execution_profile: optionalExecutionProfile,
    execution_profile_source: z
      .enum(["manual", "recommendation"])
      .nullable()
      .default(null),
    execution_profile_rule: text.nullable().default(null),
    lifecycle: lifecycle.default({
      workspace_ready: "unknown",
      pr_created: "unknown",
      pr_merged: "unknown",
      closed: "unknown",
    }),
  })
  .strict();

export function defaultGroupAtoms(groupId: string) {
  return [
    {
      id: `group-atom-${groupId}-prepare-parent`,
      title: "准备父分支",
      purpose: "建立交付单元父分支",
      output: "父分支已准备",
      lifecycle_stage: "workspace_ready" as const,
      status: "planned" as const,
    },
    {
      id: `group-atom-${groupId}-create-pr`,
      title: "创建父 PR",
      purpose: "提交交付单元父 PR",
      output: "父 PR 已创建",
      lifecycle_stage: "pr_created" as const,
      status: "planned" as const,
    },
    {
      id: `group-atom-${groupId}-verify-integration`,
      title: "验收集成结果",
      purpose: "核对贡献任务集成结果",
      output: "集成结果已验收",
      lifecycle_stage: null,
      status: "planned" as const,
    },
    {
      id: `group-atom-${groupId}-merge-pr`,
      title: "合并父 PR",
      purpose: "合并已验收的父 PR",
      output: "父 PR 已合并",
      lifecycle_stage: "pr_merged" as const,
      status: "planned" as const,
    },
    {
      id: `group-atom-${groupId}-closeout`,
      title: "收口",
      purpose: "完成交付单元收口",
      output: "交付单元已收口",
      lifecycle_stage: "closed" as const,
      status: "planned" as const,
    },
  ];
}
export const task = z
  .object({
    id,
    title: text,
    kind: z.enum([
      "contribution",
      "release",
      "deployment",
      "verification",
      "coordination",
      "development",
      "other",
    ]),
    group_id: id,
    thread_id: nullableText,
    state: z.enum([
      "planned",
      "ready",
      "starting",
      "running",
      "agent_idle",
      "waiting",
      "blocked",
      "integrated",
      "completed",
      "closed",
    ]),
    agent_resume_state: z.enum(["starting", "running"]).optional(),
    disposition: z
      .enum(["active", "superseded", "abandoned"])
      .default("active"),
    execution_owner: z
      .enum(["main", "delivery_agent", "task_agent"])
      .nullable()
      .default(null),
    conversation_policy: z
      .enum(["main_owned", "delivery_owned", "task_agent", "none"])
      .nullable()
      .default(null),
    delivery_policy: z
      .enum(["parent_pr", "child_pr", "evidence", "none"])
      .nullable()
      .default(null),
    superseded_by_task_id: nullableText.default(null),
    atoms: z.array(
      z
        .object({
          id,
          title: text,
          status: z.enum(["planned", "running", "completed", "blocked"]),
        })
        .strict(),
    ),
    owned_surfaces: z.array(text),
    branch: nullableText.default(null),
    base_sha: sha.nullable(),
    pr: externalRef.nullable(),
    requirements_path: requirementsPath,
    execution_profile: optionalExecutionProfile,
    execution_profile_source: z
      .enum(["manual", "recommendation"])
      .nullable()
      .default(null),
    execution_profile_rule: text.nullable().default(null),
    started_at: timestamp.nullable(),
    finished_at: timestamp.nullable(),
    blocker: nullableText,
    assignment_history: z.array(
      z
        .object({
          group_id: id,
          effective_at: timestamp,
          reason: text,
          cut_operation_id: id.nullable(),
        })
        .strict(),
    ),
    lifecycle: lifecycle.default({
      workspace_ready: "unknown",
      pr_created: "unknown",
      pr_merged: "unknown",
      closed: "unknown",
    }),
  })
  .strict();
export const providerReceipt = z
  .object({
    provider: text,
    repository: text,
    resource_type: z.enum(["branch", "pr"]),
    resource_id: text,
    branch: text,
    target_branch: nullableText,
    base_sha: sha.nullable(),
    head_sha: sha.nullable(),
    pr: externalRef.nullable(),
    state: z.enum(["exists", "open", "merged", "absent", "unknown"]),
    evidence_ref: text,
  })
  .strict();
export const fact = z
  .object({
    id,
    kind: z.enum([
      "child_review",
      "task_quality",
      "pr_merged",
      "branch_published",
      "pr_published",
      "ci_passed",
      "published",
      "deployed",
      "verified",
    ]),
    subject_id: id,
    status: z.enum(["passed", "failed", "unknown"]),
    source: text,
    observed_at: timestamp,
    sha: sha.nullable(),
    evidence_ref: nullableText,
    quality: z
      .object({
        task_id: id,
        thread_id: text,
        pr: externalRef,
        base_sha: sha,
        head_sha: sha,
        acceptance_refs: z.array(text).min(1),
        checks: z
          .array(
            z
              .object({ name: text, status: z.literal("passed"), evidence_ref: text })
              .strict(),
          )
          .min(1),
      })
      .nullable()
      .optional(),
    receipt: providerReceipt.nullable().optional(),
  })
  .strict();
export const cutEvidence = z
  .object({
    source: text,
    observed_at: timestamp,
    sha,
    evidence_ref: text,
  })
  .strict();
export const operation = z
  .object({
    id,
    kind: z.enum([
      "dispatch",
      "merge",
      "cut",
      "publish_branch",
      "publish_pr",
      "release",
      "deploy",
    ]),
    actor_id: text,
    target_id: id,
    status: z.enum(["claimed", "succeeded", "failed", "unknown"]),
    request: stringMap,
    expected_sha: sha.nullable(),
    receipt_fact_id: id.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
const eventType = z.enum([
  "plan_approved",
  "protected_action_approved",
  "plan_revision_proposed",
  "plan_revision_approved",
  "plan_revision_superseded",
  "plan_revision_abandoned",
  "task_migration_recorded",
  "binding_resolved",
  "dispatch_claimed",
  "thread_bound",
  "group_updated",
  "group_atom_updated",
  "group_execution_updated",
  "group_base_reconciled",
  "atom_updated",
  "link_verification",
  "task_ready",
  "task_started",
  "task_waiting",
  "task_resumed",
  "task_runtime_observed",
  "task_blocked",
  "task_rebased",
  "task_integrated",
  "task_completed",
  "task_closed",
  "merge_claimed",
  "merge_resolved",
  "publish_branch_claimed",
  "publish_branch_resolved",
  "publish_pr_claimed",
  "publish_pr_resolved",
  "lifecycle_recorded",
  "milestone_recorded",
  "action_claimed",
  "action_resolved",
  "cut_claimed",
  "cut_applied",
  "fact_observed",
  "follow_pr_recorded",
  "notification_delivery_resolved",
  "notification_delivery_reconciled",
  "notification_sent",
  "notification_acknowledged",
  "execution_profile_updated",
  "dispatch_claim_replaced",
  "execution_profile_migrated",
  "execution_profile_default_updated",
  "dispatch_request_bound",
  "dispatch_creation_resolved",
  "dispatch_thread_observed",
  "resource_updated",
  "resource_closed",
  "run_completed",
]);
export const event = z
  .object({
    id,
    type: eventType,
    subject_id: id,
    actor_id: text,
    occurred_at: timestamp.nullable(),
    recorded_at: timestamp,
    data: stringMap,
  })
  .strict();
export const notificationMode = z.enum(["auto", "deliver", "none"]);
export const notificationRecipient = z.union([
  z.literal("owner"),
  z.object({ thread_id: text }).strict(),
]);
export const notificationOption = z
  .object({
    mode: notificationMode,
    recipient: notificationRecipient.optional(),
  })
  .strict();
export const notificationDeliveryStatus = z.enum([
  "pending",
  "sent",
  "failed",
  "unknown",
]);
export const notificationAckStatus = z.enum(["unacknowledged", "acknowledged"]);
export const notification = z
  .object({
    id,
    event_id: id,
    recipient_thread_id: text,
    ledger_status: z.literal("committed").default("committed"),
    status: z.enum(["pending", "sent", "failed", "unknown", "acknowledged"]),
    delivery_status: notificationDeliveryStatus.default("pending"),
    ack_status: notificationAckStatus.default("unacknowledged"),
    attempts: z.number().int().nonnegative(),
    last_attempt_id: nullableText.default(null),
    last_reconciliation_id: nullableText.default(null),
    last_error: nullableText.default(null),
    updated_at: timestamp,
  })
  .strict();
export const ledgerSchema = z
  .object({
    schema_version: z.literal(2),
    source_schema_version: z.literal(1).nullable().default(null),
    contract_version: z.union([z.literal(1), z.literal(2)]),
    version: z.object({
      skill_id: text,
      skill_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
      viewer_contract: z.number().int().positive(),
    }).strict().nullable().default(null),
    orchestration_id: id,
    revision: z.number().int().nonnegative(),
    repository: z
      .object({
        provider: z.enum(["github", "gitea"]),
        host: text,
        owner: text,
        name: text,
        target_branch: text,
      })
      .strict(),
    control: z
      .object({
        owner_thread_id: nullableText,
        ownership: z.enum(["pending", "bound", "uncertain"]),
        approval_id: nullableText,
      })
      .strict(),
    config: z
      .object({
        max_running_tasks: z.number().int().positive(),
        display_timezone: text,
        conversation_links_verified: z.boolean().default(false),
        execution_profile: executionProfile.nullable().default(null),
      })
      .strict(),
    plans: z.array(plan).min(1),
    active_plan_id: id,
    execution_plan_id: id,
    groups: z.array(group),
    tasks: z.array(task),
    follow_prs: z.array(
      z
        .object({
          id,
          origin_task_id: id,
          origin_group_id: id,
          pr: externalRef,
          target_branch: text,
          state: z.enum(["open", "merged", "blocked"]),
          merge_fact_id: id.nullable(),
          affected_task_ids: z.array(id),
        })
        .strict(),
    ),
    facts: z.array(fact),
    operations: z.array(operation),
    events: z.array(event),
    milestones: z.array(milestone).default([]),
    requests: z.array(
      z
        .object({
          request_id: id,
          command: text,
          canonical_input: text,
          result: z.unknown(),
          committed_revision: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    notifications: z.array(notification),
    resources: z.array(
      z
        .object({
          id,
          kind: z.enum([
            "conversation",
            "worktree",
            "branch",
            "port",
            "service",
          ]),
          target: nullableText,
          status: z.enum([
            "unknown",
            "active",
            "pending",
            "closed",
            "archive_failed",
            "archive_unknown",
            "unarchive_failed",
            "unarchive_unknown",
            "not_applicable",
          ]),
          evidence_ref: nullableText,
          error: nullableText.optional(),
          last_attempt_at: timestamp.nullable().optional(),
          operation_id: nullableText.optional(),
          archive_policy: z.enum(["auto", "manual"]).optional(),
        })
        .strict(),
    ),
    updated_at: timestamp,
  })
  .strict();
export type Ledger = z.infer<typeof ledgerSchema>;
export type Plan = z.infer<typeof plan>;
export type Task = z.infer<typeof task>;

export type TaskExecutionPolicyIssue = { code: string; message: string };

export function taskExecutionPolicyIssues(
  candidate: Pick<Task, "execution_owner" | "conversation_policy" | "delivery_policy">,
): TaskExecutionPolicyIssue[] {
  const { execution_owner: owner, conversation_policy: conversation, delivery_policy: delivery } = candidate;
  if (owner === null && conversation === null && delivery === null) return [];
  const issues: TaskExecutionPolicyIssue[] = [];
  if (owner === null || conversation === null || delivery === null) {
    issues.push({ code: "TASK_EXECUTION_POLICY_INCOMPLETE", message: "任务执行归属、对话策略和交付策略必须同时声明" });
    return issues;
  }
  if (owner === "main" && conversation !== "main_owned") issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "Main Agent 任务必须使用 main_owned 对话策略" });
  if (owner === "task_agent" && conversation !== "task_agent") issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "Task Agent 任务必须使用 task_agent 对话策略" });
  if (owner === "delivery_agent" && conversation !== "delivery_owned") issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "交付 Agent 任务必须使用 delivery_owned 对话策略" });
  if (owner === "main" && delivery === "child_pr") issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "Main Agent 不得拥有 child PR" });
  if (owner === "delivery_agent" && delivery === "child_pr") issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "交付 Agent 不得拥有 child PR" });
  if (owner === "task_agent" && delivery === "parent_pr") issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "Task Agent 不得拥有 parent PR" });
  if (conversation === "none" && ["child_pr", "evidence"].includes(delivery)) issues.push({ code: "TASK_EXECUTION_POLICY_CONFLICT", message: "无对话任务不能声明 child PR 或验证证据" });
  return issues;
}

export function validateTaskExecutionPolicies(tasks: readonly Task[], requireComplete = false): void {
  for (const candidate of tasks) {
    if (requireComplete && candidate.execution_owner === null && candidate.conversation_policy === null && candidate.delivery_policy === null)
      requireCondition(false, "TASK_EXECUTION_POLICY_INCOMPLETE", `${candidate.id}: 任务执行归属、对话策略和交付策略必须声明`, 3);
    const issues = taskExecutionPolicyIssues(candidate);
    requireCondition(issues.length === 0, issues[0]?.code ?? "TASK_EXECUTION_POLICY_INVALID", `${candidate.id}: ${issues.map((issue) => issue.message).join("；")}`, 3);
  }
}
export function isContributionKind(kind: Task["kind"]): boolean {
  return kind === "contribution" || kind === "development";
}
export type PlanRevision = z.infer<typeof planRevision>;
export type ExecutionPhase = z.infer<typeof executionPhase>;
export type ExecutionProfile = z.infer<typeof executionProfile>;
export const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = {
  ...defaultExecutionProfile,
};
export function recommendedExecutionProfile(
  kind: Task["kind"],
  fallback: ExecutionProfile,
): ExecutionProfile {
  if (["development", "contribution"].includes(kind))
    return { model: "gpt-6.1-sol", thinking: "high" };
  if (["verification", "coordination", "release", "deployment"].includes(kind))
    return { model: "gpt-6-luna", thinking: "medium" };
  return { ...fallback };
}
export type DevPlanHandoffSource = z.infer<typeof planHandoffSource>;
type DevPlanHandoff = z.infer<typeof planHandoff>;
type DevPlanHandoffValidationOptions = {
  allowDynamicAssignments?: boolean;
  assignmentEvidence?: ReadonlyMap<string, ReadonlySet<string>>;
  dynamicGroupIds?: ReadonlySet<string>;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function acceptanceScopeDigest(
  scopes: DevPlanHandoff["acceptance_scopes"],
): string {
  const normalized = [...scopes].sort((left, right) =>
    left.acceptance_id < right.acceptance_id
      ? -1
      : left.acceptance_id > right.acceptance_id
        ? 1
        : 0,
  );
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function sameMembers(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

const taskStateEventTypes = new Set([
  "task_runtime_observed",
  "task_started",
  "task_waiting",
  "task_resumed",
  "task_blocked",
  "task_integrated",
  "task_completed",
  "task_closed",
]);

function taskStateAtEvent(
  ledger: Ledger,
  taskId: string,
  eventIndex: number,
  currentState: Task["state"],
): Task["state"] | null {
  let state: Task["state"] = "planned";
  let observed = false;
  for (const event of ledger.events.slice(0, eventIndex)) {
    if (event.subject_id !== taskId && event.data.task_id !== taskId) continue;
    if (
      event.type === "thread_bound" &&
      event.data.outcome === "succeeded" &&
      typeof event.data.thread_id === "string" &&
      event.subject_id === taskId
    ) {
      state = "starting";
      observed = true;
    } else if (taskStateEventTypes.has(event.type)) {
      const candidate = event.data.state;
      if (
        typeof candidate !== "string" ||
        ![
          "planned",
          "ready",
          "starting",
          "running",
          "agent_idle",
          "waiting",
          "blocked",
          "integrated",
          "completed",
          "closed",
        ].includes(candidate)
      )
        return null;
      state = candidate as Task["state"];
      observed = true;
    } else if (
      event.type === "merge_resolved" &&
      event.data.task_id === taskId &&
      event.data.outcome === "succeeded"
    ) {
      state = "integrated";
      observed = true;
    }
  }
  return observed || currentState === "planned" ? state : null;
}

function sameTaskStructure(left: Task, right: Task): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.thread_id === right.thread_id &&
    left.requirements_path === right.requirements_path &&
    canonicalJson(left.owned_surfaces) ===
      canonicalJson(right.owned_surfaces) &&
    canonicalJson(left.atoms.map(({ id, title }) => ({ id, title }))) ===
      canonicalJson(right.atoms.map(({ id, title }) => ({ id, title })))
  );
}

function sortedSurfaces(value: string[]): string[] {
  return [...value].sort();
}

function normalizeOwnedSurface(value: string): string | undefined {
  const stripped = value.trim().replaceAll("\\", "/");
  if (!stripped) return;
  const normalized = posixPath.normalize(stripped);
  const canonical =
    normalized === "/" ? normalized : normalized.replace(/\/+$/, "") || ".";
  if (
    canonical.startsWith("/") ||
    canonical === ".." ||
    canonical.startsWith("../") ||
    /^[A-Za-z]:\/.*$/.test(canonical)
  )
    return;
  return canonical;
}

function normalizedOwnedSurfaces(value: string[]): string[] | undefined {
  const normalized = value.map(normalizeOwnedSurface);
  if (normalized.some((surface): surface is undefined => surface === undefined))
    return;
  const surfaces = normalized as string[];
  return new Set(surfaces).size === surfaces.length ? surfaces : undefined;
}

function ownedSurfacesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left === "." ||
    right === "." ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export function validatePlanHandoff(candidate: Plan): void {
  const handoff = candidate.plan_handoff;
  if (!handoff) return;
  const taskIds = candidate.nodes
    .filter((item) => item.kind === "task")
    .map((item) => item.ref_id)
    .filter((value): value is string => value !== null);
  requireCondition(
    new Set(handoff.task_ids).size === handoff.task_ids.length,
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff task IDs must be unique",
  );
  requireCondition(
    sameMembers(handoff.task_ids, taskIds),
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff task IDs must match plan task nodes",
  );
  const surfaceTaskIds = handoff.task_surfaces.map((item) => item.task_id);
  requireCondition(
    new Set(surfaceTaskIds).size === surfaceTaskIds.length &&
      sameMembers(surfaceTaskIds, handoff.task_ids),
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff task surfaces must cover every plan task exactly once",
  );
  const planSurfaces = handoff.task_surfaces.map((item) => ({
    taskId: item.task_id,
    surfaces: normalizedOwnedSurfaces(item.owned_surfaces),
  }));
  requireCondition(
    planSurfaces.every((item) => item.surfaces !== undefined),
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff owned surfaces must be repository-relative and unique",
  );
  for (let index = 0; index < planSurfaces.length; index += 1)
    for (const right of planSurfaces.slice(index + 1)) {
      const left = planSurfaces[index]!;
      const shared = left.surfaces!.some((surface) =>
        right.surfaces!.some((other) => ownedSurfacesOverlap(surface, other)),
      );
      requireCondition(
        !shared,
        "INVALID_PLAN_HANDOFF",
        `dev-plan handoff owned surfaces must be disjoint between ${left.taskId} and ${right.taskId}`,
      );
    }
  requireCondition(
    new Set(handoff.acceptance_scopes.map((item) => item.acceptance_id))
      .size === handoff.acceptance_scopes.length,
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff acceptance IDs must be unique",
  );
  requireCondition(
    handoff.acceptance_digest ===
      acceptanceScopeDigest(handoff.acceptance_scopes),
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff acceptance digest does not match its scopes",
  );
  requireCondition(
    handoff.acceptance_scopes.some((item) => item.scope.startsWith("batch:")) &&
      handoff.acceptance_scopes.some((item) => item.scope.startsWith("task:")),
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff must include batch and task acceptance scopes",
  );
  for (const item of handoff.acceptance_scopes) {
    const [kind, target] = item.scope.split(":", 2);
    requireCondition(
      kind === "batch" || kind === "task",
      "INVALID_PLAN_HANDOFF",
      "dev-plan handoff acceptance scope kind is invalid",
    );
    if (kind === "task")
      requireCondition(
        target === item.owner_id && handoff.task_ids.includes(target),
        "INVALID_PLAN_HANDOFF",
        "dev-plan task acceptance scope must own a plan task",
      );
  }
}

export function attachDevPlanHandoff(
  candidate: Plan,
  source: DevPlanHandoffSource,
): Plan {
  requireCondition(
    candidate.plan_handoff === undefined,
    "INVALID_PLAN_HANDOFF",
    "A handoff source cannot replace an existing dev-plan handoff envelope",
  );
  const parsedSource = planHandoffSource.parse(source);
  const taskIds = candidate.nodes
    .filter((item) => item.kind === "task")
    .map((item) => item.ref_id)
    .filter((value): value is string => value !== null);
  const attached = plan.parse({
    ...candidate,
    plan_handoff: {
      flow_type: "multi-task-flow",
      raw_plan_digest: parsedSource.raw_plan_digest,
      acceptance_digest: acceptanceScopeDigest(parsedSource.acceptance_scopes),
      task_ids: taskIds,
      task_surfaces: parsedSource.task_surfaces,
      acceptance_scopes: parsedSource.acceptance_scopes,
    },
  });
  validatePlanHandoff(attached);
  return attached;
}

export function validateDevPlanHandoff(
  candidate: Plan,
  groups: Array<z.infer<typeof group>>,
  tasks: Array<z.infer<typeof task>>,
  options: DevPlanHandoffValidationOptions = {},
): void {
  const handoff = candidate.plan_handoff;
  requireCondition(
    handoff,
    "INVALID_PLAN_HANDOFF",
    "multi-task-flow init requires a dev-plan handoff envelope",
  );
  validatePlanHandoff(candidate);
  const taskIds = tasks.map((item) => item.id);
  requireCondition(
    sameMembers(handoff.task_ids, taskIds),
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff task IDs must match runtime tasks",
  );
  const runtimeGroupIds = new Set(groups.map((item) => item.id));
  const taskNodes = new Map(
    candidate.nodes
      .filter((item) => item.kind === "task" && item.ref_id !== null)
      .map((item) => [item.ref_id!, item]),
  );
  const plannedGroupIds = new Set<string>();
  for (const runtimeTask of tasks) {
    const taskNode = taskNodes.get(runtimeTask.id);
    requireCondition(
      runtimeGroupIds.has(runtimeTask.group_id),
      "INVALID_PLAN_HANDOFF",
      `runtime task ${runtimeTask.id} references an unknown group`,
    );
    requireCondition(
      taskNode?.group_id !== null && taskNode?.group_id !== undefined,
      "INVALID_PLAN_HANDOFF",
      `plan task ${runtimeTask.id} must declare a group`,
    );
    requireCondition(
      runtimeGroupIds.has(taskNode!.group_id!),
      "INVALID_PLAN_HANDOFF",
      `plan task ${runtimeTask.id} references an unknown group`,
    );
    plannedGroupIds.add(taskNode!.group_id!);
    const hasDynamicAssignment =
      options.assignmentEvidence
        ?.get(runtimeTask.id)
        ?.has(runtimeTask.group_id) === true &&
      runtimeTask.assignment_history.some(
        (item) => item.group_id === runtimeTask.group_id,
      );
    requireCondition(
      options.allowDynamicAssignments
        ? taskNode!.group_id === runtimeTask.group_id || hasDynamicAssignment
        : taskNode!.group_id === runtimeTask.group_id,
      "INVALID_PLAN_HANDOFF",
      `plan task ${runtimeTask.id} group does not match runtime ownership`,
    );
  }
  const surfaces = new Map(
    handoff.task_surfaces.map((item) => [item.task_id, item.owned_surfaces]),
  );
  const normalizedRuntimeSurfaces = new Map<string, string[]>();
  for (const runtimeTask of tasks) {
    const handoffOwnedSurfaces = normalizedOwnedSurfaces(
      surfaces.get(runtimeTask.id) ?? [],
    );
    const runtimeOwnedSurfaces = normalizedOwnedSurfaces(
      runtimeTask.owned_surfaces,
    );
    requireCondition(
      handoffOwnedSurfaces !== undefined && runtimeOwnedSurfaces !== undefined,
      "INVALID_PLAN_HANDOFF",
      `dev-plan handoff owned surfaces are invalid for task ${runtimeTask.id}`,
    );
    requireCondition(
      JSON.stringify(sortedSurfaces(handoffOwnedSurfaces!)) ===
        JSON.stringify(sortedSurfaces(runtimeOwnedSurfaces!)),
      "INVALID_PLAN_HANDOFF",
      `dev-plan handoff owned surfaces do not match task ${runtimeTask.id}`,
    );
    normalizedRuntimeSurfaces.set(runtimeTask.id, runtimeOwnedSurfaces!);
  }
  const runtimeSurfaceEntries = [...normalizedRuntimeSurfaces.entries()];
  for (let index = 0; index < runtimeSurfaceEntries.length; index += 1)
    for (const [rightTaskId, rightSurfaces] of runtimeSurfaceEntries.slice(
      index + 1,
    )) {
      const [leftTaskId, leftSurfaces] = runtimeSurfaceEntries[index]!;
      const shared = leftSurfaces.some((surface) =>
        rightSurfaces.some((other) => ownedSurfacesOverlap(surface, other)),
      );
      requireCondition(
        !shared,
        "INVALID_PLAN_HANDOFF",
        `dev-plan handoff owned surfaces must be disjoint between ${leftTaskId} and ${rightTaskId}`,
      );
    }
  for (const item of handoff.acceptance_scopes) {
    const [kind, target] = item.scope.split(":", 2);
    if (kind === "batch")
      requireCondition(
        target === item.owner_id && groups.some((group) => group.id === target),
        "INVALID_PLAN_HANDOFF",
        "dev-plan batch acceptance scope must own a runtime group",
      );
    else
      requireCondition(
        tasks.some((task) => task.id === target),
        "INVALID_PLAN_HANDOFF",
        "dev-plan task acceptance scope must own a runtime task",
      );
  }
  for (const runtimeTask of tasks)
    requireCondition(
      handoff.acceptance_scopes.some(
        (item) => item.scope === `task:${runtimeTask.id}`,
      ),
      "INVALID_PLAN_HANDOFF",
      `dev-plan handoff is missing task acceptance scope for ${runtimeTask.id}`,
    );
  const requiredBatchGroupIds = options.allowDynamicAssignments
    ? plannedGroupIds
    : new Set(groups.map((item) => item.id));
  for (const runtimeGroup of groups)
    requireCondition(
      plannedGroupIds.has(runtimeGroup.id) ||
        options.dynamicGroupIds?.has(runtimeGroup.id) === true,
      "INVALID_PLAN_HANDOFF",
      `runtime group ${runtimeGroup.id} is not bound to the approved plan`,
    );
  for (const groupId of requiredBatchGroupIds)
    requireCondition(
      handoff.acceptance_scopes.some(
        (item) => item.scope === `batch:${groupId}`,
      ),
      "INVALID_PLAN_HANDOFF",
      `dev-plan handoff is missing batch acceptance scope for ${groupId}`,
    );
}

export function validateInitialRuntimeState(
  groups: Array<z.infer<typeof group>>,
  tasks: Array<z.infer<typeof task>>,
): void {
  const validRequirementsPath = (value: string | null): boolean =>
    requirementsPath.safeParse(value).success;
  const bootstraps = groups.filter(
    (candidate) => candidate.delivery_unit_kind === "bootstrap",
  );
  requireCondition(
    bootstraps.length <= 1,
    "INVALID_INITIAL_STATE",
    "At most one bootstrap delivery unit is allowed",
    3,
  );
  for (const candidate of bootstraps) {
    requireCondition(
      candidate.owner_kind === "main",
      "INVALID_INITIAL_STATE",
      "Bootstrap delivery unit must be main-owned",
      3,
    );
    requireCondition(
      candidate.agent_thread_id === null,
      "INVALID_INITIAL_STATE",
      "Bootstrap delivery unit cannot bind a group conversation",
      3,
    );
  }
  for (const candidate of groups.filter(
    (item) => item.delivery_unit_kind === "regular",
  ))
    requireCondition(
      candidate.owner_kind === "group",
      "INVALID_INITIAL_STATE",
      "Regular delivery unit must be group-owned",
      3,
    );
  const groupsAreUnboundAndPlanned = groups.every(
    (candidate) =>
      candidate.agent_thread_id === null &&
      candidate.state === "planned" &&
      candidate.parent_branch === null &&
      candidate.parent_pr === null &&
      candidate.cut_sha === null &&
      candidate.current_sha === null &&
      candidate.merge_sha === null &&
      validRequirementsPath(candidate.requirements_path) &&
      candidate.atoms.every((atom) => atom.status === "planned") &&
      candidate.coordination_execution.state === "unknown" &&
      candidate.coordination_execution.reason === null &&
      candidate.coordination_execution.waiting_for_task_ids.length === 0 &&
      Object.values(candidate.lifecycle).every((stage) => stage === "unknown"),
  );
  const tasksAreUnboundAndPlanned = tasks.every(
    (candidate) =>
      candidate.thread_id === null &&
      candidate.state === "planned" &&
      candidate.base_sha === null &&
      candidate.pr === null &&
      validRequirementsPath(candidate.requirements_path) &&
      candidate.started_at === null &&
      candidate.finished_at === null &&
      candidate.blocker === null &&
      candidate.assignment_history.length === 0 &&
      candidate.branch === null &&
      candidate.atoms.every((atom) => atom.status === "planned") &&
      Object.values(candidate.lifecycle).every((stage) => stage === "unknown"),
  );

  requireCondition(
    groupsAreUnboundAndPlanned && tasksAreUnboundAndPlanned,
    "INVALID_INITIAL_STATE",
    "Initial groups and tasks must be unbound and planned with planned atoms",
  );
}

export function validatePlan(candidate: Plan): void {
  validatePlanHandoff(candidate);
  if (candidate.revision) {
    const changeCount =
      candidate.revision.change_set.added.length +
      candidate.revision.change_set.removed.length +
      candidate.revision.change_set.modified.length;
    requireCondition(
      changeCount > 0,
      "EMPTY_PLAN_REVISION",
      "A plan revision must retain a non-empty canonical diff",
    );
    requireCondition(
      new Set(candidate.revision.affected_task_ids).size ===
        candidate.revision.affected_task_ids.length,
      "DUPLICATE_ID",
      "Plan revision task IDs must be unique",
    );
    requireCondition(
      new Set(candidate.revision.affected_node_ids).size ===
        candidate.revision.affected_node_ids.length,
      "DUPLICATE_ID",
      "Plan revision node IDs must be unique",
    );
    requireCondition(
      new Set(candidate.revision.affected_edge_ids).size ===
        candidate.revision.affected_edge_ids.length,
      "DUPLICATE_ID",
      "Plan revision edge IDs must be unique",
    );
  }
  for (const collection of [
    candidate.atoms,
    candidate.group_atoms,
    candidate.atomic_edges,
    candidate.nodes,
    candidate.edges,
    candidate.cut_rules,
    candidate.actions,
  ]) {
    requireCondition(
      new Set(collection.map((item) => item.id)).size === collection.length,
      "DUPLICATE_ID",
      "Plan IDs must be unique within each collection",
    );
  }
  validateGrouping(candidate.atoms, candidate.atomic_edges);
  topologicalOrder(
    candidate.nodes.map((item) => item.id),
    candidate.edges.map((item) => ({
      from: item.from_node_id,
      to: item.to_node_id,
    })),
  );
  const taskNodes = new Map(
    candidate.nodes
      .filter((item) => item.kind === "task")
      .map((item) => [item.ref_id, item.id]),
  );
  requireCondition(
    !taskNodes.has(null) &&
      taskNodes.size ===
        candidate.nodes.filter((item) => item.kind === "task").length,
    "DUPLICATE_TASK_NODE",
    "Each task needs exactly one identified plan node",
  );
  requireCondition(
    candidate.atoms.every((atom) => taskNodes.has(atom.task_id)),
    "MISSING_TASK_NODE",
    "Every atom must belong to a task node",
  );
  const groupNodes = new Set(
    candidate.nodes
      .map((item) => item.group_id)
      .filter((item): item is string => item !== null),
  );
  requireCondition(
    candidate.group_atoms.every((atom) => groupNodes.has(atom.group_id)),
    "MISSING_GROUP",
    "Every delivery-unit atom must belong to a group node",
  );
  requireCondition(
    candidate.actions.every(
      (action) =>
        (action.task_id !== null && taskNodes.has(action.task_id)) ||
        (action.group_id !== null && groupNodes.has(action.group_id)),
    ),
    "MISSING_PLAN_TARGET",
    "Every planned action must belong to a task or group node",
  );
  requireCondition(
    candidate.actions.every(
      (action) =>
        action.kind === "publish_branch" ||
        action.kind === "publish_pr" ||
        action.task_id !== null,
    ),
    "MISSING_TASK_NODE",
    "Release and deploy actions must belong to a task node",
  );
  for (const taskNode of candidate.nodes.filter((item) => item.kind === "task"))
    requireCondition(
      taskNode.group_id !== null,
      "MISSING_GROUP",
      "Every task node must identify its group",
    );
  const nodes = new Map(candidate.nodes.map((item) => [item.id, item]));
  const atoms = new Map(candidate.atoms.map((item) => [item.id, item]));
  const actualEdges = new Set(
    candidate.edges.map(
      (item) => `${item.from_node_id}:${item.to_node_id}:${item.requires}`,
    ),
  );
  for (const atomDependency of candidate.atomic_edges) {
    const from = atoms.get(atomDependency.from_atom_id)!;
    const to = atoms.get(atomDependency.to_atom_id)!;
    if (from.task_id !== to.task_id) {
      requireCondition(
        actualEdges.has(
          `${taskNodes.get(from.task_id)}:${taskNodes.get(to.task_id)}:integrated`,
        ),
        "MISSING_HANDOFF",
        "Cross-task atomic dependencies require an integrated task edge",
      );
    }
  }
  for (const dependency of candidate.edges) {
    requireCondition(
      nodes.has(dependency.from_node_id) && nodes.has(dependency.to_node_id),
      "UNKNOWN_NODE",
      "Dependency references an unknown node",
    );
  }
}

export type PlanCompletenessIssue = {
  code: string;
  message: string;
};

/** Validate the content required before a plan may enter the formal flow. */
export function planCompletenessIssues(candidate: Plan): PlanCompletenessIssue[] {
  const issues: PlanCompletenessIssue[] = [];
  const taskNodes = candidate.nodes.filter((node) => node.kind === "task");
  if (taskNodes.length === 0)
    issues.push({ code: "empty_tasks", message: "计划至少需要一个任务。" });
  const atomTaskIds = new Set(candidate.atoms.map((atom) => atom.task_id));
  for (const taskNode of taskNodes) {
    if (!taskNode.ref_id || !atomTaskIds.has(taskNode.ref_id))
      issues.push({ code: "missing_atom", message: `任务 ${taskNode.label} 缺少原子任务。` });
    if (taskNode.estimate_minutes === null)
      issues.push({ code: "missing_estimate", message: `任务 ${taskNode.label} 缺少估时。` });
    if (!taskNode.estimate_basis)
      issues.push({ code: "missing_estimate_basis", message: `任务 ${taskNode.label} 缺少估时依据。` });
    if (!taskNode.estimate_confidence)
      issues.push({ code: "missing_estimate_confidence", message: `任务 ${taskNode.label} 缺少估时置信度。` });
  }
  return issues;
}

export function validateSchedulablePlan(candidate: Plan): void {
  const issue = planCompletenessIssues(candidate)[0];
  requireCondition(!issue, "PLAN_INCOMPLETE", issue?.message ?? "计划内容不完整。", 3);
}

export type CutAssignmentEvidence = {
  assignments: Map<string, Set<string>>;
  dynamicGroupIds: Set<string>;
};

export function collectCutAssignmentEvidence(
  ledger: Ledger,
  active: Plan,
): CutAssignmentEvidence {
  const currentGroups = new Map<string, string>();
  for (const node of active.nodes.filter((item) => item.kind === "task"))
    if (node.ref_id !== null && node.group_id !== null)
      currentGroups.set(node.ref_id, node.group_id);
  const assignments = new Map<string, Set<string>>();
  const dynamicGroupIds = new Set<string>();
  const appliedOperationIds = new Set<string>();
  const createdGroupIds = new Set<string>();
  for (const [eventIndex, event] of ledger.events.entries()) {
    if (event.type !== "cut_applied") continue;
    const operationId = event.data.operation_id;
    const oldGroupId = event.data.old_group_id;
    const newGroupId = event.data.new_group_id;
    const cutSha = event.data.cut_sha;
    const oldGroupCurrentSha = event.data.old_group_current_sha;
    const includedTaskIds = event.data.included_task_ids;
    const reassignedTaskIds = event.data.reassigned_task_ids;
    const cutEvidenceValue = event.data.cut_evidence;
    requireCondition(
      id.safeParse(operationId).success &&
        id.safeParse(oldGroupId).success &&
        id.safeParse(newGroupId).success &&
        sha.safeParse(cutSha).success &&
        oldGroupCurrentSha === cutSha &&
        Array.isArray(includedTaskIds) &&
        includedTaskIds.every((item) => id.safeParse(item).success) &&
        Array.isArray(reassignedTaskIds) &&
        reassignedTaskIds.every((item) => id.safeParse(item).success),
      "INVALID_CUT_EVENT",
      "cut_applied event has invalid assignment evidence",
    );
    requireCondition(
      !appliedOperationIds.has(operationId as string) &&
        !createdGroupIds.has(newGroupId as string),
      "INVALID_CUT_EVENT",
      "cut_applied event reuses a cut operation or dynamic group",
    );
    requireCondition(
      event.subject_id === oldGroupId && oldGroupId !== newGroupId,
      "INVALID_CUT_EVENT",
      "cut_applied event subject does not match its old group",
    );
    const operation = ledger.operations.find((item) => item.id === operationId);
    requireCondition(
      operation !== undefined &&
        operation.kind === "cut" &&
        operation.status === "succeeded" &&
        operation.target_id === oldGroupId &&
        operation.request.operation_id === operationId &&
        operation.request.group_id === oldGroupId &&
        operation.expected_sha === cutSha,
      "INVALID_CUT_EVENT",
      "cut_applied event is not bound to a succeeded cut operation",
    );
    const oldGroup = ledger.groups.find((item) => item.id === oldGroupId);
    const newGroup = ledger.groups.find((item) => item.id === newGroupId);
    requireCondition(
      oldGroup !== undefined && newGroup !== undefined,
      "INVALID_CUT_EVENT",
      "cut_applied event references an unknown group",
    );
    const ruleId = operation?.request.rule_id;
    const rule = active.cut_rules.find((item) => item.id === ruleId);
    requireCondition(
      rule !== undefined,
      "INVALID_CUT_EVENT",
      "cut_applied event references an unknown cut rule",
    );
    const cutEvidenceResult = cutEvidence.safeParse(cutEvidenceValue);
    requireCondition(
      cutEvidenceResult.success && cutEvidenceResult.data.sha === cutSha,
      "INVALID_CUT_EVENT",
      "cut_applied event is missing verified provider evidence",
    );
    const cutClaim = ledger.events
      .slice(0, eventIndex)
      .find(
        (candidate) =>
          candidate.type === "cut_claimed" &&
          candidate.subject_id === oldGroupId &&
          candidate.actor_id === operation!.actor_id &&
          candidate.data.operation_id === operationId &&
          candidate.data.group_id === oldGroupId &&
          candidate.data.rule_id === ruleId &&
          sha.safeParse(candidate.data.expected_sha).success,
      );
    requireCondition(
      cutClaim !== undefined,
      "INVALID_CUT_EVENT",
      "cut_applied event is not preceded by a matching cut claim",
    );
    requireCondition(
      rule!.status === "applied",
      "INVALID_CUT_EVENT",
      "cut_applied event does not bind an applied cut rule",
    );
    let ruleGroupId = rule!.group_id;
    for (const previousEvent of ledger.events.slice(0, eventIndex))
      if (
        previousEvent.type === "cut_applied" &&
        previousEvent.data.old_group_id === ruleGroupId &&
        typeof previousEvent.data.new_group_id === "string"
      )
        ruleGroupId = previousEvent.data.new_group_id;
    requireCondition(
      ruleGroupId === oldGroupId,
      "INVALID_CUT_EVENT",
      "cut_applied event does not match its approved cut rule group",
    );
    requireCondition(
      oldGroup!.cut_sha === cutSha,
      "INVALID_CUT_EVENT",
      "cut_applied event does not bind the old group cut boundary",
    );
    requireCondition(
      event.data.new_group_state === "planned" &&
        event.data.new_group_agent_thread_id === null &&
        event.data.new_group_parent_branch === null &&
        event.data.new_group_parent_pr === null &&
        event.data.new_group_cut_sha === null &&
        event.data.new_group_current_sha === null &&
        event.data.new_group_merge_sha === null &&
        event.data.new_group_requirements_path === null,
      "INVALID_CUT_EVENT",
      "cut_applied event does not prove a clean dynamic group creation",
    );
    const initialGroupSnapshot = group.safeParse(event.data.new_group_snapshot);
    requireCondition(
      initialGroupSnapshot.success &&
        initialGroupSnapshot.data.id === newGroupId &&
        initialGroupSnapshot.data.state === "planned" &&
        initialGroupSnapshot.data.agent_thread_id === null &&
        initialGroupSnapshot.data.parent_branch === null &&
        initialGroupSnapshot.data.parent_pr === null &&
        initialGroupSnapshot.data.cut_sha === null &&
        initialGroupSnapshot.data.current_sha === null &&
        initialGroupSnapshot.data.merge_sha === null &&
        initialGroupSnapshot.data.requirements_path === null,
      "INVALID_CUT_EVENT",
      "cut_applied event is missing a clean dynamic group snapshot",
    );
    requireCondition(
      initialGroupSnapshot.data.state === event.data.new_group_state &&
        initialGroupSnapshot.data.agent_thread_id ===
          event.data.new_group_agent_thread_id &&
        initialGroupSnapshot.data.parent_branch ===
          event.data.new_group_parent_branch &&
        canonicalJson(initialGroupSnapshot.data.parent_pr) ===
          canonicalJson(event.data.new_group_parent_pr) &&
        initialGroupSnapshot.data.cut_sha === event.data.new_group_cut_sha &&
        initialGroupSnapshot.data.current_sha ===
          event.data.new_group_current_sha &&
        initialGroupSnapshot.data.merge_sha ===
          event.data.new_group_merge_sha &&
        initialGroupSnapshot.data.requirements_path ===
          event.data.new_group_requirements_path,
      "INVALID_CUT_EVENT",
      "cut_applied event snapshot does not match its creation fields",
    );
    const oldGroupSnapshot = group.safeParse(event.data.old_group_snapshot);
    requireCondition(
      oldGroupSnapshot.success &&
        oldGroupSnapshot.data.id === oldGroupId &&
        oldGroupSnapshot.data.current_sha === cutSha &&
        oldGroupSnapshot.data.cut_sha === cutSha &&
        oldGroupSnapshot.data.title === oldGroup.title &&
        oldGroupSnapshot.data.agent_thread_id === oldGroup.agent_thread_id &&
        oldGroupSnapshot.data.parent_branch === oldGroup.parent_branch &&
        canonicalJson(oldGroupSnapshot.data.parent_pr) ===
          canonicalJson(oldGroup.parent_pr) &&
        oldGroupSnapshot.data.requirements_path ===
          oldGroup.requirements_path &&
        oldGroupSnapshot.data.merge_sha === null &&
        ["planned", "active", "blocked"].includes(oldGroupSnapshot.data.state),
      "INVALID_CUT_EVENT",
      "cut_applied event is missing the old group boundary snapshot",
    );
    const priorGroupEvidence = ledger.events
      .slice(0, eventIndex)
      .some((candidate) => candidate.subject_id === newGroupId);
    requireCondition(
      !priorGroupEvidence,
      "INVALID_CUT_EVENT",
      "cut_applied event reuses a group with prior runtime history",
    );
    let latestGroupSnapshot = initialGroupSnapshot.data;
    for (const laterEvent of ledger.events.slice(eventIndex + 1)) {
      if (laterEvent.subject_id !== newGroupId) continue;
      const snapshotField =
        laterEvent.type === "cut_applied"
          ? "old_group_snapshot"
          : ["thread_bound", "group_updated", "merge_resolved"].includes(
                laterEvent.type,
              )
            ? "group_snapshot"
            : null;
      if (snapshotField === null) continue;
      const laterSnapshot = group.safeParse(laterEvent.data[snapshotField]);
      requireCondition(
        laterSnapshot.success && laterSnapshot.data.id === newGroupId,
        "INVALID_CUT_EVENT",
        `cut lifecycle event ${laterEvent.id} is missing a bound group snapshot`,
      );
      latestGroupSnapshot = laterSnapshot.data;
    }
    requireCondition(
      canonicalJson(latestGroupSnapshot) === canonicalJson(newGroup),
      "INVALID_CUT_EVENT",
      "cut lifecycle snapshots do not match the current dynamic group",
    );
    const included = includedTaskIds as string[];
    const reassigned = reassignedTaskIds as string[];
    requireCondition(
      new Set([...included, ...reassigned]).size ===
        included.length + reassigned.length,
      "INVALID_CUT_EVENT",
      "cut_applied event overlaps included and reassigned tasks",
    );
    const expectedDevelopmentTaskIds = ledger.tasks
      .filter(
        (task) =>
          isContributionKind(task.kind) &&
          currentGroups.get(task.id) === oldGroupId,
      )
      .map((task) => task.id);
    requireCondition(
      sameMembers(expectedDevelopmentTaskIds, [...included, ...reassigned]),
      "INVALID_CUT_EVENT",
      "cut_applied event does not cover every old-delivery-unit contribution task",
    );
    const taskSnapshots = z.array(task).safeParse(event.data.task_snapshots);
    requireCondition(
      taskSnapshots.success &&
        sameMembers(
          taskSnapshots.data.map((item) => item.id),
          expectedDevelopmentTaskIds,
        ) &&
        taskSnapshots.data.every(
          (item) =>
            item.group_id === oldGroupId && isContributionKind(item.kind),
        ),
      "INVALID_CUT_EVENT",
      "cut_applied event is missing complete task boundary snapshots",
    );
    const snapshotById = new Map(
      taskSnapshots.success
        ? taskSnapshots.data.map((item) => [item.id, item])
        : [],
    );
    const boundaryStateById = new Map(
      expectedDevelopmentTaskIds.map((taskId) => [
        taskId,
        taskStateAtEvent(
          ledger,
          taskId,
          eventIndex,
          ledger.tasks.find((item) => item.id === taskId)?.state ?? "planned",
        ),
      ]),
    );
    requireCondition(
      [...boundaryStateById.values()].every((state) => state !== null),
      "INVALID_CUT_EVENT",
      "cut_applied event is missing task state history before the cut boundary",
    );
    for (const taskId of expectedDevelopmentTaskIds) {
      const task = ledger.tasks.find((item) => item.id === taskId);
      const snapshot = snapshotById.get(taskId);
      requireCondition(
        task !== undefined &&
          snapshot !== undefined &&
          sameTaskStructure(snapshot, task) &&
          snapshot.group_id === oldGroupId &&
          snapshot.state === boundaryStateById.get(taskId),
        "INVALID_CUT_EVENT",
        `cut_applied event has an invalid task boundary snapshot ${taskId}`,
      );
    }
    for (const taskId of included) {
      const task = ledger.tasks.find((item) => item.id === taskId);
      const snapshot = snapshotById.get(taskId);
      requireCondition(
        task !== undefined &&
          snapshot !== undefined &&
          isContributionKind(task.kind) &&
          currentGroups.get(taskId) === oldGroupId &&
          canonicalJson(task.assignment_history) ===
            canonicalJson(snapshot.assignment_history) &&
          ["integrated", "closed"].includes(snapshot.state),
        "INVALID_CUT_EVENT",
        `cut_applied event has an invalid included task ${taskId}`,
      );
    }
    const reassignmentGroupId = newGroupId as string;
    const seenTaskIds = new Set<string>();
    for (const taskId of reassigned) {
      requireCondition(
        !seenTaskIds.has(taskId),
        "INVALID_CUT_EVENT",
        "cut_applied event repeats a reassigned task",
      );
      seenTaskIds.add(taskId);
      const task = ledger.tasks.find((item) => item.id === taskId);
      const snapshot = snapshotById.get(taskId);
      requireCondition(
        task !== undefined &&
          snapshot !== undefined &&
          isContributionKind(task.kind) &&
          isContributionKind(snapshot.kind) &&
          !["integrated", "completed", "closed"].includes(snapshot.state) &&
          currentGroups.get(taskId) === oldGroupId &&
          task.group_id === newGroupId &&
          task.assignment_history.some(
            (item) =>
              item.group_id === newGroupId &&
              item.cut_operation_id === operationId,
          ),
        "INVALID_CUT_EVENT",
        `cut_applied event has an invalid task boundary snapshot ${taskId}`,
      );
      requireCondition(
        snapshot !== undefined &&
          task.assignment_history.length > snapshot.assignment_history.length &&
          canonicalJson(
            task.assignment_history.slice(
              0,
              snapshot.assignment_history.length,
            ),
          ) === canonicalJson(snapshot.assignment_history) &&
          task.assignment_history[snapshot.assignment_history.length]
            ?.cut_operation_id === operationId,
        "INVALID_CUT_EVENT",
        `cut_applied event does not prove reassignment boundary for task ${taskId}`,
      );
      currentGroups.set(taskId, reassignmentGroupId);
      assignments.set(
        taskId,
        new Set([...(assignments.get(taskId) ?? []), reassignmentGroupId]),
      );
    }
    const historyTaskIds = ledger.tasks
      .filter((task) =>
        task.assignment_history.some(
          (item) => item.cut_operation_id === operationId,
        ),
      )
      .map((task) => task.id);
    requireCondition(
      sameMembers(historyTaskIds, reassigned),
      "INVALID_CUT_EVENT",
      "cut_applied event does not match assignment history",
    );
    appliedOperationIds.add(operationId as string);
    createdGroupIds.add(newGroupId as string);
    dynamicGroupIds.add(reassignmentGroupId);
  }
  for (const task of ledger.tasks)
    requireCondition(
      currentGroups.get(task.id) === task.group_id,
      "INVALID_CUT_EVENT",
      `runtime task ${task.id} has an unsupported group assignment`,
    );
  return { assignments, dynamicGroupIds };
}

export function normalizeLegacyLedger(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const raw = value as Record<string, unknown>;
  const rawPlans = Array.isArray(raw.plans) ? raw.plans : [];
  const plans = rawPlans.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    )
      return candidate;
    const item = normalizeRetiredPlanAlias(
      candidate as Record<string, unknown>,
    );
    if (
      item.plan_handoff !== null &&
      typeof item.plan_handoff === "object" &&
      !Array.isArray(item.plan_handoff) &&
      Object.keys(item.plan_handoff as Record<string, unknown>).length === 0
    ) {
      const { plan_handoff: _legacyHandoff, ...withoutLegacyHandoff } = item;
      return {
        ...withoutLegacyHandoff,
        lifecycle:
          item.lifecycle ??
          (item.approval_id === null ? "proposed" : "approved"),
        revision: item.revision ?? null,
      };
    }
    return {
      ...item,
      lifecycle:
        item.lifecycle ?? (item.approval_id === null ? "proposed" : "approved"),
      revision: item.revision ?? null,
    };
  });
  return {
    ...raw,
    schema_version: 2,
    source_schema_version:
      raw.schema_version === 1 ? 1 : (raw.source_schema_version ?? null),
    contract_version:
      raw.schema_version === undefined ? 1 : raw.contract_version === 2 ? 2 : 1,
    execution_plan_id: raw.execution_plan_id ?? raw.active_plan_id,
    milestones: Array.isArray(raw.milestones) ? raw.milestones : [],
    groups: Array.isArray(raw.groups)
      ? raw.groups.map((item) =>
          item && typeof item === "object"
            ? {
                lifecycle: {
                  workspace_ready: "unknown",
                  pr_created: "unknown",
                  pr_merged: "unknown",
                  closed: "unknown",
                  ...((item as any).lifecycle ?? {}),
                },
                atoms: Array.isArray((item as any).atoms)
                  ? (item as any).atoms
                  : [],
                coordination_execution: (item as any)
                  .coordination_execution ?? {
                  state: "unknown",
                  reason: null,
                  waiting_for_task_ids: [],
                },
                delivery_unit_kind: "regular",
                owner_kind: "group",
                ...(item as any),
              }
            : item,
        )
      : raw.groups,
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((item) =>
          item && typeof item === "object"
            ? {
                branch: null,
                lifecycle: {
                  workspace_ready: "unknown",
                  pr_created: "unknown",
                  pr_merged: "unknown",
                  closed: "unknown",
                  ...((item as any).lifecycle ?? {}),
                },
                ...(item as any),
              }
            : item,
        )
      : raw.tasks,
    notifications: Array.isArray(raw.notifications)
      ? raw.notifications.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? {
                ledger_status: "committed",
                delivery_status:
                  (item as any).delivery_status ??
                  ((item as any).status === "acknowledged"
                    ? "sent"
                    : ((item as any).status ?? "pending")),
                ack_status:
                  (item as any).ack_status ??
                  ((item as any).status === "acknowledged"
                    ? "acknowledged"
                    : "unacknowledged"),
                last_attempt_id: null,
                last_reconciliation_id: null,
                last_error: null,
                ...(item as any),
              }
            : item,
        )
      : raw.notifications,
    plans: plans.map((item: any) => ({
      group_atoms: Array.isArray(item.group_atoms) ? item.group_atoms : [],
      ...item,
    })),
  };
}

function validateDeliveryUnits(ledger: Ledger): void {
  const bootstrap = ledger.groups.filter(
    (item) => item.delivery_unit_kind === "bootstrap",
  );
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
          (!item.agent_thread_id ||
            item.agent_thread_id !== ledger.control.owner_thread_id),
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
        for (const incoming of plan.edges.filter(
          (item) => item.to_node_id === node.id,
        ))
          pending.push(nodes.get(incoming.from_node_id));
      }
    }
  }
}

export function validateLedger(value: unknown): Ledger {
  const parsed = ledgerSchema.parse(normalizeLegacyLedger(value));
  validateDeliveryUnits(parsed);
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
    new Set(parsed.requests.map((item) => item.request_id)).size ===
      parsed.requests.length,
    "DUPLICATE_REQUEST",
    "Request IDs must be unique",
  );
  for (const notice of parsed.notifications) {
    requireCondition(
      notice.ledger_status === "committed",
      "INVALID_NOTIFICATION_STATE",
      "Notification intent must be committed before delivery",
    );
    requireCondition(
      notice.status === "acknowledged"
        ? notice.delivery_status === "sent" &&
            notice.ack_status === "acknowledged"
        : notice.status === notice.delivery_status &&
            notice.ack_status === "unacknowledged",
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
  const activePlan = parsed.plans.find(
    (item) => item.id === parsed.active_plan_id,
  )!;
  const executionPlan = parsed.plans.find(
    (item) => item.id === parsed.execution_plan_id,
  )!;
  requireCondition(
    activePlan.lifecycle !== "superseded" &&
      activePlan.lifecycle !== "abandoned",
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
    parsed.active_plan_id === parsed.execution_plan_id ||
      activePlan.lifecycle === "proposed",
    "INVALID_PLAN_LIFECYCLE",
    "A different active and execution plan requires a proposed active revision",
  );
  requireCondition(
    parsed.control.approval_id === executionPlan.approval_id,
    "APPROVAL_MISMATCH",
    "Control approval must match the execution plan approval",
  );
  for (const item of parsed.plans) {
    validatePlan(item);
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
    parsed.tasks.every((item) =>
      parsed.groups.some((group) => group.id === item.group_id),
    ),
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
  const active = parsed.plans.find(
    (item) => item.id === parsed.active_plan_id,
  )!;
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
    active.nodes
      .filter((item) => item.kind === "task")
      .map((item) => item.ref_id),
  );
  const planGroupIds = new Set(
    active.nodes
      .map((node) => node.group_id)
      .filter((groupId): groupId is string => groupId !== null),
  );
  for (const event of parsed.events)
    if (
      event.type === "cut_applied" &&
      typeof event.data.new_group_id === "string"
    )
      planGroupIds.add(event.data.new_group_id);
  requireCondition(
    parsed.groups.every((group) => planGroupIds.has(group.id)),
    "ORPHAN_GROUP",
    "Runtime group is not present in the active plan",
  );
  const executionPlanTaskIds = new Set(
    (
      parsed.plans.find((item) => item.id === parsed.execution_plan_id)
        ?.nodes ?? []
    )
      .filter((item) => item.kind === "task")
      .map((item) => item.ref_id),
  );
  requireCondition(
    parsed.tasks.every(
      (task) => planTaskIds.has(task.id) || executionPlanTaskIds.has(task.id),
    ),
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
      (event) =>
        event.type === "cut_applied" && event.data.new_group_id === owner.id,
    );
    const snapshot = cut?.data.new_group_snapshot as
      z.infer<typeof group> | undefined;
    const configured = active.group_atoms.filter(
      (atom) => atom.group_id === owner.id,
    );
    const expected = configured.length
      ? configured.map(({ group_id, ...atom }) => atom)
      : (snapshot?.atoms.map(({ status, ...atom }) => atom) ?? []);
    requireCondition(
      canonicalJson(expected) ===
        canonicalJson(owner.atoms.map(({ status, ...atom }) => atom)),
      "GROUP_ATOM_MISMATCH",
      "Delivery-unit atoms must match their plan or verified cut configuration in serial order",
    );
  }
  for (const task of parsed.tasks) {
    const expected = active.atoms
      .filter((atom) => atom.task_id === task.id)
      .map((atom) => atom.id);
    requireCondition(
      JSON.stringify(expected) ===
        JSON.stringify(task.atoms.map((atom) => atom.id)),
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
      const pr = target.type === "group" ? item.parent_pr : item.pr;
      const latest = parsed.facts
        .filter(
          (candidate) =>
            candidate.kind === "pr_published" &&
            candidate.subject_id === item.id,
        )
        .sort((left, right) =>
          left.observed_at.localeCompare(right.observed_at),
        )
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
