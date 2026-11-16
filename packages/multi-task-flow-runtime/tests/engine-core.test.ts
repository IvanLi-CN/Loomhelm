import { describe, expect, test } from "bun:test";
import { apply, deliveryUnitPrMerged, ready, requireGroupDispatchGate, type Request } from "../lib/engine";
import { deriveExecutionPhase } from "../lib/revisions";
import {
  type Ledger,
  type Plan,
  type Task,
  taskExecutionPolicyIssues,
  validateLedger,
} from "../lib/schema";
import {
  at,
  base,
  head,
  merge,
  groupActor,
  main,
  approve,
  approveV2,
  fixture,
  request,
  readyAtomicFixture,
  readyBootstrapFixture,
  v2Fixture,
  providerBranchReceipt,
  providerPrReceipt,
} from "./engine-fixtures";

test("task execution policy rejects contradictory ownership and preserves legacy absence", () => {
  expect(
    taskExecutionPolicyIssues({
      execution_owner: "main",
      conversation_policy: "main_owned",
      delivery_policy: "parent_pr",
    }),
  ).toEqual([]);
  expect(
    taskExecutionPolicyIssues({
      execution_owner: "delivery_agent",
      conversation_policy: "delivery_owned",
      delivery_policy: "child_pr",
    }),
  ).toHaveLength(1);
  expect(
    taskExecutionPolicyIssues({
      execution_owner: "task_agent",
      conversation_policy: "main_owned",
      delivery_policy: "parent_pr",
    }),
  ).toHaveLength(2);
  expect(
    taskExecutionPolicyIssues({
      execution_owner: null,
      conversation_policy: null,
      delivery_policy: null,
    }),
  ).toEqual([]);
  expect(
    taskExecutionPolicyIssues({
      execution_owner: "main",
      conversation_policy: null,
      delivery_policy: null,
    })[0]?.code,
  ).toBe("TASK_EXECUTION_POLICY_INCOMPLETE");
});


test("planned delivery units cannot record running execution", () => {
  const ledger = fixture();
  ledger.groups[0]!.state = "planned";
  expect(() =>
    apply(
      ledger,
      "group-execution-update",
      request(
        ledger,
        "planned-running",
        {
          group_id: "g",
          state: "running",
          observed_at: at,
        },
        groupActor,
      ),
    ),
  ).toThrow("Only active delivery units can record runtime execution");
});

test("protected recovery is the only blocked-to-active path", () => {
  const ledger = fixture();
  approve(ledger);
  ledger.groups[0]!.state = "blocked";
  const incoming = structuredClone(ledger.groups[0]!);
  incoming.state = "active";
  expect(() =>
    apply(
      ledger,
      "group-update",
      request(ledger, "illegal-reopen", { group: incoming }, groupActor),
    ),
  ).toThrow("Group merge and closeout require verified operations");
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-recovery", {
      kind: "delivery_unit_recovery",
      target_id: "g",
      approval_id: "recovery-approved",
    }),
  );
  expect(
    apply(
      ledger,
      "group-reopen",
      request(
        ledger,
        "reopen",
        {
          group_id: "g",
          plan_id: "plan",
          recovery_id: "recovery-approved",
          reason: "provider facts reconciled",
          evidence_refs: ["evidence://recovery"],
        },
        groupActor,
      ),
    ),
  ).toMatchObject({ result: { group_id: "g", state: "active" } });
});

test("closeout reconciliation invalidates or preserves the business state explicitly", () => {
  const ledger = fixture();
  ledger.groups[0]!.state = "closed";
  ledger.events.push({
    id: "closeout-event",
    type: "group_updated",
    subject_id: "g",
    actor_id: "group-thread",
    occurred_at: at,
    recorded_at: at,
    data: { state: "closed" },
  });
  expect(
    apply(
      ledger,
      "group-closeout-reconcile",
      request(
        ledger,
        "reconcile-invalid",
        {
          group_id: "g",
          plan_id: "plan",
          closeout_event_id: "closeout-event",
          reconciliation_id: "reconcile-1",
          outcome: "invalid",
          reason: "merge evidence mismatch",
          evidence_refs: ["evidence://provider"],
          provider_observation: {
            pr: { provider: "github", repository: "example/repo", id: "1", url: null },
            provider_state: "closed",
            merge_sha: null,
            source: "github",
            observed_at: at,
            evidence_ref: "evidence://provider",
          },
        },
        groupActor,
      ),
    ),
  ).toMatchObject({ result: { outcome: "invalid", state: "blocked" } });
  expect(ledger.groups[0]!.state).toBe("blocked");
});

