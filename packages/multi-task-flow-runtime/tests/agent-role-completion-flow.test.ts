import { expect, test } from "bun:test";
import { canonicalizeContract3Plan } from "../lib/atomic-orchestration";
import { createCliThread, initializationPrompt } from "../lib/codex-cli-create";
import { apply, authorize, type Request } from "../lib/engine";
import {
  defaultGroupAtoms,
  defaultTaskAtoms,
  deliveryTopologyForGroup,
  type Ledger,
  type Task,
  validateDeliveryTopologies,
  validateLedger,
} from "../lib/schema";

const at = "2026-01-01T00:00:00.000Z";
const base = "a".repeat(40);
const main = { role: "main", thread_id: "main-thread" } as const;

function fixture(options: { bootstrap?: boolean } = {}): Ledger {
  const group = {
    id: "group-a",
    title: "交付单元 A",
    delivery_unit_kind: options.bootstrap ? "bootstrap" : "regular",
    owner_kind: options.bootstrap ? "main" : "group",
    agent_thread_id: options.bootstrap ? null : "delivery-thread",
    state: options.bootstrap ? "planned" : "active",
    parent_branch: "orchestration/a",
    parent_pr: null,
    cut_sha: null,
    current_sha: base,
    merge_sha: null,
    requirements_path: null,
  };
  const tasks = ["task-a", "task-b", "task-c"].map((id) => ({
    id,
    title: id,
    kind: "contribution",
    group_id: "group-a",
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
  return validateLedger({
    schema_version: 1,
    orchestration_id: "role-flow-run",
    revision: 0,
    repository: {
      provider: "github",
      host: "github.com",
      owner: "example",
      name: "loomhelm",
      target_branch: "main",
    },
    control: { owner_thread_id: main.thread_id, ownership: "bound", approval_id: "approved" },
    config: {
      execution_profile: { model: "gpt-6.1-sol", thinking: "medium" },
      max_running_tasks: 3,
      display_timezone: "Asia/Shanghai",
    },
    plans: [
      {
        id: "plan",
        supersedes_id: null,
        approval_id: "approved",
        created_at: at,
        start_at: at,
        atoms: [],
        atomic_edges: [],
        nodes: [
          {
            id: "node-a",
            kind: "task",
            ref_id: "task-a",
            group_id: "group-a",
            label: "task-a",
            estimate_minutes: null,
            estimate_basis: null,
            estimate_confidence: null,
          },
          {
            id: "node-b",
            kind: "task",
            ref_id: "task-b",
            group_id: "group-a",
            label: "task-b",
            estimate_minutes: null,
            estimate_basis: null,
            estimate_confidence: null,
          },
          {
            id: "node-c",
            kind: "task",
            ref_id: "task-c",
            group_id: "group-a",
            label: "task-c",
            estimate_minutes: null,
            estimate_basis: null,
            estimate_confidence: null,
          },
        ],
        edges: [
          { id: "a-c", from_node_id: "node-a", to_node_id: "node-c", requires: "integrated" },
        ],
        cut_rules: [],
        actions: [],
      },
    ],
    active_plan_id: "plan",
    groups: [group],
    tasks,
    follow_prs: [],
    facts: [],
    operations: [],
    events: [
      {
        id: "plan-approved",
        type: "plan_approved",
        subject_id: "plan",
        actor_id: main.thread_id,
        occurred_at: at,
        recorded_at: at,
        data: { approval_id: "approved", authorized_actions: ["dispatch"] },
      },
    ],
    requests: [],
    notifications: [],
    resources: [],
    updated_at: at,
  });
}

function request(
  ledger: Ledger,
  request_id: string,
  payload: Record<string, unknown>,
  actor: Request["actor"] = main,
): Request {
  return {
    run_id: ledger.orchestration_id,
    actor,
    request_id,
    expected_revision: ledger.revision,
    payload,
  };
}

function modernFixture(): Ledger {
  const ledger = fixture();
  const plan = ledger.plans[0];
  const group = ledger.groups[0];
  if (!plan || !group) throw new Error("fixture plan or group missing");
  ledger.schema_version = 2;
  ledger.source_schema_version = null;
  ledger.contract_version = 3;
  ledger.execution_plan_id = plan.id;
  plan.lifecycle = "approved";
  const approval = ledger.events.find((event) => event.type === "plan_approved");
  if (approval) approval.data.authorized_actions = ["dispatch", "publish_branch", "publish_pr"];
  plan.actions = [
    {
      id: "publish-group-branch",
      kind: "publish_branch",
      task_id: null,
      group_id: group.id,
      target_identity: "branch:orchestration/a",
    },
    {
      id: "publish-group-pr",
      kind: "publish_pr",
      task_id: null,
      group_id: group.id,
      target_identity: "pr:100",
    },
    ...ledger.tasks.flatMap((task) => [
      {
        id: `publish-${task.id}-branch`,
        kind: "publish_branch" as const,
        task_id: task.id,
        group_id: null,
        target_identity: `branch:${task.id}`,
      },
      {
        id: `publish-${task.id}-pr`,
        kind: "publish_pr" as const,
        task_id: task.id,
        group_id: null,
        target_identity: `pr:${task.id}`,
      },
    ]),
  ];
  for (const node of plan.nodes) {
    node.estimate_minutes = 1;
    node.estimate_basis = "mock completion flow";
    node.estimate_confidence = "high";
  }
  group.atoms = defaultGroupAtoms(group.id).map((atom, index) => ({
    ...atom,
    status: index < 2 ? ("completed" as const) : ("planned" as const),
  }));
  group.lifecycle.workspace_ready = "passed";
  group.lifecycle.pr_created = "passed";
  group.coordination_execution = { state: "running", reason: null, waiting_for_task_ids: [] };
  const parentPr = {
    provider: "github",
    repository: "example/loomhelm",
    id: "100",
    url: "https://github.com/example/loomhelm/pull/100",
  };
  group.parent_pr = parentPr;
  group.pr = {
    state: "published",
    pr: parentPr,
    parent_branch: group.parent_branch ?? "orchestration/a",
  };
  plan.group_atoms = group.atoms.map(({ status: _status, ...atom }) => ({
    ...atom,
    group_id: group.id,
  }));
  for (const task of ledger.tasks) {
    task.execution_owner = "task_agent";
    task.conversation_policy = "task_agent";
    task.delivery_policy = "child_pr";
    task.atoms = defaultTaskAtoms(task.id);
    task.lifecycle.workspace_ready = "passed";
    task.branch = task.id;
  }
  plan.atoms = ledger.tasks.flatMap((task) =>
    task.atoms.map((atom) => ({
      id: atom.id,
      title: atom.title,
      task_id: task.id,
      purpose: "mock task atom",
      output: "mock task output",
    })),
  );
  const groupEdges = group.atoms.slice(1).map((atom, index) => ({
    id: `group-edge-${index}`,
    from_atom_id: group.atoms[index]?.id ?? "missing",
    to_atom_id: atom.id,
  }));
  const taskEdges = ledger.tasks.flatMap((task) =>
    task.atoms.slice(1).map((atom, index) => ({
      id: `${task.id}-edge-${index}`,
      from_atom_id: task.atoms[index]?.id ?? "missing",
      to_atom_id: atom.id,
    })),
  );
  plan.atomic_edges = [...groupEdges, ...taskEdges];
  ledger.plans[0] = canonicalizeContract3Plan(plan, ledger.tasks);
  ledger.resources.push(
    {
      id: "group-worktree",
      kind: "worktree",
      target: group.id,
      status: "active",
      evidence_ref: "mock",
    },
    {
      id: "group-branch",
      kind: "branch",
      target: group.parent_branch,
      status: "active",
      evidence_ref: "mock",
    },
    {
      id: "task-worktree",
      kind: "worktree",
      target: "task-a",
      status: "active",
      evidence_ref: "mock",
    },
    { id: "task-branch", kind: "branch", target: "task-a", status: "active", evidence_ref: "mock" },
  );
  const branchReceipt = {
    provider: "github",
    repository: "example/loomhelm",
    resource_type: "branch" as const,
    resource_id: group.parent_branch ?? "orchestration/a",
    branch: group.parent_branch ?? "orchestration/a",
    target_branch: null,
    base_sha: null,
    head_sha: base,
    pr: null,
    state: "exists" as const,
    evidence_ref: "mock:branch",
  };
  const prReceipt = {
    provider: "github",
    repository: "example/loomhelm",
    resource_type: "pr" as const,
    resource_id: parentPr.id,
    branch: group.parent_branch ?? "orchestration/a",
    target_branch: "main",
    base_sha: null,
    head_sha: base,
    pr: parentPr,
    state: "open" as const,
    evidence_ref: "mock:pr",
  };
  ledger.facts.push(
    {
      id: "group-branch-published",
      kind: "branch_published",
      subject_id: group.id,
      status: "passed",
      source: "mock",
      observed_at: at,
      sha: base,
      evidence_ref: "mock:branch",
      receipt: branchReceipt,
    },
    {
      id: "group-pr-published",
      kind: "pr_published",
      subject_id: group.id,
      status: "passed",
      source: "mock",
      observed_at: at,
      sha: base,
      evidence_ref: "mock:pr",
      receipt: prReceipt,
    },
  );
  ledger.operations.push({
    id: "group-dispatch",
    kind: "dispatch",
    actor_id: main.thread_id,
    target_id: group.id,
    status: "succeeded",
    request: { target_type: "group", handoff_notification_id: "group-handoff" },
    expected_sha: null,
    receipt_fact_id: null,
    created_at: at,
    updated_at: at,
  });
  ledger.notifications.push({
    id: "group-handoff",
    event_id: "group-handoff-event",
    recipient_thread_id: group.agent_thread_id ?? "delivery-thread",
    ledger_status: "committed",
    status: "acknowledged",
    delivery_status: "sent",
    ack_status: "acknowledged",
    attempts: 1,
    last_attempt_id: "group-handoff-attempt",
    last_reconciliation_id: "group-handoff-reconcile",
    last_error: null,
    updated_at: at,
  });
  ledger.events.push({
    id: "group-handoff-event",
    type: "notification_acknowledged",
    subject_id: group.id,
    actor_id: group.agent_thread_id ?? "delivery-thread",
    occurred_at: at,
    recorded_at: at,
    data: { notification_id: "group-handoff" },
  });
  ledger.events.push(
    {
      id: "group-workspace-recorded",
      type: "lifecycle_recorded",
      subject_id: group.id,
      actor_id: group.agent_thread_id ?? "delivery-thread",
      occurred_at: at,
      recorded_at: at,
      data: { target_type: "group", stage: "workspace_ready", evidence_ref: "mock:workspace" },
    },
    ...ledger.tasks.map((task) => ({
      id: `${task.id}-workspace-recorded`,
      type: "lifecycle_recorded" as const,
      subject_id: task.id,
      actor_id: main.thread_id,
      occurred_at: at,
      recorded_at: at,
      data: { target_type: "task", stage: "workspace_ready", evidence_ref: "mock:workspace" },
    })),
  );
  return ledger;
}

test("mock Codex handshakes preserve Delivery Agent and Task Agent roles", async () => {
  const calls: Array<{ role: string; prompt: string }> = [];
  for (const role of ["Delivery Agent", "Task Agent"] as const) {
    const result = await createCliThread(
      {
        title: `${role} fixture`,
        prompt: "formal handoff follows",
        cwd: "/repo",
        model: "gpt-6.1-sol",
        thinking: "medium",
        role,
      },
      {
        run: async (input) => {
          const inputRole = input.role ?? role;
          calls.push({ role: inputRole, prompt: initializationPrompt(inputRole) });
          return {
            thread_id: `${role === "Delivery Agent" ? "delivery" : "task"}-thread`,
            exit_code: 0,
            turn_completed: true,
            events: ["thread.started", "turn.completed"],
          };
        },
        read: async (threadId) => ({
          thread: {
            id: threadId,
            cwd: "/repo/worktree",
            model: "gpt-6.1-sol",
            reasoningEffort: "medium",
          },
          turn: {
            id: `${threadId}-turn`,
            status: "completed",
            items: [
              { type: "user_message", text: initializationPrompt(role) },
              { type: "agent_message", text: "已进入待命状态。" },
            ],
          },
        }),
        verify: () => base,
      },
    );
    expect(result).toMatchObject({ outcome: "succeeded", thread_id: expect.any(String) });
  }
  expect(calls.map((call) => call.role)).toEqual(["Delivery Agent", "Task Agent"]);
  expect(calls[0]?.prompt).toContain("Delivery Agent");
  expect(calls[1]?.prompt).toContain("Task Agent");
});

test("mock completion flow uses CLI evidence, revision fencing and reconcile-first recovery", () => {
  const ledger = fixture();
  const task = ledger.tasks[0];
  if (!task) throw new Error("fixture task missing");

  expect(() => authorize(ledger, { role: "main", thread_id: "foreign-main" })).toThrow(
    "Main conversation does not own",
  );
  expect(() => authorize(ledger, { role: "group", thread_id: "foreign-delivery" })).toThrow(
    "Group conversation is not bound",
  );
  expect(() => authorize(ledger, { role: "task", thread_id: "foreign-task" })).toThrow(
    "Task conversation is not bound",
  );

  const replayLedger = fixture();
  const replayRequest = request(replayLedger, "replay-claim", {
    task_id: "task-a",
    operation_id: "replay-operation",
  });
  apply(replayLedger, "dispatch-claim", replayRequest);
  expect((apply(replayLedger, "dispatch-claim", replayRequest) as { code?: string }).code).toBe(
    "REPLAYED",
  );
  expect(() =>
    apply(replayLedger, "dispatch-claim", {
      ...replayRequest,
      payload: { task_id: "task-b", operation_id: "replay-operation" },
    }),
  ).toThrow("different content");

  apply(
    ledger,
    "dispatch-claim",
    request(ledger, "claim-task", { task_id: task.id, operation_id: "dispatch-task" }),
  );
  apply(
    ledger,
    "dispatch-bind-request",
    request(ledger, "bind-task", {
      operation_id: "dispatch-task",
      native_request_id: "native-task",
      creation_parameters: {
        title: task.title,
        prompt: "formal handoff",
        cwd: "/repo",
        transport: "codex-exec",
        execution_profile: ledger.config.execution_profile,
      },
    }),
  );
  apply(
    ledger,
    "dispatch-resolve",
    request(ledger, "unknown-task", {
      operation_id: "dispatch-task",
      outcome: "unknown",
    }),
  );
  expect(ledger.operations[0]?.status).toBe("unknown");
  expect(() =>
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "unsafe-success", {
        operation_id: "dispatch-task",
        outcome: "succeeded",
        thread_id: "task-thread",
      }),
    ),
  ).toThrow("Matching native request");
  expect(() =>
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "duplicate-claim", { task_id: task.id, operation_id: "dispatch-again" }),
    ),
  ).toThrow("dispatch claim");

  apply(
    ledger,
    "dispatch-progress",
    request(ledger, "observe-task", {
      operation_id: "dispatch-task",
      native_request_id: "native-task",
      thread_id: "task-thread",
    }),
  );
  apply(
    ledger,
    "dispatch-resolve",
    request(ledger, "reconcile-task", {
      operation_id: "dispatch-task",
      outcome: "succeeded",
      thread_id: "task-thread",
      native_evidence: {
        source: "multi-task-flow-reconcile",
        native_tool_name: "codex exec",
        operation_id: "dispatch-task",
        native_request_id: "native-task",
        ...ledger.config.execution_profile,
        evidence_ref: "codex-thread-reconcile:task-thread",
        created_at: at,
        thread_id: "task-thread",
        workspace_path: "/repo/worktree",
        initial_head: base,
        turn_completed: true,
      },
    }),
  );
  expect(ledger.tasks[0]?.thread_id).toBe("task-thread");
  expect(ledger.operations[0]?.status).toBe("succeeded");
  expect(ledger.notifications).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        recipient_thread_id: "task-thread",
        status: "pending",
        delivery_status: "pending",
      }),
    ]),
  );
  expect(ledger.events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "dispatch_claimed",
      "dispatch_request_bound",
      "dispatch_creation_resolved",
    ]),
  );
  expect(() =>
    apply(ledger, "dispatch-claim", {
      ...request(ledger, "stale-revision", { task_id: "task-b", operation_id: "stale" }),
      expected_revision: 0,
    }),
  ).toThrow("Ledger version changed");
});

