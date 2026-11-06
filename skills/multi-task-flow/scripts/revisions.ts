import { canonicalJson } from "./revisions-json";
export { canonicalJson } from "./revisions-json";
import { z } from "zod";
import {
  changeReason,
  executionPhase,
  planChangeSet,
  planRevision,
  type ExecutionPhase,
  type Ledger,
  type Plan,
  type PlanRevision,
  type Task,
} from "./schema";

export const revisionInput = z
  .object({
    reason: changeReason.nullable().optional(),
  })
  .strict();
export type RevisionInput = z.infer<typeof revisionInput>;

type ChangeEntry = { path: string; old_value?: unknown; new_value?: unknown };
type ChangeSet = z.infer<typeof planChangeSet>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addModified(
  changes: ChangeSet,
  path: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  changes.modified.push({
    path,
    old_value: structuredClone(oldValue),
    new_value: structuredClone(newValue),
  });
}

function diffValue(
  changes: ChangeSet,
  path: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  if (canonicalJson(oldValue) === canonicalJson(newValue)) return;
  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue) &&
    oldValue.every(isRecord) &&
    newValue.every(isRecord) &&
    oldValue.every((item) => typeof item.id === "string") &&
    newValue.every((item) => typeof item.id === "string")
  ) {
    const oldById = new Map(oldValue.map((item) => [item.id as string, item]));
    const newById = new Map(newValue.map((item) => [item.id as string, item]));
    for (const [id, item] of newById) {
      if (!oldById.has(id))
        changes.added.push({
          path: `${path}[${id}]`,
          new_value: structuredClone(item),
        });
      else diffValue(changes, `${path}[${id}]`, oldById.get(id), item);
    }
    for (const [id, item] of oldById)
      if (!newById.has(id))
        changes.removed.push({
          path: `${path}[${id}]`,
          old_value: structuredClone(item),
        });
    return;
  }
  if (isRecord(oldValue) && isRecord(newValue)) {
    const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
    for (const key of [...keys].sort())
      diffValue(changes, `${path}.${key}`, oldValue[key], newValue[key]);
    return;
  }
  addModified(changes, path, oldValue, newValue);
}

function planContent(plan: Plan): Record<string, unknown> {
  return {
    start_at: plan.start_at,
    atoms: plan.atoms,
    group_atoms: plan.group_atoms,
    atomic_edges: plan.atomic_edges,
    nodes: plan.nodes,
    edges: plan.edges,
    cut_rules: plan.cut_rules,
    actions: plan.actions,
    plan_handoff: plan.plan_handoff ?? null,
  };
}

function taskContent(task: Task): Record<string, unknown> {
  return {
    title: task.title,
    kind: task.kind,
    group_id: task.group_id,
    thread_id: task.thread_id,
    state: task.state,
    disposition: task.disposition,
    superseded_by_task_id: task.superseded_by_task_id,
    atoms: task.atoms,
    owned_surfaces: task.owned_surfaces,
    base_sha: task.base_sha,
    pr: task.pr,
    requirements_path: task.requirements_path,
    execution_profile: task.execution_profile,
    started_at: task.started_at,
    finished_at: task.finished_at,
    blocker: task.blocker,
    assignment_history: task.assignment_history,
  };
}

function groupContent(
  group: Ledger["groups"][number],
): Record<string, unknown> {
  return {
    title: group.title,
    delivery_unit_kind: group.delivery_unit_kind,
    owner_kind: group.owner_kind,
    agent_thread_id: group.agent_thread_id,
    state: group.state,
    parent_branch: group.parent_branch,
    parent_pr: group.parent_pr,
    cut_sha: group.cut_sha,
    current_sha: group.current_sha,
    merge_sha: group.merge_sha,
    requirements_path: group.requirements_path,
    execution_profile: group.execution_profile,
  };
}

