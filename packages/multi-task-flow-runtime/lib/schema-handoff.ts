import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { z } from "zod";
import {
  atomicNode,
  validateAtomicBoundaries,
  validateAtomicGraph,
  validateDeliveryUnitLifecycleEdges,
  validateTaskLifecycleEdges,
} from "../lib/atomic-orchestration";
import { requireCondition } from "../lib/errors";
import { topologicalOrder, validateGrouping } from "../lib/graph";
import {
  type atomEdge,
  executionPhase,
  type group,
  type Ledger,
  type Plan,
  plan,
  planHandoffSource,
  type Task,
  type task,
} from "./schema-models";
import { type DevPlanHandoffSource, isContributionKind } from "./schema-policies";

const requirementsPath = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .refine(
    (value) => value === null || /^requirements\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.md$/.test(value),
    "requirements_path must reference a Markdown file under requirements/",
  );
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export type DevPlanHandoff = z.infer<typeof planHandoff>;
type DevPlanHandoffValidationOptions = {
  allowDynamicAssignments?: boolean;
  assignmentEvidence?: ReadonlyMap<string, ReadonlySet<string>>;
  dynamicGroupIds?: ReadonlySet<string>;
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function acceptanceScopeDigest(scopes: DevPlanHandoff["acceptance_scopes"]): string {
  const normalized = [...scopes].sort((left, right) =>
    left.acceptance_id < right.acceptance_id
      ? -1
      : left.acceptance_id > right.acceptance_id
        ? 1
        : 0,
  );
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function sameMembers(left: string[], right: string[]): boolean {
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

export function taskStateAtEvent(
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

export function sameTaskStructure(left: Task, right: Task): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.thread_id === right.thread_id &&
    left.requirements_path === right.requirements_path &&
    canonicalJson(left.owned_surfaces) === canonicalJson(right.owned_surfaces) &&
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
  const canonical = normalized === "/" ? normalized : normalized.replace(/\/+$/, "") || ".";
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
  if (normalized.some((surface): surface is undefined => surface === undefined)) return;
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
    new Set(handoff.acceptance_scopes.map((item) => item.acceptance_id)).size ===
      handoff.acceptance_scopes.length,
    "INVALID_PLAN_HANDOFF",
    "dev-plan handoff acceptance IDs must be unique",
  );
  requireCondition(
    handoff.acceptance_digest === acceptanceScopeDigest(handoff.acceptance_scopes),
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

export function attachDevPlanHandoff(candidate: Plan, source: DevPlanHandoffSource): Plan {
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
      options.assignmentEvidence?.get(runtimeTask.id)?.has(runtimeTask.group_id) === true &&
      runtimeTask.assignment_history.some((item) => item.group_id === runtimeTask.group_id);
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
    const handoffOwnedSurfaces = normalizedOwnedSurfaces(surfaces.get(runtimeTask.id) ?? []);
    const runtimeOwnedSurfaces = normalizedOwnedSurfaces(runtimeTask.owned_surfaces);
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
    for (const [rightTaskId, rightSurfaces] of runtimeSurfaceEntries.slice(index + 1)) {
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
      handoff.acceptance_scopes.some((item) => item.scope === `task:${runtimeTask.id}`),
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
      handoff.acceptance_scopes.some((item) => item.scope === `batch:${groupId}`),
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
  const bootstraps = groups.filter((candidate) => candidate.delivery_unit_kind === "bootstrap");
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
  for (const candidate of groups.filter((item) => item.delivery_unit_kind === "regular"))
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
    candidate.atomic_nodes,
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
  if (
    candidate.atomic_nodes.length ||
    candidate.atomic_edges.some((edge) => "from_node_id" in edge)
  ) {
    requireCondition(
      candidate.atomic_edges.every((edge) => "from_node_id" in edge && "to_node_id" in edge),
      "ATOMIC_CONTRACT_REQUIRED",
      "Contract-3 atomic plans must use node-based atomic edges",
    );
    validateAtomicGraph(candidate.atomic_nodes, candidate.atomic_edges as any);
    if (candidate.atomic_nodes.some((node) => node.kind === "boundary")) {
      try {
        validateAtomicBoundaries(candidate.atomic_nodes, candidate.atomic_edges as any);
      } catch (error) {
        requireCondition(
          false,
          "ATOMIC_GRAPH_INCOMPLETE",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const canonicalById = new Map(candidate.atomic_nodes.map((node) => [node.id, node]));
    for (const atom of candidate.atoms) {
      const node = canonicalById.get(atom.id);
      requireCondition(
        node?.kind === "work" && node.scope?.kind === "task" && node.scope.task_id === atom.task_id,
        "ATOMIC_GRAPH_INCOMPLETE",
        `Canonical graph must contain task atom ${atom.id} with matching scope`,
      );
    }
    for (const atom of candidate.group_atoms) {
      const node = canonicalById.get(atom.id);
      requireCondition(
        node?.kind === "work" &&
          node.scope?.kind === "delivery_unit" &&
          node.scope.delivery_unit_id === atom.group_id,
        "ATOMIC_GRAPH_INCOMPLETE",
        `Canonical graph must contain delivery-unit atom ${atom.id} with matching scope`,
      );
    }
    try {
      validateDeliveryUnitLifecycleEdges(candidate.group_atoms, candidate.atomic_edges);
    } catch (error) {
      requireCondition(
        false,
        "ATOMIC_GRAPH_INCOMPLETE",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      validateTaskLifecycleEdges(candidate.atoms, candidate.atomic_edges);
    } catch (error) {
      requireCondition(
        false,
        "ATOMIC_GRAPH_INCOMPLETE",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  for (const task of (candidate.tasks ?? []).filter((item) => isContributionKind(item.kind))) {
    requireCondition(
      candidate.atoms.some((atom) => atom.task_id === task.id),
      "MISSING_CONTRIBUTION_ATOM",
      `Contribution task ${task.id} must declare at least one atomic task`,
    );
  }
  const taskAtomIds = new Set(candidate.atoms.map((atom) => atom.id));
  const groupAtomIds = new Set(candidate.group_atoms.map((atom) => atom.id));
  const groupingEdges = candidate.atomic_edges.filter((edge): edge is z.infer<typeof atomEdge> => {
    if (!("from_atom_id" in edge)) return false;
    const taskEdge = taskAtomIds.has(edge.from_atom_id) && taskAtomIds.has(edge.to_atom_id);
    const groupEdge = groupAtomIds.has(edge.from_atom_id) && groupAtomIds.has(edge.to_atom_id);
    requireCondition(
      taskEdge || groupEdge,
      "UNKNOWN_NODE",
      "Atomic edge references an unknown atom",
    );
    return taskEdge;
  });
  validateGrouping(candidate.atoms, groupingEdges);
  topologicalOrder(
    candidate.nodes.map((item) => item.id),
    candidate.edges.map((item) => ({
      from: item.from_node_id,
      to: item.to_node_id,
    })),
  );
  const taskNodes = new Map(
    candidate.nodes.filter((item) => item.kind === "task").map((item) => [item.ref_id, item.id]),
  );
  requireCondition(
    !taskNodes.has(null) &&
      taskNodes.size === candidate.nodes.filter((item) => item.kind === "task").length,
    "DUPLICATE_TASK_NODE",
    "Each task needs exactly one identified plan node",
  );
  requireCondition(
    candidate.atoms.every((atom) => taskNodes.has(atom.task_id)),
    "MISSING_TASK_NODE",
    "Every atom must belong to a task node",
  );
  const groupNodes = new Set(
    candidate.nodes.map((item) => item.group_id).filter((item): item is string => item !== null),
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
  for (const action of candidate.actions) {
    if (action.target) {
      requireCondition(
        action.target.type === "task"
          ? action.task_id === action.target.id
          : action.group_id === action.target.id,
        "PLAN_TARGET_MISMATCH",
        "Planned action target must match its task/group owner",
      );
    } else {
      requireCondition(
        action.target_identity !== undefined,
        "MISSING_PLAN_TARGET",
        "Planned action must use a structured target",
      );
    }
  }
  requireCondition(
    candidate.actions.every(
      (action) =>
        action.kind === "publish_branch" || action.kind === "publish_pr" || action.task_id !== null,
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
    candidate.edges.map((item) => `${item.from_node_id}:${item.to_node_id}:${item.requires}`),
  );
  for (const atomDependency of candidate.atomic_edges.filter(
    (edge): edge is z.infer<typeof atomEdge> => "from_atom_id" in edge,
  )) {
    const from = atoms.get(atomDependency.from_atom_id)!;
    const to = atoms.get(atomDependency.to_atom_id)!;
    if (from.task_id !== to.task_id) {
      requireCondition(
        actualEdges.has(`${taskNodes.get(from.task_id)}:${taskNodes.get(to.task_id)}:integrated`),
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
      issues.push({
        code: "missing_estimate_basis",
        message: `任务 ${taskNode.label} 缺少估时依据。`,
      });
    if (!taskNode.estimate_confidence)
      issues.push({
        code: "missing_estimate_confidence",
        message: `任务 ${taskNode.label} 缺少估时置信度。`,
      });
  }
  return issues;
}

export function validateSchedulablePlan(candidate: Plan): void {
  const issue = planCompletenessIssues(candidate)[0];
  requireCondition(!issue, "PLAN_INCOMPLETE", issue?.message ?? "计划内容不完整。", 3);
}

export type TheoreticalScheduleIssue = { code: string; node_id: string | null; message: string };

export function theoreticalScheduleIssues(candidate: Plan): TheoreticalScheduleIssue[] {
  const issues: TheoreticalScheduleIssue[] = [];
  const nodes = new Map(candidate.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of candidate.edges) {
    if (!nodes.has(edge.from_node_id) || !nodes.has(edge.to_node_id)) {
      issues.push({
        code: "SCHEDULE_DANGLING_DEPENDENCY",
        node_id: edge.to_node_id,
        message: `依赖引用不存在：${edge.from_node_id} → ${edge.to_node_id}。`,
      });
      continue;
    }
    incoming.set(edge.to_node_id, [...(incoming.get(edge.to_node_id) ?? []), edge.from_node_id]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push({
        code: "SCHEDULE_CYCLE",
        node_id: id,
        message: `理论排期存在循环依赖：${id}。`,
      });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const predecessor of incoming.get(id) ?? []) visit(predecessor);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of candidate.nodes) visit(node.id);
  for (const node of candidate.nodes)
    if (node.kind === "task" && (node.estimate_minutes === null || node.estimate_minutes <= 0)) {
      issues.push({
        code:
          node.estimate_minutes === null
            ? "SCHEDULE_MISSING_DURATION"
            : "SCHEDULE_NONPOSITIVE_DURATION",
        node_id: node.id,
        message:
          node.estimate_minutes === null
            ? `任务 ${node.label} 缺少理论排期时长。`
            : `任务 ${node.label} 的理论排期时长必须大于 0。`,
      });
    }
  return issues;
}
