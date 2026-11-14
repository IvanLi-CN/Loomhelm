import { expect, test } from "bun:test";
import { atomicNode, canonicalizeContract3Ledger, canonicalizeContract3Plan, contract3MigrationCandidate, deriveBusinessStatus, evaluateMilestone, taskPrBinding, validateAtomicGraph, validateContributionStart } from "../lib/atomic-orchestration";

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

test("accepts explicit start and end atomic boundaries", () => {
  expect(atomicNode.parse({ kind: "boundary", id: "atomic-start", title: "开始", boundary: "start", state: "planned" })).toEqual({ kind: "boundary", id: "atomic-start", title: "开始", boundary: "start", state: "planned" });
  expect(atomicNode.parse({ kind: "boundary", id: "atomic-end", title: "结束", boundary: "end", state: "completed" })).toEqual({ kind: "boundary", id: "atomic-end", title: "结束", boundary: "end", state: "completed" });
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

test("represents a singleton task by the delivery-unit PR binding", () => {
  const parsed = taskPrBinding.parse({ state: "shared_delivery_unit", delivery_unit_id: "du-1" });
  expect(parsed).toEqual({ state: "shared_delivery_unit", delivery_unit_id: "du-1" });
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
  expect(() => validateContributionStart(node, { pr: { state: "unpublished" } } as any, {
    delivery_unit_kind: "bootstrap",
    owner_kind: "main",
    execution_owner: "main",
    conversation_policy: "main_owned",
    active: true,
    workspace_ready: true,
    parent_pr_status: "definitively_absent",
  })).not.toThrow();
  expect(() => validateContributionStart(node, { pr: { state: "closed", pr: ref, parent_branch: "main", closed_at: "2026-01-01T00:00:00Z", closed_reason: "provider_closed" } } as any, {
    delivery_unit_kind: "bootstrap",
    owner_kind: "main",
    execution_owner: "main",
    conversation_policy: "main_owned",
    active: true,
    workspace_ready: true,
    parent_pr_status: "present",
  })).toThrow();
  expect(() => validateContributionStart(node, { pr: { state: "unpublished" } } as any, {
    delivery_unit_kind: "bootstrap",
    owner_kind: "main",
    execution_owner: "main",
    conversation_policy: "main_owned",
    active: true,
    workspace_ready: true,
    parent_pr_status: "unknown",
  })).toThrow();
  expect(() => validateContributionStart(node, { pr: { state: "unpublished" } } as any, {
    delivery_unit_kind: "bootstrap",
    owner_kind: "main",
    execution_owner: "task_agent",
    conversation_policy: "task_agent",
    active: true,
    workspace_ready: true,
  })).toThrow();
  expect(deriveBusinessStatus([node], { kind: "task", task_id: "task-1" })).toBe("running");
});

test("migrates unambiguous task atoms and rejects group atoms", () => {
  const result = contract3MigrationCandidate({ contract_version: 2, tasks: [{ id: "task-1", group_id: "du-1", atoms: [{ id: "atom-1", title: "Code" }] }], groups: [{ id: "du-1", atoms: [] }], plans: [{ atomic_edges: [] }] });
  expect(result.contract_version).toBe(3);
  expect(result.atomic_nodes[0].scope).toEqual({ kind: "task", task_id: "task-1", delivery_unit_id: "du-1" });
  expect(() => contract3MigrationCandidate({ contract_version: 2, tasks: [], groups: [{ id: "du-1", atoms: [{ id: "legacy" }] }], plans: [] })).toThrow("ambiguous");
});

test("materializes legacy task and delivery-unit atoms into the contract-3 graph", () => {
  const plan = canonicalizeContract3Plan({
    atoms: [{ id: "atom-task", title: "Task", task_id: "task-1", purpose: "Purpose", output: "Output" }],
    group_atoms: [{ id: "atom-group", title: "Workspace", group_id: "du-1", purpose: "Prepare", output: "Ready", lifecycle_stage: "workspace_ready" }],
    atomic_edges: [{ id: "atom-edge", from_atom_id: "atom-task", to_atom_id: "atom-group" }],
  }, [{ id: "task-1", group_id: "du-1", kind: "verification" }]);

  expect(plan.atomic_nodes.map((node: { id: string }) => node.id)).toEqual(["atom-task", "atom-group"]);
  expect(plan.atomic_edges).toEqual([{
    id: "atom-edge",
    from_node_id: "atom-task",
    to_node_id: "atom-group",
    requires: { kind: "source_terminal_success" },
  }]);
  expect(() => validateAtomicGraph(plan.atomic_nodes, plan.atomic_edges)).not.toThrow();
});

test("derives atomic dependencies from the legacy task graph when no atom edges were declared", () => {
  const plan = canonicalizeContract3Plan({
    atoms: [
      { id: "atom-a", title: "A", task_id: "task-a", purpose: "A", output: "A" },
      { id: "atom-b", title: "B", task_id: "task-b", purpose: "B", output: "B" },
    ],
    atomic_edges: [],
    nodes: [
      { id: "node-a", kind: "task", ref_id: "task-a" },
      { id: "node-b", kind: "task", ref_id: "task-b" },
    ],
    edges: [{ id: "task-edge", from_node_id: "node-a", to_node_id: "node-b", requires: "integrated" }],
  }, [
    { id: "task-a", group_id: "du-1", kind: "contribution" },
    { id: "task-b", group_id: "du-1", kind: "contribution" },
  ]);

  expect(plan.atomic_edges).toEqual([{
    id: "atomic-task-edge",
    from_node_id: "atom-a",
    to_node_id: "atom-b",
    requires: { kind: "source_terminal_success" },
  }]);
  expect(() => validateAtomicGraph(plan.atomic_nodes, plan.atomic_edges)).not.toThrow();
});

test("derives delivery-unit lifecycle order when legacy group atoms have no edges", () => {
  const plan = canonicalizeContract3Plan({
    atoms: [],
    group_atoms: [
      { id: "group-prepare", title: "Prepare", group_id: "du-1", purpose: "Prepare", output: "Prepared", lifecycle_stage: "workspace_ready" },
      { id: "group-pr", title: "PR", group_id: "du-1", purpose: "PR", output: "Created", lifecycle_stage: "pr_created" },
      { id: "group-merge", title: "Merge", group_id: "du-1", purpose: "Merge", output: "Merged", lifecycle_stage: "pr_merged" },
    ],
    atomic_edges: [],
  });

  expect(plan.atomic_edges).toEqual([
    { id: "atomic-lifecycle-du-1-1", from_node_id: "group-prepare", to_node_id: "group-pr", requires: { kind: "source_terminal_success" } },
    { id: "atomic-lifecycle-du-1-2", from_node_id: "group-pr", to_node_id: "group-merge", requires: { kind: "source_terminal_success" } },
  ]);
  expect(() => validateAtomicGraph(plan.atomic_nodes, plan.atomic_edges)).not.toThrow();
});

test("materializes contract-3 ledger roots and every plan from legacy atom collections", () => {
  const ledger = canonicalizeContract3Ledger({
    active_plan_id: "plan",
    execution_plan_id: "plan",
    tasks: [{ id: "task", group_id: "group", kind: "contribution", atoms: [] }],
    plans: [{
      id: "plan",
      atoms: [{ id: "task-atom", task_id: "task", title: "Implement", purpose: "Implement", output: "Code" }],
      group_atoms: [{ id: "group-atom", group_id: "group", title: "Prepare", purpose: "Prepare", output: "Ready", lifecycle_stage: "workspace_ready" }],
      atomic_edges: [{ id: "edge", from_atom_id: "task-atom", to_atom_id: "group-atom" }],
    }],
    atomic_nodes: [],
    atomic_edges: [],
  });
  expect(ledger.atomic_nodes).toHaveLength(2);
  expect(ledger.atomic_edges).toEqual([{ id: "edge", from_node_id: "task-atom", to_node_id: "group-atom", requires: { kind: "source_terminal_success" } }]);
  expect(ledger.plans[0].atomic_nodes).toHaveLength(2);
});
