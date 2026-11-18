import { expect, test } from "bun:test";
import { apply } from "../lib/engine";
import { atomicPredecessorsPending } from "../lib/engine-support-core";
import { validateLedger } from "../lib/schema";
import { modernFixture, request } from "./role-flow-fixtures";

const actor = { role: "task", thread_id: "task-thread" } as const;
const groupActor = { role: "group", thread_id: "delivery-thread" } as const;
const identity = {
  package_name: "@loomhelm/multi-task-flow",
  package_version: "0.6.2",
  build_id: "b".repeat(64),
  source_sha: "b".repeat(40),
  compatibility_line: "compat-v1",
  ledger_contract: 6 as const,
  api_contract: 1 as const,
  frontend_contract: 1 as const,
  viewer_contract: 5 as const,
};

test("a task reports waiting and blocked without claiming execution slots", () => {
  const ledger = modernFixture();
  ledger.tasks[0]!.thread_id = actor.thread_id;
  ledger.tasks[0]!.state = "starting";
  for (const state of ["running", "waiting", "blocked", "blocked", "waiting"] as const)
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        `update-${ledger.revision}`,
        {
          task_id: "task-a",
          state,
          detail: "CI status changed",
        },
        actor,
      ),
    );
  expect(ledger.tasks[0]!.started_at).not.toBeNull();
  expect(ledger.tasks[0]!.state).toBe("waiting");
});

test("current contract atom updates follow edges despite reversed storage order", () => {
  const ledger = modernFixture();
  ledger.contract_version = 6;
  ledger.runtime_identity = identity;
  const task = ledger.tasks[0]!;
  task.thread_id = actor.thread_id;
  task.state = "running";
  const [first, second] = task.atoms;
  task.atoms.reverse();
  const invoke = (atom_id: string) =>
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        `atom-${ledger.revision}`,
        { task_id: task.id, atom_id, state: "running" },
        actor,
      ),
    );
  expect(() => invoke(second!.id)).toThrow(first!.id);
  expect(invoke(first!.id)).toMatchObject({ code: "APPLIED" });
});

test("a milestone distinguishes reported completion from explicit evidence", () => {
  const ledger = modernFixture();
  const plan = ledger.plans[0]!;
  const [source, target] = ledger.tasks[0]!.atoms;
  const milestoneId = "evidence-gate";
  plan.atomic_nodes.push({
    id: milestoneId,
    kind: "milestone",
    title: "Evidence gate",
    state: "planned",
    scope: { kind: "delivery_unit", delivery_unit_id: ledger.groups[0]!.id },
    acceptance: [],
  });
  plan.atomic_edges = [
    {
      id: "source-to-milestone",
      from_node_id: source!.id,
      to_node_id: milestoneId,
      requires: {
        kind: "source_evidence",
        criterion: {
          kind: "ci_passed",
          target_ref: "mock",
          head_sha: "a".repeat(40),
          checks: ["test"],
        },
      },
    },
    {
      id: "milestone-to-target",
      from_node_id: milestoneId,
      to_node_id: target!.id,
      requires: { kind: "source_terminal_success" },
    },
  ];
  expect(atomicPredecessorsPending(ledger, plan, target!.id)).toEqual([milestoneId]);
  source!.status = "completed";
  expect(atomicPredecessorsPending(ledger, plan, target!.id)).toEqual([milestoneId]);
  plan.atomic_edges[0]!.requires = { kind: "source_terminal_success" };
  expect(atomicPredecessorsPending(ledger, plan, target!.id)).toEqual([]);
  plan.atomic_edges[0]!.requires = {
    kind: "source_evidence",
    criterion: { kind: "pr_published", pr_ref: ledger.groups[0]!.parent_pr! },
  };
  const publication = ledger.facts.find((fact) => fact.kind === "pr_published")!;
  publication.status = "unknown";
  expect(atomicPredecessorsPending(ledger, plan, target!.id)).toEqual([milestoneId]);
  publication.status = "passed";
  expect(atomicPredecessorsPending(ledger, plan, target!.id)).toEqual([]);
});

