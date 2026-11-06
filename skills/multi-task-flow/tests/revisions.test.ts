import { describe, expect, test } from "bun:test";
import { apply, ready, type Request } from "../scripts/engine";
import { contractJsonSchema, localSemanticProjection } from "../scripts/contract";
import {
  buildPlanRevision,
  deriveExecutionPhase,
  diffPlan,
  validateRevisionInput,
} from "../scripts/revisions";
import { validateLedger } from "../scripts/schema";

const base = "a".repeat(40);
const at = "2026-01-01T00:00:00.000Z";
const main = { role: "main", thread_id: "main-thread" } as const;

function fixture() {
  const group = {
    id: "g",
    title: "Group",
    agent_thread_id: "group-thread",
    state: "active",
    parent_branch: "parent",
    parent_pr: null,
    cut_sha: null,
    current_sha: base,
    merge_sha: null,
    requirements_path: null,
  };
  const tasks = ["a", "b", "c"].map((id) => ({
    id,
    title: id,
    kind: "contribution",
    group_id: "g",
    thread_id: null,
    state: "planned",
    atoms: [],
    owned_surfaces: [`src/${id}`],
    base_sha: base,
    pr: null,
    requirements_path: null,
    started_at: null,
    finished_at: null,
    blocker: null,
    assignment_history: [],
  }));
  const nodes = ["a", "b", "c"].map((id) => ({
    id: `node-${id}`,
    kind: "task",
    ref_id: id,
    group_id: "g",
    label: id,
    estimate_minutes: null,
    estimate_basis: null,
    estimate_confidence: null,
  }));
  const plan = {
    id: "plan",
    supersedes_id: null,
    approval_id: null,
    created_at: at,
    start_at: null,
    atoms: [],
    atomic_edges: [],
    nodes,
    edges: [{ id: "a-c", from_node_id: "node-a", to_node_id: "node-c", requires: "integrated" }],
    cut_rules: [],
    actions: [],
  };
  return validateLedger({
    schema_version: 1,
    orchestration_id: "run",
    revision: 0,
    repository: { provider: "github", host: "github.com", owner: "example", name: "repo", target_branch: "main" },
    control: { owner_thread_id: "main-thread", ownership: "bound", approval_id: null },
    config: { execution_profile: { model: "gpt-6.1-sol", thinking: "medium" }, max_running_tasks: 3, display_timezone: "Asia/Shanghai" },
    plans: [plan],
    active_plan_id: "plan",
    groups: [group],
    tasks,
    follow_prs: [],
    facts: [],
    operations: [],
    events: [],
    requests: [],
    notifications: [],
    resources: [],
    updated_at: at,
  });
}

function request(ledger: ReturnType<typeof fixture>, requestId: string, payload: Record<string, unknown>, actor: Request["actor"] = main): Request {
  if (payload.outcome === "succeeded" && (payload.native_evidence as any)?.source === "create_thread") {
    const operation = ledger.operations.find((item) => item.id === payload.operation_id)!;
    const nativeId = `native-${operation.id}`;
    if (!operation.request.native_request_id) apply(ledger, "dispatch-bind-request", { run_id: "run", actor: main, request_id: `bind-${operation.id}`, expected_revision: ledger.revision, payload: { operation_id: operation.id, native_request_id: nativeId } });
    payload.native_evidence = { source: "multi-task-flow-cli", native_tool_name: "thread/start", operation_id: operation.id, native_request_id: nativeId, ...(operation.request.execution_profile as object), evidence_ref: "fixture://app-server", created_at: at };
  }
  return { run_id: ledger.orchestration_id, actor, request_id: requestId, expected_revision: ledger.revision, payload };
}

function approve(ledger: ReturnType<typeof fixture>, planId = ledger.active_plan_id, requestId = `approve-${planId}`): void {
  apply(ledger, "plan-approve", request(ledger, requestId, {
    plan_id: planId,
    approval_id: `approval-${planId}`,
    authorized_actions: ["dispatch"],
    authorized_action_ids: [],
  }));
}

