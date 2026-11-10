import { describe, expect, test } from "bun:test";
import { createDemoLedger, createPlanningDemoLedger } from "../examples/orchestration-viewer/ledger";
import { plan, validateSchedulablePlan } from "../lib/schema";
import { actualIntervals, buildView, planWarnings, plannedIntervals } from "../lib/view";
import { initialOutput } from "../web/agent-output";
import { rangeFromIntervals } from "../web/execution-range";

const at = "2026-01-01T00:00:00.000Z";
function taskNode(id: string, minutes: number | null) {
  return { id, kind: "task", ref_id: id, group_id: null, label: id, estimate_minutes: minutes, estimate_basis: minutes === null ? null : "estimate", estimate_confidence: minutes === null ? null : "medium" };
}
function fixture(nodes: unknown[], edges: unknown[], startAt: string | null = at) {
  return plan.parse({ id: "plan", supersedes_id: null, approval_id: null, created_at: at, start_at: startAt, atoms: [], atomic_edges: [], nodes, edges, cut_rules: [], actions: [] });
}
function withRuntimeEvidence<T extends ReturnType<typeof createPlanningDemoLedger>>(ledger: T): T {
  ledger.groups.forEach((group) => {
    group.lifecycle.workspace_ready = "passed";
    ledger.events.push({
      id: `${group.id}-workspace-ready`,
      type: "lifecycle_recorded",
      subject_id: group.id,
      actor_id: ledger.control.owner_thread_id!,
      occurred_at: ledger.updated_at,
      recorded_at: ledger.updated_at,
      data: { target_type: "group", stage: "workspace_ready", resource_ids: [`${group.id}-worktree`, `${group.id}-branch`] },
    });
    ledger.resources.push(
      { id: `${group.id}-worktree`, kind: "worktree", target: group.id, status: "active", evidence_ref: `${group.id}:worktree` },
      { id: `${group.id}-branch`, kind: "branch", target: group.parent_branch, status: "active", evidence_ref: `${group.id}:branch` },
    );
    ledger.facts.push({
      id: `${group.id}-branch-published`,
      kind: "branch_published",
      subject_id: group.id,
      status: "passed",
      source: "sample",
      observed_at: ledger.updated_at,
      sha: group.current_sha,
      evidence_ref: `${group.id}:published`,
      receipt: {
        provider: ledger.repository.provider,
        repository: `${ledger.repository.owner}/${ledger.repository.name}`,
        resource_type: "branch",
        resource_id: group.parent_branch!,
        branch: group.parent_branch!,
        target_branch: null,
        base_sha: null,
        head_sha: group.current_sha,
        pr: null,
        state: "exists",
        evidence_ref: `${group.id}:published`,
      },
    });
  });
  return ledger;
}

