import { conversationArchiveEligibility } from "../lib/conversation-eligibility";
import { runtimeTaskState } from "../web/task-state";
import { planWarnings } from "../lib/view-warnings";
export { planWarnings, type PlanWarning } from "../lib/view-warnings";
import { createAtomProjection } from "../lib/view-atoms";
import {
  profileProjection,
  profileMigrationWarnings,
} from "../lib/execution-profile";
import { ContractError, requireCondition } from "../lib/errors";
import {
  isContributionKind,
  planCompletenessIssues,
  taskExecutionPolicyIssues,
  validateLedger,
  type Ledger,
  type Plan,
} from "../lib/schema";
import { ready } from "../lib/engine";
import {
  deriveExecutionPhase,
  reasonRequired,
  evidenceRequired,
} from "../lib/revisions";
import { initialOutput, type AgentOutput } from "../web/agent-output";
import { localSemanticProjection } from "../lib/contract";
import { SKILL_ID, SKILL_VERSION, VIEWER_CONTRACT } from "../lib/contract";
import type { AtomicEdge, AtomicNode } from "../lib/atomic-orchestration";

export type PlannedInterval = {
  node_id: string;
  start: string | null;
  end: string | null;
  start_offset_minutes: number | null;
  end_offset_minutes: number | null;
};

const RELATIVE_EPOCH = Date.parse("2000-01-01T00:00:00.000Z");

function deliveryGateDiagnostics(group: Ledger["groups"][number]): Record<string, string>[] {
  const workspaceAtom = group.atoms.find((atom) => atom.lifecycle_stage === "workspace_ready");
  const prAtom = group.atoms.find((atom) => atom.lifecycle_stage === "pr_created");
  const diagnostics: Record<string, string>[] = [];
  if (group.lifecycle.workspace_ready !== "passed" || workspaceAtom?.status !== "completed")
    diagnostics.push({ code: "DELIVERY_WORKSPACE_GATE_PENDING", message: "交付单元尚未完成 workspace_ready 原子任务" });
  if (group.lifecycle.pr_created !== "passed" || !group.parent_pr || prAtom?.status !== "completed")
    diagnostics.push({ code: "DELIVERY_PARENT_PR_GATE_PENDING", message: "父 PR 尚未创建、核验并完成交付原子任务" });
  return diagnostics;
}

function formalExecutionWarnings(ledger: Ledger): Record<string, unknown>[] {
  return ledger.groups.flatMap((group) => {
    if (group.state !== "active" || group.coordination_execution.state !== "running")
      return [];
    const tasks = ledger.tasks.filter(
      (task) =>
        task.group_id === group.id &&
        isContributionKind(task.kind) &&
        ["planned", "ready"].includes(task.state),
    );
    if (!tasks.length) return [];
    const taskIds = new Set(tasks.map((task) => task.id));
    const hasDispatch = ledger.operations.some(
      (operation) =>
        operation.kind === "dispatch" &&
        [group.id, ...taskIds].includes(operation.target_id),
    );
    if (hasDispatch || tasks.some((task) => task.thread_id)) return [];
    return [{
      code: "formal_execution_missing",
      group_id: group.id,
      task_ids: tasks.map((task) => task.id),
      reason: "交付单元正在运行，但没有正式 task dispatch 或任务对话记录。",
    }];
  });
}

type ReadinessBlocker = {
  code: string;
  group_id: string | null;
  message: string;
  resource: {
    kind: "conversation" | "worktree" | "branch" | "pr";
    status: "not_created" | "unknown";
    target_id: string | null;
  } | null;
};

type RuntimeReadiness = {
  status: "ready" | "blocked" | "unknown";
  blockers: ReadinessBlocker[];
};

function planGroupIds(ledger: Ledger, plan: Plan): Set<string> {
  const taskIds = new Set(
    plan.nodes
      .filter((node) => node.kind === "task" && node.ref_id)
      .map((node) => node.ref_id),
  );
  const groupIds = new Set(
    plan.nodes
      .map((node) => node.group_id)
      .filter((groupId): groupId is string => groupId !== null),
  );
  for (const task of ledger.tasks) {
    if (taskIds.has(task.id)) groupIds.add(task.group_id);
  }
  return groupIds;
}

function requiresRuntimeEvidence(ledger: Ledger): boolean {
  return !(ledger.source_schema_version === 1 && ledger.contract_version !== 2);
}