export function diffPlan(
  previous: Plan,
  proposed: Plan,
  previousTasks: Task[],
  proposedTasks: Task[],
  previousGroups: Ledger["groups"],
  proposedGroups: Ledger["groups"],
): ChangeSet {
  const changes: ChangeSet = { added: [], removed: [], modified: [] };
  diffValue(changes, "plan", planContent(previous), planContent(proposed));
  diffValue(
    changes,
    "tasks",
    previousTasks.map((item) => ({ id: item.id, ...taskContent(item) })),
    proposedTasks.map((item) => ({ id: item.id, ...taskContent(item) })),
  );
  diffValue(
    changes,
    "groups",
    previousGroups.map((item) => ({ id: item.id, ...groupContent(item) })),
    proposedGroups.map((item) => ({ id: item.id, ...groupContent(item) })),
  );
  for (const entries of [changes.added, changes.removed, changes.modified])
    entries.sort((left, right) => left.path.localeCompare(right.path));
  return planChangeSet.parse(changes);
}

export function deriveExecutionPhase(
  ledger: Pick<Ledger, "events">,
): ExecutionPhase {
  return ledger.events.some((event) => event.type === "task_started")
    ? "implementation"
    : "planning";
}

function taskIdsForNodeIds(plan: Plan, nodeIds: Iterable<string>): Set<string> {
  const ids = new Set(nodeIds);
  return new Set(
    plan.nodes
      .filter(
        (node) =>
          ids.has(node.id) && node.kind === "task" && node.ref_id !== null,
      )
      .map((node) => node.ref_id!),
  );
}

function changedTaskIds(
  changeSet: ChangeSet,
  previous: Plan,
  proposed: Plan,
): Set<string> {
  const taskIds = new Set<string>();
  const allNodes = [...previous.nodes, ...proposed.nodes];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  for (const entry of [
    ...changeSet.added,
    ...changeSet.removed,
    ...changeSet.modified,
  ]) {
    const taskMatch = entry.path.match(/^tasks\[([^\]]+)\]/);
    if (taskMatch) taskIds.add(taskMatch[1]!);
    const nodeMatch = entry.path.match(/^plan\.nodes\[([^\]]+)\]/);
    if (nodeMatch) {
      const node = nodeById.get(nodeMatch[1]!);
      if (node?.kind === "task" && node.ref_id) taskIds.add(node.ref_id);
    }
    const groupAtomMatch = entry.path.match(/^plan\.group_atoms\[([^\]]+)\]/);
    if (groupAtomMatch) {
      const atom = [...previous.group_atoms, ...proposed.group_atoms].find(
        (item) => item.id === groupAtomMatch[1],
      );
      if (atom)
        for (const node of allNodes)
          if (
            node.kind === "task" &&
            node.ref_id &&
            node.group_id === atom.group_id
          )
            taskIds.add(node.ref_id);
    }
    const atomMatch = entry.path.match(/^plan\.atoms\[([^\]]+)\]/);
    if (atomMatch) {
      const atom = [...previous.atoms, ...proposed.atoms].find(
        (item) => item.id === atomMatch[1],
      );
      if (atom) taskIds.add(atom.task_id);
    }
    const actionMatch = entry.path.match(/^plan\.actions\[([^\]]+)\]/);
    if (actionMatch) {
      const action = [...previous.actions, ...proposed.actions].find(
        (item) => item.id === actionMatch[1],
      );
      if (action?.task_id) taskIds.add(action.task_id);
    }
    const edgeMatch = entry.path.match(/^plan\.edges\[([^\]]+)\]/);
    if (edgeMatch) {
      const edge = [...previous.edges, ...proposed.edges].find(
        (item) => item.id === edgeMatch[1],
      );
      if (edge)
        taskIdsForNodeIds(proposed, [
          edge.from_node_id,
          edge.to_node_id,
        ]).forEach((id) => taskIds.add(id));
      if (edge)
        taskIdsForNodeIds(previous, [
          edge.from_node_id,
          edge.to_node_id,
        ]).forEach((id) => taskIds.add(id));
    }
  }
  return taskIds;
}