describe("timeline projections", () => {
  test("rejects incomplete plans before formal scheduling", () => {
    expect(() => validateSchedulablePlan(fixture([taskNode("a", null)], []))).toThrow("缺少原子任务");
    const complete = plan.parse({ id: "complete", supersedes_id: null, approval_id: null, created_at: at, start_at: null, atoms: [{ id: "atom-a", title: "a", task_id: "a", purpose: "work", output: "done" }], atomic_edges: [], nodes: [{ ...taskNode("a", 30), estimate_basis: "fixture", estimate_confidence: "medium" }], edges: [], cut_rules: [], actions: [] });
    expect(() => validateSchedulablePlan(complete)).not.toThrow();
  });
  test("projects atom completion only from an event for the same owner and stable ID", () => {
    const ledger = createDemoLedger(1_767_200_000_000);
    const completed = ledger.events.find((event) => event.id === "atom-finish-model")!;
    const atoms = () => (buildView(ledger).tasks as Array<{ id: string; atoms: Array<{ completed_at: string | null }> }>).find((task) => task.id === "model")!.atoms;
    expect(atoms()[0]?.completed_at).toBe(completed.occurred_at);
    completed.subject_id = "ledger";
    expect(atoms()[0]?.completed_at).toBeNull();
    completed.subject_id = "model";
    completed.data.atom_id = "another-atom";
    expect(atoms()[0]?.completed_at).toBeNull();
  });
  test("never uses ledger events as conversation output", () => {
    const view = buildView(createDemoLedger(1_767_200_000_000));
    const ledgerTask = (view.tasks as Array<{ id: string; latest_output: string | null }>).find((task) => task.id === "ledger");
    const plannedTask = (view.tasks as Array<{ id: string; latest_output: string | null }>).find((task) => task.id === "verify");
    expect(ledgerTask?.latest_output).toBeNull();
    expect(plannedTask?.latest_output).toBeNull();
    expect(view.execution_phase).toBe("implementation");
    expect(view.active_plan_id).toBe(view.execution_plan_id);
    expect(view.plan_state).toMatchObject({ approval_pending: false, lifecycle: "approved" });
    expect((view.semantic_context as { field_metadata: Record<string, unknown> }).field_metadata).toHaveProperty("execution_phase");
  });

  test("separates proposal approval from runtime readiness for an unbound regular unit", () => {
    const ledger = createPlanningDemoLedger(1_767_200_000_000);
    ledger.groups.find((group) => group.id === "dashboard")!.agent_thread_id = null;
    const before = JSON.stringify(ledger);
    const view = buildView(ledger) as any;

    expect(view.plan_state).toMatchObject({
      proposal: { status: "complete" },
      approval: { status: "approved" },
      scheduling: { status: "blocked" },
      runtime_readiness: { status: "blocked" },
      scheduling_eligible: false,
      authorization_label: "Not schedulable",
    });
    expect(view.plan_state.runtime_readiness.blockers).toContainEqual(expect.objectContaining({
      code: "COORDINATOR_NOT_BOUND",
      group_id: "dashboard",
      resource: { kind: "conversation", status: "not_created", target_id: "dashboard" },
    }));
    expect(view.groups.find((group: any) => group.id === "dashboard")).toMatchObject({
      coordinator: { status: "not_created", thread_id: null },
      runtime_readiness: { status: "blocked" },
    });
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("blocks schema2 contract2 readiness without execution receipts", () => {
    const ledger = structuredClone(createPlanningDemoLedger(1_767_200_000_000));
    ledger.contract_version = 2;
    ledger.source_schema_version = null;
    const before = JSON.stringify(ledger);
    const view = buildView(ledger) as any;

    expect(view.plan_state).toMatchObject({
      proposal: { status: "complete" },
      approval: { status: "approved" },
      scheduling: { status: "blocked" },
      runtime_readiness: { status: "blocked" },
      scheduling_eligible: false,
    });
    expect(view.plan_state.runtime_readiness.blockers).toContainEqual(expect.objectContaining({
      code: "WORKSPACE_NOT_READY",
      group_id: "dashboard",
    }));
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("projects contract2 readiness only after workspace and branch receipts pass", () => {
    const ledger = withRuntimeEvidence(structuredClone(createPlanningDemoLedger(1_767_200_000_000)));
    ledger.contract_version = 2;
    ledger.source_schema_version = null;
    const view = buildView(ledger) as any;

    expect(view.plan_state).toMatchObject({
      proposal: { status: "complete" },
      approval: { status: "approved" },
      scheduling: { status: "eligible" },
      runtime_readiness: { status: "ready" },
      scheduling_eligible: true,
    });
  });

  test("does not project a closed delivery unit as schedulable", () => {
    const ledger = withRuntimeEvidence(structuredClone(createPlanningDemoLedger(1_767_200_000_000)));
    ledger.contract_version = 2;
    ledger.source_schema_version = null;
    ledger.groups.find((group) => group.id === "dashboard")!.state = "closed";
    const view = buildView(ledger) as any;

    expect(view.plan_state.scheduling.status).toBe("blocked");
    expect(view.plan_state.runtime_readiness.blockers).toContainEqual(expect.objectContaining({
      code: "GROUP_CLOSED",
      group_id: "dashboard",
    }));
  });

  test("projects an unresolved group conversation creation as unknown", () => {
    const ledger = structuredClone(createPlanningDemoLedger(1_767_200_000_000));
    ledger.contract_version = 2;
    ledger.source_schema_version = null;
    const group = ledger.groups.find((item) => item.id === "dashboard")!;
    group.agent_thread_id = null;
    ledger.operations.push({
      id: "dispatch-dashboard-unknown",
      kind: "dispatch",
      actor_id: ledger.control.owner_thread_id!,
      target_id: group.id,
      status: "unknown",
      request: { target_type: "group" },
      expected_sha: null,
      receipt_fact_id: null,
      created_at: ledger.updated_at,
      updated_at: ledger.updated_at,
    });
    const view = buildView(ledger) as any;

    expect(view.groups.find((item: any) => item.id === group.id)).toMatchObject({
      coordinator: { status: "unknown", thread_id: null },
      runtime_readiness: { status: "unknown" },
    });
    expect(view.plan_state.runtime_readiness.blockers).toContainEqual(expect.objectContaining({
      code: "COORDINATOR_UNKNOWN",
      group_id: group.id,
      resource: { kind: "conversation", status: "unknown", target_id: group.id },
    }));
  });

  test("does not project uncertain orchestration ownership as ready", () => {
    const ledger = withRuntimeEvidence(structuredClone(createPlanningDemoLedger(1_767_200_000_000)));
    ledger.contract_version = 2;
    ledger.source_schema_version = null;
    ledger.control.ownership = "uncertain";
    const view = buildView(ledger) as any;

    expect(view.plan_state).toMatchObject({
      scheduling: { status: "unknown" },
      runtime_readiness: { status: "unknown" },
      scheduling_eligible: false,
    });
    expect(view.plan_state.runtime_readiness.blockers).toContainEqual(expect.objectContaining({
      code: "CONTROL_OWNERSHIP_UNKNOWN",
    }));
  });

  test("warns when a running group has no formal contribution dispatch", () => {
    const ledger = createPlanningDemoLedger(1_767_200_000_000);
    ledger.groups.find((group) => group.id === "dashboard")!.coordination_execution.state = "running";
    ledger.tasks.filter((task) => task.group_id === "dashboard").forEach((task) => { task.thread_id = null; });
    const view = buildView(ledger) as { warnings: Array<Record<string, unknown>> };
    expect(view.warnings).toContainEqual(expect.objectContaining({
      code: "formal_execution_missing",
      group_id: "dashboard",
      task_ids: ["dashboard-ui", "server", "integration"],
    }));
  });

  test("projects the supplied conversation snapshot without mutating the ledger", () => {
    const ledger = createDemoLedger(1_767_200_000_000);
    const before = JSON.stringify(ledger);
    const output = { ...initialOutput(ledger.tasks[0]!.thread_id), state: "available" as const, text: "fresh commentary", stale: false };
    const view = buildView(ledger, undefined, { [ledger.tasks[0]!.id]: output });
    expect((view.tasks as Array<Record<string, unknown>>)[0]!.latest_agent_output).toEqual(output);
    expect((view.tasks as Array<Record<string, unknown>>)[0]!.latest_output).toBe("fresh commentary");
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("uses historical execution intervals for group duration", () => {
    expect(rangeFromIntervals([
      { start: "2026-10-31T00:00:00.000Z", end: "2026-10-31T01:00:00.000Z" },
      { start: "2026-10-31T02:00:00.000Z", end: null },
    ])).toEqual({ start: "2026-10-31T00:00:00.000Z", end: null });
  });

  test("respects parallel capacity and prerequisite completion", () => {
    const input = fixture([taskNode("a", 60), taskNode("b", 30), taskNode("c", 10)], [{ id: "b-c", from_node_id: "b", to_node_id: "c", requires: "integrated" }]);
    const rows = plannedIntervals(input, 2);
    expect(rows.find((item) => item.node_id === "a")!.start_offset_minutes).toBe(0);
    expect(rows.find((item) => item.node_id === "b")!.start_offset_minutes).toBe(0);
    expect(rows.find((item) => item.node_id === "c")!.start_offset_minutes).toBe(30);
  });

  test("keeps unknown time unknown rather than assuming zero duration", () => {
    const input = fixture([taskNode("a", null), taskNode("b", 30)], [{ id: "a-b", from_node_id: "a", to_node_id: "b", requires: "integrated" }]);
    const rows = plannedIntervals(input, 3);
    expect(rows.find((item) => item.node_id === "a")!.end).toBeNull();
    expect(rows.find((item) => item.node_id === "b")!.start).toBeNull();
    const unknownStart = plannedIntervals(fixture([taskNode("a", 30)], [], null), 3);
    expect(unknownStart).toHaveLength(1);
    expect(unknownStart[0]!.start_offset_minutes).toBe(0);
  });

  test("computes a relative schedule without a plan start", () => {
    const missingStart = fixture([taskNode("a", 30)], [], null);
    expect(planWarnings(missingStart)).toEqual([{ code: "legacy_invalid", reason: "任务 a 缺少原子任务，只读查看。" }]);
    expect(plannedIntervals(missingStart, 3)[0]).toMatchObject({ start_offset_minutes: 0, end_offset_minutes: 30 });
    expect(planWarnings(fixture([taskNode("a", 30)], []))).toEqual([{ code: "legacy_invalid", reason: "任务 a 缺少原子任务，只读查看。" }]);

    const ledger = createDemoLedger(1_767_200_000_000);
    ledger.plans[0]!.start_at = null;
    const view = buildView(ledger) as { plan_warnings: Array<{ code: string; reason: string }> };
    expect(view.plan_warnings).toEqual([]);
  });

  test("does not invent an end time for a running task", () => {
    const rows = actualIntervals({ tasks: [{ id: "a", group_id: "g" }], events: [{ subject_id: "a", data: {}, type: "task_started", occurred_at: at }] } as any);
    expect(rows).toEqual([{ task_id: "a", group_id: "g", state: "running", start: at, end: null }]);
  });

  test("retains historical groups at a cut and ignores failed merge attempts", () => {
    const cutAt = "2026-01-01T00:30:00.000Z";
    const rows = actualIntervals({ tasks: [{ id: "a", group_id: "new" }], events: [
      { subject_id: "a", data: { group_id: "old" }, type: "task_started", occurred_at: at },
      { subject_id: "old", data: { task_id: "a", outcome: "failed" }, type: "merge_resolved", occurred_at: "2026-01-01T00:15:00.000Z" },
      { subject_id: "old", data: { old_group_id: "old", new_group_id: "new", reassigned_task_ids: ["a"] }, type: "cut_applied", occurred_at: cutAt },
    ] } as any);
    expect(rows).toEqual([
      { task_id: "a", group_id: "old", state: "running", start: at, end: cutAt },
      { task_id: "a", group_id: "new", state: "running", start: cutAt, end: null },
    ]);
  });
});

test("group timing uses its own events and output binding, never contribution intervals", () => {
  const ledger = createDemoLedger(1_767_200_000_000), group = ledger.groups[0]!;
  const find = () => buildView(ledger).groups.find(g => g.id === group.id)!;
  expect(find().started_at).toBeNull();
  ledger.events.push({ id: "own-start", type: "group_execution_updated", subject_id: group.id, actor_id: "owner", occurred_at: at, recorded_at: at, data: { group_id: group.id, state: "running" } });
  ledger.events.push({ id: "own-finish", type: "group_updated", subject_id: group.id, actor_id: "owner", occurred_at: "2026-01-01T00:15:00.000Z", recorded_at: at, data: { group_id: group.id, state: "closed" } });
  expect(find().started_at).toBe(at); expect(find().finished_at).toBe("2026-01-01T00:15:00.000Z");
});