function planSchedulingIssues(ledger: Ledger, plan: Plan): PlanCompletenessIssue[] {
  if (ledger.source_schema_version === 1) return [];
  const contributionTasks = ledger.tasks.filter(
    (task) => task.disposition === "active" && isContributionKind(task.kind),
  );
  const groupIds = new Set(contributionTasks.map((task) => task.group_id));
  const missing: string[] = [];
  for (const groupId of groupIds) {
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      if (!plan.actions.some(
        (action) =>
          action.kind === kind &&
          action.group_id === groupId &&
          action.task_id === null,
      )) missing.push(`${kind}:group:${groupId}`);
    }
  }
  for (const task of contributionTasks) {
    if (!plan.actions.some((action) => action.task_id === task.id)) continue;
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      if (!plan.actions.some(
        (action) =>
          action.kind === kind &&
          action.task_id === task.id &&
          action.group_id === null,
      )) missing.push(`${kind}:task:${task.id}`);
    }
  }
  return missing.length
    ? [{
        code: "PLAN_NOT_DISPATCHABLE",
        message: `贡献任务执行需要批准的发布动作：${missing.join(", ")}`,
      }]
    : [];
}

function taskSchedulingIssues(ledger: Ledger): Array<PlanCompletenessIssue & { group_id: string }> {
  if (ledger.source_schema_version === 1) return [];
  return ledger.tasks.flatMap((task) =>
    taskExecutionPolicyIssues(task).map((issue) => ({ ...issue, group_id: task.group_id })),
  );
}

function activeGroupDispatch(
  ledger: Ledger,
  groupId: string,
): Ledger["operations"][number] | null {
  return ledger.operations.find(
    (operation) =>
      operation.kind === "dispatch" &&
      operation.target_id === groupId &&
      operation.request.target_type === "group" &&
      ["claimed", "unknown", "succeeded"].includes(operation.status),
  ) ?? null;
}

function coordinatorProjection(ledger: Ledger, group: Ledger["groups"][number]) {
  if (group.delivery_unit_kind === "bootstrap") {
    return ledger.control.owner_thread_id
      ? { status: "bound" as const, thread_id: ledger.control.owner_thread_id }
      : { status: "unknown" as const, thread_id: null };
  }
  return group.agent_thread_id
    ? { status: "bound" as const, thread_id: group.agent_thread_id }
    : activeGroupDispatch(ledger, group.id)
      ? { status: "unknown" as const, thread_id: null }
    : { status: "not_created" as const, thread_id: null };
}

function blockerResource(
  ledger: Ledger,
  kind: "worktree" | "branch",
  targetId: string,
): ReadinessBlocker["resource"] {
  return {
    kind,
    status: ledger.resources.some(
      (resource) => resource.kind === kind && resource.target === targetId,
    ) ? "unknown" : "not_created",
    target_id: targetId,
  };
}

function groupWorkspaceBlockers(
  ledger: Ledger,
  group: Ledger["groups"][number],
): ReadinessBlocker[] {
  if (!requiresRuntimeEvidence(ledger)) return [];
  const hasContributionWork = ledger.tasks.some(
    (task) =>
      task.group_id === group.id &&
      task.disposition === "active" &&
      isContributionKind(task.kind) &&
      !["integrated", "completed", "closed"].includes(task.state),
  );
  const groupDispatch = activeGroupDispatch(ledger, group.id);
  const hasCodexExecDispatch =
    groupDispatch?.status === "succeeded" &&
    (groupDispatch.request.creation_parameters as any)?.transport === "codex-exec";
  if (!hasContributionWork && !hasCodexExecDispatch) return [];

  const blockers: ReadinessBlocker[] = [];
  if (group.lifecycle.workspace_ready !== "passed") {
    blockers.push({
      code: "WORKSPACE_NOT_READY",
      group_id: group.id,
      message: `交付单元「${group.title}」尚未记录通过的工作区就绪事实。`,
      resource: blockerResource(ledger, "worktree", group.id),
    });
    return blockers;
  }

  const worktreeReady = ledger.resources.some(
    (resource) =>
      resource.kind === "worktree" &&
      resource.target === group.id &&
      resource.status === "active",
  );
  if (!worktreeReady) {
    blockers.push({
      code: "WORKSPACE_NOT_READY",
      group_id: group.id,
      message: `交付单元「${group.title}」缺少可用的活动工作区。`,
      resource: blockerResource(ledger, "worktree", group.id),
    });
  }

  if (!group.parent_branch || !group.current_sha) {
    blockers.push({
      code: "BASE_NOT_READY",
      group_id: group.id,
      message: `交付单元「${group.title}」缺少可核对的父分支基线。`,
      resource: blockerResource(ledger, "branch", group.parent_branch ?? group.id),
    });
  } else {
    const branchReady = ledger.resources.some(
      (resource) =>
        resource.kind === "branch" &&
        resource.target === group.parent_branch &&
        resource.status === "active",
    );
    if (!branchReady) {
      blockers.push({
        code: "WORKSPACE_NOT_READY",
        group_id: group.id,
        message: `交付单元「${group.title}」缺少活动父分支资源。`,
        resource: blockerResource(ledger, "branch", group.parent_branch),
      });
    }
  }

  if (hasContributionWork && group.parent_branch && group.current_sha) {
    const publication = ledger.facts
      .filter(
        (fact) =>
          fact.kind === "branch_published" && fact.subject_id === group.id,
      )
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
      .at(-1);
    const branchPublished =
      publication?.status === "passed" &&
      publication.sha === group.current_sha &&
      publication.receipt?.resource_type === "branch" &&
      publication.receipt.branch === group.parent_branch;
    if (!branchPublished) {
      blockers.push({
        code: publication?.status === "unknown"
          ? "BRANCH_PUBLICATION_UNKNOWN"
          : "BRANCH_NOT_PUBLISHED",
        group_id: group.id,
        message: publication?.status === "unknown"
          ? `交付单元「${group.title}」的父分支发布回执未知。`
          : `交付单元「${group.title}」尚未取得匹配当前基线的父分支发布回执。`,
        resource: blockerResource(ledger, "branch", group.parent_branch),
      });
    }
  }

  if (hasCodexExecDispatch) {
    const baseline = groupDispatch?.request.development_baseline as any;
    const baselineReady =
      baseline &&
      baseline.clean === true &&
      baseline.sha === baseline.head &&
      baseline.sha === group.current_sha;
    if (!baselineReady) {
      blockers.push({
        code: "BASELINE_NOT_VERIFIED",
        group_id: group.id,
        message: `交付单元「${group.title}」尚未记录与当前基线匹配的干净工作区回执。`,
        resource: null,
      });
    }
  }
  return blockers;
}

