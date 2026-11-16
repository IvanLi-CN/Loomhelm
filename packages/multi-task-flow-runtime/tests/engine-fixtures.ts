import { canonicalizeContract3Plan } from "../lib/atomic-orchestration";
import { apply, type Request } from "../lib/engine";
import { type Ledger, type Plan, type Task, validateLedger } from "../lib/schema";

export const base = "a".repeat(40),
  head = "b".repeat(40),
  merge = "c".repeat(40);
export const at = "2026-01-01T00:00:00.000Z";
export const main = { role: "main", thread_id: "main-thread" } as const;
export const groupActor = { role: "group", thread_id: "group-thread" } as const;

export function taskQuality(taskId: string, threadId: string, pr: any, baseSha: string, headSha: string) {
  return {
    task_id: taskId,
    thread_id: threadId,
    pr,
    base_sha: baseSha,
    head_sha: headSha,
    acceptance_refs: ["acceptance"],
    checks: [{ name: "tests", status: "passed" as const, evidence_ref: "tests" }],
  };
}

export type FixtureLedger = Ledger & {
  plans: [Plan, ...Plan[]];
  groups: [Ledger["groups"][number], ...Ledger["groups"][number][]];
  tasks: [Task, Task, Task, ...Task[]];
};

export function fixture(): FixtureLedger {
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
  const initialPlan = {
    id: "plan",
    supersedes_id: null,
    approval_id: null,
    created_at: at,
    start_at: null,
    atoms: [],
    atomic_edges: [],
    nodes,
    edges: [
      {
        id: "a-c",
        from_node_id: "node-a",
        to_node_id: "node-c",
        requires: "integrated",
      },
    ],
    cut_rules: [
      {
        id: "cut",
        group_id: "g",
        priority: 0,
        required_task_ids: ["a"],
        status: "pending",
      },
    ],
    actions: [],
  };
  const ledger = validateLedger({
    schema_version: 1,
    orchestration_id: "run",
    revision: 0,
    repository: {
      provider: "github",
      host: "github.com",
      owner: "example",
      name: "repo",
      target_branch: "main",
    },
    control: {
      owner_thread_id: "main-thread",
      ownership: "bound",
      approval_id: null,
    },
    config: {
      execution_profile: { model: "gpt-6.1-sol", thinking: "medium" },
      max_running_tasks: 3,
      display_timezone: "Asia/Shanghai",
    },
    plans: [initialPlan],
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
  return {
    ...ledger,
    plans: ledger.plans as FixtureLedger["plans"],
    groups: ledger.groups as FixtureLedger["groups"],
    tasks: ledger.tasks as FixtureLedger["tasks"],
  };
}
export function request(
  ledger: ReturnType<typeof fixture>,
  requestId: string,
  payload: Record<string, unknown>,
  actor: Request["actor"] = main,
): Request {
  if (
    payload.outcome === "succeeded" &&
    (payload.native_evidence as any)?.source === "create_thread"
  ) {
    const operation = ledger.operations.find((item) => item.id === payload.operation_id)!;
    const nativeId = `native-${operation.id}`;
    if (!operation.request.native_request_id)
      apply(ledger, "dispatch-bind-request", {
        run_id: "run",
        actor: main,
        request_id: `bind-${operation.id}`,
        expected_revision: ledger.revision,
        payload: { operation_id: operation.id, native_request_id: nativeId },
      });
    payload.native_evidence = {
      source: "multi-task-flow-cli",
      native_tool_name: "thread/start",
      operation_id: operation.id,
      native_request_id: nativeId,
      ...(operation.request.execution_profile as object),
      evidence_ref: "fixture://app-server",
      created_at: at,
    };
  }
  return {
    run_id: "run",
    actor,
    request_id: requestId,
    expected_revision: ledger.revision,
    payload,
  };
}
export function approve(ledger: ReturnType<typeof fixture>) {
  apply(
    ledger,
    "plan-approve",
    request(ledger, "approve", {
      plan_id: "plan",
      approval_id: "approved",
      authorized_actions: ["dispatch", "merge", "cut"],
      authorized_action_ids: [],
    }),
  );
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-parent", {
      kind: "delivery_unit_merge",
      target_id: "g",
      approval_id: "parent-approved",
    }),
  );
}