test("contract-3 group dispatch waits for upstream delivery-unit PR merge", () => {
  const ledger = fixture();
  ledger.contract_version = 3;
  ledger.source_schema_version = null;
  const plan = ledger.plans[0]!;
  plan.nodes.push({
    id: "upstream-node",
    kind: "milestone",
    ref_id: null,
    group_id: "upstream",
    label: "Upstream",
    estimate_minutes: 1,
    estimate_basis: "fixture",
    estimate_confidence: "high",
  });
  plan.edges.push({
    id: "upstream-a",
    from_node_id: "upstream-node",
    to_node_id: "node-a",
    requires: "completed",
  });
  expect(() => requireGroupDispatchGate(ledger, ledger.groups[0]!)).toThrow(
    "upstream delivery-unit PRs",
  );
});

test.each(["merged", "closed"] as const)("%s preserves upstream PR merge eligibility", (state) => {
  expect(
    deliveryUnitPrMerged({
      state,
      merge_sha: merge,
      lifecycle: { pr_merged: "passed" },
      pr: {
        state: "merged",
        pr: {
          provider: "github",
          repository: "example/repo",
          id: "1",
          url: "https://github.com/example/repo/pull/1",
        },
        parent_branch: "main",
        merge_sha: merge,
      },
    } as any),
  ).toBe(true);
});

test("closed upstream with a provider-closed PR is not dispatchable", () => {
  expect(
    deliveryUnitPrMerged({
      state: "closed",
      merge_sha: merge,
      lifecycle: { pr_merged: "passed" },
      pr: {
        state: "closed",
        pr: {
          provider: "github",
          repository: "example/repo",
          id: "1",
          url: "https://github.com/example/repo/pull/1",
        },
        parent_branch: "main",
      },
    } as any),
  ).toBe(false);
});

test("contract-3 group dispatch binds only the multi-task-flow codex exec transport", () => {
  const ledger = fixture();
  approve(ledger);
  ledger.groups[0]!.state = "planned";
  ledger.groups[0]!.agent_thread_id = null;
  apply(
    ledger,
    "dispatch-group-claim",
    request(ledger, "group-claim", { group_id: "g", operation_id: "group-op" }),
  );
  ledger.contract_version = 3;
  ledger.source_schema_version = null;
  expect(() =>
    apply(
      ledger,
      "dispatch-bind-request",
      request(ledger, "missing-transport", {
        operation_id: "group-op",
        native_request_id: "native-group",
      }),
    ),
  ).toThrow("codex exec transport");
});

test("contract-3 execution waits for an acknowledged formal handoff", () => {
  const ledger = fixture();
  approve(ledger);
  ledger.contract_version = 3;
  ledger.source_schema_version = null;
  expect(() =>
    apply(
      ledger,
      "group-execution-update",
      request(
        ledger,
        "group-start-without-handoff",
        {
          group_id: "g",
          state: "running",
          reason: null,
          waiting_for_task_ids: [],
        },
        groupActor,
      ),
    ),
  ).toThrow("formal handoff");
});

test("runtime observation persists the formal agent_idle task state and restores it", () => {
  const ledger = fixture();
  const task = ledger.tasks[1]!;
  task.state = "running";
  task.thread_id = "runtime-thread";
  const observe = (runtime: string, requestId: string) =>
    apply(
      ledger,
      "task-runtime-observe",
      request(ledger, requestId, {
        task_id: task.id,
        thread_id: task.thread_id,
        runtime,
        turn_id: "turn",
        observed_at: at,
      }),
    );
  observe("idle", "idle-1");
  expect(task.id).toBe(ledger.tasks[1]!.id);
  expect(ledger.tasks[1]!.state).toBe("agent_idle");
  expect(ledger.tasks[1]!.agent_resume_state).toBe("running");
  expect(validateLedger(ledger).tasks[1]!.state).toBe("agent_idle");
  observe("unknown", "unknown-1");
  expect(ledger.tasks[1]!.state).toBe("running");
  observe("idle", "idle-2");
  observe("active", "active-1");
  expect(ledger.tasks[1]!.state).toBe("running");
  ledger.tasks[1]!.state = "waiting";
  observe("idle", "waiting-idle");
  expect(ledger.tasks[1]!.state).toBe("waiting");
});