function blockersReadiness(blockers: ReadinessBlocker[]): RuntimeReadiness {
  return {
    status: blockers.some((item) => item.code.endsWith("UNKNOWN"))
      ? blockers.some((item) => !item.code.endsWith("UNKNOWN")) ? "blocked" : "unknown"
      : "blocked",
    blockers,
  };
}

function groupRuntimeReadiness(
  ledger: Ledger,
  group: Ledger["groups"][number],
  relevant: boolean,
): RuntimeReadiness {
  if (!relevant) return { status: "unknown", blockers: [] };
  if (group.state === "closed") {
    return {
      status: "blocked",
      blockers: [{
        code: "GROUP_CLOSED",
        group_id: group.id,
        message: `交付单元「${group.title}」已经收口，不能继续运行时派发。`,
        resource: null,
      }],
    };
  }
  if (
    requiresRuntimeEvidence(ledger) &&
    (ledger.control.ownership !== "bound" || !ledger.control.owner_thread_id)
  ) {
    return {
      status: "unknown",
      blockers: [{
        code: "CONTROL_OWNERSHIP_UNKNOWN",
        group_id: group.id,
        message: "编排控制权尚未确认，运行时派发保持未知。",
        resource: null,
      }],
    };
  }
  const coordinator = coordinatorProjection(ledger, group);
  if (coordinator.status === "not_created") {
    return {
      status: "blocked",
      blockers: [{
        code: "COORDINATOR_NOT_BOUND",
        group_id: group.id,
        message: `普通交付单元「${group.title}」尚未绑定交付协调者，运行时派发保持阻断。`,
        resource: { kind: "conversation", status: "not_created", target_id: group.id },
      }],
    };
  }
  if (coordinator.status === "unknown") {
    return {
      status: "unknown",
      blockers: [{
        code: "COORDINATOR_UNKNOWN",
        group_id: group.id,
        message: `交付单元「${group.title}」的交付协调者绑定未知。`,
        resource: { kind: "conversation", status: "unknown", target_id: group.id },
      }],
    };
  }
  if (group.state === "planned") {
    return {
      status: "blocked",
      blockers: [{
        code: "GROUP_NOT_ACTIVE",
        group_id: group.id,
        message: `交付单元「${group.title}」尚未激活，任务运行时派发保持阻断。`,
        resource: null,
      }],
    };
  }
  if (group.state === "blocked") {
    return {
      status: "blocked",
      blockers: [{
        code: "GROUP_BLOCKED",
        group_id: group.id,
        message: `交付单元「${group.title}」当前处于阻塞状态。`,
        resource: null,
      }],
    };
  }
  const workspaceBlockers = groupWorkspaceBlockers(ledger, group);
  return workspaceBlockers.length
    ? blockersReadiness(workspaceBlockers)
    : { status: "ready", blockers: [] };
}

