import {
  sectionHeadingCount,
  unfencedMarkerLines,
  validateFencedBlocks,
} from "./markdown";
import { parseAcceptance } from "./acceptance";
import {
  BatchMap,
  TaskRecord,
  TaskMap,
  field,
  hasKey,
  ownedSurfacesOverlap,
  type ParseOrchestrationOptions,
} from "./orchestration_base";
import { parseOrchestration } from "./orchestration_parser";
import {
  validateAcceptanceScopes,
  validateBatchMetadata,
} from "./orchestration_metadata";
import {
  hasExplicitDependency,
  itemsAreSerialized,
  validateDependencies,
} from "./orchestration_dependencies";

export function validate(
  text: string,
  options: ParseOrchestrationOptions = {},
): void {
  validateFencedBlocks(text);
  if (
    unfencedMarkerLines(text, "<proposed_plan>").length ||
    unfencedMarkerLines(text, "</proposed_plan>").length
  )
    throw new Error("raw v2 plans must not contain a proposed_plan wrapper");
  if (sectionHeadingCount(text, "Wave Thread Contracts") > 0)
    throw new Error(
      "WAVE_THREAD_V2_DUPLICATE_CONTRACT: raw v2 plans must not contain ## Wave Thread Contracts",
    );
  parseAcceptance(
    text,
    options.acceptanceLabel === undefined
      ? { requireScopedAcceptance: true }
      : { requireScopedAcceptance: true, scopeLabel: options.acceptanceLabel },
  );
  const [batches, tasks] = parseOrchestration(text, options);
  if (options.requireMultipleTasks && Object.keys(tasks).length < 2)
    throw new Error(
      "MULTI_TASK_DOWNGRADE: multi-task-flow requires at least two task items; a single direct main-agent task is a topology downgrade.",
    );
  if (
    options.requireExplicitDependency &&
    !hasExplicitDependency(batches, tasks)
  )
    throw new Error(
      "MULTI_TASK_DEPENDENCY_REQUIRED: multi-task-flow requires at least one explicit task or batch dependency.",
    );
  validateBatchMetadata(
    batches,
    options.expectedEventProtocol === undefined
      ? {}
      : { expectedEventProtocol: options.expectedEventProtocol },
  );
  validateOrchestration(text, batches, tasks, options);
}

function validateOrchestration(
  text: string,
  batches: BatchMap,
  tasks: TaskMap,
  options: ParseOrchestrationOptions = {},
): void {
  const overlap = Object.keys(batches).filter((id) => hasKey(tasks, id));
  if (overlap.length)
    throw new Error(
      `batch and task IDs must be globally unique: ${overlap.sort().join(", ")}`,
    );
  validateDependencies(
    batches,
    tasks,
    options.requireEarlierWave === undefined
      ? {}
      : { requireEarlierWave: options.requireEarlierWave },
  );
  validateAcceptanceScopes(
    text,
    batches,
    tasks,
    options.acceptanceLabel === undefined
      ? {}
      : { scopeLabel: options.acceptanceLabel },
  );
  const all = Object.values(tasks);
  if (options.requireDisjointOwnedSurfaces) {
    for (let index = 0; index < all.length; index += 1)
      for (const right of all.slice(index + 1)) {
        const left = all[index]!;
        const shared = field(left.fields, "owned_surfaces")
          .split(",")
          .some((surface) =>
            field(right.fields, "owned_surfaces")
              .split(",")
              .some((other) => ownedSurfacesOverlap(surface, other)),
          );
        if (shared)
          throw new Error(
            `multi-task-flow owned_surfaces must be disjoint in ${left.batch_id}:${left.id} and ${right.batch_id}:${right.id}`,
          );
      }
  }
  const byWave = new Map<number, TaskRecord[]>();
  for (const task of Object.values(tasks))
    byWave.set(task.wave, [...(byWave.get(task.wave) ?? []), task]);
  for (const items of byWave.values())
    for (let index = 0; index < items.length; index += 1)
      for (const right of items.slice(index + 1)) {
        const left = items[index]!;
        const shared = field(left.fields, "owned_surfaces")
          .split(",")
          .some((surface) =>
            field(right.fields, "owned_surfaces")
              .split(",")
              .some((other) => ownedSurfacesOverlap(surface, other)),
          );
        if (shared && !itemsAreSerialized(left, right, batches, tasks))
          throw new Error(
            `same-wave owned_surfaces overlap in ${left.batch_id}:${left.id} and ${right.batch_id}:${right.id} wave:${left.wave}`,
          );
      }
  for (let index = 0; index < all.length; index += 1)
    for (const right of all.slice(index + 1))
      if (all[index]!.batch_id !== right.batch_id) {
        const left = all[index]!;
        const shared = field(left.fields, "owned_surfaces")
          .split(",")
          .some((surface) =>
            field(right.fields, "owned_surfaces")
              .split(",")
              .some((other) => ownedSurfacesOverlap(surface, other)),
          );
        if (shared && !itemsAreSerialized(left, right, batches, tasks))
          throw new Error(
            `cross-batch owned_surfaces overlap in ${left.batch_id}:${left.id} and ${right.batch_id}:${right.id}`,
          );
      }
}