test("idle during startup still requires the first task-start fact", () => {
  const ledger = fixture();
  ledger.tasks[1]!.state = "starting";
  ledger.tasks[1]!.thread_id = "runtime-thread";
  apply(
    ledger,
    "task-runtime-observe",
    request(ledger, "startup-idle", {
      turn_id: "startup-turn",
      task_id: "b",
      thread_id: "runtime-thread",
      runtime: "idle",
      observed_at: at,
    }),
  );
  expect(ledger.tasks[1]!.agent_resume_state).toBe("starting");
  apply(
    ledger,
    "task-update",
    request(
      ledger,
      "startup-running",
      { task_id: "b", state: "running", occurred_at: at },
      { role: "task", thread_id: "runtime-thread" },
    ),
  );
  expect(ledger.tasks[1]!.started_at).toBe(at);
  expect(ledger.events.at(-1)?.type).toBe("task_started");
  expect(ledger.tasks[1]!.agent_resume_state).toBeUndefined();
});

test("bound main conversation can record a main-owned task and its atom", () => {
  const ledger = fixture();
  ledger.plans[0]!.lifecycle = "approved";
  ledger.plans[0]!.approval_id = "approved";
  ledger.control.approval_id = "approved";
  ledger.plans[0]!.atoms = [
    { id: "atom-a", title: "a", task_id: "a", purpose: "fixture task", output: "fixture output" },
  ];
  const task = ledger.tasks[0]!;
  task.execution_owner = "main";
  task.conversation_policy = "main_owned";
  task.delivery_policy = "parent_pr";
  task.atoms = [{ id: "atom-a", title: "a", status: "planned" }];
  apply(
    ledger,
    "task-update",
    request(ledger, "main-start", { task_id: task.id, state: "running", occurred_at: at }, main),
  );
  expect(ledger.tasks[0]!.state).toBe("running");
  expect(ledger.tasks[0]!.started_at).toBe(at);
  apply(
    ledger,
    "atom-update",
    request(
      ledger,
      "main-atom-start",
      { task_id: task.id, atom_id: "atom-a", state: "running" },
      main,
    ),
  );
  apply(
    ledger,
    "atom-update",
    request(ledger, "main-atom", { task_id: task.id, atom_id: "atom-a", state: "completed" }, main),
  );
  expect(ledger.tasks[0]!.atoms[0]!.status).toBe("completed");
  expect(ledger.events.at(-1)?.type).toBe("atom_updated");
});

test("terminal task creates a pending conversation archive resource", () => {
  const ledger = fixture();
  const task = ledger.tasks[1]!;
  task.kind = "verification";
  task.thread_id = "task-b-thread";
  task.state = "running";
  apply(
    ledger,
    "task-update",
    request(
      ledger,
      "complete-b",
      {
        task_id: task.id,
        state: "completed",
        evidence: "verification complete",
        occurred_at: at,
      },
      { role: "task", thread_id: task.thread_id },
    ),
  );
  expect(ledger.resources).toContainEqual(
    expect.objectContaining({ kind: "conversation", target: "task-b-thread", status: "pending" }),
  );
});