function runtimeReadinessProjection(ledger: Ledger, plan: Plan): {
  summary: RuntimeReadiness;
  byGroup: Map<string, RuntimeReadiness>;
} {
  const groupIds = planGroupIds(ledger, plan);
  const byGroup = new Map(
    ledger.groups.map((group) => [group.id, groupRuntimeReadiness(ledger, group, groupIds.has(group.id))]),
  );
  const summaries = [...byGroup.values()].filter((item) => item.blockers.length > 0);
  const blockers = summaries
    .filter((item) => {
      const group = ledger.groups.find((candidate) => candidate.id === item.blockers[0]?.group_id);
      if (!group) return true;
      if (group.state === "planned" && item.blockers.every((blocker) => blocker.code === "COORDINATOR_NOT_BOUND")) return false;
      if (group.state === "closed" || group.state === "blocked") {
        return ledger.tasks.some((task) =>
          task.group_id === group.id &&
          task.disposition === "active" &&
          ["planned", "ready"].includes(task.state) &&
          !task.thread_id,
        );
      }
      return true;
    })
    .flatMap((item) => item.blockers);
  return {
    summary: {
      status: blockers.some((item) => item.code.endsWith("UNKNOWN"))
        ? blockers.some((item) => !item.code.endsWith("UNKNOWN")) ? "blocked" : "unknown"
        : blockers.length ? "blocked" : "ready",
      blockers,
    },
    byGroup,
  };
}

export function plannedIntervals(plan: Plan, maxRunning: number): PlannedInterval[] {
  const start = 0;
  const order = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const remaining = new Set(plan.nodes.map((node) => node.id));
  const results = new Map<
    string,
    { start: number | null; end: number | null }
  >();
  const lanes = Array.from({ length: maxRunning }, () => start);
  const instant = new Set([
    "main_start",
    "main_end",
    "group_start",
    "group_end",
  ]);
  while (remaining.size) {
    const candidates = plan.nodes.filter(
      (node) =>
        remaining.has(node.id) &&
        plan.edges
          .filter((edge) => edge.to_node_id === node.id)
          .every((edge) => results.has(edge.from_node_id)),
    );
    requireCondition(candidates.length, "CYCLE", "Cannot schedule cyclic plan");
    const choices = candidates
      .map((node) => {
        const predecessors = plan.edges
          .filter((edge) => edge.to_node_id === node.id)
          .map((edge) => results.get(edge.from_node_id)!.end);
        const predecessorEnd =
          predecessors.some((time) => time === null)
            ? null
            : Math.max(start, ...(predecessors as number[]));
        const lane =
          node.kind === "task" ? lanes.indexOf(Math.min(...lanes)) : -1;
        const laneStart = lane >= 0 ? lanes[lane] : undefined;
        const available =
          lane < 0
            ? predecessorEnd
              : predecessorEnd === null || laneStart === undefined
              ? null
              : Math.max(predecessorEnd, laneStart);
        const priority = plan.edges.filter(
          (edge) => edge.from_node_id === node.id,
        ).length;
        return { node, available, lane, priority };
      })
      .sort(
        (a, b) =>
          (a.available ?? Infinity) - (b.available ?? Infinity) ||
          b.priority - a.priority ||
          order.get(a.node.id)! - order.get(b.node.id)! ||
          a.node.id.localeCompare(b.node.id),
      );
    const chosen = choices[0];
    requireCondition(
      chosen !== undefined,
      "CYCLE",
      "Cannot choose a plan node",
    );
    const duration = instant.has(chosen.node.kind)
      ? 0
      : chosen.node.estimate_minutes;
    const end =
      chosen.available === null || duration === null
        ? null
        : chosen.available + duration * 60_000;
    if (chosen.lane >= 0) lanes[chosen.lane] = end ?? Infinity;
    results.set(chosen.node.id, { start: chosen.available, end });
    remaining.delete(chosen.node.id);
  }
  return plan.nodes.map((node) => {
    const interval = results.get(node.id)!;
    return {
      node_id: node.id,
      start: interval.start === null ? null : new Date(RELATIVE_EPOCH + interval.start).toISOString(),
      end: interval.end === null ? null : new Date(RELATIVE_EPOCH + interval.end).toISOString(),
      start_offset_minutes: interval.start === null ? null : interval.start / 60000,
      end_offset_minutes: interval.end === null ? null : interval.end / 60000,
    };
  });
}

