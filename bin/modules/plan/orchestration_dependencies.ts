import {
  BATCH_DEPENDENCY_MILESTONES,
  TASK_DEPENDENCY_MILESTONES,
  BatchMap,
  TaskRecord,
  TaskMap,
  field,
  hasKey,
  normalized,
  pythonStrip,
} from "./orchestration_base";

export interface DependencyValidationOptions {
  requireEarlierWave?: boolean;
}

function dependencyTokens(value: string, label: string): string[] {
  const tokens = value.split(",").map(pythonStrip);
  if (tokens.some((token) => !token))
    throw new Error(`${label} dependency must not contain empty items`);
  if (tokens.some((token) => normalized(token) === "none")) {
    if (tokens.length !== 1)
      throw new Error(`${label} dependency must use none alone`);
    return [];
  }
  return tokens;
}

export function hasExplicitDependency(
  batches: BatchMap,
  tasks: TaskMap,
): boolean {
  return [...Object.values(batches), ...Object.values(tasks)].some((item) =>
    field(item.fields, "depends_on")
      .split(",")
      .map(pythonStrip)
      .some((dependency) => dependency && normalized(dependency) !== "none"),
  );
}

export function validateDependencies(
  batches: BatchMap,
  tasks: TaskMap,
  options: DependencyValidationOptions = {},
): void {
  const batchGraph = new Map(
    Object.keys(batches).map((id) => [id, new Set<string>()]),
  );
  for (const batch of Object.values(batches)) {
    for (const dependency of dependencyTokens(
      field(batch.fields, "depends_on"),
      `batch:${batch.id}`,
    )) {
      if (!dependency.startsWith("batch:"))
        throw new Error(
          `batch:${batch.id} dependency must reference a batch: ${dependency}`,
        );
      const separator = dependency.indexOf("/", 7);
      const identity = dependency.slice(
        6,
        separator < 0 ? undefined : separator,
      );
      const milestone = separator < 0 ? "" : dependency.slice(separator + 1);
      if (!hasKey(batches, identity))
        throw new Error(
          `batch:${batch.id} references unknown batch dependency ${dependency}`,
        );
      if (identity === batch.id)
        throw new Error(`batch:${batch.id} cannot depend on itself`);
      if (!milestone)
        throw new Error(
          `batch:${batch.id} dependency must name an explicit milestone: ${dependency}`,
        );
      if (!BATCH_DEPENDENCY_MILESTONES.has(milestone))
        throw new Error(
          `batch:${batch.id} references unknown batch milestone ${milestone}`,
        );
      batchGraph.get(batch.id)?.add(identity);
    }
  }
  assertAcyclic(batchGraph, "batch dependency cycle detected");
  const taskGraph = new Map(
    Object.keys(tasks).map((id) => [id, new Set<string>()]),
  );
  for (const task of Object.values(tasks))
    for (const dependency of dependencyTokens(
      field(task.fields, "depends_on"),
      `task:${task.id}`,
    )) {
      if (dependency.startsWith("batch:")) continue;
      const id = dependency.replace(/^task:/, "").split("/", 1)[0]!;
      if (hasKey(tasks, id)) taskGraph.get(task.id)?.add(id);
    }
  assertAcyclic(taskGraph, "task dependency cycle detected");
  const combined = new Map<string, Set<string>>();
  for (const batch of Object.values(batches))
    combined.set(
      `batch:${batch.id}`,
      new Set(
        Object.values(tasks)
          .filter((task) => task.batch_id === batch.id)
          .map((task) => `task:${batch.id}:${task.id}`),
      ),
    );
  for (const batch of Object.values(batches))
    for (const dependency of dependencyTokens(
      field(batch.fields, "depends_on"),
      `batch:${batch.id}`,
    ))
      combined
        .get(`batch:${batch.id}`)
        ?.add(`batch:${dependency.slice(6).split("/", 1)[0]!}`);
  for (const task of Object.values(tasks)) {
    const node = `task:${task.batch_id}:${task.id}`;
    const edges = combined.get(node) ?? new Set<string>();
    combined.set(node, edges);
    for (const dependency of dependencyTokens(
      field(task.fields, "depends_on"),
      `task:${task.id}`,
    )) {
      if (dependency.startsWith("batch:"))
        edges.add(`batch:${dependency.slice(6).split("/", 1)[0]}`);
      else {
        const id = dependency.replace(/^task:/, "").split("/", 1)[0]!;
        if (!hasKey(tasks, id))
          throw new Error(
            `task:${task.id} references unknown task dependency ${dependency}`,
          );
        edges.add(`task:${tasks[id]!.batch_id}:${id}`);
      }
    }
  }
  assertAcyclic(combined, "dependency cycle detected across batch/task layers");
  for (const task of Object.values(tasks))
    for (const raw of field(task.fields, "depends_on").split(",")) {
      const dependency = pythonStrip(raw);
      if (!dependency || normalized(dependency) === "none") continue;
      if (dependency.startsWith("batch:")) {
        const separator = dependency.indexOf("/");
        const id = dependency.slice(6, separator < 0 ? undefined : separator);
        const milestone = separator < 0 ? "" : dependency.slice(separator + 1);
        if (!hasKey(batches, id))
          throw new Error(
            `task:${task.id} references unknown batch dependency ${dependency}`,
          );
        if (id === task.batch_id)
          throw new Error(`task:${task.id} cannot depend on its own batch`);
        if (!milestone)
          throw new Error(
            `task:${task.id} batch dependency must name an explicit milestone: ${dependency}`,
          );
        if (!BATCH_DEPENDENCY_MILESTONES.has(milestone))
          throw new Error(
            `task:${task.id} references unknown batch milestone ${milestone}`,
          );
        continue;
      }
      const unprefixed = dependency.replace(/^task:/, "");
      const separator = unprefixed.indexOf("/");
      const id = unprefixed.slice(0, separator < 0 ? undefined : separator);
      const milestone = separator < 0 ? "" : unprefixed.slice(separator + 1);
      if (!hasKey(tasks, id))
        throw new Error(
          `task:${task.id} references unknown task dependency ${dependency}`,
        );
      if (separator < 0 || !milestone)
        throw new Error(
          `task:${task.id} task dependency must name an explicit milestone: ${dependency}`,
        );
      if (!TASK_DEPENDENCY_MILESTONES.has(milestone))
        throw new Error(
          `task:${task.id} references unknown task milestone ${milestone}`,
        );
      if (tasks[id]!.batch_id !== task.batch_id)
        throw new Error(
          `task:${task.id} cross-batch task dependency must use an explicit batch milestone: ${id}`,
        );
      if (options.requireEarlierWave !== false && tasks[id]!.wave >= task.wave)
        throw new Error(
          `task:${task.id} dependency must be in an earlier wave: ${id}`,
        );
    }
}

function assertAcyclic(graph: Map<string, Set<string>>, message: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new Error(message);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
}

export function itemsAreSerialized(
  left: TaskRecord,
  right: TaskRecord,
  batches: BatchMap,
  tasks: TaskMap,
): boolean {
  if (left.batch_id === right.batch_id) return false;
  for (const [item, other] of [
    [left, right],
    [right, left],
  ] as const)
    for (const raw of field(item.fields, "depends_on").split(",")) {
      const dependency = pythonStrip(raw);
      if (
        dependency.startsWith("batch:") &&
        dependency.slice(6).split("/", 1)[0] === other.batch_id
      )
        return true;
      const id = dependency.replace(/^task:/, "").split("/", 1)[0];
      if (id === other.id && hasKey(tasks, id)) return true;
    }
  for (const [batchId, otherId] of [
    [left.batch_id, right.batch_id],
    [right.batch_id, left.batch_id],
  ] as const)
    for (const raw of field(batches[batchId]!.fields, "depends_on").split(","))
      if (
        pythonStrip(raw).startsWith("batch:") &&
        pythonStrip(raw).slice(6).split("/", 1)[0] === otherId
      )
        return true;
  return false;
}