test("contract-3 mock completion reaches Task and DeliveryUnit closeout gates", () => {
  const ledger = modernFixture();
  const task = ledger.tasks[0];
  const group = ledger.groups[0];
  if (!task || !group) throw new Error("modern fixture task or group missing");
  apply(
    ledger,
    "dispatch-claim",
    request(ledger, "modern-claim", { task_id: task.id, operation_id: "modern-dispatch" }),
  );
  apply(
    ledger,
    "dispatch-bind-request",
    request(ledger, "modern-bind", {
      operation_id: "modern-dispatch",
      native_request_id: "modern-native",
      creation_parameters: {
        title: task.title,
        prompt: "contract-3 handoff",
        cwd: "/repo",
        transport: "codex-exec",
        execution_profile: ledger.config.execution_profile,
      },
    }),
  );
  apply(
    ledger,
    "dispatch-progress",
    request(ledger, "modern-progress", {
      operation_id: "modern-dispatch",
      native_request_id: "modern-native",
      thread_id: "modern-task-thread",
    }),
  );
  apply(
    ledger,
    "dispatch-resolve",
    request(ledger, "modern-resolve", {
      operation_id: "modern-dispatch",
      outcome: "succeeded",
      thread_id: "modern-task-thread",
      native_evidence: {
        source: "multi-task-flow-reconcile",
        native_tool_name: "codex exec",
        operation_id: "modern-dispatch",
        native_request_id: "modern-native",
        ...ledger.config.execution_profile,
        evidence_ref: "mock:modern-thread",
        created_at: at,
        thread_id: "modern-task-thread",
        workspace_path: "/repo/modern-worktree",
        initial_head: base,
        turn_completed: true,
      },
    }),
  );
  expect(() => authorize(ledger, { role: "task", thread_id: "foreign-task" })).toThrow(
    "Task conversation is not bound",
  );
  const taskActor = { role: "task", thread_id: "modern-task-thread" } as const;
  const baseline = { sha: base, head: base, clean: true as const, source: "mock-verifier" };
  apply(
    ledger,
    "development-baseline-sync",
    request(
      ledger,
      "modern-baseline",
      {
        target_type: "task",
        target_id: task.id,
        dispatch_operation_id: "modern-dispatch",
        mode: "initial",
        expected_previous_baseline: null,
        expected_lineage_sha: base,
        lineage_event_id: "initial",
        branch: task.branch,
        resource_ids: ["task-worktree", "task-branch"],
        baseline,
        evidence_ref: "mock:modern-baseline",
      },
      taskActor,
    ),
  );
  apply(
    ledger,
    "task-update",
    request(
      ledger,
      "modern-start",
      { task_id: task.id, state: "running", occurred_at: at },
      taskActor,
    ),
  );
  const currentTask = ledger.tasks.find((item) => item.id === task.id);
  if (!currentTask) throw new Error("modern fixture task missing after baseline");
  for (const [index, atom] of currentTask.atoms.entries()) {
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        `modern-atom-start-${index}`,
        { task_id: task.id, atom_id: atom.id, state: "running" },
        taskActor,
      ),
    );
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        `modern-atom-complete-${index}`,
        { task_id: task.id, atom_id: atom.id, state: "completed" },
        taskActor,
      ),
    );
  }
  const completedTask = ledger.tasks.find((item) => item.id === task.id);
  if (!completedTask) throw new Error("completed task missing");
  const childPr = {
    provider: "github",
    repository: "example/loomhelm",
    id: "101",
    url: "https://github.com/example/loomhelm/pull/101",
  };
  completedTask.pr = {
    state: "open",
    pr: childPr,
    branch: task.branch ?? task.id,
    base_branch: group.parent_branch ?? "orchestration/a",
  };
  apply(
    ledger,
    "task-equivalent-integrate",
    request(
      ledger,
      "modern-task-integrate",
      {
        task_id: task.id,
        task_pr: childPr,
        parent_pr: group.parent_pr,
        task_head_sha: base,
        parent_merge_sha: base,
        integration_commits: [base],
        evidence_ref: "mock:integration",
      },
      taskActor,
    ),
  );
  const integratedTask = ledger.tasks.find((item) => item.id === task.id);
  if (!integratedTask) throw new Error("integrated task missing");
  integratedTask.pr = {
    state: "merged",
    pr: childPr,
    branch: task.branch ?? task.id,
    merge_sha: base,
  };
  ledger.facts.push({
    id: "task-pr-merged",
    kind: "pr_merged",
    subject_id: task.id,
    status: "passed",
    source: "mock",
    observed_at: at,
    sha: base,
    evidence_ref: "mock:task-merge",
    receipt: {
      provider: "github",
      repository: "example/loomhelm",
      resource_type: "pr",
      resource_id: childPr.id,
      branch: task.branch ?? task.id,
      target_branch: group.parent_branch ?? "orchestration/a",
      base_sha: base,
      head_sha: base,
      pr: childPr,
      state: "merged",
      evidence_ref: "mock:task-merge",
    },
  });
  integratedTask.lifecycle.pr_merged = "passed";
  apply(
    ledger,
    "task-update",
    request(
      ledger,
      "modern-task-close",
      { task_id: task.id, state: "closed", occurred_at: at },
      taskActor,
    ),
  );
  expect(ledger.tasks.find((item) => item.id === task.id)).toMatchObject({
    state: "closed",
    lifecycle: { closed: "passed" },
  });

  for (const candidate of ledger.tasks.filter((item) => item.id !== task.id))
    candidate.state = "integrated";
  const currentGroup = ledger.groups.find((item) => item.id === group.id);
  if (!currentGroup) throw new Error("current group missing");
  currentGroup.state = "merged";
  currentGroup.merge_sha = base;
  currentGroup.lifecycle.pr_merged = "passed";
  if (!currentGroup.parent_pr) throw new Error("modern fixture parent PR missing");
  currentGroup.pr = {
    state: "merged",
    pr: currentGroup.parent_pr,
    parent_branch: currentGroup.parent_branch ?? "orchestration/a",
    merge_sha: base,
  };
  currentGroup.atoms = currentGroup.atoms.map((atom, index) => ({
    ...atom,
    status: index < currentGroup.atoms.length - 1 ? ("completed" as const) : ("running" as const),
  }));
  ledger.facts.push(
    {
      id: "group-pr-merged",
      kind: "pr_merged",
      subject_id: currentGroup.id,
      status: "passed",
      source: "mock",
      observed_at: at,
      sha: base,
      evidence_ref: "mock:group-merge",
      receipt: {
        provider: "github",
        repository: "example/loomhelm",
        resource_type: "pr",
        resource_id: currentGroup.parent_pr.id,
        branch: currentGroup.parent_branch ?? "orchestration/a",
        target_branch: "main",
        base_sha: base,
        head_sha: base,
        pr: currentGroup.parent_pr,
        state: "merged",
        evidence_ref: "mock:group-merge",
      },
    },
    {
      id: "group-ci",
      kind: "ci_passed",
      subject_id: currentGroup.id,
      status: "passed",
      source: "mock",
      observed_at: at,
      sha: base,
      evidence_ref: "mock:ci",
    },
  );
  currentGroup.coordination_execution = { state: "idle", reason: null, waiting_for_task_ids: [] };
  apply(
    ledger,
    "group-close",
    request(
      ledger,
      "modern-group-close",
      { group_id: group.id },
      { role: "group", thread_id: currentGroup.agent_thread_id ?? "delivery-thread" },
    ),
  );
  expect(ledger.groups.find((item) => item.id === group.id)).toMatchObject({
    state: "closed",
    lifecycle: { closed: "passed" },
  });
  expect(ledger.groups.find((item) => item.id === group.id)?.atoms.at(-1)?.status).toBe(
    "completed",
  );
});