test("task readiness starts at the first executable atomic work", () => {
  const ledger = readyAtomicFixture();

  expect(ready(ledger, "a")).toBe(true);
  ledger.tasks[0]!.atoms[0]!.status = "running";
  expect(ready(ledger, "a")).toBe(false);
  ledger.tasks[0]!.atoms[0]!.status = "blocked";
  expect(ready(ledger, "a")).toBe(false);

  const missingAtom = readyAtomicFixture();
  missingAtom.tasks[0]!.atoms = missingAtom.tasks[0]!.atoms.slice(1);
  expect(ready(missingAtom, "a")).toBe(false);

  const missingEdges = readyAtomicFixture();
  missingEdges.plans[0]!.atomic_edges = [];
  expect(ready(missingEdges, "a")).toBe(false);

  const missingLaterAtom = readyAtomicFixture();
  missingLaterAtom.tasks[0]!.atoms = missingLaterAtom.tasks[0]!.atoms.slice(0, -1);
  expect(ready(missingLaterAtom, "a")).toBe(false);

  const partialEdges = readyAtomicFixture();
  partialEdges.plans[0]!.atomic_edges = partialEdges.plans[0]!.atomic_edges.slice(1);
  expect(ready(partialEdges, "a")).toBe(false);

  const conflictingState = readyAtomicFixture();
  conflictingState.plans[0]!.atomic_nodes.find(
    (node) => node.id === "task-a-prepare-branch",
  )!.state = "completed";
  expect(ready(conflictingState, "a")).toBe(false);

  const missingCanonicalNode = readyAtomicFixture();
  missingCanonicalNode.plans[0]!.atomic_nodes = missingCanonicalNode.plans[0]!.atomic_nodes.filter(
    (node) => node.id !== "task-a-prepare-branch",
  );
  expect(ready(missingCanonicalNode, "a")).toBe(false);

  const missingCanonicalTargets = readyAtomicFixture();
  missingCanonicalTargets.plans[0]!.atomic_nodes =
    missingCanonicalTargets.plans[0]!.atomic_nodes.filter(
      (node) => node.scope?.kind !== "task" || node.scope.task_id !== "a",
    );
  expect(ready(missingCanonicalTargets, "a")).toBe(false);

  const missingCanonicalGraph = readyAtomicFixture();
  missingCanonicalGraph.contract_version = 3;
  missingCanonicalGraph.plans[0]!.atomic_nodes = [];
  missingCanonicalGraph.plans[0]!.atomic_edges = [];
  expect(ready(missingCanonicalGraph, "a")).toBe(false);

  const danglingEdge = readyAtomicFixture();
  danglingEdge.plans[0]!.atomic_edges[0]!.from_node_id = "missing-node";
  expect(ready(danglingEdge, "a")).toBe(false);

  const recoverable = readyAtomicFixture();
  recoverable.tasks[0]!.state = "blocked";
  recoverable.tasks[0]!.atoms[0]!.status = "blocked";
  recoverable.plans[0]!.atomic_nodes.find((node) => node.id === "task-a-prepare-branch")!.state =
    "blocked";
  expect(ready(recoverable, "a")).toBe(true);

  ledger.tasks[0]!.atoms[0]!.status = "planned";
  ledger.tasks[0]!.thread_id = "task-a-thread";
  ledger.tasks[0]!.state = "running";
  expect(() =>
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        "blocked-later-atom",
        {
          task_id: "a",
          atom_id: "task-a-create-pr",
          state: "running",
        },
        { role: "task", thread_id: "task-a-thread" },
      ),
    ),
  ).toThrow("Earlier atoms must complete first");
});

test("contribution dispatch is blocked until the parent PR gate is complete", () => {
  const ledger = v2Fixture();
  approveV2(ledger);
  ledger.groups[0].atoms = [
    {
      id: "workspace",
      title: "Prepare parent",
      purpose: "Prepare",
      output: "Ready",
      lifecycle_stage: "workspace_ready",
      status: "planned",
    },
    {
      id: "parent-pr",
      title: "Create parent PR",
      purpose: "Publish",
      output: "Created",
      lifecycle_stage: "pr_created",
      status: "planned",
    },
  ];
  ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({
    ...atom,
    group_id: "g",
  }));
  expect(() =>
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "blocked-before-parent-pr", {
        task_id: "a",
        operation_id: "dispatch-before-parent-pr",
      }),
    ),
  ).toThrow("parent PR is created and verified");
  try {
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "blocked-before-parent-pr-details", {
        task_id: "a",
        operation_id: "dispatch-before-parent-pr-details",
      }),
    );
  } catch (error) {
    expect((error as any).code).toBe("DELIVERY_GATE_PENDING");
    expect((error as any).details.missing).toEqual(["workspace_ready", "parent_pr"]);
    expect((error as any).details.recovery).toContain("retry dispatch-claim");
  }
  ledger.tasks[0].thread_id = "task-a-thread";
  ledger.tasks[0].state = "starting";
  expect(() =>
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "blocked-task-start",
        {
          task_id: "a",
          state: "running",
          occurred_at: at,
        },
        { role: "task", thread_id: "task-a-thread" },
      ),
    ),
  ).toThrow("parent PR is created and verified");
  try {
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "blocked-task-start-details",
        {
          task_id: "a",
          state: "running",
          occurred_at: at,
        },
        { role: "task", thread_id: "task-a-thread" },
      ),
    );
  } catch (error) {
    expect((error as any).details.recovery).toContain("retry task-update");
  }
});