test("the owner may retract completion and all descendants recheck the graph", () => {
  const ledger = modernFixture();
  ledger.contract_version = 6;
  ledger.runtime_identity = identity;
  const task = ledger.tasks[0]!;
  task.thread_id = actor.thread_id;
  task.state = "running";
  const plan = ledger.plans[0]!;
  for (const id of ["work-c", "work-b", "work-a"]) {
    const atom = { id, title: id, purpose: "Implement change", output: "Working change" };
    task.atoms.push({ id, title: id, status: "planned" });
    plan.atoms.push({ ...atom, task_id: task.id });
    plan.atomic_nodes.push({
      ...atom,
      kind: "work",
      activity_type: "contribution",
      state: "planned",
      acceptance: [],
      scope: { kind: "task", task_id: task.id, delivery_unit_id: task.group_id },
    });
  }
  for (const [from, to] of [
    ["work-a", "work-b"],
    ["work-b", "work-c"],
  ] as const)
    plan.atomic_edges.push({
      id: `${from}-to-${to}`,
      from_node_id: from,
      to_node_id: to,
      requires: { kind: "source_terminal_success" },
    });
  let sequence = 0;
  const report = (atom_id: string, state: string, reporter = actor) =>
    apply(
      ledger,
      "atom-update",
      request(ledger, `report-atom-${++sequence}`, { task_id: task.id, atom_id, state }, reporter),
    );
  expect(report("work-a", "completed")).toMatchObject({ code: "APPLIED" });
  expect(report("work-b", "completed")).toMatchObject({ code: "APPLIED" });
  expect(() => report("work-a", "planned", { ...actor, thread_id: "another-thread" })).toThrow();
  expect(report("work-a", "planned")).toMatchObject({ code: "APPLIED" });
  expect(ledger.tasks[0]!.atoms.find((item) => item.id === "work-b")?.status).toBe("completed");
  expect(() => report("work-c", "running")).toThrow(/work-b/);
  expect(() => report("work-c", "completed")).toThrow(/work-b/);
  expect(report("work-c", "blocked")).toMatchObject({ code: "APPLIED" });
  expect(report("work-a", "completed")).toMatchObject({ code: "APPLIED" });
  expect(report("work-c", "completed")).toMatchObject({ code: "APPLIED" });
});

test("an unclaimed external merge can be corrected without authorizing integration", () => {
  const ledger = modernFixture();
  const group = ledger.groups[0]!;
  const sha = "b".repeat(40);
  const provider_observation = {
    provider: "github",
    repository: "example/loomhelm",
    resource_type: "pr",
    resource_id: group.parent_pr!.id,
    pr: group.parent_pr,
    branch: group.parent_branch,
    target_branch: "main",
    state: "merged",
    base_sha: "a".repeat(40),
    head_sha: sha,
    merge_sha: sha,
    evidence_ref: "mock:merge",
  };
  const payload = { target_type: "group", target_id: group.id, provider_observation };
  const before = validateLedger(ledger);
  expect(
    apply(ledger, "merge-observe", request(ledger, "observation", payload, groupActor)),
  ).toMatchObject({ result: { status: "unclaimed", operation_id: null } });
  expect(
    apply(
      ledger,
      "merge-observe",
      request(
        ledger,
        "correction",
        {
          ...payload,
          supersedes: "observation",
          provider_observation: {
            ...provider_observation,
            evidence_ref: "mock:correction",
          },
        },
        groupActor,
      ),
    ),
  ).toMatchObject({ result: { status: "unclaimed" } });
  expect(ledger.events.filter((event) => event.data.operation === "merge-observe")).toHaveLength(2);
  expect(ledger.facts).toEqual(before.facts);
  expect(ledger.operations).toEqual(before.operations);
  expect(ledger.groups).toEqual(before.groups);
});

test("workspace readiness commits the baseline and preparation atom together", () => {
  const ledger = modernFixture();
  ledger.contract_version = 6;
  ledger.runtime_identity = identity;
  const task = ledger.tasks[0]!;
  const sha = task.base_sha!;
  task.thread_id = actor.thread_id;
  task.state = "starting";
  task.lifecycle.workspace_ready = "unknown";
  const at = "2026-01-01T00:00:00.000Z";
  ledger.operations.push({
    id: "native-dispatch",
    kind: "dispatch",
    actor_id: "main-thread",
    target_id: task.id,
    status: "succeeded",
    expected_sha: null,
    receipt_fact_id: null,
    created_at: at,
    updated_at: at,
    request: {
      native_request_id: "native-request",
      creation_parameters: { transport: "codex-exec" },
      creation_result: {
        native_evidence: {
          thread_id: actor.thread_id,
          native_request_id: "native-request",
          workspace_path: "/mock/workspace",
          initial_head: sha,
        },
      },
    },
  });
  const payload = {
    target_type: "task",
    target_id: task.id,
    stage: "workspace_ready",
    branch: task.branch,
    resource_ids: ["task-worktree", "task-branch"],
    baseline: { sha, head: sha, clean: true, source: "mock" },
    baseline_sync: {
      mode: "initial",
      dispatch_operation_id: "native-dispatch",
      expected_previous_baseline: null,
      expected_lineage_sha: sha,
      lineage_event_id: "initial",
    },
    evidence_ref: "mock:workspace",
  };
  const before = structuredClone(ledger);
  expect(() =>
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "reject",
        {
          ...payload,
          baseline_sync: { ...payload.baseline_sync, expected_lineage_sha: null },
        },
        actor,
      ),
    ),
  ).toThrow("current target lineage");
  expect(ledger).toEqual(before);
  const write = request(ledger, "workspace", payload, actor);
  expect(apply(ledger, "lifecycle-record", write)).toMatchObject({ code: "APPLIED" });
  expect(ledger.tasks[0]!.lifecycle.workspace_ready).toBe("passed");
  expect(ledger.tasks[0]!.atoms[0]!.status).toBe("completed");
  expect(
    ledger.operations.find((item) => item.id === "native-dispatch")?.request.development_baseline,
  ).toMatchObject({ sha });
  expect(apply(ledger, "lifecycle-record", write)).toMatchObject({ code: "REPLAYED" });
});
