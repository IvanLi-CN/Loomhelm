import { conversationArchiveEligibility } from "../lib/conversation-eligibility";
import { planWarnings } from "../lib/view-warnings";
import { runtimeTaskState } from "../web/task-state";

export { type PlanWarning, planWarnings } from "../lib/view-warnings";

import {
  type AtomicBoundaryNode,
  type AtomicEdge,
  type AtomicNode,
  canonicalizeContract3Plan,
  deriveBusinessStatus,
  evaluateMilestone,
  type MilestoneEvaluation,
} from "../lib/atomic-orchestration";
import { localSemanticProjection, SKILL_ID, SKILL_VERSION, VIEWER_CONTRACT } from "../lib/contract";
import { parentPrReady, ready } from "../lib/engine";
import { deliveryUnitPrMergedFromLedger } from "../lib/engine-support-gates";
import { ContractError, requireCondition } from "../lib/errors";
import { profileMigrationWarnings, profileProjection } from "../lib/execution-profile";
import { deriveExecutionPhase, evidenceRequired, reasonRequired } from "../lib/revisions";
import {
  isContributionKind,
  type Ledger,
  type Plan,
  parseLedger,
  planCompletenessIssues,
  taskExecutionPolicyIssues,
  theoreticalScheduleIssues,
  validateLedger,
} from "../lib/schema";
import { createAtomProjection } from "../lib/view-atoms";
import { type AgentOutput, initialOutput } from "../web/agent-output";

const RELATIVE_EPOCH = "2026-01-01T00:00:00.000Z";

export type PlannedInterval = {
  node_id: string;
  start: string | null;
  end: string | null;
  start_offset_minutes: number | null;
  end_offset_minutes: number | null;
};

export function compatibilityAtomicNodeState(node: AtomicNode, ledger: Ledger): AtomicNode {
  if (node.kind === "boundary") {
    const started =
      ledger.events.some((event) => event.type === "task_started") ||
      ledger.tasks.some((task) => task.started_at !== null);
    const finished = ledger.events.some((event) => event.type === "run_completed");
    return {
      ...node,
      state:
        node.boundary === "start"
          ? started
            ? "completed"
            : "planned"
          : finished
            ? "completed"
            : "planned",
    };
  }
  if (node.kind !== "work") return node;
  const scope = (node as any).scope as
    | { kind: "task" | "delivery_unit"; task_id?: string; delivery_unit_id: string }
    | undefined;
  const task =
    scope?.kind === "task" ? ledger.tasks.find((item) => item.id === scope.task_id) : undefined;
  const taskAtom = task?.atoms.find((atom) => atom.id === node.id);
  const groupAtom =
    scope?.kind === "delivery_unit"
      ? ledger.groups
          .find((item) => item.id === scope.delivery_unit_id)
          ?.atoms.find((atom) => atom.id === node.id)
      : undefined;
  const status = taskAtom?.status ?? groupAtom?.status ?? "planned";
  if (status === "planned") return { ...node, state: "planned", scope } as AtomicNode;
  const startedAt = task?.started_at ?? new Date(RELATIVE_EPOCH).toISOString();
  const updatedAt = task?.finished_at ?? startedAt;
  const runtime = { started_at: startedAt, updated_at: updatedAt, evidence_refs: [] };
  if (status === "running") return { ...node, state: "running", scope, runtime } as AtomicNode;
  if (status === "blocked")
    return {
      ...node,
      state: "blocked",
      scope,
      runtime,
      blocker: {
        code: "LEGACY_BLOCKED",
        message: task?.blocker ?? "Atomic work is blocked",
        evidence_refs: [],
      },
    } as AtomicNode;
  return {
    ...node,
    state: "completed",
    scope,
    runtime,
    result: {
      completed_at: task?.finished_at ?? updatedAt,
      evidence_refs: [`legacy:atomic:${node.id}`],
    },
  } as AtomicNode;
}

export function syntheticAtomicBoundaries(ledger: Ledger): AtomicBoundaryNode[] {
  const started =
    ledger.events.some((event) => event.type === "task_started") ||
    ledger.tasks.some((task) => task.started_at !== null);
  const finished = ledger.events.some((event) => event.type === "run_completed");
  return [
    {
      kind: "boundary",
      id: "atomic-start",
      title: "开始",
      boundary: "start",
      state: started ? "completed" : "planned",
    },
    {
      kind: "boundary",
      id: "atomic-end",
      title: "结束",
      boundary: "end",
      state: finished ? "completed" : "planned",
    },
  ];
}

