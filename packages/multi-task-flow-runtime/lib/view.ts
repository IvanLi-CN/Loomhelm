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
import { deliveryUnitPrMerged, parentPrReady, ready } from "../lib/engine";
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
import type { PlannedInterval, ReadinessBlocker } from "./view-readiness";
import * as viewHelpers from "./view-readiness";

export type { PlannedInterval } from "./view-readiness";

const RELATIVE_EPOCH = Date.parse("2000-01-01T00:00:00.000Z");
const {
  appendAtomicBoundaryEdges,
  closeoutReconciliationProjection,
  compatibilityAtomicNodeState,
  coordinatorProjection,
  deliveryGateDiagnostics,
  formalExecutionWarnings,
  mergeCapabilityProjection,
  planSchedulingIssues,
  runtimeReadinessProjection,
  syntheticAtomicBoundaries,
  taskPrProjection,
  taskSchedulingIssues,
} = viewHelpers;

export function plannedIntervals(plan: Plan, maxRunning: number): PlannedInterval[] {
  const start = 0;
  const order = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const remaining = new Set(plan.nodes.map((node) => node.id));
  const results = new Map<string, { start: number | null; end: number | null }>();
  const lanes = Array.from({ length: maxRunning }, () => start);
  const instant = new Set(["main_start", "main_end", "group_start", "group_end"]);
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
        const predecessorEnd = predecessors.some((time) => time === null)
          ? null
          : Math.max(start, ...(predecessors as number[]));
        const lane = node.kind === "task" ? lanes.indexOf(Math.min(...lanes)) : -1;
        const laneStart = lane >= 0 ? lanes[lane] : undefined;
        const available =
          lane < 0
            ? predecessorEnd
            : predecessorEnd === null || laneStart === undefined
              ? null
              : Math.max(predecessorEnd, laneStart);
        const priority = plan.edges.filter((edge) => edge.from_node_id === node.id).length;
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
    requireCondition(chosen !== undefined, "CYCLE", "Cannot choose a plan node");
    const duration = instant.has(chosen.node.kind) ? 0 : chosen.node.estimate_minutes;
    const end =
      chosen.available === null || duration === null ? null : chosen.available + duration * 60_000;
    if (chosen.lane >= 0) lanes[chosen.lane] = end ?? Infinity;
    results.set(chosen.node.id, { start: chosen.available, end });
    remaining.delete(chosen.node.id);
  }
  return plan.nodes.map((node) => {
    const interval = results.get(node.id)!;
    return {
      node_id: node.id,
      start:
        interval.start === null ? null : new Date(RELATIVE_EPOCH + interval.start).toISOString(),
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
      typeof cuts[0]?.data.old_group_id === "string" ? cuts[0].data.old_group_id : task.group_id;
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
                (event.type === "merge_resolved" && event.data.outcome === "succeeded")))),
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
      if (typeof event.data.group_id === "string") groupId = event.data.group_id;
      if (
        event.type === "task_runtime_observed" &&
        ["running", "agent_idle"].includes(String(event.data.state))
      )
        current = {
          task_id: task.id,
          group_id: groupId,
          state: String(event.data.state),
          start: time,
          end: null,
        };
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
  options: { readOnly?: boolean } = {},
): Record<string, unknown> {
  const ledger = options.readOnly ? parseLedger(input) : validateLedger(input);
  const plan = ledger.plans.find((item) => item.id === (planId ?? ledger.active_plan_id));
  if (!plan) throw new ContractError("PLAN_NOT_FOUND", "Plan not found", 2);
  const atomProjection = createAtomProjection(ledger, plan);
  const { atomTime } = atomProjection;
  const phase = deriveExecutionPhase(ledger);
  const activePlan = ledger.plans.find((item) => item.id === ledger.active_plan_id)!;
  const executionPlan = ledger.plans.find((item) => item.id === ledger.execution_plan_id)!;
  const completenessIssues = planCompletenessIssues(plan);
  const schedulingPlanIssues = planSchedulingIssues(ledger, plan);
  const theoreticalIssues = theoreticalScheduleIssues(plan);
  const schedulingTaskIssues = taskSchedulingIssues(ledger);
  const isApprovedExecution =
    activePlan.id === executionPlan.id && activePlan.lifecycle === "approved";
  const runtimeProjection = runtimeReadinessProjection(ledger, plan);
  const approvalPending = activePlan.id !== executionPlan.id || activePlan.lifecycle !== "approved";
  const schedulingBlockers: ReadinessBlocker[] = [
    ...(approvalPending
      ? [
          {
            code: "OWNER_APPROVAL_PENDING",
            group_id: null,
            message: "Owner approval 尚未完成，运行时派发保持阻断。",
            resource: null,
          },
        ]
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
    ...theoreticalIssues.map((issue) => ({
      code: issue.code,
      group_id: null,
      message: issue.message,
      resource: issue.node_id,
    })),
    ...schedulingTaskIssues.map((issue) => ({
      code: issue.code,
      group_id: issue.group_id,
      message: issue.message,
      resource: null,
    })),
    ...runtimeProjection.summary.blockers,
  ];
  const schedulingStatus =
    approvalPending ||
    completenessIssues.length ||
    schedulingPlanIssues.length ||
    schedulingTaskIssues.length ||
    theoreticalIssues.length
      ? "blocked"
      : runtimeProjection.summary.status === "ready"
        ? "eligible"
        : runtimeProjection.summary.status;
  const hasLegacyAtomicProjection =
    !plan.atomic_nodes.length && (plan.atoms.length > 0 || plan.group_atoms.length > 0);
  const compatibilityPlan = hasLegacyAtomicProjection
    ? canonicalizeContract3Plan(plan, ledger.tasks)
    : null;
  const canonicalAtomicNodes: AtomicNode[] = (
    plan.atomic_nodes.length
      ? plan.atomic_nodes.map((node) => compatibilityAtomicNodeState(node, ledger))
      : hasLegacyAtomicProjection
        ? (compatibilityPlan.atomic_nodes as AtomicNode[]).map((node) =>
            compatibilityAtomicNodeState(node, ledger),
          )
        : plan.nodes
            .filter((node) => node.kind === "task" || node.kind === "milestone")
            .map((node) => {
              const task =
                node.kind === "task" && node.ref_id
                  ? ledger.tasks.find((item) => item.id === node.ref_id)
                  : undefined;
              if (node.kind === "milestone") {
                return {
                  kind: "milestone" as const,
                  id: node.id,
                  title: node.label,
                  state: "planned" as const,
                  scope: {
                    kind: "delivery_unit" as const,
                    delivery_unit_id: node.group_id ?? "unassigned",
                  },
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
                activity_type: (task?.kind === "verification" ||
                task?.kind === "release" ||
                task?.kind === "deployment"
                  ? task.kind
                  : "contribution") as "contribution" | "verification" | "release" | "deployment",
                state:
                  task?.state === "starting"
                    ? "starting"
                    : task?.state === "running"
                      ? "running"
                      : task?.state === "blocked"
                        ? "blocked"
                        : ["integrated", "completed", "closed"].includes(task?.state ?? "")
                          ? "completed"
                          : "planned",
                scope: {
                  kind: "task" as const,
                  task_id: node.ref_id ?? node.id,
                  delivery_unit_id: task?.group_id ?? node.group_id ?? "unassigned",
                },
              };
            })
  ) as AtomicNode[];
  const nodeData = plan.nodes.map((node) => ({
    ...node,
    planned_group_id: node.group_id,
    group_id:
      node.kind === "task"
        ? (ledger.tasks.find((task) => task.id === node.ref_id)?.group_id ?? null)
        : node.group_id,
  }));
  const existingAtomicNodeIds = new Set(canonicalAtomicNodes.map((node) => node.id));
  for (const node of plan.nodes.filter(
    (item) => item.kind === "milestone" && !existingAtomicNodeIds.has(item.id),
  )) {
    canonicalAtomicNodes.push({
      kind: "milestone",
      id: node.id,
      title: node.label,
      state: "planned",
      scope: { kind: "delivery_unit", delivery_unit_id: node.group_id ?? "unassigned" },
      acceptance: [],
    });
  }
  for (const boundary of syntheticAtomicBoundaries(ledger)) {
    if (!canonicalAtomicNodes.some((node) => node.id === boundary.id))
      canonicalAtomicNodes.push(boundary);
  }
  const canonicalAtomicNodeIds = new Set(canonicalAtomicNodes.map((node) => node.id));
  const sourceAtomicEdges: Plan["atomic_edges"] =
    compatibilityPlan?.atomic_edges ?? plan.atomic_edges;
  const declaredAtomicEdges: AtomicEdge[] = sourceAtomicEdges.map((edge) =>
    "from_node_id" in edge
      ? edge
      : {
          id: edge.id,
          from_node_id: edge.from_atom_id,
          to_node_id: edge.to_atom_id,
          requires: { kind: "source_terminal_success" as const },
        },
  );
  const legacyAtomicEdges: AtomicEdge[] = plan.edges
    .filter(
      (edge) =>
        canonicalAtomicNodeIds.has(edge.from_node_id) &&
        canonicalAtomicNodeIds.has(edge.to_node_id),
    )
    .map((edge) => ({
      id: edge.id,
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      requires: { kind: edge.requires as "source_terminal_success" },
    }));
  const seenAtomicEdges = new Set(
    declaredAtomicEdges.map((edge) => `${edge.from_node_id}->${edge.to_node_id}`),
  );
  const baseAtomicEdges: AtomicEdge[] = [
    ...declaredAtomicEdges,
    ...legacyAtomicEdges.filter((edge) => {
      const key = `${edge.from_node_id}->${edge.to_node_id}`;
      if (seenAtomicEdges.has(key)) return false;
      seenAtomicEdges.add(key);
      return true;
    }),
  ];
  const canonicalAtomicEdges = appendAtomicBoundaryEdges(
    plan,
    canonicalAtomicNodes,
    baseAtomicEdges,
  );
  const atomicNodeById = new Map(canonicalAtomicNodes.map((node) => [node.id, node]));
  const milestoneEvaluations = new Map<string, MilestoneEvaluation>();
  for (const milestone of canonicalAtomicNodes.filter(
    (node): node is Extract<AtomicNode, { kind: "milestone" }> => node.kind === "milestone",
  )) {
    const incoming = canonicalAtomicEdges
      .filter((edge) => edge.to_node_id === milestone.id)
      .map((edge) => {
        const source = atomicNodeById.get(edge.from_node_id);
        const satisfied = source?.kind === "work" ? source.state === "completed" : false;
        return {
          satisfied,
          blocked: source?.kind === "work" && source.state === "blocked",
          evidence_refs:
            source?.kind === "work"
              ? (source.result?.evidence_refs ?? source.runtime?.evidence_refs ?? [])
              : [],
        };
      });
    const acceptance = milestone.acceptance.map(() => ({
      satisfied: false,
      evidence_refs: [] as string[],
    }));
    try {
      milestoneEvaluations.set(milestone.id, evaluateMilestone(milestone, incoming, acceptance));
    } catch {
      /* invalid legacy milestones remain pending in the compatibility view */
    }
  }
  // Keep the aggregate graph at the plan level. Atomic nodes are rendered only
  // in the atomic graph tab; projecting them here duplicates each task card.
  const canonicalDisplayNodes = nodeData;
  const canonicalDisplayEdges = plan.edges;
  const selectedTaskIds = new Set(
    plan.nodes.filter((node) => node.kind === "task").map((node) => node.ref_id),
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
            (owner.delivery_unit_kind === "bootstrap" || !!owner.agent_thread_id) &&
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
      const plannedAtoms = plan.atoms.filter((atom) => atom.task_id === task.id);
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
      const derivedStatus = deriveBusinessStatus(
        canonicalAtomicNodes,
        { kind: "task", task_id: task.id },
        milestoneEvaluations,
      );
      return {
        ...task,
        pr: taskPrProjection(task, owner),
        ...(() => {
          const gateDiagnostics =
            owner && isContributionKind(task.kind)
              ? deliveryGateDiagnostics(ledger, owner, task)
              : [];
          return { gateDiagnostics };
        })(),
        dispatch_diagnostics: [
          ...taskExecutionPolicyIssues(task),
          ...(owner && owner.delivery_unit_kind === "regular" && !owner.agent_thread_id
            ? [
                {
                  code: "DELIVERY_AGENT_NOT_BOUND",
                  message: "regular delivery unit 未绑定交付 Agent",
                },
              ]
            : []),
          ...(owner && isContributionKind(task.kind)
            ? deliveryGateDiagnostics(ledger, owner, task)
            : []),
        ],
        dispatch_readiness:
          task.execution_owner === null &&
          task.conversation_policy === null &&
          task.delivery_policy === null
            ? "unknown"
            : taskExecutionPolicyIssues(task).length > 0
              ? "blocked"
              : owner &&
                  isContributionKind(task.kind) &&
                  deliveryGateDiagnostics(ledger, owner, task).length > 0
                ? "blocked"
                : owner && (owner.delivery_unit_kind === "bootstrap" || !!owner.agent_thread_id)
                  ? "ready"
                  : "blocked",
        state: runtimeTaskState(task, outputs[task.id]),
        derived_status: derivedStatus,
        ...(runtimeTaskState(task, outputs[task.id]) === "agent_idle" && task.state !== "agent_idle"
          ? { agent_resume_state: task.state }
          : {}),
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
          ? (ledger.resources.find(
              (resource) => resource.kind === "conversation" && resource.target === task.thread_id,
            ) ?? null)
          : null,
      };
    });
  const allTasksDispatchReady = tasks.every((task) => task.dispatch_readiness === "ready");
  const allDeliveryUnitsDispatchReady = ledger.groups.every(
    (item) =>
      deliveryGateDiagnostics(ledger, item).length === 0 &&
      (item.delivery_unit_kind === "bootstrap" || !!item.agent_thread_id),
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
      version_status:
        ledger.version === null
          ? { state: "historical_read_only", reason: "账本未声明 Skill 版本身份" }
          : ledger.version.skill_id !== SKILL_ID ||
              ledger.version.skill_version !== SKILL_VERSION ||
              ledger.version.viewer_contract !== VIEWER_CONTRACT
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
      approval_pending: activePlan.id !== executionPlan.id || activePlan.lifecycle !== "approved",
      scheduling_eligible: schedulingStatus === "eligible",
      dispatch_readiness:
        allDeliveryUnitsDispatchReady && allTasksDispatchReady ? "ready" : "blocked",
      delivery_agent_readiness: ledger.groups.some(
        (item) => item.delivery_unit_kind === "regular" && !item.agent_thread_id,
      )
        ? "unbound"
        : "bound",
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
      pr_merged_availability: deliveryUnitPrMerged(item) ? "available" : "unavailable",
      derived_status: deriveBusinessStatus(
        canonicalAtomicNodes,
        { kind: "delivery_unit", delivery_unit_id: item.id },
        milestoneEvaluations,
      ),
      ...(() => {
        const gateDiagnostics = deliveryGateDiagnostics(ledger, item);
        return { gateDiagnostics };
      })(),
      delivery_agent_readiness:
        item.delivery_unit_kind === "bootstrap"
          ? "not_applicable"
          : item.agent_thread_id
            ? "bound"
            : "unbound",
      dispatch_readiness:
        item.delivery_unit_kind === "bootstrap"
          ? deliveryGateDiagnostics(ledger, item).length === 0
            ? "ready"
            : "blocked"
          : item.agent_thread_id && deliveryGateDiagnostics(ledger, item).length === 0
            ? "ready"
            : "blocked",
      dispatch_diagnostics: [
        ...(item.delivery_unit_kind === "regular" && !item.agent_thread_id
          ? [
              {
                code: "DELIVERY_AGENT_NOT_BOUND",
                message: "regular delivery unit 未绑定交付 Agent",
              },
            ]
          : []),
        ...deliveryGateDiagnostics(ledger, item),
      ],
      merge_capability: mergeCapabilityProjection(ledger, item),
      closeout_reconciliation: closeoutReconciliationProjection(ledger, item.id),
      recovery: {
        eligible:
          item.state === "blocked" &&
          closeoutReconciliationProjection(ledger, item.id).status !== "unknown",
        blockers: item.state !== "blocked" ? ["DeliveryUnit 当前不是 blocked"] : [],
      },
      ...profileProjection(ledger, "group", item),
      coordinator: coordinatorProjection(ledger, item),
      runtime_readiness: runtimeProjection.byGroup.get(item.id) ?? {
        status: "unknown",
        blockers: [],
      },
      latest_agent_output:
        outputs[`group:${item.id}`] ??
        initialOutput(
          item.delivery_unit_kind === "bootstrap"
            ? ledger.control.owner_thread_id
            : item.agent_thread_id,
        ),
      started_at:
        ledger.events.find(
          (e) =>
            e.type === "group_execution_updated" &&
            e.data.group_id === item.id &&
            e.data.state === "running",
        )?.occurred_at ?? null,
      finished_at:
        ledger.events.find(
          (e) =>
            e.type === "group_updated" && e.subject_id === item.id && e.data.state === "closed",
        )?.occurred_at ?? null,
    })),
    tasks: tasks.map((item) => ({
      ...item,
      ...profileProjection(ledger, "task", item),
    })),
    profile_read_only: !ledger.config.execution_profile,
    follow_prs: ledger.follow_prs,
    plans: planSummary,
    selected_plan_id: plan.id,
    nodes: canonicalDisplayNodes,
    edges: canonicalDisplayEdges,
    atomic_edges: canonicalAtomicEdges,
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
