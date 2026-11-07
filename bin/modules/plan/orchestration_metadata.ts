import { parseAcceptance } from "./acceptance";
import {
  IDENTIFIER,
  BATCH_DEPENDENCY_MILESTONES,
  BatchMap,
  FieldMap,
  TaskMap,
  field,
  normalizedTopology,
  pythonStrip,
  MULTI_TASK_FLOW_EVENT_PROTOCOL,
} from "./orchestration_base";

function sameKeys(left: object, right: object): boolean {
  return (
    JSON.stringify(Object.keys(left).sort()) ===
    JSON.stringify(Object.keys(right).sort())
  );
}

export function validateBatchMetadataFromFields(
  batches: Record<string, FieldMap>,
  options: BatchMetadataOptions = {},
): void {
  for (const fields of Object.values(batches))
    validateBatchFields(fields, options.expectedEventProtocol);
}
export interface BatchMetadataOptions {
  expectedEventProtocol?: string;
}

function validateBatchFields(
  fields: FieldMap,
  expectedEventProtocol = MULTI_TASK_FLOW_EVENT_PROTOCOL,
): void {
  if (fields.event_protocol && fields.event_protocol !== expectedEventProtocol)
    throw new Error(`event_protocol must be ${expectedEventProtocol}`);
  if (fields.child_pr && !new Set(["required", "none"]).has(fields.child_pr))
    throw new Error("child_pr must be required or none");
  if (
    fields.mode === "parent-child" &&
    fields.child_pr &&
    fields.child_pr !== "required"
  )
    throw new Error("parent-child mode requires child_pr=required");
  if (fields.mode === "direct" && fields.child_pr && fields.child_pr !== "none")
    throw new Error("direct mode requires child_pr=none");
  const topology = normalizedTopology(fields.topology ?? "");
  if (
    ["stacked", "aggregate", "tracking", "ledger", "runtime-ledger"].some(
      (prefix) => topology === prefix || topology.startsWith(`${prefix}-`),
    )
  )
    throw new Error("topology uses a retired delivery topology");
  const expected =
    fields.mode === "parent-child"
      ? "sibling-prs"
      : fields.mode === "direct"
        ? "direct-final-pr"
        : "";
  if (topology && expected && topology !== expected)
    throw new Error(`topology must be ${expected} for mode=${fields.mode}`);
  if (
    fields.release_policy &&
    !new Set(["branch-preview", "trunk-only"]).has(fields.release_policy)
  )
    throw new Error("release_policy must be branch-preview or trunk-only");
}

export function validateBatchMetadata(
  batches: BatchMap,
  options: BatchMetadataOptions = {},
): void {
  for (const batch of Object.values(batches))
    validateBatchFields(batch.fields, options.expectedEventProtocol);
}

function acceptanceIds(value: string, label: string): string[] {
  const ids = value.split(",").map(pythonStrip).filter(Boolean);
  if (!ids.length || ids.some((item) => !IDENTIFIER.test(item)))
    throw new Error(`${label} must contain comma-separated acceptance IDs`);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${label} repeats an acceptance ID`);
  return ids;
}

export function validateAcceptanceScopes(
  text: string,
  batches: BatchMap,
  tasks: TaskMap,
  options: { scopeLabel?: string } = {},
): void {
  const parsed = parseAcceptance(
    text,
    options.scopeLabel === undefined
      ? { requireScopedAcceptance: true }
      : { requireScopedAcceptance: true, scopeLabel: options.scopeLabel },
  );
  const items = new Map(parsed.items.map((item) => [item.id, item.scope]));
  const declarations = new Map<string, string[]>();
  for (const batch of Object.values(batches))
    for (const id of acceptanceIds(
      field(batch.fields, "acceptance"),
      `batch:${batch.id} acceptance`,
    ))
      declarations.set(id, [
        ...(declarations.get(id) ?? []),
        `batch:${batch.id}`,
      ]);
  for (const task of Object.values(tasks))
    for (const id of acceptanceIds(
      field(task.fields, "acceptance"),
      `task:${task.id} acceptance`,
    ))
      declarations.set(id, [
        ...(declarations.get(id) ?? []),
        `task:${task.id}`,
      ]);
  for (const [id, owners] of declarations) {
    if (!items.has(id))
      throw new Error(`v2 acceptance declaration references unknown ID: ${id}`);
    if (JSON.stringify(owners) !== JSON.stringify([items.get(id)]))
      throw new Error(
        `v2 acceptance ${id} must be declared exactly by its scope owner`,
      );
  }
  const undeclared = [...items.keys()]
    .filter((id) => !declarations.has(id))
    .sort();
  if (undeclared.length)
    throw new Error(
      `v2 acceptance entries are not declared by an owner: ${undeclared.join(", ")}`,
    );
}