test("dispatch-claim recovery names its caller when only workspace readiness is missing", () => {
  const ledger = v2Fixture();
  approveV2(ledger);
  ledger.groups[0].atoms = [
    {
      id: "workspace",
      title: "Prepare parent",
      purpose: "Prepare",
      output: "Ready",
      lifecycle_stage: "workspace_ready",
      status: "planned",
    },
    {
      id: "parent-pr",
      title: "Create parent PR",
      purpose: "Publish",
      output: "Created",
      lifecycle_stage: "pr_created",
      status: "completed",
    },
  ];
  ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({
    ...atom,
    group_id: "g",
  }));
  ledger.groups[0].lifecycle.pr_created = "passed";
  const parentPr = providerPrReceipt("parent-pr", "parent", base, base);
  ledger.groups[0].parent_pr = parentPr.pr;
  ledger.facts.push({
    id: "parent-branch-fact",
    kind: "branch_published",
    subject_id: "g",
    status: "passed",
    source: "github",
    observed_at: at,
    sha: base,
    evidence_ref: "provider:parent",
    receipt: providerBranchReceipt("parent", base),
  });
  ledger.facts.push({
    id: "parent-pr-fact",
    kind: "pr_published",
    subject_id: "g",
    status: "passed",
    source: "github",
    observed_at: at,
    sha: base,
    evidence_ref: "provider:parent-pr",
    receipt: parentPr,
  });

  let dispatchError: any;
  try {
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "workspace-only-dispatch", {
        task_id: "a",
        operation_id: "workspace-only-dispatch-op",
      }),
    );
  } catch (error) {
    dispatchError = error;
    expect((error as any).details.missing).toEqual(["workspace_ready"]);
    expect((error as any).details.recovery).toContain("retry dispatch-claim");
    expect((error as any).details.recovery).not.toContain("retry task-update");
  }
  expect(dispatchError).toBeDefined();
});

test("main-owned bootstrap contributions can start before the parent PR exists", () => {
  const ledger = v2Fixture();
  ledger.groups[0].delivery_unit_kind = "bootstrap";
  ledger.groups[0].owner_kind = "main";
  ledger.groups[0].agent_thread_id = null;
  ledger.groups[0].atoms = [
    {
      id: "workspace",
      title: "Prepare parent",
      purpose: "Prepare",
      output: "Ready",
      lifecycle_stage: "workspace_ready",
      status: "planned",
    },
  ];
  ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({
    ...atom,
    group_id: "g",
  }));
  const task = ledger.tasks[0];
  task.execution_owner = "main";
  task.conversation_policy = "main_owned";
  task.delivery_policy = "parent_pr";
  task.atoms = [{ id: "atom-a", title: "a", status: "planned" }];
  approveV2(ledger);
  ledger.facts.push({
    id: "bootstrap-parent-pr-absent",
    kind: "pr_published",
    subject_id: "g",
    status: "failed",
    source: "github",
    observed_at: at,
    sha: null,
    evidence_ref: "provider:bootstrap-parent-pr-absent",
    receipt: {
      provider: "github",
      repository: "example/repo",
      resource_type: "pr",
      resource_id: "parent-pr",
      branch: "parent",
      target_branch: "main",
      base_sha: null,
      head_sha: null,
      pr: null,
      state: "absent",
      evidence_ref: "provider:bootstrap-parent-pr-absent",
    },
  });

  let bootstrapWorkspaceError: any;
  try {
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "bootstrap-main-before-workspace",
        {
          task_id: task.id,
          state: "running",
          occurred_at: at,
        },
        main,
      ),
    );
  } catch (error) {
    bootstrapWorkspaceError = error;
    expect((error as any).message).toContain("delivery-unit workspace is ready");
    expect((error as any).details.missing).toEqual(["workspace_ready"]);
    expect((error as any).details.recovery).toContain("retry task-update");
  }
  expect(bootstrapWorkspaceError).toBeDefined();

  ledger.groups[0].lifecycle.workspace_ready = "passed";
  ledger.groups[0].atoms[0].status = "completed";
  ledger.events.push({
    id: "bootstrap-workspace-recorded",
    type: "lifecycle_recorded",
    subject_id: "g",
    actor_id: "main-thread",
    occurred_at: at,
    recorded_at: at,
    data: { target_type: "group", stage: "workspace_ready", evidence_ref: "workspace" },
  });

  ledger.groups[0].state = "planned";
  expect(() =>
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "bootstrap-planned-group",
        {
          task_id: task.id,
          state: "running",
          occurred_at: at,
        },
        main,
      ),
    ),
  ).toThrow("Task group is not active");
  ledger.groups[0].state = "active";

  apply(
    ledger,
    "task-update",
    request(
      ledger,
      "bootstrap-main-start",
      {
        task_id: task.id,
        state: "running",
        occurred_at: at,
      },
      main,
    ),
  );

  expect(ledger.tasks[0].state).toBe("running");
  expect(ledger.tasks[0].started_at).toBe(at);
  expect(ledger.events.at(-1)?.type).toBe("task_started");
  expect(deriveExecutionPhase(ledger)).toBe("implementation");
  const proposed = structuredClone(ledger.plans[0]);
  proposed.id = "bootstrap-revision";
  proposed.supersedes_id = ledger.execution_plan_id;
  proposed.approval_id = null;
  proposed.lifecycle = "proposed";
  proposed.revision = null;
  proposed.actions = proposed.actions.map((action: any) => ({
    ...action,
    target: action.group_id
      ? { type: "group", id: action.group_id }
      : { type: "task", id: action.task_id },
  }));
  const revisedTasks = structuredClone(ledger.tasks);
  revisedTasks[0].owned_surfaces = ["src/changed-after-start"];
  let migrationError: any;
  try {
    apply(
      ledger,
      "plan-propose",
      request(
        ledger,
        "bootstrap-boundary-change",
        {
          plan: proposed,
          groups: structuredClone(ledger.groups),
          tasks: revisedTasks,
          revision: {
            reason: {
              category: "owner_direction",
              summary: "Update the implementation boundary after direct bootstrap start.",
              evidence_refs: ["evidence://bootstrap-start"],
              impact: "The started task requires explicit migration if its owned surface changes.",
            },
          },
        },
        main,
      ),
    );
  } catch (error) {
    migrationError = error;
  }
  expect(migrationError?.code).toBe("TASK_MIGRATION_REQUIRED");
  expect(ledger.groups[0].parent_pr).toBeNull();
});