test("topology projection matches Agent ownership contracts", () => {
  const shared = [
    {
      id: "shared-task",
      group_id: "shared",
      kind: "contribution",
      disposition: "active",
      execution_owner: "delivery_agent",
      conversation_policy: "delivery_owned",
      delivery_policy: "shared_delivery_unit",
    },
    { id: "verify", group_id: "shared", kind: "verification", disposition: "active" },
  ] as const;
  expect(deliveryTopologyForGroup(shared, "shared")).toBe("shared_delivery");
  expect(() => validateDeliveryTopologies(shared as unknown as Task[], true)).not.toThrow();

  const integrated = ["task-a", "task-b"].map((id) => ({
    id,
    group_id: "integrated",
    kind: "contribution",
    disposition: "active",
    execution_owner: "task_agent",
    conversation_policy: "task_agent",
    delivery_policy: "child_pr",
  } as const));
  expect(deliveryTopologyForGroup(integrated, "integrated")).toBe("multi_task_integration");
  expect(() => validateDeliveryTopologies(integrated as unknown as Task[], true)).not.toThrow();
  expect(() =>
    validateDeliveryTopologies(
      [
        {
          ...integrated[0],
          delivery_policy: "shared_delivery_unit",
          execution_owner: "delivery_agent",
          conversation_policy: "delivery_owned",
        },
        integrated[1],
      ] as unknown as Task[],
      true,
    ),
  ).toThrow("multi-task delivery unit");
});

