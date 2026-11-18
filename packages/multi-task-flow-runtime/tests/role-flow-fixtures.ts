import { canonicalizeContract3Plan } from "../lib/atomic-orchestration";
import type { Request } from "../lib/engine";
import { defaultGroupAtoms, defaultTaskAtoms, type Ledger, validateLedger } from "../lib/schema";

const at = "2026-01-01T00:00:00.000Z";
const base = "a".repeat(40);
const main = { role: "main", thread_id: "main-thread" } as const;

export function fixture(options: { bootstrap?: boolean } = {}): Ledger {
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

export function request(
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

export function modernFixture(): Ledger {
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
  if (approval)
    approval.data.authorized_actions = ["dispatch", "publish_branch", "publish_pr", "merge"];
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
      lifecycle_stage: atom.lifecycle_stage,
      lifecycle_role: atom.lifecycle_role,
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