test("bootstrap parent PR bypass requires explicit absence evidence", () => {
  const ledger = readyBootstrapFixture();
  const task = ledger.tasks[0];
  task.execution_owner = "main";
  task.conversation_policy = "main_owned";
  task.delivery_policy = "parent_pr";
  expect(() =>
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "bootstrap-without-absence",
        {
          task_id: task.id,
          state: "running",
          occurred_at: at,
        },
        main,
      ),
    ),
  ).toThrow("parent PR is created and verified");
});

test("bootstrap parent PR bypass fails closed for uncertain publication and retained paths", () => {
  for (const uncertainty of ["operation", "fact"] as const) {
    const ledger = readyBootstrapFixture();
    const task = ledger.tasks[0];
    task.execution_owner = "main";
    task.conversation_policy = "main_owned";
    task.delivery_policy = "parent_pr";
    if (uncertainty === "operation") {
      ledger.operations.push({
        id: "pending-parent-pr",
        kind: "publish_pr",
        actor_id: "main-thread",
        target_id: "g",
        status: "unknown",
        request: { target_type: "group" },
        expected_sha: null,
        receipt_fact_id: null,
        created_at: at,
        updated_at: at,
      });
    } else {
      ledger.facts.push({
        id: "unknown-parent-pr",
        kind: "pr_published",
        subject_id: "g",
        status: "unknown",
        source: "github",
        observed_at: at,
        sha: null,
        evidence_ref: "provider:unknown-parent-pr",
        receipt: null,
      });
    }
    expect(() =>
      apply(
        ledger,
        "task-update",
        request(
          ledger,
          `bootstrap-uncertain-${uncertainty}`,
          {
            task_id: task.id,
            state: "running",
            occurred_at: at,
          },
          main,
        ),
      ),
    ).toThrow("parent PR is created and verified");
    expect(ledger.tasks[0].state).toBe("planned");
  }
});