test("bootstrap topology keeps the main Agent as the DeliveryUnit owner", () => {
  const regular = fixture();
  const regularGroup = structuredClone(regular.groups[0]);
  if (!regularGroup) throw new Error("regular fixture group missing");
  regularGroup.delivery_unit_kind = "bootstrap";
  regularGroup.owner_kind = "main";
  regularGroup.agent_thread_id = null;
  expect(() =>
    apply(
      regular,
      "group-update",
      request(regular, "illegal-bootstrap-conversion", { group: regularGroup }, main),
    ),
  ).toThrow("only the bootstrap delivery unit");

  const ledger = fixture({ bootstrap: true });
  const group = structuredClone(ledger.groups[0]);
  if (!group) throw new Error("fixture group missing");
  ledger.groups[0] = group;
  apply(ledger, "group-update", request(ledger, "bootstrap-update", { group }, main));
  expect(ledger.groups[0]).toMatchObject({
    delivery_unit_kind: "bootstrap",
    owner_kind: "main",
    agent_thread_id: null,
  });
  expect(() =>
    apply(
      ledger,
      "group-update",
      request(
        ledger,
        "foreign-bootstrap-update",
        { group },
        { role: "group", thread_id: "foreign" },
      ),
    ),
  ).toThrow("Group conversation is not bound");
});
