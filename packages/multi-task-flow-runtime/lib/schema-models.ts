import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { z } from "zod";
import {
  atomicNode,
  atomicEdge as canonicalAtomicEdge,
  deliveryUnitExternalFacts,
  taskPrBinding,
  validateAtomicBoundaries,
  validateAtomicGraph,
  validateDeliveryUnitLifecycleEdges,
  validateTaskLifecycleEdges,
} from "../lib/atomic-orchestration";
import { requireCondition } from "../lib/errors";
import { topologicalOrder, validateGrouping } from "../lib/graph";
import { normalizeRetiredPlanAlias } from "../lib/legacy-plan-alias";

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const text = z.string().trim().min(1);
export const executionProfile = z.object({ model: text, thinking: text }).strict();
export const optionalExecutionProfile = executionProfile.nullable().default(null);
const defaultExecutionProfile = { model: "gpt-5.6-luna", thinking: "max" };
const timestamp = z.iso.datetime({ offset: false });
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nullableText = text.nullable();
const requirementsPath = nullableText.refine(
  (value) => value === null || /^requirements\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.md$/.test(value),
  "requirements_path must reference a Markdown file under requirements/",
);
const stringMap = z.record(z.string(), z.unknown());
export const executionPhase = z.enum(["planning", "implementation"]);
export const planLifecycle = z.enum(["proposed", "approved", "superseded", "abandoned"]);
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
    scope: z.string().regex(/^(?:batch|task):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
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
export const atomEdge = z.object({ id, from_atom_id: id, to_atom_id: id }).strict();
export const node = z
  .object({
    id,
    kind: z.enum(["main_start", "main_end", "group_start", "group_end", "task", "milestone"]),
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
export const lifecycleStage = z.enum(["unknown", "pending", "passed", "blocked"]);
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
    target: z
      .object({
        type: z.enum(["task", "group"]),
        id,
      })
      .strict()
      .optional(),
    /** Legacy read-only identity; new plans must use target. */
    target_identity: text.optional(),
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
    /** Legacy atom edges remain readable; canonical contract-3 edges use node IDs and requires unions. */
    atomic_edges: z.array(z.union([atomEdge, canonicalAtomicEdge])),
    atomic_nodes: z.array(atomicNode).default([]),
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
    /** Canonical DeliveryUnit PR; parent_pr remains a read-only compatibility alias. */
    pr: z.union([externalRef, deliveryUnitExternalFacts]).nullable().default(null),
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
    execution_profile_source: z.enum(["manual", "recommendation"]).nullable().default(null),
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

export function defaultTaskAtoms(taskId: string) {
  return [
    {
      id: `task-atom-${taskId}-prepare-branch`,
      title: "准备任务分支",
      status: "planned" as const,
      lifecycle_stage: "branch_ready" as const,
    },
    {
      id: `task-atom-${taskId}-create-pr`,
      title: "创建任务 PR",
      status: "planned" as const,
      lifecycle_stage: "pr_created" as const,
    },
    {
      id: `task-atom-${taskId}-merge-pr`,
      title: "合并任务 PR",
      status: "planned" as const,
      lifecycle_stage: "pr_merged" as const,
    },
    {
      id: `task-atom-${taskId}-closeout`,
      title: "任务收口",
      status: "planned" as const,
      lifecycle_stage: "closed" as const,
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
    disposition: z.enum(["active", "superseded", "abandoned"]).default("active"),
    execution_owner: z.enum(["main", "delivery_agent", "task_agent"]).nullable().default(null),
    conversation_policy: z
      .enum(["main_owned", "delivery_owned", "task_agent", "none"])
      .nullable()
      .default(null),
    delivery_policy: z
      .enum(["parent_pr", "child_pr", "shared_delivery_unit", "evidence", "none"])
      .nullable()
      .default(null),
    superseded_by_task_id: nullableText.default(null),
    atoms: z.array(
      z
        .object({
          id,
          title: text,
          status: z.enum(["planned", "running", "completed", "blocked"]),
          lifecycle_stage: z
            .enum(["branch_ready", "pr_created", "pr_merged", "closed"])
            .nullable()
            .optional(),
        })
        .strict(),
    ),
    owned_surfaces: z.array(text),
    branch: nullableText.default(null),
    base_sha: sha.nullable(),
    pr: z.union([externalRef, taskPrBinding]).nullable().default(null),
    requirements_path: requirementsPath,
    execution_profile: optionalExecutionProfile,
    execution_profile_source: z.enum(["manual", "recommendation"]).nullable().default(null),
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
export const baselineReceipt = z
  .object({
    sha,
    head: sha,
    clean: z.literal(true),
    source: text,
    fetched_at: timestamp.optional(),
  })
  .strict();
export const baselineAudit = z
  .object({
    target_type: z.enum(["group", "task"]),
    target_id: id,
    dispatch_operation_id: id,
    native_request_id: text,
    thread_id: text,
    mode: z.enum(["initial", "refresh"]),
    previous_baseline: baselineReceipt.nullable(),
    lineage_event_id: text,
    lineage_sha: sha,
    branch: text,
    resource_ids: z.array(id).min(1),
    receipt: baselineReceipt,
    observed_at: timestamp,
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
      "baseline_verified",
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
          .array(z.object({ name: text, status: z.literal("passed"), evidence_ref: text }).strict())
          .min(1),
      })
      .nullable()
      .optional(),
    receipt: providerReceipt.nullable().optional(),
    baseline: baselineAudit.nullable().optional(),
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
    kind: z.enum(["dispatch", "merge", "cut", "publish_branch", "publish_pr", "release", "deploy"]),
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
  "development_baseline_synchronized",
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
  "external_merge_reconciled",
  "task_completed",
  "task_closed",
  "merge_claimed",
  "merge_resolved",
  "publish_branch_claimed",
  "publish_branch_resolved",
  "publish_branch_repaired",
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
export const notificationDeliveryStatus = z.enum(["pending", "sent", "failed", "unknown"]);
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
export const resource = z
  .object({
    id,
    kind: z.enum(["conversation", "worktree", "branch", "port", "service"]),
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
  .strict();
export const ledgerSchema = z
  .object({
    schema_version: z.literal(2),
    source_schema_version: z.literal(1).nullable().default(null),
    contract_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    version: z
      .object({
        skill_id: text,
        skill_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
        viewer_contract: z.number().int().positive(),
      })
      .strict()
      .nullable()
      .default(null),
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
    /** Contract-3 canonical graph snapshot; legacy readers may derive this from the active plan. */
    atomic_nodes: z.array(atomicNode).default([]),
    atomic_edges: z.array(z.union([atomEdge, canonicalAtomicEdge])).default([]),
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
    resources: z.array(resource),
    updated_at: timestamp,
  })
  .strict();
export type Ledger = z.infer<typeof ledgerSchema>;
export type Plan = z.infer<typeof plan>;
export type Task = z.infer<typeof task>;