export function actualIntervals(ledger: Ledger): {
  task_id: string;
  group_id: string;
  state: string;
  start: string;
  end: string | null;
}[] {
  const intervals: {
    task_id: string;
    group_id: string;
    state: string;
    start: string;
    end: string | null;
  }[] = [];
  for (const task of ledger.tasks) {
    let current: (typeof intervals)[number] | null = null;
    const cuts = ledger.events.filter(
      (event) =>
        event.type === "cut_applied" &&
        Array.isArray(event.data.reassigned_task_ids) &&
        event.data.reassigned_task_ids.includes(task.id),
    );
    let groupId =
      typeof cuts[0]?.data.old_group_id === "string"
        ? cuts[0].data.old_group_id
        : task.group_id;
    const events = ledger.events
      .filter(
        (event) =>
          event.occurred_at &&
          (cuts.includes(event) ||
            ((event.subject_id === task.id || event.data.task_id === task.id) &&
              ([
                "task_started",
                "task_resumed",
                "task_runtime_observed",
                "task_waiting",
                "task_blocked",
                "task_completed",
              ].includes(event.type) ||
                (event.type === "merge_resolved" &&
                  event.data.outcome === "succeeded")))),
      )
      .sort((a, b) => a.occurred_at!.localeCompare(b.occurred_at!));
    for (const event of events) {
      const time = event.occurred_at!;
      if (event.type === "cut_applied") {
        if (typeof event.data.new_group_id === "string") {
          groupId = event.data.new_group_id;
          if (current) {
            const previous: (typeof intervals)[number] = current;
            intervals.push({ ...previous, end: time });
            current = { ...previous, group_id: groupId, start: time };
          }
        }
        continue;
      }
      if (current) {
        current.end = time;
        intervals.push(current);
        current = null;
      }
      if (typeof event.data.group_id === "string")
        groupId = event.data.group_id;
      if (event.type === "task_runtime_observed" && ["running", "agent_idle"].includes(String(event.data.state)))
        current = { task_id: task.id, group_id: groupId, state: String(event.data.state), start: time, end: null };
      if (["task_started", "task_resumed"].includes(event.type))
        current = {
          task_id: task.id,
          group_id: groupId,
          state: "running",
          start: time,
          end: null,
        };
      if (["task_waiting", "task_blocked"].includes(event.type))
        current = {
          task_id: task.id,
          group_id: groupId,
          state: event.type === "task_waiting" ? "waiting" : "blocked",
          start: time,
          end: null,
        };
    }
    if (current) intervals.push(current);
  }
  return intervals;
}