function proposedPlan(ledger: ReturnType<typeof fixture>, id: string) {
  const proposed = structuredClone(ledger.plans.find((item) => item.id === ledger.execution_plan_id)!);
  proposed.id = id;
  proposed.supersedes_id = ledger.execution_plan_id;
  proposed.approval_id = null;
  proposed.lifecycle = "proposed";
  proposed.revision = null;
  return proposed;
}

function startTask(ledger: ReturnType<typeof fixture>, taskId = "a"): void {
  apply(ledger, "plan-approve", request(ledger, "initial-approval", {
    plan_id: "plan",
    approval_id: "approval-plan",
    authorized_actions: ["dispatch"],
    authorized_action_ids: [],
  }));
  apply(ledger, "dispatch-claim", request(ledger, "dispatch-a", { task_id: taskId, operation_id: "dispatch-a" }));
  apply(ledger, "dispatch-resolve", request(ledger, "bind-a", {
    operation_id: "dispatch-a",
    outcome: "succeeded",
    thread_id: `task-${taskId}`,
    native_evidence: { source: "create_thread" },
  }));
  apply(ledger, "task-update", request(ledger, "start-a", { task_id: taskId, state: "running", occurred_at: at }, { role: "task", thread_id: `task-${taskId}` }));
}

const dependencyReason = {
  category: "dependency_correction",
  summary: "Remove a dependency invalidated by the implementation boundary.",
  evidence_refs: ["evidence://loomhelm/v3/dependency-review"],
  impact: "The successor must be recalculated under the replacement graph.",
};

