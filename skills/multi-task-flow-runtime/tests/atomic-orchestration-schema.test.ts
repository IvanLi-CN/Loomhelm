import { expect, test } from "bun:test";
import { atomicNode, contract3MigrationCandidate, deriveBusinessStatus, evaluateMilestone, taskPrBinding, validateAtomicGraph, validateContributionStart } from "../lib/atomic-orchestration";

const ref = { provider: "github", repository: "org/repo", id: "pr-1", url: "https://github.com/org/repo/pull/1" };

test("accepts task-scoped contribution work with starting lifecycle", () => {
  const node = atomicNode.parse({
    kind: "work", id: "work-1", title: "Implement", purpose: "Code", output: "Patch", acceptance: [],
    activity_type: "contribution", state: "starting",
    scope: { kind: "task", task_id: "task-1", delivery_unit_id: "du-1" },
    runtime: { started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", evidence_refs: [] },
  });
  expect(node.kind).toBe("work");
});

test("rejects delivery-unit scope for contribution work", () => {
  expect(() => atomicNode.parse({
    kind: "work", id: "work-1", title: "Implement", purpose: "Code", output: "Patch", acceptance: [],
    activity_type: "contribution", state: "planned", scope: { kind: "delivery_unit", delivery_unit_id: "du-1" },
  })).toThrow();
});

test("represents closed PRs without treating them as success", () => {
  const parsed = taskPrBinding.parse({ state: "closed", pr: ref, branch: "feature", closed_at: "2026-01-01T00:00:00Z", closed_reason: "provider_closed" });
  expect(parsed.state).toBe("closed");
});

test("rejects cyclic atomic graphs and empty planned milestones", () => {
  const nodes = [
    { kind: "milestone", id: "m-1", title: "M1", state: "planned", scope: { kind: "delivery_unit", delivery_unit_id: "du-1" }, acceptance: [{ kind: "node_satisfied", node_id: "w-1" }] },
    { kind: "work", id: "w-1", title: "W1", purpose: "Work", output: "Done", acceptance: [], activity_type: "verification", state: "planned", scope: { kind: "delivery_unit", delivery_unit_id: "du-1" } },
  ] as const;
  const edges = [
    { id: "e-1", from_node_id: "m-1", to_node_id: "w-1", requires: { kind: "source_terminal_success" } },
    { id: "e-2", from_node_id: "w-1", to_node_id: "m-1", requires: { kind: "source_terminal_success" } },
  ] as const;
  expect(() => validateAtomicGraph(nodes as any, edges as any)).toThrow("acyclic");
  expect(() => validateAtomicGraph([{ kind: "milestone", id: "empty", title: "Empty", state: "planned", scope: { kind: "delivery_unit", delivery_unit_id: "du-1" }, acceptance: [] }] as any, [])).toThrow("conditions");
});

test("evaluates milestone conditions with full AND semantics", () => {
  const node = { kind: "milestone", id: "m-1", title: "M", state: "planned", scope: { kind: "delivery_unit", delivery_unit_id: "du-1" }, acceptance: [{ kind: "node_satisfied", node_id: "w-1" }] } as any;
  expect(evaluateMilestone(node, [{ satisfied: true }], [{ satisfied: false }]).status).toBe("pending");
  expect(evaluateMilestone(node, [{ satisfied: true }], [{ satisfied: true }]).status).toBe("satisfied");
  expect(evaluateMilestone(node, [{ satisfied: false, blocked: true }], [{ satisfied: true }]).status).toBe("blocked");
});

test("derives business status and enforces contribution starting prerequisites", () => {
  const node = atomicNode.parse({ kind: "work", id: "work-1", title: "Implement", purpose: "Implement", output: "code", acceptance: [], activity_type: "contribution", state: "starting", scope: { kind: "task", task_id: "task-1", delivery_unit_id: "du-1" }, runtime: { started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", evidence_refs: [] } });
  expect(() => validateContributionStart(node, { pr: { state: "unpublished" } } as any)).toThrow();
  expect(() => validateContributionStart(node, { pr: { state: "published", pr: ref, parent_branch: "main" }, parent_branch: "main" } as any)).not.toThrow();
  expect(deriveBusinessStatus([node], { kind: "task", task_id: "task-1" })).toBe("running");
});

test("migrates unambiguous task atoms and rejects group atoms", () => {
  const result = contract3MigrationCandidate({ contract_version: 2, tasks: [{ id: "task-1", group_id: "du-1", atoms: [{ id: "atom-1", title: "Code" }] }], groups: [{ id: "du-1", atoms: [] }], plans: [{ atomic_edges: [] }] });
  expect(result.contract_version).toBe(3);
  expect(result.atomic_nodes[0].scope).toEqual({ kind: "task", task_id: "task-1", delivery_unit_id: "du-1" });
  expect(() => contract3MigrationCandidate({ contract_version: 2, tasks: [], groups: [{ id: "du-1", atoms: [{ id: "legacy" }] }], plans: [] })).toThrow("ambiguous");
});