export function buildView(
  input: unknown,
  planId?: string,
  outputs: Record<string, AgentOutput> = {},
): Record<string, unknown> {
  const ledger = validateLedger(input);
  const plan = ledger.plans.find(
    (item) => item.id === (planId ?? ledger.active_plan_id),
  );
  if (!plan) throw new ContractError("PLAN_NOT_FOUND", "Plan not found", 2);
  const atomProjection = createAtomProjection(ledger, plan);
  const { atomTime } = atomProjection;
  const phase = deriveExecutionPhase(ledger);
  const activePlan = ledger.plans.find(
    (item) => item.id === ledger.active_plan_id,
  )!;
  const executionPlan = ledger.plans.find(
    (item) => item.id === ledger.execution_plan_id,
  )!;
  const completenessIssues = planCompletenessIssues(plan);
  const schedulingPlanIssues = planSchedulingIssues(ledger, plan);
  const schedulingTaskIssues = taskSchedulingIssues(ledger);
  const isApprovedExecution =
    activePlan.id === executionPlan.id && activePlan.lifecycle === "approved";
  const runtimeProjection = runtimeReadinessProjection(ledger, plan);
  const approvalPending =
    activePlan.id !== executionPlan.id || activePlan.lifecycle !== "approved";
  const schedulingBlockers: ReadinessBlocker[] = [
    ...(approvalPending
      ? [{
          code: "OWNER_APPROVAL_PENDING",
          group_id: null,
          message: "Owner approval 尚未完成，运行时派发保持阻断。",
          resource: null,
        }]
      : []),
    ...completenessIssues.map((issue) => ({
      code: issue.code,
      group_id: null,
      message: issue.message,
      resource: null,
    })),
    ...schedulingPlanIssues.map((issue) => ({
      code: issue.code,
      group_id: null,
      message: issue.message,
      resource: null,
    })),
    ...schedulingTaskIssues.map((issue) => ({
      code: issue.code,
      group_id: issue.group_id,
      message: issue.message,
      resource: null,
    })),
    ...runtimeProjection.summary.blockers,
  ];
  const schedulingStatus = approvalPending || completenessIssues.length || schedulingPlanIssues.length || schedulingTaskIssues.length
    ? "blocked"
    : runtimeProjection.summary.status === "ready"
      ? "eligible"
      : runtimeProjection.summary.status;
  const nodeData = plan.nodes.map((node) => ({
    ...node,
    planned_group_id: node.group_id,
    group_id:
      node.kind === "task"
        ? (ledger.tasks.find((task) => task.id === node.ref_id)?.group_id ??
          null)
        : node.group_id,
  }));
  const canonicalAtomicNodes: AtomicNode[] = plan.atomic_nodes.length
    ? plan.atomic_nodes
    : plan.nodes
        .filter((node) => node.kind === "task" || node.kind === "milestone")
        .map((node) => {
          const task = node.kind === "task" && node.ref_id ? ledger.tasks.find((item) => item.id === node.ref_id) : undefined;
          if (node.kind === "milestone") {
            return {
              kind: "milestone" as const,
              id: node.id,
              title: node.label,
              state: "planned" as const,
              scope: { kind: "delivery_unit" as const, delivery_unit_id: node.group_id ?? "unassigned" },
              acceptance: [],
            };
          }
          return {
            kind: "work" as const,
            id: node.id,
            title: node.label,
            purpose: node.label,
            output: task?.owned_surfaces?.join(", ") ?? node.label,
            acceptance: [],
            activity_type: (task?.kind === "verification" || task?.kind === "release" || task?.kind === "deployment" ? task.kind : "contribution") as "contribution" | "verification" | "release" | "deployment",
            state: task?.state === "running" ? "running" : task?.state === "blocked" ? "blocked" : "planned",
            scope: { kind: "task" as const, task_id: node.ref_id ?? node.id, delivery_unit_id: task?.group_id ?? node.group_id ?? "unassigned" },
          };
        });
  const existingAtomicNodeIds = new Set(canonicalAtomicNodes.map((node) => node.id));
  for (const node of plan.nodes.filter((item) => item.kind === "milestone" && !existingAtomicNodeIds.has(item.id))) {
    canonicalAtomicNodes.push({
      kind: "milestone",
      id: node.id,
      title: node.label,
      state: "planned",
      scope: { kind: "delivery_unit", delivery_unit_id: node.group_id ?? "unassigned" },
      acceptance: [],
    });
  }
  const canonicalAtomicNodeIds = new Set(canonicalAtomicNodes.map((node) => node.id));
  const declaredAtomicEdges: AtomicEdge[] = plan.atomic_edges.map((edge) =>
    "from_node_id" in edge
      ? edge
      : { id: edge.id, from_node_id: edge.from_atom_id, to_node_id: edge.to_atom_id, requires: { kind: "source_terminal_success" as const } },
  );
  const legacyAtomicEdges: AtomicEdge[] = plan.edges
    .filter((edge) => canonicalAtomicNodeIds.has(edge.from_node_id) && canonicalAtomicNodeIds.has(edge.to_node_id))
    .map((edge) => ({ id: edge.id, from_node_id: edge.from_node_id, to_node_id: edge.to_node_id, requires: { kind: edge.requires as "source_terminal_success" } }));
  const seenAtomicEdges = new Set(declaredAtomicEdges.map((edge) => `${edge.from_node_id}->${edge.to_node_id}`));
  const canonicalAtomicEdges: AtomicEdge[] = [...declaredAtomicEdges, ...legacyAtomicEdges.filter((edge) => {
    const key = `${edge.from_node_id}->${edge.to_node_id}`;
    if (seenAtomicEdges.has(key)) return false;
    seenAtomicEdges.add(key);
    return true;
  })];
  const selectedTaskIds = new Set(
    plan.nodes
      .filter((node) => node.kind === "task")
      .map((node) => node.ref_id),
  );
  const tasks = ledger.tasks
    .filter((task) => selectedTaskIds.has(task.id))
    .map((task) => {
      const owner = ledger.groups.find((item) => item.id === task.group_id);
      let isReady = false;
      const isHeld =
        activePlan.revision?.paused_task_ids.includes(task.id) === true &&
        activePlan.id !== executionPlan.id;
      if (["planned", "ready"].includes(task.state)) {
        try {
          const owner = ledger.groups.find((item) => item.id === task.group_id);
          const groupReady =
            !!owner &&
            (owner.delivery_unit_kind === "bootstrap" ||
              !!owner.agent_thread_id) &&
            (["release", "deployment", "verification"].includes(task.kind)
              ? owner.state === "merged" && !!owner.merge_sha
              : owner.state === "active" &&
                (!isContributionKind(task.kind) ||
                  (!!task.base_sha && task.base_sha === owner.current_sha)));
          isReady = !isHeld && groupReady && ready(ledger, task.id);
        } catch {
          isReady = false;
        }
      }
      const plannedAtoms = plan.atoms.filter(
        (atom) => atom.task_id === task.id,
      );
      const runtimeAtoms = new Map(task.atoms.map((atom) => [atom.id, atom]));
      const atoms = plannedAtoms.length
        ? plannedAtoms.map((atom) => ({
            id: atom.id,
            title: atom.title,
            purpose: atom.purpose,
            output: atom.output,
            status: runtimeAtoms.get(atom.id)?.status ?? "planned",
          }))
        : [];
      return {
        ...task,
        ...(() => {
          const gateDiagnostics = owner && isContributionKind(task.kind) ? deliveryGateDiagnostics(owner) : [];
          return { gateDiagnostics };
        })(),
        dispatch_diagnostics: [
          ...taskExecutionPolicyIssues(task),
          ...(owner && owner.delivery_unit_kind === "regular" && !owner.agent_thread_id
            ? [{ code: "DELIVERY_AGENT_NOT_BOUND", message: "regular delivery unit 未绑定交付 Agent" }]
            : []),
          ...((owner && isContributionKind(task.kind)) ? deliveryGateDiagnostics(owner) : []),
        ],
        dispatch_readiness:
          task.execution_owner === null && task.conversation_policy === null && task.delivery_policy === null
            ? "unknown"
            : taskExecutionPolicyIssues(task).length > 0
              ? "blocked"
              : owner && isContributionKind(task.kind) && deliveryGateDiagnostics(owner).length > 0
                ? "blocked"
              : owner && (owner.delivery_unit_kind === "bootstrap" || !!owner.agent_thread_id)
              ? "ready"
              : "blocked",
        state: runtimeTaskState(task, outputs[task.id]),
        ...(runtimeTaskState(task, outputs[task.id]) === "agent_idle" && task.state !== "agent_idle" ? { agent_resume_state: task.state } : {}),
        atoms: atoms.map((atom) => ({
          ...atom,
          completed_at: atomTime(task.id, atom),
        })),
        planned_atoms: plannedAtoms,
        is_ready: isReady,
        is_held: isHeld,
        hold_reason: isHeld ? "等待高影响计划修订批准" : null,
        latest_agent_output: outputs[task.id] ?? initialOutput(task.thread_id),
        latest_output: outputs[task.id]?.text ?? null,
        conversation_archive: conversationArchiveEligibility(ledger, task.id),
        conversation_resource: task.thread_id
          ? ledger.resources.find(
              (resource) =>
                resource.kind === "conversation" && resource.target === task.thread_id,
            ) ?? null
          : null,
      };
    });
  const allTasksDispatchReady = tasks.every(
    (task) => task.dispatch_readiness === "ready",
  );
  const planSummary = ledger.plans.map((item) => ({
    id: item.id,
    created_at: item.created_at,
    approval_id: item.approval_id,
    lifecycle: item.lifecycle,
    is_active: item.id === ledger.active_plan_id,
    is_execution: item.id === ledger.execution_plan_id,
    change_class: item.revision?.change_class ?? null,
    approval_required: item.revision?.approval_required ?? false,
    reason_required: item.revision ? reasonRequired(item.revision) : false,
    evidence_required: item.revision ? evidenceRequired(item.revision) : false,
    paused_task_ids: item.revision?.paused_task_ids ?? [],
  }));
  return {
    orchestration: {
      id: ledger.orchestration_id,
      owner_thread_id: ledger.control.owner_thread_id,
      repository: ledger.repository,
      revision: ledger.revision,
      updated_at: ledger.updated_at,
      display_timezone: ledger.config.display_timezone,
      max_running_tasks: ledger.config.max_running_tasks,
      conversation_links_verified: ledger.config.conversation_links_verified,
      contract_version: ledger.contract_version,
      version: ledger.version,
      version_status: ledger.version === null
        ? { state: "historical_read_only", reason: "账本未声明 Skill 版本身份" }
        : ledger.version.skill_id !== SKILL_ID || ledger.version.skill_version !== SKILL_VERSION || ledger.version.viewer_contract !== VIEWER_CONTRACT
          ? { state: "mismatch", reason: "Skill、账本和 Viewer 版本不一致" }
          : { state: "current", reason: null },
      execution_profile: ledger.config.execution_profile,
    },
    execution_phase: phase,
    active_plan_id: ledger.active_plan_id,
    execution_plan_id: ledger.execution_plan_id,
    plan_state: {
      active_plan_id: ledger.active_plan_id,
      execution_plan_id: ledger.execution_plan_id,
      lifecycle: activePlan.lifecycle,
      phase,
      approval_pending:
        activePlan.id !== executionPlan.id ||
        activePlan.lifecycle !== "approved",
      scheduling_eligible: schedulingStatus === "eligible",
      dispatch_readiness: ledger.groups.every((item) => item.delivery_unit_kind === "bootstrap" || !!item.agent_thread_id) && allTasksDispatchReady ? "ready" : "blocked",
      delivery_agent_readiness: ledger.groups.some((item) => item.delivery_unit_kind === "regular" && !item.agent_thread_id) ? "unbound" : "bound",
      proposal: {
        status: completenessIssues.length === 0 ? "complete" : "blocked",
        issues: completenessIssues,
      },
      approval: {
        status: isApprovedExecution ? "approved" : "not_approved",
        approval_id: isApprovedExecution ? activePlan.approval_id : null,
      },
      scheduling: {
        status: schedulingStatus,
        blockers: schedulingBlockers,
      },
      runtime_readiness: runtimeProjection.summary,
      completeness: {
        status: completenessIssues.length === 0 ? "complete" : "blocked",
        issues: completenessIssues,
      },
      authorization_label: isApprovedExecution
        ? schedulingStatus === "eligible"
          ? "Schedulable"
          : "Not schedulable"
        : "Not approved",
      revision: activePlan.revision,
    },
    semantic_context: localSemanticProjection(ledger, "dashboard_view"),
    groups: atomProjection.groups.map((item) => ({
      ...item,
      ...(() => {
        const gateDiagnostics = item.delivery_unit_kind === "regular" ? deliveryGateDiagnostics(item) : [];
        return { gateDiagnostics };
      })(),
      delivery_agent_readiness: item.delivery_unit_kind === "bootstrap" ? "not_applicable" : item.agent_thread_id ? "bound" : "unbound",
      dispatch_readiness: item.delivery_unit_kind === "bootstrap" || (!!item.agent_thread_id && deliveryGateDiagnostics(item).length === 0) ? "ready" : "blocked",
      dispatch_diagnostics: [
        ...(item.delivery_unit_kind === "regular" && !item.agent_thread_id ? [{ code: "DELIVERY_AGENT_NOT_BOUND", message: "regular delivery unit 未绑定交付 Agent" }] : []),
        ...(item.delivery_unit_kind === "regular" ? deliveryGateDiagnostics(item) : []),
      ],
      ...profileProjection(ledger, "group", item),
      coordinator: coordinatorProjection(ledger, item),
      runtime_readiness: runtimeProjection.byGroup.get(item.id) ?? { status: "unknown", blockers: [] },
      latest_agent_output: outputs[`group:${item.id}`] ?? initialOutput(item.delivery_unit_kind === "bootstrap" ? ledger.control.owner_thread_id : item.agent_thread_id),
      started_at: ledger.events.find(e => e.type === "group_execution_updated" && e.data.group_id === item.id && e.data.state === "running")?.occurred_at ?? null,
      finished_at: ledger.events.find(e => e.type === "group_updated" && e.subject_id === item.id && e.data.state === "closed")?.occurred_at ?? null,
    })),
    tasks: tasks.map((item) => ({
      ...item,
      ...profileProjection(ledger, "task", item),
    })),
    profile_read_only: !ledger.config.execution_profile,
    follow_prs: ledger.follow_prs,
    plans: planSummary,
    selected_plan_id: plan.id,
    nodes: nodeData,
    edges: plan.edges,
    atomic_edges: plan.atomic_edges,
    atomic_nodes: canonicalAtomicNodes,
    canonical_atomic_edges: canonicalAtomicEdges,
    planned_intervals: plannedIntervals(plan, ledger.config.max_running_tasks),
    actual_intervals: actualIntervals(ledger),
    actual_milestones: plan.nodes
      .filter((node) => node.kind !== "task")
      .map((node) => {
        const event = ledger.events.find(
          (item) =>
            (node.kind === "main_end" && item.type === "run_completed") ||
            (node.ref_id &&
              item.subject_id === node.ref_id &&
              item.type === "group_updated" &&
              ((node.kind === "group_start" && item.data.state === "active") ||
                (node.kind === "group_end" && item.data.state === "closed"))),
        );
        return { node_id: node.id, occurred_at: event?.occurred_at ?? null };
      }),
    plan_warnings: [
      ...planWarnings(plan),
      ...completenessIssues.map((issue) => ({
        code: issue.code,
        reason: issue.message,
      })),
      ...schedulingPlanIssues.map((issue) => ({
        code: issue.code,
        reason: issue.message,
      })),
      ...schedulingTaskIssues.map((issue) => ({
        code: issue.code,
        reason: issue.message,
      })),
      ...runtimeProjection.summary.blockers.map((blocker) => ({
        code: blocker.code,
        reason: blocker.message,
      })),
    ],
    warnings: [
      ...profileMigrationWarnings(ledger),
      ...formalExecutionWarnings(ledger),
      ...ledger.operations
        .filter((item) => item.status === "unknown")
        .map((item) => ({
          operation_id: item.id,
          target_id: item.target_id,
          reason: "Operation result requires reconciliation",
        })),
    ],
  };
}
