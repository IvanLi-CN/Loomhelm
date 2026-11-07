import { runtimeTaskState } from "../web/task-state";
import { planWarnings } from "./view-warnings";
export { planWarnings, type PlanWarning } from "./view-warnings";
import { createAtomProjection } from "./view-atoms";
import {
  profileProjection,
  profileMigrationWarnings,
} from "./execution-profile";
import { ContractError, requireCondition } from "./errors";
import {
  isContributionKind,
  validateLedger,
  type Ledger,
  type Plan,
} from "./schema";
import { ready } from "./engine";
import {
  deriveExecutionPhase,
  reasonRequired,
  evidenceRequired,
} from "./revisions";
import { initialOutput, type AgentOutput } from "../web/agent-output";
import { localSemanticProjection } from "./contract";

type Interval = { node_id: string; start: string | null; end: string | null };

export function plannedIntervals(plan: Plan, maxRunning: number): Interval[] {
  const start = plan.start_at ? Date.parse(plan.start_at) : null;
  const order = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const remaining = new Set(plan.nodes.map((node) => node.id));
  const results = new Map<
    string,
    { start: number | null; end: number | null }
  >();
  const lanes = Array.from({ length: maxRunning }, () => start ?? Infinity);
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
          start === null || predecessors.some((time) => time === null)
            ? null
            : Math.max(start, ...(predecessors as number[]));
        const lane =
          node.kind === "task" ? lanes.indexOf(Math.min(...lanes)) : -1;
        const laneStart = lane >= 0 ? lanes[lane] : undefined;
        const available =
          lane < 0
            ? predecessorEnd
            : predecessorEnd === null ||
                laneStart === undefined ||
                !Number.isFinite(laneStart)
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
      start:
        interval.start === null ? null : new Date(interval.start).toISOString(),
      end: interval.end === null ? null : new Date(interval.end).toISOString(),
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
  const nodeData = plan.nodes.map((node) => ({
    ...node,
    planned_group_id: node.group_id,
    group_id:
      node.kind === "task"
        ? (ledger.tasks.find((task) => task.id === node.ref_id)?.group_id ??
          null)
        : node.group_id,
  }));
  const selectedTaskIds = new Set(
    plan.nodes
      .filter((node) => node.kind === "task")
      .map((node) => node.ref_id),
  );
  const tasks = ledger.tasks
    .filter((task) => selectedTaskIds.has(task.id))
    .map((task) => {
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
        conversation_resource: task.thread_id
          ? ledger.resources.find(
              (resource) =>
                resource.kind === "conversation" && resource.target === task.thread_id,
            ) ?? null
          : null,
      };
    });
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
      execution_profile: ledger.config.execution_profile,
    },
    execution_phase: phase,
    active_plan_id: ledger.active_plan_id,
    execution_plan_id: ledger.execution_plan_id,
    plan_state: {
      active_plan_id: ledger.active_plan_id,
      execution_plan_id: ledger.execution_plan_id,
      lifecycle: activePlan.lifecycle,
      approval_pending:
        activePlan.id !== executionPlan.id ||
        activePlan.lifecycle !== "approved",
      revision: activePlan.revision,
    },
    semantic_context: localSemanticProjection(ledger, "dashboard_view"),
    groups: atomProjection.groups.map((item) => ({
      ...item,
      ...profileProjection(ledger, "group", item),
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
    plan_warnings: planWarnings(plan),
    warnings: [
      ...profileMigrationWarnings(ledger),
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