export function v2Fixture() {
  const ledger: any = structuredClone(fixture());
  ledger.schema_version = 2;
  ledger.source_schema_version = null;
  ledger.plans[0].atoms = ["a", "b", "c"].map((id) => ({
    id: `atom-${id}`,
    title: id,
    task_id: id,
    purpose: "fixture task",
    output: "fixture output",
  }));
  ledger.plans[0].nodes.forEach((node: any) => {
    if (node.kind === "task") {
      node.estimate_minutes = 30;
      node.estimate_basis = "fixture estimate";
      node.estimate_confidence = "medium";
    }
  });
  ledger.tasks.forEach((task: any) => {
    task.atoms = [{ id: `atom-${task.id}`, title: task.id, status: "completed" }];
  });
  ledger.groups[0].lifecycle = {
    workspace_ready: "unknown",
    pr_created: "unknown",
    pr_merged: "unknown",
    closed: "unknown",
  };
  ledger.tasks.forEach((task: any) => {
    task.branch = null;
    task.lifecycle = {
      workspace_ready: "unknown",
      pr_created: "unknown",
      pr_merged: "unknown",
      closed: "unknown",
    };
  });
  ledger.resources = [
    {
      id: "group-worktree",
      kind: "worktree",
      target: "g",
      status: "active",
      evidence_ref: "worktree-receipt",
    },
    {
      id: "group-branch",
      kind: "branch",
      target: "parent",
      status: "active",
      evidence_ref: "branch-receipt",
    },
    {
      id: "task-worktree",
      kind: "worktree",
      target: "a",
      status: "active",
      evidence_ref: "task-worktree-receipt",
    },
    {
      id: "task-branch",
      kind: "branch",
      target: "task-a",
      status: "active",
      evidence_ref: "task-branch-receipt",
    },
  ];
  ledger.plans[0].actions = [
    {
      id: "publish-group-branch",
      kind: "publish_branch",
      task_id: null,
      group_id: "g",
      target_identity: "branch:parent",
    },
    {
      id: "publish-group-pr",
      kind: "publish_pr",
      task_id: null,
      group_id: "g",
      target_identity: "pr:parent-pr",
    },
    {
      id: "publish-task-branch",
      kind: "publish_branch",
      task_id: "a",
      group_id: null,
      target_identity: "branch:task-a",
    },
    {
      id: "publish-task-pr",
      kind: "publish_pr",
      task_id: "a",
      group_id: null,
      target_identity: "pr:child-pr",
    },
  ];
  return validateLedger(ledger) as any;
}
export function approveV2(ledger: ReturnType<typeof v2Fixture>) {
  apply(
    ledger,
    "plan-approve",
    request(ledger, "approve-v2", {
      plan_id: "plan",
      approval_id: "approved-v2",
      authorized_actions: ["dispatch", "publish_branch", "publish_pr", "merge"],
      authorized_action_ids: [
        "publish-group-branch",
        "publish-group-pr",
        "publish-task-branch",
        "publish-task-pr",
      ],
    }),
  );
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-v2-parent", {
      kind: "delivery_unit_merge",
      target_id: "g",
      approval_id: "parent-approved-v2",
    }),
  );
}

export function readyBootstrapFixture() {
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
      status: "completed",
    },
  ];
  ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({
    ...atom,
    group_id: "g",
  }));
  ledger.groups[0].lifecycle.workspace_ready = "passed";
  ledger.events.push({
    id: "bootstrap-workspace-recorded",
    type: "lifecycle_recorded",
    subject_id: "g",
    actor_id: "main-thread",
    occurred_at: at,
    recorded_at: at,
    data: { target_type: "group", stage: "workspace_ready", evidence_ref: "workspace" },
  });
  approveV2(ledger);
  return ledger;
}

export function readyAtomicFixture() {
  const ledger = v2Fixture();
  const task = ledger.tasks[0]!;
  const suffixes = ["prepare-branch", "create-pr", "merge-pr", "closeout"];
  const lifecycle = ["branch_ready", "pr_created", "pr_merged", "closed"] as const;
  const atoms = suffixes.map((suffix, index) => ({
    id: `task-a-${suffix}`,
    title: suffix,
    status: "planned" as const,
    lifecycle_stage: lifecycle[index],
  }));
  task.atoms = atoms;
  ledger.plans[0].atoms = [
    ...ledger.plans[0].atoms.filter((atom) => atom.task_id !== task.id),
    ...atoms.map((atom) => ({
      id: atom.id,
      title: atom.title,
      task_id: task.id,
      purpose: atom.title,
      output: atom.title,
    })),
  ];
  ledger.plans[0].atomic_edges = atoms.slice(1).map((atom, index) => ({
    id: `task-a-edge-${index}`,
    from_atom_id: atoms[index]!.id,
    to_atom_id: atom.id,
  }));
  ledger.plans[0] = canonicalizeContract3Plan(ledger.plans[0], ledger.tasks);
  approveV2(ledger);
  return ledger;
}


export function providerBranchReceipt(branch: string, sha: string) {
  return {
    provider: "github",
    repository: "example/repo",
    resource_type: "branch",
    resource_id: branch,
    branch,
    target_branch: null,
    base_sha: null,
    head_sha: sha,
    pr: null,
    state: "exists",
    evidence_ref: `provider:${branch}`,
  };
}
export function providerPrReceipt(id: string, branch: string, baseSha: string, headSha: string) {
  const pr = {
    provider: "github",
    repository: "example/repo",
    id,
    url: `https://github.com/example/repo/pull/${id}`,
  };
  return {
    provider: "github",
    repository: "example/repo",
    resource_type: "pr",
    resource_id: id,
    branch,
    target_branch: "main",
    base_sha: baseSha,
    head_sha: headSha,
    pr,
    state: "open",
    evidence_ref: `provider:pr:${id}`,
  };
}