function downstreamTaskIds(plan: Plan, roots: Set<string>): Set<string> {
  const taskNodeIds = new Map(
    plan.nodes
      .filter((node) => node.kind === "task" && node.ref_id)
      .map((node) => [node.ref_id!, node.id]),
  );
  const queue = [...roots].flatMap((taskId) =>
    taskNodeIds.has(taskId) ? [taskNodeIds.get(taskId)!] : [],
  );
  const visited = new Set(queue);
  while (queue.length) {
    const source = queue.shift()!;
    for (const edge of plan.edges.filter(
      (item) => item.from_node_id === source,
    )) {
      if (visited.has(edge.to_node_id)) continue;
      visited.add(edge.to_node_id);
      queue.push(edge.to_node_id);
    }
  }
  for (const node of plan.nodes)
    if (node.kind === "task" && node.ref_id && visited.has(node.id))
      roots.add(node.ref_id);
  return roots;
}

function isLowImpact(changeSet: ChangeSet): boolean {
  const entries = [
    ...changeSet.added,
    ...changeSet.removed,
    ...changeSet.modified,
  ];
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        /^plan\.nodes\[[^\]]+\]\.(?:label|estimate_minutes|estimate_basis|estimate_confidence)$/.test(
          entry.path,
        ) ||
        /^tasks\[[^\]]+\]\.title$/.test(entry.path) ||
        /^groups\[[^\]]+\]\.title$/.test(entry.path),
    )
  );
}

export function buildPlanRevision(
  ledger: Ledger,
  previous: Plan,
  proposed: Plan,
  proposedTasks: Task[],
  proposedGroups: Ledger["groups"],
  input: RevisionInput = {},
): PlanRevision {
  const executionPhase = deriveExecutionPhase(ledger);
  const changeSet = diffPlan(
    previous,
    proposed,
    ledger.tasks,
    proposedTasks,
    ledger.groups,
    proposedGroups,
  );
  const changedTasks = changedTaskIds(changeSet, previous, proposed);
  const changeClass =
    executionPhase === "planning"
      ? "planning_revision"
      : isLowImpact(changeSet)
        ? "implementation_low_impact"
        : "implementation_high_impact";
  const pausedTaskIds =
    changeClass === "implementation_high_impact"
      ? [...downstreamTaskIds(proposed, changedTasks)]
          .filter((taskId) => {
            const task = proposedTasks.find((item) => item.id === taskId);
            return task
              ? !["integrated", "completed", "closed"].includes(task.state) &&
                  task.disposition === "active"
              : false;
          })
          .sort()
      : [];
  return planRevision.parse({
    execution_phase: executionPhase,
    change_class: changeClass,
    affected_task_ids: [...changedTasks].sort(),
    affected_node_ids: [
      ...new Set(
        [
          ...changeSet.added,
          ...changeSet.removed,
          ...changeSet.modified,
        ].flatMap((entry) => {
          const match = entry.path.match(/^plan\.nodes\[([^\]]+)\]/);
          return match ? [match[1]!] : [];
        }),
      ),
    ].sort(),
    affected_edge_ids: [
      ...new Set(
        [
          ...changeSet.added,
          ...changeSet.removed,
          ...changeSet.modified,
        ].flatMap((entry) => {
          const match = entry.path.match(/^plan\.edges\[([^\]]+)\]/);
          return match ? [match[1]!] : [];
        }),
      ),
    ].sort(),
    change_set: changeSet,
    reason: input.reason ?? null,
    approval_required: changeClass !== "implementation_low_impact",
    paused_task_ids: pausedTaskIds,
  });
}

export function reasonRequired(revision: PlanRevision): boolean {
  return revision.change_class !== "planning_revision";
}

export function evidenceRequired(revision: PlanRevision): boolean {
  return revision.change_class === "implementation_high_impact";
}

export function validateRevisionInput(revision: PlanRevision): void {
  const changeCount =
    revision.change_set.added.length +
    revision.change_set.removed.length +
    revision.change_set.modified.length;
  if (changeCount === 0)
    throw new Error("Plan revision requires a non-empty diff");
  if (reasonRequired(revision)) {
    if (!revision.reason) throw new Error("Plan revision requires a reason");
    if (
      evidenceRequired(revision) &&
      revision.reason.evidence_refs.length === 0
    )
      throw new Error("High-impact plan revision requires evidence");
  }
}