test("regular and Task Agent bootstrap paths retain the parent PR gate after workspace readiness", () => {
  const regular = readyBootstrapFixture();
  regular.groups[0].delivery_unit_kind = "regular";
  regular.groups[0].owner_kind = "group";
  regular.groups[0].agent_thread_id = "group-thread";
  regular.tasks[0].execution_owner = "main";
  regular.tasks[0].conversation_policy = "main_owned";
  regular.tasks[0].delivery_policy = "parent_pr";
  expect(() =>
    apply(
      regular,
      "task-update",
      request(
        regular,
        "regular-main-without-parent",
        {
          task_id: "a",
          state: "running",
          occurred_at: at,
        },
        main,
      ),
    ),
  ).toThrow("parent PR is created and verified");
  expect(regular.tasks[0].state).toBe("planned");

  const taskAgent = readyBootstrapFixture();
  taskAgent.tasks[0].execution_owner = "task_agent";
  taskAgent.tasks[0].conversation_policy = "task_agent";
  taskAgent.tasks[0].delivery_policy = "child_pr";
  taskAgent.tasks[0].thread_id = "task-a-thread";
  taskAgent.tasks[0].state = "starting";
  expect(() =>
    apply(
      taskAgent,
      "task-update",
      request(
        taskAgent,
        "bootstrap-task-agent-without-parent",
        {
          task_id: "a",
          state: "running",
          occurred_at: at,
        },
        { role: "task", thread_id: "task-a-thread" },
      ),
    ),
  ).toThrow("parent PR is created and verified");
  expect(taskAgent.tasks[0].state).toBe("starting");
});

test("bootstrap dispatch-claim remains blocked for Task Agent work without a parent PR", () => {
  const ledger = readyBootstrapFixture();
  ledger.tasks[0].execution_owner = "task_agent";
  ledger.tasks[0].conversation_policy = "task_agent";
  ledger.tasks[0].delivery_policy = "child_pr";
  expect(() =>
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "bootstrap-dispatch-without-parent", {
        task_id: "a",
        operation_id: "bootstrap-dispatch-without-parent-op",
      }),
    ),
  ).toThrow("parent PR is created and verified");
  expect(ledger.operations).toHaveLength(0);
});

test("closed parent PRs do not satisfy the retained contribution gate", () => {
  const ledger = readyBootstrapFixture();
  ledger.groups[0].delivery_unit_kind = "regular";
  ledger.groups[0].owner_kind = "group";
  ledger.groups[0].agent_thread_id = "group-thread";
  ledger.groups[0].parent_pr = providerPrReceipt("closed-parent", "parent", base, base).pr;
  ledger.groups[0].lifecycle.pr_created = "passed";
  ledger.groups[0].atoms.push({
    id: "parent-pr",
    title: "Create parent PR",
    purpose: "Publish",
    output: "Created",
    lifecycle_stage: "pr_created",
    status: "completed",
  });
  ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({
    ...atom,
    group_id: "g",
  }));
  ledger.facts.push({
    id: "closed-parent-pr",
    kind: "pr_published",
    subject_id: "g",
    status: "passed",
    source: "github",
    observed_at: at,
    sha: base,
    evidence_ref: "provider:closed-parent-pr",
    receipt: { ...providerPrReceipt("closed-parent", "parent", base, base), state: "absent" },
  });
  ledger.tasks[0].execution_owner = "task_agent";
  ledger.tasks[0].conversation_policy = "task_agent";
  ledger.tasks[0].delivery_policy = "child_pr";
  ledger.tasks[0].thread_id = "task-a-thread";
  ledger.tasks[0].state = "starting";
  expect(() =>
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "closed-parent-blocked",
        {
          task_id: "a",
          state: "running",
          occurred_at: at,
        },
        { role: "task", thread_id: "task-a-thread" },
      ),
    ),
  ).toThrow("parent PR is created and verified");
  expect(ledger.tasks[0].state).toBe("starting");
});