describe("phase-aware plan revisions", () => {
  test("enters implementation only after a real task_started event", () => {
    const ledger = fixture();
    expect(deriveExecutionPhase(ledger)).toBe("planning");
    ledger.tasks[0]!.state = "starting";
    expect(deriveExecutionPhase(ledger)).toBe("planning");
    ledger.events.push({ id: "started", type: "task_started", subject_id: "a", actor_id: "task-a", occurred_at: at, recorded_at: at, data: { task_id: "a" } });
    expect(deriveExecutionPhase(ledger)).toBe("implementation");
  });

  test("classifies a Loomhelm v2 to v3 dependency deletion as planning_revision", () => {
    const ledger = fixture();
    const previous = structuredClone(ledger.plans[0]!);
    previous.nodes = ["session-resume", "query-layer", "server-read-path", "ui-regression", "docs"].map((id) => ({ id, kind: "task", ref_id: null, group_id: null, label: id, estimate_minutes: null, estimate_basis: null, estimate_confidence: null }));
    const dependencyPairs: [string, string][] = [
      ["session-resume", "query-layer"],
      ["server-read-path", "query-layer"],
      ["query-layer", "ui-regression"],
      ["ui-regression", "docs"],
    ];
    previous.edges = dependencyPairs.map(([from, to]) => ({ id: `${from}-${to}`, from_node_id: from, to_node_id: to, requires: "completed" as const }));
    const proposed = structuredClone(previous);
    proposed.edges = [];
    const revision = buildPlanRevision(ledger, previous, proposed, ledger.tasks, ledger.groups);
    expect(revision.change_class).toBe("planning_revision");
    expect(revision.reason).toBeNull();
    expect(revision.change_set.removed.map((entry) => entry.path)).toEqual([
      "plan.edges[query-layer-ui-regression]",
      "plan.edges[server-read-path-query-layer]",
      "plan.edges[session-resume-query-layer]",
      "plan.edges[ui-regression-docs]",
    ]);
  });

  test("planning revisions require a diff and a fresh approval", () => {
    const ledger = fixture();
    const proposed = proposedPlan(ledger, "plan-v2");
    proposed.nodes[0]!.label = "Renamed during planning";
    const result = apply(ledger, "plan-propose", request(ledger, "propose-planning", {
      plan: proposed,
      groups: structuredClone(ledger.groups),
      tasks: structuredClone(ledger.tasks),
    })) as any;
    expect(result.result).toMatchObject({ plan_id: "plan-v2", change_class: "planning_revision", approval_required: true });
    expect(ledger.active_plan_id).toBe("plan-v2");
    expect(ledger.execution_plan_id).toBe("plan-v2");
    expect(ledger.control.approval_id).toBeNull();
    expect(ready(ledger, "a")).toBe(false);
    approve(ledger, "plan-v2", "approve-planning");
    expect(ledger.plans.find((item) => item.id === "plan")!.lifecycle).toBe("superseded");
    expect(ledger.execution_plan_id).toBe("plan-v2");
  });

  test("implementation low-impact revisions auto-approve with a required reason", () => {
    const ledger = fixture();
    startTask(ledger);
    const proposed = proposedPlan(ledger, "plan-low");
    proposed.nodes[0]!.label = "Renamed without changing execution boundaries";
    const result = apply(ledger, "plan-propose", request(ledger, "propose-low", {
      plan: proposed,
      groups: structuredClone(ledger.groups),
      tasks: structuredClone(ledger.tasks),
      revision: { reason: { ...dependencyReason, category: "owner_direction", evidence_refs: [] } },
    })) as any;
    expect(result.result).toMatchObject({ change_class: "implementation_low_impact", approval_required: false });
    expect(ledger.active_plan_id).toBe("plan-low");
    expect(ledger.execution_plan_id).toBe("plan-low");
    expect(ledger.plans.find((item) => item.id === "plan-low")!.lifecycle).toBe("approved");
    expect(ledger.events.map((event) => event.type)).toContain("plan_revision_approved");
  });

  test("implementation high-impact revisions keep the old execution pointer and hold successors", () => {
    const ledger = fixture();
    startTask(ledger);
    const proposed = proposedPlan(ledger, "plan-high");
    proposed.edges = [];
    const result = apply(ledger, "plan-propose", request(ledger, "propose-high", {
      plan: proposed,
      groups: structuredClone(ledger.groups),
      tasks: structuredClone(ledger.tasks),
      revision: { reason: dependencyReason },
    })) as any;
    expect(result.result).toMatchObject({ change_class: "implementation_high_impact", approval_required: true });
    expect(ledger.active_plan_id).toBe("plan-high");
    expect(ledger.execution_plan_id).toBe("plan");
    expect(ledger.plans.find((item) => item.id === "plan")!.lifecycle).toBe("approved");
    expect(ready(ledger, "b")).toBe(true);
    expect(ready(ledger, "c")).toBe(false);
    approve(ledger, "plan-high", "approve-high");
    expect(ledger.execution_plan_id).toBe("plan-high");
    expect(ledger.plans.find((item) => item.id === "plan")!.lifecycle).toBe("superseded");
    expect(ready(ledger, "c")).toBe(true);
  });

  test("rejects a high-impact revision without reason before mutating the ledger", () => {
    const ledger = fixture();
    startTask(ledger);
    const proposed = proposedPlan(ledger, "plan-invalid");
    proposed.edges = [];
    const before = JSON.stringify(ledger);
    expect(() => apply(ledger, "plan-propose", request(ledger, "propose-invalid", {
      plan: proposed,
      groups: structuredClone(ledger.groups),
      tasks: structuredClone(ledger.tasks),
    }))).toThrow("structured reason");
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("abandoning a candidate restores the prior execution plan", () => {
    const ledger = fixture();
    startTask(ledger);
    const proposed = proposedPlan(ledger, "plan-abandoned");
    proposed.edges = [];
    apply(ledger, "plan-propose", request(ledger, "propose-abandoned", {
      plan: proposed,
      groups: structuredClone(ledger.groups),
      tasks: structuredClone(ledger.tasks),
      revision: { reason: dependencyReason },
    }));
    apply(ledger, "plan-abandon", request(ledger, "abandon", { plan_id: "plan-abandoned" }));
    expect(ledger.active_plan_id).toBe("plan");
    expect(ledger.execution_plan_id).toBe("plan");
    expect(ledger.plans.find((item) => item.id === "plan-abandoned")!.lifecycle).toBe("abandoned");
    expect(ledger.events.at(-1)?.type).toBe("plan_revision_abandoned");
  });

  test("requires a revision association when migrating a started task", () => {
    const ledger = fixture();
    startTask(ledger);
    const proposed = proposedPlan(ledger, "plan-migration");
    proposed.nodes = proposed.nodes.filter((node) => node.ref_id !== "a");
    proposed.nodes.push({ ...structuredClone(proposed.nodes[0]!), id: "node-a-replacement", ref_id: "a-replacement", label: "a replacement" });
    proposed.edges = [];
    const replacement = { ...structuredClone(ledger.tasks[0]!), id: "a-replacement", title: "a replacement", thread_id: null, state: "planned", owned_surfaces: ["src/a-replacement"], started_at: null, finished_at: null, blocker: null, assignment_history: [] };
    const tasks = [...structuredClone(ledger.tasks), replacement];
    apply(ledger, "plan-propose", request(ledger, "propose-migration", {
      plan: proposed,
      groups: structuredClone(ledger.groups),
      tasks,
      revision: { reason: dependencyReason },
    }));
    apply(ledger, "task-migrate", request(ledger, "migrate-a", {
      old_task_id: "a",
      new_task_id: "a-replacement",
      reason: dependencyReason,
      inherited_outputs: ["validated source facts"],
      uninherited_outputs: ["old thread binding"],
    }));
    expect(ledger.tasks.find((task) => task.id === "a")!.disposition).toBe("superseded");
    expect(ledger.tasks.find((task) => task.id === "a")!.superseded_by_task_id).toBe("a-replacement");
    expect(ledger.events.at(-1)?.type).toBe("task_migration_recorded");
    expect((ledger.events.at(-1)?.data.plan_revision as Record<string, unknown>).change_class).toBe("implementation_high_impact");
    validateLedger(ledger);
  });

  test("exposes one contract schema and a local semantic projection", () => {
    const schema = contractJsonSchema() as { properties?: Record<string, unknown>; [key: string]: unknown };
    expect(schema.properties).toHaveProperty("execution_plan_id");
    expect(schema.properties).toHaveProperty("contract_version");
    expect(schema["x-contract-version"]).toBe(2);
    expect(schema["x-field-metadata"]).toHaveProperty("plan_revision");
    const projection = localSemanticProjection(fixture(), "plan-propose");
    expect(projection).toMatchObject({ contract_version: 1, operation: "plan-propose", phase: { value: "planning" }, plans: { approval_pending: false } });
    expect((projection.examples as { negative: string[] }).negative).toContain("active_plan_id alone is not execution completion.");
  });

  test("rejects malformed empty revisions and reports the four replayed dependency deletions", () => {
    const ledger = fixture();
    const previous = structuredClone(ledger.plans[0]!);
    const empty = structuredClone(previous);
    expect(() => validateRevisionInput(buildPlanRevision(ledger, previous, empty, ledger.tasks, ledger.groups))).toThrow();
    expect(diffPlan(previous, previous, ledger.tasks, ledger.tasks, ledger.groups, ledger.groups)).toEqual({ added: [], removed: [], modified: [] });
  });
});

test("group atom revisions are audited, require approval and restore on abandon", () => {
  const ledger = fixture();
  const atom = { id: "group-prepare", title: "Prepare", purpose: "Prepare", output: "Ready", lifecycle_stage: null };
  ledger.plans[0]!.group_atoms = [{ ...atom, group_id: "g" }];
  ledger.groups[0]!.atoms = [{ ...atom, status: "planned" }];
  const proposed = proposedPlan(ledger, "group-revision");
  proposed.group_atoms[0]!.title = "Prepare revised";
  const groups = structuredClone(ledger.groups);
  groups[0]!.atoms[0]!.title = "Prepare revised";
  apply(ledger, "plan-propose", request(ledger, "propose-atoms", { plan: proposed, groups, tasks: structuredClone(ledger.tasks) }));
  expect(ledger.plans.at(-1)!.revision!.change_set.modified.some((change) => change.path.includes("group_atoms"))).toBe(true);
  expect(() => apply(ledger, "group-atom-update", request(ledger, "unapproved-atom", { group_id: "g", atom_id: atom.id, state: "running" }))).toThrow("not approved");
  apply(ledger, "plan-abandon", request(ledger, "abandon-atoms", { plan_id: proposed.id }));
  expect(validateLedger(ledger).groups[0]!.atoms[0]!.title).toBe("Prepare");
});