export function appendAtomicBoundaryEdges(
  plan: Plan,
  nodes: readonly AtomicNode[],
  existing: readonly AtomicEdge[],
): AtomicEdge[] {
  const boundaryStart = nodes.find(
    (node): node is AtomicBoundaryNode => node.kind === "boundary" && node.boundary === "start",
  );
  const boundaryEnd = nodes.find(
    (node): node is AtomicBoundaryNode => node.kind === "boundary" && node.boundary === "end",
  );
  if (!boundaryStart || !boundaryEnd) return [...existing];
  const atomicIds = new Set(nodes.map((node) => node.id));
  const planToAtomic = new Map<string, string>();
  for (const node of plan.nodes) {
    if (node.kind === "main_start") planToAtomic.set(node.id, boundaryStart.id);
    else if (node.kind === "main_end") planToAtomic.set(node.id, boundaryEnd.id);
    else if (node.kind === "task" && node.ref_id) {
      const atomic = nodes.find(
        (candidate) =>
          candidate.kind === "work" &&
          candidate.scope?.kind === "task" &&
          candidate.scope.task_id === node.ref_id,
      );
      if (atomic) planToAtomic.set(node.id, atomic.id);
    } else if (node.kind === "milestone" && atomicIds.has(node.id))
      planToAtomic.set(node.id, node.id);
  }
  const outgoing = new Map<string, Plan["edges"]>();
  for (const edge of plan.edges)
    outgoing.set(edge.from_node_id, [...(outgoing.get(edge.from_node_id) ?? []), edge]);
  const hidden = new Set(
    plan.nodes
      .filter((node) => ["group_start", "group_end"].includes(node.kind))
      .map((node) => node.id),
  );
  const derived: AtomicEdge[] = [];
  const add = (id: string, from: string, to: string) => {
    if (from === to || !atomicIds.has(from) || !atomicIds.has(to)) return;
    derived.push({
      id,
      from_node_id: from,
      to_node_id: to,
      requires: { kind: "source_terminal_success" },
    });
  };
  const walk = (sourcePlanId: string, currentPlanId: string, visited: Set<string>) => {
    if (visited.has(currentPlanId)) return;
    const nextVisited = new Set(visited).add(currentPlanId);
    for (const edge of outgoing.get(currentPlanId) ?? []) {
      const target = planToAtomic.get(edge.to_node_id);
      const source = planToAtomic.get(sourcePlanId);
      if (source && target) add(`atomic-boundary-${edge.id}-${source}-${target}`, source, target);
      else if (hidden.has(edge.to_node_id)) walk(sourcePlanId, edge.to_node_id, nextVisited);
    }
  };
  for (const planNodeId of planToAtomic.keys()) walk(planNodeId, planNodeId, new Set());
  const merged = [...existing, ...derived];
  const seen = new Set<string>();
  const result = merged.filter((edge) => {
    const key = `${edge.from_node_id}->${edge.to_node_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const incoming = new Set(result.map((edge) => edge.to_node_id));
  const outgoingIds = new Set(result.map((edge) => edge.from_node_id));
  for (const node of nodes) {
    if (node.kind === "boundary") continue;
    if (!incoming.has(node.id))
      result.push({
        id: `atomic-boundary-start-${node.id}`,
        from_node_id: boundaryStart.id,
        to_node_id: node.id,
        requires: { kind: "source_terminal_success" },
      });
    if (!outgoingIds.has(node.id))
      result.push({
        id: `atomic-boundary-end-${node.id}`,
        from_node_id: node.id,
        to_node_id: boundaryEnd.id,
        requires: { kind: "source_terminal_success" },
      });
  }
  return result;
}

export function deliveryUnitPr(group: Ledger["groups"][number]) {
  if (group.pr && "state" in group.pr) return "pr" in group.pr ? group.pr.pr : null;
  return group.parent_pr;
}

export function latestParentPrFact(ledger: Ledger, groupId: string) {
  return ledger.facts
    .filter((fact) => fact.kind === "pr_published" && fact.subject_id === groupId)
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
    .at(-1);
}

export function parentPrDefinitivelyAbsent(
  ledger: Ledger,
  group: Ledger["groups"][number],
): boolean {
  const latest = latestParentPrFact(ledger, group.id);
  const publicationPending = ledger.operations.some(
    (operation) =>
      operation.kind === "publish_pr" &&
      operation.target_id === group.id &&
      ["claimed", "unknown"].includes(operation.status),
  );
  return Boolean(
    !publicationPending &&
      latest &&
      latest.status === "failed" &&
      latest.receipt?.resource_type === "pr" &&
      latest.receipt.state === "absent" &&
      !deliveryUnitPr(group),
  );
}

export function mergeCapabilityProjection(ledger: Ledger, group: Ledger["groups"][number]) {
  const latest = ledger.facts
    .filter((fact) => fact.kind === "pr_merged" && fact.subject_id === group.id)
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
    .at(-1);
  const satisfied = deliveryUnitPrMergedFromLedger(ledger, group);
  const closeoutUnknown = closeoutReconciliationProjection(ledger, group.id).status === "unknown";
  return {
    status: satisfied
      ? "satisfied"
      : closeoutUnknown || latest?.status === "unknown"
        ? "unknown"
        : "blocked",
    merge_sha: group.merge_sha,
    evidence_refs: latest?.evidence_ref ? [latest.evidence_ref] : [],
    reason: satisfied
      ? null
      : closeoutUnknown
        ? "closeout 对账结果未知，合并能力已冻结"
        : "有效 merge fact、SHA 和 provider PR receipt 尚未全部匹配",
  };
}

export function closeoutReconciliationProjection(ledger: Ledger, groupId: string) {
  const event = ledger.events
    .filter((item) => item.subject_id === groupId && item.data.operation === "closeout-reconcile")
    .at(-1);
  return {
    status: event?.data.outcome ?? "unreconciled",
    reconciliation_id: event?.data.reconciliation_id ?? null,
    reason: event?.data.reason ?? null,
    evidence_refs: Array.isArray(event?.data.evidence_refs) ? event.data.evidence_refs : [],
  };
}

export function allowsBootstrapMainOwnedStart(
  ledger: Ledger,
  group: Ledger["groups"][number],
  task?: Ledger["tasks"][number],
): boolean {
  const workspaceAtom = group.atoms.find((atom) => atom.lifecycle_stage === "workspace_ready");
  return Boolean(
    task &&
      group.state === "active" &&
      group.delivery_unit_kind === "bootstrap" &&
      group.owner_kind === "main" &&
      task.execution_owner === "main" &&
      task.conversation_policy === "main_owned" &&
      group.lifecycle.workspace_ready === "passed" &&
      workspaceAtom?.status === "completed" &&
      parentPrDefinitivelyAbsent(ledger, group),
  );
}

export function allowsBootstrapGroupStart(
  ledger: Ledger,
  group: Ledger["groups"][number],
): boolean {
  const workspaceAtom = group.atoms.find((atom) => atom.lifecycle_stage === "workspace_ready");
  return Boolean(
    group.state === "active" &&
      group.delivery_unit_kind === "bootstrap" &&
      group.owner_kind === "main" &&
      group.lifecycle.workspace_ready === "passed" &&
      workspaceAtom?.status === "completed" &&
      parentPrDefinitivelyAbsent(ledger, group),
  );
}

export function deliveryGateDiagnostics(
  ledger: Ledger,
  group: Ledger["groups"][number],
  task?: Ledger["tasks"][number],
): Record<string, string>[] {
  const workspaceAtom = group.atoms.find((atom) => atom.lifecycle_stage === "workspace_ready");
  const diagnostics: Record<string, string>[] = [];
  if (group.state !== "active")
    diagnostics.push({ code: "DELIVERY_UNIT_NOT_ACTIVE", message: "交付单元尚未进入 active 状态" });
  if (group.lifecycle.workspace_ready !== "passed" || workspaceAtom?.status !== "completed")
    diagnostics.push({
      code: "DELIVERY_WORKSPACE_GATE_PENDING",
      message: "交付单元尚未完成 workspace_ready 原子任务",
    });
  const bootstrapGroupException = !task && allowsBootstrapGroupStart(ledger, group);
  if (
    !allowsBootstrapMainOwnedStart(ledger, group, task) &&
    !bootstrapGroupException &&
    !parentPrReady(ledger, group)
  )
    diagnostics.push({
      code: "DELIVERY_PARENT_PR_GATE_PENDING",
      message: "父 PR 尚未创建、核验并完成交付原子任务",
    });
  return diagnostics;
}

export function taskPrProjection(
  task: Ledger["tasks"][number],
  owner: Ledger["groups"][number] | undefined,
): { url: string | null } | null {
  if (!task.pr || typeof task.pr !== "object" || !("state" in task.pr))
    return task.pr && "url" in task.pr ? { url: task.pr.url ?? null } : null;
  if (task.pr.state === "shared_delivery_unit") {
    const deliveryPr = owner?.pr;
    if (deliveryPr && typeof deliveryPr === "object" && "state" in deliveryPr && "pr" in deliveryPr)
      return { url: deliveryPr.pr.url ?? null };
    return owner?.parent_pr ? { url: owner.parent_pr.url ?? null } : null;
  }
  return "pr" in task.pr ? { url: task.pr.pr.url ?? null } : null;
}

export function formalExecutionWarnings(ledger: Ledger): Record<string, unknown>[] {
  return ledger.groups.flatMap((group) => {
    if (group.state !== "active" || group.coordination_execution.state !== "running") return [];
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
        operation.kind === "dispatch" && [group.id, ...taskIds].includes(operation.target_id),
    );
    if (hasDispatch || tasks.some((task) => task.thread_id)) return [];
    return [
      {
        code: "formal_execution_missing",
        group_id: group.id,
        task_ids: tasks.map((task) => task.id),
        reason: "交付单元正在运行，但没有正式 task dispatch 或任务对话记录。",
      },
    ];
  });
}

export type ReadinessBlocker = {
  code: string;
  group_id: string | null;
  message: string;
  resource: {
    kind: "conversation" | "worktree" | "branch" | "pr";
    status: "not_created" | "unknown";
    target_id: string | null;
  } | null;
};

export type RuntimeReadiness = {
  status: "ready" | "blocked" | "unknown";
  blockers: ReadinessBlocker[];
};

export function planGroupIds(ledger: Ledger, plan: Plan): Set<string> {
  const taskIds = new Set(
    plan.nodes.filter((node) => node.kind === "task" && node.ref_id).map((node) => node.ref_id),
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

export function requiresRuntimeEvidence(ledger: Ledger): boolean {
  return !(ledger.source_schema_version === 1 && ledger.contract_version !== 2);
}

export function planSchedulingIssues(ledger: Ledger, plan: Plan): PlanCompletenessIssue[] {
  if (ledger.source_schema_version === 1) return [];
  const contributionTasks = ledger.tasks.filter(
    (task) => task.disposition === "active" && isContributionKind(task.kind),
  );
  const groupIds = new Set(contributionTasks.map((task) => task.group_id));
  const missing: string[] = [];
  for (const groupId of groupIds) {
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      if (
        !plan.actions.some(
          (action) =>
            action.kind === kind && action.group_id === groupId && action.task_id === null,
        )
      )
        missing.push(`${kind}:group:${groupId}`);
    }
  }
  for (const task of contributionTasks) {
    if (!plan.actions.some((action) => action.task_id === task.id)) continue;
    for (const kind of ["publish_branch", "publish_pr"] as const) {
      if (
        !plan.actions.some(
          (action) =>
            action.kind === kind && action.task_id === task.id && action.group_id === null,
        )
      )
        missing.push(`${kind}:task:${task.id}`);
    }
  }
  return missing.length
    ? [
        {
          code: "PLAN_NOT_DISPATCHABLE",
          message: `贡献任务执行需要批准的发布动作：${missing.join(", ")}`,
        },
      ]
    : [];
}

export function taskSchedulingIssues(
  ledger: Ledger,
): Array<PlanCompletenessIssue & { group_id: string }> {
  if (ledger.source_schema_version === 1) return [];
  return ledger.tasks.flatMap((task) =>
    taskExecutionPolicyIssues(task).map((issue) => ({ ...issue, group_id: task.group_id })),
  );
}

export function activeGroupDispatch(
  ledger: Ledger,
  groupId: string,
): Ledger["operations"][number] | null {
  return (
    ledger.operations.find(
      (operation) =>
        operation.kind === "dispatch" &&
        operation.target_id === groupId &&
        operation.request.target_type === "group" &&
        ["claimed", "unknown", "succeeded"].includes(operation.status),
    ) ?? null
  );
}

export function coordinatorProjection(ledger: Ledger, group: Ledger["groups"][number]) {
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

export function blockerResource(
  ledger: Ledger,
  kind: "worktree" | "branch",
  targetId: string,
): ReadinessBlocker["resource"] {
  return {
    kind,
    status: ledger.resources.some(
      (resource) => resource.kind === kind && resource.target === targetId,
    )
      ? "unknown"
      : "not_created",
    target_id: targetId,
  };
}

export function groupWorkspaceBlockers(
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
      resource.kind === "worktree" && resource.target === group.id && resource.status === "active",
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
      .filter((fact) => fact.kind === "branch_published" && fact.subject_id === group.id)
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
      .at(-1);
    const branchPublished =
      publication?.status === "passed" &&
      publication.sha === group.current_sha &&
      publication.receipt?.resource_type === "branch" &&
      publication.receipt.branch === group.parent_branch;
    if (!branchPublished) {
      blockers.push({
        code:
          publication?.status === "unknown" ? "BRANCH_PUBLICATION_UNKNOWN" : "BRANCH_NOT_PUBLISHED",
        group_id: group.id,
        message:
          publication?.status === "unknown"
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

export function blockersReadiness(blockers: ReadinessBlocker[]): RuntimeReadiness {
  return {
    status: blockers.some((item) => item.code.endsWith("UNKNOWN"))
      ? blockers.some((item) => !item.code.endsWith("UNKNOWN"))
        ? "blocked"
        : "unknown"
      : "blocked",
    blockers,
  };
}

export function groupRuntimeReadiness(
  ledger: Ledger,
  group: Ledger["groups"][number],
  relevant: boolean,
): RuntimeReadiness {
  if (!relevant) return { status: "unknown", blockers: [] };
  if (group.state === "closed") {
    return {
      status: "blocked",
      blockers: [
        {
          code: "GROUP_CLOSED",
          group_id: group.id,
          message: `交付单元「${group.title}」已经收口，不能继续运行时派发。`,
          resource: null,
        },
      ],
    };
  }
  if (
    requiresRuntimeEvidence(ledger) &&
    (ledger.control.ownership !== "bound" || !ledger.control.owner_thread_id)
  ) {
    return {
      status: "unknown",
      blockers: [
        {
          code: "CONTROL_OWNERSHIP_UNKNOWN",
          group_id: group.id,
          message: "编排控制权尚未确认，运行时派发保持未知。",
          resource: null,
        },
      ],
    };
  }
  const coordinator = coordinatorProjection(ledger, group);
  if (coordinator.status === "not_created") {
    return {
      status: "blocked",
      blockers: [
        {
          code: "COORDINATOR_NOT_BOUND",
          group_id: group.id,
          message: `普通交付单元「${group.title}」尚未绑定交付协调者，运行时派发保持阻断。`,
          resource: { kind: "conversation", status: "not_created", target_id: group.id },
        },
      ],
    };
  }
  if (coordinator.status === "unknown") {
    return {
      status: "unknown",
      blockers: [
        {
          code: "COORDINATOR_UNKNOWN",
          group_id: group.id,
          message: `交付单元「${group.title}」的交付协调者绑定未知。`,
          resource: { kind: "conversation", status: "unknown", target_id: group.id },
        },
      ],
    };
  }
  if (group.state === "planned") {
    return {
      status: "blocked",
      blockers: [
        {
          code: "GROUP_NOT_ACTIVE",
          group_id: group.id,
          message: `交付单元「${group.title}」尚未激活，任务运行时派发保持阻断。`,
          resource: null,
        },
      ],
    };
  }
  if (group.state === "blocked") {
    return {
      status: "blocked",
      blockers: [
        {
          code: "GROUP_BLOCKED",
          group_id: group.id,
          message: `交付单元「${group.title}」当前处于阻塞状态。`,
          resource: null,
        },
      ],
    };
  }
  const workspaceBlockers = groupWorkspaceBlockers(ledger, group);
  return workspaceBlockers.length
    ? blockersReadiness(workspaceBlockers)
    : { status: "ready", blockers: [] };
}

export function runtimeReadinessProjection(
  ledger: Ledger,
  plan: Plan,
): {
  summary: RuntimeReadiness;
  byGroup: Map<string, RuntimeReadiness>;
} {
  const groupIds = planGroupIds(ledger, plan);
  const byGroup = new Map(
    ledger.groups.map((group) => [
      group.id,
      groupRuntimeReadiness(ledger, group, groupIds.has(group.id)),
    ]),
  );
  const summaries = [...byGroup.values()].filter((item) => item.blockers.length > 0);
  const blockers = summaries
    .filter((item) => {
      const group = ledger.groups.find((candidate) => candidate.id === item.blockers[0]?.group_id);
      if (!group) return true;
      if (
        group.state === "planned" &&
        item.blockers.every((blocker) => blocker.code === "COORDINATOR_NOT_BOUND")
      )
        return false;
      if (group.state === "closed" || group.state === "blocked") {
        return ledger.tasks.some(
          (task) =>
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
        ? blockers.some((item) => !item.code.endsWith("UNKNOWN"))
          ? "blocked"
          : "unknown"
        : blockers.length
          ? "blocked"
          : "ready",
      blockers,
    },
    byGroup,
  };
}