test("contract-3 regular dispatch uses the repository target branch and current delivery-unit SHA", () => {
  const readyLedger = () => {
    const ledger = v2Fixture();
    ledger.contract_version = 3;
    ledger.source_schema_version = null;
    ledger.tasks.forEach((task) => {
      task.execution_owner = "task_agent";
      task.conversation_policy = "task_agent";
      task.delivery_policy = "child_pr";
    });
    approveV2(ledger);

    const owner = ledger.groups[0]!;
    owner.delivery_unit_kind = "regular";
    owner.owner_kind = "group";
    owner.agent_thread_id = "group-thread";
    owner.state = "active";
    owner.lifecycle.workspace_ready = "passed";
    owner.lifecycle.pr_created = "passed";
    owner.atoms = [
      {
        id: "workspace",
        title: "Prepare parent",
        purpose: "Prepare",
        output: "Ready",
        lifecycle_stage: "workspace_ready",
        status: "completed",
      },
      {
        id: "parent-pr",
        title: "Create parent PR",
        purpose: "Publish",
        output: "Created",
        lifecycle_stage: "pr_created",
        status: "completed",
      },
    ];
    ledger.plans[0]!.group_atoms = owner.atoms.map(({ status, ...atom }) => ({
      ...atom,
      group_id: owner.id,
    }));
    ledger.events.push(
      {
        id: "parent-workspace-event",
        type: "lifecycle_recorded",
        subject_id: owner.id,
        actor_id: owner.agent_thread_id,
        occurred_at: at,
        recorded_at: at,
        data: {
          target_type: "group",
          stage: "workspace_ready",
          evidence_ref: "provider:workspace",
        },
      },
      {
        id: "parent-pr-lifecycle-event",
        type: "lifecycle_recorded",
        subject_id: owner.id,
        actor_id: owner.agent_thread_id,
        occurred_at: at,
        recorded_at: at,
        data: { target_type: "group", stage: "pr_created", evidence_ref: "provider:parent-pr" },
      },
    );

    const parentPr = providerPrReceipt(
      "parent-pr",
      owner.parent_branch!,
      owner.current_sha!,
      owner.current_sha!,
    );
    expect(owner.parent_branch).not.toBe(ledger.repository.target_branch);
    expect(parentPr.target_branch).toBe(ledger.repository.target_branch);
    expect(parentPr.head_sha).toBe(owner.current_sha);
    owner.pr = {
      state: "published",
      pr: parentPr.pr,
      parent_branch: owner.parent_branch!,
    };
    ledger.facts.push(
      {
        id: "parent-branch-fact",
        kind: "branch_published",
        subject_id: owner.id,
        status: "passed",
        source: "github",
        observed_at: at,
        sha: owner.current_sha,
        evidence_ref: "provider:parent-branch",
        receipt: providerBranchReceipt(owner.parent_branch!, owner.current_sha!),
      },
      {
        id: "parent-pr-fact",
        kind: "pr_published",
        subject_id: owner.id,
        status: "passed",
        source: "github",
        observed_at: at,
        sha: owner.current_sha,
        evidence_ref: "provider:parent-pr",
        receipt: parentPr,
      },
    );
    ledger.operations.push({
      id: "group-dispatch",
      kind: "dispatch",
      actor_id: main.thread_id,
      target_id: owner.id,
      status: "succeeded",
      request: { target_type: "group", handoff_notification_id: "group-handoff" },
      expected_sha: null,
      receipt_fact_id: null,
      created_at: at,
      updated_at: at,
    });
    ledger.notifications.push({
      id: "group-handoff",
      event_id: "group-dispatch-event",
      recipient_thread_id: owner.agent_thread_id,
      ledger_status: "committed",
      status: "acknowledged",
      delivery_status: "sent",
      ack_status: "acknowledged",
      attempts: 1,
      last_attempt_id: "group-handoff-attempt",
      last_reconciliation_id: null,
      last_error: null,
      updated_at: at,
    });
    return ledger;
  };

  const ledger = readyLedger();
  expect(
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "regular-dispatch", {
        task_id: "a",
        operation_id: "regular-dispatch-op",
      }),
    ),
  ).toMatchObject({ result: { operation_id: "regular-dispatch-op" } });

  const staleHead = readyLedger();
  const parentPrFact = staleHead.facts.find((fact) => fact.id === "parent-pr-fact")!;
  parentPrFact.receipt!.head_sha = head;
  expect(() =>
    apply(
      staleHead,
      "dispatch-claim",
      request(staleHead, "stale-parent-head", {
        task_id: "a",
        operation_id: "stale-parent-head-op",
      }),
    ),
  ).toThrow("parent PR is created and verified");
  try {
    apply(
      staleHead,
      "dispatch-claim",
      request(staleHead, "stale-parent-head-details", {
        task_id: "a",
        operation_id: "stale-parent-head-details-op",
      }),
    );
  } catch (error) {
    expect((error as any).code).toBe("DELIVERY_GATE_PENDING");
    expect((error as any).details.missing).toEqual(["parent_pr"]);
  }
});


