import { describe, expect, test } from "bun:test";
import { apply, ready, type Request } from "../scripts/engine";
import {
  validateLedger,
  type Ledger,
  type Plan,
  type Task,
} from "../scripts/schema";

const base = "a".repeat(40),
  head = "b".repeat(40),
  merge = "c".repeat(40);
const at = "2026-01-01T00:00:00.000Z";
const main = { role: "main", thread_id: "main-thread" } as const;
const groupActor = { role: "group", thread_id: "group-thread" } as const;

type FixtureLedger = Ledger & {
  plans: [Plan, ...Plan[]];
  groups: [Ledger["groups"][number], ...Ledger["groups"][number][]];
  tasks: [Task, Task, Task, ...Task[]];
};

function fixture(): FixtureLedger {
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
    config: { execution_profile: { model: "gpt-6.1-sol", thinking: "medium" }, max_running_tasks: 3, display_timezone: "Asia/Shanghai" },
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
function request(
  ledger: ReturnType<typeof fixture>,
  requestId: string,
  payload: Record<string, unknown>,
  actor: Request["actor"] = main,
): Request {
  if (payload.outcome === "succeeded" && (payload.native_evidence as any)?.source === "create_thread") {
    const operation = ledger.operations.find((item) => item.id === payload.operation_id)!;
    const nativeId = `native-${operation.id}`;
    if (!operation.request.native_request_id) apply(ledger, "dispatch-bind-request", { run_id: "run", actor: main, request_id: `bind-${operation.id}`, expected_revision: ledger.revision, payload: { operation_id: operation.id, native_request_id: nativeId } });
    payload.native_evidence = { source: "multi-task-flow-cli", native_tool_name: "thread/start", operation_id: operation.id, native_request_id: nativeId, ...(operation.request.execution_profile as object), evidence_ref: "fixture://app-server", created_at: at };
  }
  return {
    run_id: "run",
    actor,
    request_id: requestId,
    expected_revision: ledger.revision,
    payload,
  };
}
function approve(ledger: ReturnType<typeof fixture>) {
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
}

test("runtime observation persists the formal agent_idle task state and restores it", () => {
  const ledger = fixture();
  const task = ledger.tasks[1]!;
  task.state = "running"; task.thread_id = "runtime-thread";
  const observe = (runtime: string, requestId: string) => apply(ledger, "task-runtime-observe", request(ledger, requestId, {task_id: task.id, thread_id: task.thread_id, runtime, turn_id: "turn", observed_at: at}));
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
  ledger.tasks[1]!.state = "starting"; ledger.tasks[1]!.thread_id = "runtime-thread";
  apply(ledger, "task-runtime-observe", request(ledger, "startup-idle", {turn_id: "startup-turn", task_id: "b", thread_id: "runtime-thread", runtime: "idle", observed_at: at}));
  expect(ledger.tasks[1]!.agent_resume_state).toBe("starting");
  apply(ledger, "task-update", request(ledger, "startup-running", {task_id: "b", state: "running", occurred_at: at}, {role: "task", thread_id: "runtime-thread"}));
  expect(ledger.tasks[1]!.started_at).toBe(at);
  expect(ledger.events.at(-1)?.type).toBe("task_started");
  expect(ledger.tasks[1]!.agent_resume_state).toBeUndefined();
});

test("terminal task creates a pending conversation archive resource", () => {
  const ledger = fixture();
  const task = ledger.tasks[1]!;
  task.kind = "verification";
  task.thread_id = "task-b-thread";
  task.state = "running";
  apply(ledger, "task-update", request(ledger, "complete-b", {
    task_id: task.id,
    state: "completed",
    evidence: "verification complete",
    occurred_at: at,
  }, { role: "task", thread_id: task.thread_id }));
  expect(ledger.resources).toContainEqual(expect.objectContaining({ kind: "conversation", target: "task-b-thread", status: "pending" }));
});

function v2Fixture() {
  const ledger: any = structuredClone(fixture());
  ledger.schema_version = 2;
  ledger.source_schema_version = null;
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
function approveV2(ledger: ReturnType<typeof v2Fixture>) {
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
}
function providerBranchReceipt(branch: string, sha: string) {
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
function providerPrReceipt(
  id: string,
  branch: string,
  baseSha: string,
  headSha: string,
) {
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

describe("orchestration state", () => {
  test("allows the bound main conversation to manage only a bootstrap group", () => {
    const ledger = fixture();
    ledger.groups[0].delivery_unit_kind = "bootstrap";
    ledger.groups[0].owner_kind = "main";
    ledger.groups[0].agent_thread_id = null;
    const incoming = structuredClone(ledger.groups[0]); incoming.state = "blocked";
    expect(apply(ledger, "group-update", request(ledger, "bootstrap-update", { group: incoming }))).toMatchObject({ result: { group_id: "g", state: "blocked" } });
    const regular = fixture(); const regularIncoming = structuredClone(regular.groups[0]); regularIncoming.state = "blocked";
    expect(() => apply(regular, "group-update", request(regular, "regular-main-update", { group: regularIncoming }))).toThrow("Main conversation may update only the bootstrap delivery unit");
  });
  test("rejects contradictory bootstrap ownership and cross-group predecessors in complete ledgers", () => {
    const bootstrap = fixture();
    bootstrap.groups[0].delivery_unit_kind = "bootstrap";
    bootstrap.groups[0].owner_kind = "main";
    expect(() => validateLedger(bootstrap)).toThrow("Bootstrap must be owned");
    bootstrap.groups[0].agent_thread_id = null;
    expect(() => validateLedger(bootstrap)).not.toThrow();
    const duplicate = structuredClone(bootstrap);
    duplicate.groups.push({ ...structuredClone(duplicate.groups[0]), id: "other" });
    expect(() => validateLedger(duplicate)).toThrow("At most one bootstrap");
    const predecessor = structuredClone(bootstrap);
    predecessor.groups.push({ ...structuredClone(predecessor.groups[0]), id: "other", delivery_unit_kind: "regular", owner_kind: "group", agent_thread_id: "other-thread" });
    predecessor.plans[0].nodes.push({ ...predecessor.plans[0].nodes[0]!, id: "other-node", kind: "milestone", ref_id: null, group_id: "other" });
    predecessor.plans[0].edges.push({ id: "other-before-bootstrap", from_node_id: "other-node", to_node_id: "node-a", requires: "completed" });
    expect(() => validateLedger(predecessor)).toThrow("Bootstrap cannot depend");
  });
  test("bootstrap parent merge claim uses main ownership and retains integration gates", () => {
    const ledger = fixture();
    ledger.groups[0].delivery_unit_kind = "bootstrap";
    ledger.groups[0].owner_kind = "main";
    ledger.groups[0].agent_thread_id = null;
    const pr = { provider: "github", repository: "example/repo", id: "9", url: "https://github.com/example/repo/pull/9" };
    ledger.groups[0].parent_pr = pr;
    ledger.groups[0].current_sha = head;
    approve(ledger);
    const payload = { mode: "parent", operation_id: "parent-merge", group_id: "g", target_branch: "main", expected_base_sha: base, expected_head_sha: head, pr };
    expect(() => apply(ledger, "merge-claim", request(ledger, "premature-parent", payload))).toThrow("Contribution tasks are not integrated");
    for (const task of ledger.tasks) task.state = "integrated";
    expect(() => apply(ledger, "merge-claim", request(ledger, "main-parent", payload))).not.toThrow();
  });
  test("accepts legacy development tasks with contribution semantics", () => {
    const ledger = fixture();
    ledger.tasks[0]!.kind = "development";
    approve(ledger);
    expect(ready(ledger, "a")).toBe(true);
  });
  test("v2 publication operations bind exact provider branch and PR receipts", () => {
    const ledger = v2Fixture();
    ledger.tasks[0].thread_id = "task-a";
    ledger.tasks[0].state = "running";
    approveV2(ledger);
    expect(() =>
      apply(
        ledger,
        "lifecycle-record",
        request(
          ledger,
          "unauthorized-workspace",
          {
            target_type: "group",
            target_id: "g",
            stage: "workspace_ready",
            branch: "parent",
            resource_ids: ["group-worktree", "group-branch"],
            evidence_ref: "workspace",
          },
          { role: "task", thread_id: "task-a" },
        ),
      ),
    ).toThrow("Delivery-unit lifecycle");
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "group-workspace",
        {
          target_type: "group",
          target_id: "g",
          stage: "workspace_ready",
          branch: "parent",
          resource_ids: ["group-worktree", "group-branch"],
          evidence_ref: "workspace",
        },
        groupActor,
      ),
    );
    const branchReceipt = providerBranchReceipt("parent", base);
    apply(
      ledger,
      "publish-branch-claim",
      request(
        ledger,
        "group-branch-claim",
        {
          action_id: "publish-group-branch",
          target_type: "group",
          target_id: "g",
          branch: "parent",
          expected_head_sha: base,
          operation_id: "publish-group-branch-op",
        },
        groupActor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "publish-branch-resolve",
        request(
          ledger,
          "group-branch-forged",
          {
            operation_id: "publish-group-branch-op",
            outcome: "succeeded",
            fact_id: "branch-fact",
            provider_receipt: { ...branchReceipt, head_sha: head },
          },
          groupActor,
        ),
      ),
    ).toThrow("Provider branch receipt");
    apply(
      ledger,
      "publish-branch-resolve",
      request(
        ledger,
        "group-branch-resolve",
        {
          operation_id: "publish-group-branch-op",
          outcome: "succeeded",
          fact_id: "branch-fact",
          provider_receipt: branchReceipt,
        },
        groupActor,
      ),
    );
    const parentPr = providerPrReceipt("parent-pr", "parent", base, base);
    apply(
      ledger,
      "publish-pr-claim",
      request(
        ledger,
        "group-pr-claim",
        {
          action_id: "publish-group-pr",
          target_type: "group",
          target_id: "g",
          branch: "parent",
          target_branch: "main",
          expected_base_sha: base,
          expected_head_sha: base,
          pr: parentPr.pr,
          operation_id: "publish-group-pr-op",
        },
        groupActor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "publish-pr-resolve",
        request(
          ledger,
          "group-pr-unauthorized",
          {
            operation_id: "publish-group-pr-op",
            outcome: "succeeded",
            fact_id: "pr-fact",
            provider_receipt: parentPr,
          },
          { role: "task", thread_id: "task-a" },
        ),
      ),
    ).toThrow("belongs to another actor");
    expect(() =>
      apply(
        ledger,
        "publish-pr-resolve",
        request(
          ledger,
          "group-pr-wrong-resource",
          {
            operation_id: "publish-group-pr-op",
            outcome: "succeeded",
            fact_id: "pr-fact",
            provider_receipt: { ...parentPr, resource_id: "other-pr" },
          },
          groupActor,
        ),
      ),
    ).toThrow("Provider PR receipt");
    apply(
      ledger,
      "publish-pr-resolve",
      request(
        ledger,
        "group-pr-resolve",
        {
          operation_id: "publish-group-pr-op",
          outcome: "succeeded",
          fact_id: "pr-fact",
          provider_receipt: parentPr,
        },
        groupActor,
      ),
    );
    expect(ledger.groups[0].parent_pr).toEqual(parentPr.pr);
    expect(ledger.groups[0].lifecycle.pr_created).toBe("passed");

    const taskActor = { role: "task", thread_id: "task-a" } as const;
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "task-workspace",
        {
          target_type: "task",
          target_id: "a",
          stage: "workspace_ready",
          branch: "task-a",
          resource_ids: ["task-worktree", "task-branch"],
          evidence_ref: "task-workspace",
        },
        taskActor,
      ),
    );
    const taskBranch = providerBranchReceipt("task-a", base);
    apply(
      ledger,
      "publish-branch-claim",
      request(
        ledger,
        "task-branch-claim",
        {
          action_id: "publish-task-branch",
          target_type: "task",
          target_id: "a",
          branch: "task-a",
          expected_head_sha: base,
          operation_id: "publish-task-branch-op",
        },
        taskActor,
      ),
    );
    apply(
      ledger,
      "publish-branch-resolve",
      request(
        ledger,
        "task-branch-resolve",
        {
          operation_id: "publish-task-branch-op",
          outcome: "succeeded",
          fact_id: "task-branch-fact",
          provider_receipt: taskBranch,
        },
        taskActor,
      ),
    );
    const childPr = providerPrReceipt("child-pr", "task-a", base, base);
    apply(
      ledger,
      "publish-pr-claim",
      request(
        ledger,
        "task-pr-claim",
        {
          action_id: "publish-task-pr",
          target_type: "task",
          target_id: "a",
          branch: "task-a",
          target_branch: "parent",
          expected_base_sha: base,
          expected_head_sha: base,
          pr: childPr.pr,
          operation_id: "publish-task-pr-op",
        },
        taskActor,
      ),
    );
    apply(
      ledger,
      "publish-pr-resolve",
      request(
        ledger,
        "task-pr-resolve",
        {
          operation_id: "publish-task-pr-op",
          outcome: "succeeded",
          fact_id: "task-pr-fact",
          provider_receipt: { ...childPr, target_branch: "parent" },
        },
        taskActor,
      ),
    );
    apply(
      ledger,
      "review-record",
      request(
        ledger,
        "task-review",
        {
          task_id: "a",
          base_sha: base,
          evidence: {
            id: "task-review-fact",
            kind: "child_review",
            subject_id: "a",
            status: "passed",
            source: "group-thread",
            observed_at: at,
            sha: base,
            evidence_ref: "review-proof",
          },
        },
        groupActor,
      ),
    );
    apply(
      ledger,
      "merge-claim",
      request(
        ledger,
        "task-merge-claim",
        {
          operation_id: "task-merge-op",
          group_id: "g",
          task_id: "a",
          target_branch: "parent",
          expected_base_sha: base,
          expected_head_sha: base,
          pr: childPr.pr,
        },
        taskActor,
      ),
    );
    apply(
      ledger,
      "merge-resolve",
      request(
        ledger,
        "task-merge-resolve",
        {
          operation_id: "task-merge-op",
          outcome: "succeeded",
          provider_evidence: {
            id: "task-merge-fact",
            kind: "pr_merged",
            subject_id: "a",
            status: "passed",
            source: "github",
            observed_at: at,
            sha: merge,
            evidence_ref: "merge-proof",
          },
          provider_observation: {
            pr: childPr.pr,
            head_sha: base,
            base_sha: base,
            merge_sha: merge,
            state: "merged",
          },
        },
        taskActor,
      ),
    );
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "task-close",
        { task_id: "a", state: "closed" },
        taskActor,
      ),
    );
    expect(ledger.tasks[0].lifecycle).toEqual({
      workspace_ready: "passed",
      pr_created: "passed",
      pr_merged: "passed",
      closed: "passed",
    });
  });
  test("v2 lifecycle and publication gates cannot be bypassed by milestones or local observations", () => {
    const ledger = v2Fixture();
    ledger.tasks[0].thread_id = "task-a";
    ledger.tasks[0].state = "running";
    approveV2(ledger);
    apply(
      ledger,
      "milestone-record",
      request(
        ledger,
        "milestone",
        {
          target_type: "task",
          target_id: "a",
          milestone_id: "milestone-a",
          title: "Locally ready",
          evidence_ref: "local",
        },
        { role: "task", thread_id: "task-a" },
      ),
    );
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "dispatch-without-branch", {
          task_id: "b",
          operation_id: "dispatch-b",
        }),
      ),
    ).toThrow("provider-published delivery-unit branch");
    apply(
      ledger,
      "group-base",
      request(
        ledger,
        "local-branch-observation",
        {
          group_id: "g",
          provider_observation: {
            branch: "parent",
            sha: base,
            source: "local",
            evidence_ref: "local-only",
          },
        },
        groupActor,
      ),
    );
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "group-workspace",
        {
          target_type: "group",
          target_id: "g",
          stage: "workspace_ready",
          branch: "parent",
          resource_ids: ["group-worktree", "group-branch"],
          evidence_ref: "workspace",
        },
        groupActor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "publish-pr-claim",
        request(
          ledger,
          "pr-without-branch",
          {
            action_id: "publish-group-pr",
            target_type: "group",
            target_id: "g",
            branch: "parent",
            target_branch: "main",
            expected_base_sha: base,
            expected_head_sha: base,
            pr: providerPrReceipt("unpublished", "parent", base, base).pr,
            operation_id: "unpublished-pr",
          },
          groupActor,
        ),
      ),
    ).toThrow("provider branch receipt");
    expect(ledger.milestones).toHaveLength(1);
    expect(ledger.groups[0].lifecycle.pr_created).toBe("unknown");
  });
  test("publication resolve rejects stale lineage", () => {
    const ledger = v2Fixture();
    approveV2(ledger);
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "stale-workspace",
        {
          target_type: "group",
          target_id: "g",
          stage: "workspace_ready",
          branch: "parent",
          resource_ids: ["group-worktree", "group-branch"],
          evidence_ref: "workspace",
        },
        groupActor,
      ),
    );
    apply(
      ledger,
      "publish-branch-claim",
      request(
        ledger,
        "stale-branch-claim",
        {
          action_id: "publish-group-branch",
          target_type: "group",
          target_id: "g",
          branch: "parent",
          expected_head_sha: base,
          operation_id: "stale-branch-op",
        },
        groupActor,
      ),
    );
    ledger.groups[0].current_sha = head;
    expect(() =>
      apply(
        ledger,
        "publish-branch-resolve",
        request(
          ledger,
          "stale-branch-resolve",
          {
            operation_id: "stale-branch-op",
            outcome: "succeeded",
            fact_id: "stale-branch-fact",
            provider_receipt: providerBranchReceipt("parent", base),
          },
          groupActor,
        ),
      ),
    ).toThrow("lineage changed");
  });
  test("publication failures require provider identity and block the latest gate", () => {
    const ledger = v2Fixture();
    approveV2(ledger);
    apply(
      ledger,
      "lifecycle-record",
      request(
        ledger,
        "failed-workspace",
        {
          target_type: "group",
          target_id: "g",
          stage: "workspace_ready",
          branch: "parent",
          resource_ids: ["group-worktree", "group-branch"],
          evidence_ref: "workspace",
        },
        groupActor,
      ),
    );
    apply(
      ledger,
      "publish-branch-claim",
      request(
        ledger,
        "failed-branch-claim",
        {
          action_id: "publish-group-branch",
          target_type: "group",
          target_id: "g",
          branch: "parent",
          expected_head_sha: base,
          operation_id: "failed-branch-op",
        },
        groupActor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "publish-branch-resolve",
        request(
          ledger,
          "forged-failure",
          {
            operation_id: "failed-branch-op",
            outcome: "failed",
            fact_id: "failed-branch-fact",
            provider_observation: { branch: "parent", evidence_ref: "local" },
          },
          groupActor,
        ),
      ),
    ).toThrow();
    apply(
      ledger,
      "publish-branch-resolve",
      request(
        ledger,
        "failed-branch-resolve",
        {
          operation_id: "failed-branch-op",
          outcome: "failed",
          verified_no_effect: true,
          fact_id: "failed-branch-fact",
          provider_observation: {
            ...providerBranchReceipt("parent", base),
            state: "absent",
            head_sha: null,
          },
        },
        groupActor,
      ),
    );
    expect(ledger.facts.at(-1)?.receipt?.resource_id).toBe("parent");
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "blocked-by-failed-publication", {
          task_id: "b",
          operation_id: "blocked-dispatch",
        }),
      ),
    ).toThrow("provider-published delivery-unit branch");
  });
  test("release facts cannot be written without an operation receipt", () => {
    const ledger = fixture();
    approve(ledger);
    expect(() =>
      apply(
        ledger,
        "fact-record",
        request(ledger, "forged-release", {
          fact: {
            id: "release-fact",
            kind: "published",
            subject_id: "a",
            status: "passed",
            source: "registry",
            observed_at: at,
            sha: base,
            evidence_ref: "local",
          },
        }),
      ),
    ).toThrow("operation receipt");
  });
  test("a failed command cannot partially change in-memory state", () => {
    const ledger = fixture();
    const before = JSON.stringify(ledger);
    expect(() =>
      apply(
        ledger,
        "plan-approve",
        request(ledger, "bad-approval", {
          plan_id: "plan",
          approval_id: "approved",
          authorized_actions: ["not-allowed"],
          authorized_action_ids: [],
        }),
      ),
    ).toThrow();
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("independent tasks can dispatch, while a successor waits for integration", () => {
    const ledger = fixture();
    approve(ledger);
    expect(ready(ledger, "a")).toBe(true);
    expect(ready(ledger, "b")).toBe(true);
    expect(ready(ledger, "c")).toBe(false);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-a", { task_id: "a", operation_id: "dispatch-a" }),
    );
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "claim-c", {
          task_id: "c",
          operation_id: "dispatch-c",
        }),
      ),
    ).toThrow("dependencies");
  });

  test("group-start dependencies wait for the parent merge fact", () => {
    const ledger = fixture();
    ledger.plans[0].nodes.push(
      {
        id: "parent-merge",
        kind: "milestone",
        ref_id: "g",
        group_id: "g",
        label: "Parent merge",
        estimate_minutes: null,
        estimate_basis: null,
        estimate_confidence: null,
      },
      {
        id: "next-start",
        kind: "group_start",
        ref_id: "g",
        group_id: "g",
        label: "Next group",
        estimate_minutes: null,
        estimate_basis: null,
        estimate_confidence: null,
      },
    );
    ledger.plans[0].edges = [
      {
        id: "parent-merge-start",
        from_node_id: "parent-merge",
        to_node_id: "next-start",
        requires: "merged",
      },
      {
        id: "next-start-c",
        from_node_id: "next-start",
        to_node_id: "node-c",
        requires: "completed",
      },
    ];
    approve(ledger);
    expect(ready(ledger, "c")).toBe(false);
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    ledger.facts.push({
      id: "parent-merged",
      kind: "pr_merged",
      subject_id: "g",
      status: "passed",
      source: "github",
      observed_at: at,
      sha: merge,
      evidence_ref: "merge-receipt",
    });
    expect(ready(ledger, "c")).toBe(true);
  });

  test("child merge facts bind the child receipt instead of the later parent SHA", () => {
    const ledger = fixture();
    ledger.plans[0].edges[0]!.requires = "merged";
    ledger.tasks[0].state = "integrated";
    const childMerge = "d".repeat(40);
    ledger.groups[0].current_sha = merge;
    ledger.facts.push({
      id: "child-merged",
      kind: "pr_merged",
      subject_id: "a",
      status: "passed",
      source: "github",
      observed_at: at,
      sha: childMerge,
      evidence_ref: "child-merge-receipt",
    });
    ledger.operations.push({
      id: "child-merge-op",
      kind: "merge",
      actor_id: groupActor.thread_id,
      target_id: "g",
      status: "succeeded",
      request: { mode: "child", task_id: "a" },
      expected_sha: base,
      receipt_fact_id: "child-merged",
      created_at: at,
      updated_at: at,
    });
    approve(ledger);
    expect(ready(ledger, "c")).toBe(true);
  });

  test("latest failed facts invalidate an older passed fact", () => {
    const ledger = fixture();
    ledger.plans[0].edges[0]!.requires = "published";
    approve(ledger);
    ledger.facts.push(
      {
        id: "published-old",
        kind: "published",
        subject_id: "a",
        status: "passed",
        source: "registry",
        observed_at: at,
        sha: base,
        evidence_ref: "release-1",
      },
      {
        id: "published-new",
        kind: "published",
        subject_id: "a",
        status: "failed",
        source: "registry",
        observed_at: "2026-01-01T01:00:00.000Z",
        sha: base,
        evidence_ref: "release-2",
      },
    );
    expect(ready(ledger, "c")).toBe(false);
    ledger.facts.push({
      id: "published-retry",
      kind: "published",
      subject_id: "a",
      status: "passed",
      source: "registry",
      observed_at: "2026-01-01T02:00:00.000Z",
      sha: base,
      evidence_ref: "release-3",
    });
    expect(ready(ledger, "c")).toBe(true);
  });

  test("publication receipts bind the source SHA while allowing a derived artifact SHA", () => {
    const ledger = fixture();
    ledger.plans[0].edges[0]!.requires = "published";
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    ledger.tasks[0].kind = "release";
    ledger.tasks[0].state = "running";
    ledger.tasks[0].base_sha = null;
    ledger.facts.push({
      id: "published-derived",
      kind: "published",
      subject_id: "a",
      status: "passed",
      source: "provider",
      observed_at: at,
      sha: head,
      evidence_ref: "release-receipt",
    });
    ledger.operations.push({
      id: "release-op",
      kind: "release",
      actor_id: main.thread_id,
      target_id: "a",
      status: "succeeded",
      request: { target: { identity: "registry:sample" } },
      expected_sha: merge,
      receipt_fact_id: "published-derived",
      created_at: at,
      updated_at: at,
    });
    approve(ledger);
    expect(ready(ledger, "c")).toBe(true);
  });

  test("an action failure records a blocking latest fact", () => {
    const ledger = fixture();
    ledger.plans[0].edges[0]!.requires = "published";
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    ledger.tasks[0].kind = "release";
    ledger.tasks[0].state = "running";
    ledger.tasks[0].base_sha = null;
    ledger.facts.push(
      {
        id: "published-pass",
        kind: "published",
        subject_id: "a",
        status: "passed",
        source: "provider",
        observed_at: at,
        sha: merge,
        evidence_ref: "release-1",
      },
      {
        id: "published-failure",
        kind: "published",
        subject_id: "a",
        status: "failed",
        source: "provider",
        observed_at: "2026-01-01T01:00:00.000Z",
        sha: null,
        evidence_ref: "release-2",
      },
    );
    approve(ledger);
    expect(ready(ledger, "c")).toBe(false);
  });

  test("post-merge tasks stay with their group and wait for its parent PR", () => {
    const ledger = fixture();
    ledger.tasks.push({
      ...structuredClone(ledger.tasks[0]),
      id: "deploy",
      title: "Deploy",
      kind: "deployment",
    });
    ledger.plans[0].nodes.push({
      ...structuredClone(ledger.plans[0].nodes[0]!),
      id: "node-deploy",
      ref_id: "deploy",
      label: "Deploy",
    });
    approve(ledger);
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "early-deploy", {
          task_id: "deploy",
          operation_id: "dispatch-deploy",
        }),
      ),
    ).toThrow("parent PR");
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "claim-deploy", {
          task_id: "deploy",
          operation_id: "dispatch-deploy",
        }),
      ),
    ).not.toThrow();
  });

  test("an unknown creation outcome cannot release the claim or dispatch twice", () => {
    const ledger = fixture();
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-a", { task_id: "a", operation_id: "dispatch-a" }),
    );
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "resolve-a", {
        operation_id: "dispatch-a",
        outcome: "unknown",
      }),
    );
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "again", {
          task_id: "a",
          operation_id: "dispatch-new",
        }),
      ),
    ).toThrow("dispatch claim");
    expect(() =>
      apply(
        ledger,
        "dispatch-resolve",
        request(ledger, "bad-failure", {
          operation_id: "dispatch-a",
          outcome: "failed",
          native_evidence: {
            source: "create_thread",
            operation_id: "dispatch-a",
            error: "failed",
          },
        }),
      ),
    ).toThrow("native request");
  });

  test("atomic work proceeds in serial order", () => {
    const ledger = fixture();
    ledger.plans[0].atoms.push(
      {
        id: "atom-one",
        title: "One",
        task_id: "a",
        purpose: "First",
        output: "One",
      },
      {
        id: "atom-two",
        title: "Two",
        task_id: "a",
        purpose: "Second",
        output: "Two",
      },
    );
    ledger.tasks[0].atoms.push(
      { id: "atom-one", title: "One", status: "planned" },
      { id: "atom-two", title: "Two", status: "planned" },
    );
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-atoms", {
        task_id: "a",
        operation_id: "dispatch-atoms",
      }),
    );
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "bind-atoms", {
        operation_id: "dispatch-atoms",
        outcome: "succeeded",
        thread_id: "atom-thread",
        native_evidence: { source: "create_thread" },
      }),
    );
    const actor = { role: "task", thread_id: "atom-thread" } as const;
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "start-atoms",
        { task_id: "a", state: "running", occurred_at: at },
        actor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "atom-update",
        request(
          ledger,
          "skip-first",
          { task_id: "a", atom_id: "atom-two", state: "running" },
          actor,
        ),
      ),
    ).toThrow("Earlier atoms");
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        "first-start",
        { task_id: "a", atom_id: "atom-one", state: "running" },
        actor,
      ),
    );
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        "first-done",
        { task_id: "a", atom_id: "atom-one", state: "completed" },
        actor,
      ),
    );
    apply(
      ledger,
      "atom-update",
      request(
        ledger,
        "second-start",
        { task_id: "a", atom_id: "atom-two", state: "running" },
        actor,
      ),
    );
    expect(ledger.tasks[0].atoms.map((atom) => atom.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  test("delivery-unit atoms and coordination waiting state are independent from contribution tasks", () => {
    const ledger = fixture();
    ledger.plans[0].group_atoms = [
      { id: "group-atom-one", title: "Prepare parent", group_id: "g", purpose: "Prepare", output: "Prepared", lifecycle_stage: null },
      { id: "group-atom-two", title: "Close out", group_id: "g", purpose: "Close", output: "Closed", lifecycle_stage: null },
    ];
    ledger.groups[0].atoms = ledger.plans[0].group_atoms.map((atom) => ({ ...atom, group_id: undefined, status: "planned" as const })).map(({ group_id: _groupId, ...atom }) => atom);
    apply(ledger, "group-execution-update", request(ledger, "group-waiting", { group_id: "g", state: "waiting", reason: "等待贡献任务完成集成", waiting_for_task_ids: ["a"] }, groupActor));
    expect(ledger.groups[0].coordination_execution).toEqual({ state: "waiting", reason: "等待贡献任务完成集成", waiting_for_task_ids: ["a"] });
    approve(ledger);
    apply(ledger, "group-atom-update", request(ledger, "group-atom-start", { group_id: "g", atom_id: "group-atom-one", state: "running" }, groupActor));
    expect(() => apply(ledger, "group-atom-update", request(ledger, "group-atom-skip", { group_id: "g", atom_id: "group-atom-two", state: "running" }, groupActor))).toThrow("Earlier delivery-unit atoms");
    apply(ledger, "group-atom-update", request(ledger, "group-atom-done", { group_id: "g", atom_id: "group-atom-one", state: "completed" }, groupActor));
    apply(ledger, "group-atom-update", request(ledger, "group-atom-two-start", { group_id: "g", atom_id: "group-atom-two", state: "running" }, groupActor));
    expect(() => apply(ledger, "group-execution-update", request(ledger, "group-bad-wait", { group_id: "g", state: "waiting", reason: "missing", waiting_for_task_ids: ["missing"] }, groupActor))).toThrow("contribution tasks");
  });

  test("migrated contract2 does not bypass atom lifecycle evidence", () => {
    const ledger = v2Fixture();
    ledger.contract_version = 2;
    ledger.source_schema_version = 1;
    const atom = { id: "prepare", title: "Prepare", purpose: "Prepare", output: "Ready", lifecycle_stage: "workspace_ready", status: "running" };
    ledger.groups[0].atoms = [atom];
    const { status, ...definition } = atom;
    ledger.plans[0].group_atoms = [{ ...definition, group_id: "g" }];
    approve(ledger);
    expect(() => apply(ledger, "group-atom-update", request(ledger, "migrated-atom", { group_id: "g", atom_id: "prepare", state: "completed" }, groupActor))).toThrow("not passed");
    expect(ledger.groups[0].atoms[0].status).toBe("running");
  });

  test.each([false, true])("group-close completes the closeout atom in the same transaction (bootstrap=%s)", (bootstrap) => {
    const ledger = v2Fixture();
    const coordinator = bootstrap ? main : groupActor;
    if (bootstrap) {
      ledger.groups[0].delivery_unit_kind = "bootstrap";
      ledger.groups[0].owner_kind = "main";
      ledger.groups[0].agent_thread_id = null;
    }
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    ledger.groups[0].lifecycle.pr_merged = "passed";
    ledger.groups[0].atoms = [
      { id: "group-atom-one", title: "Merge", purpose: "Merge", output: "Merged", lifecycle_stage: "pr_merged", status: "completed" },
      { id: "group-atom-two", title: "Close", purpose: "Close", output: "Closed", lifecycle_stage: "closed", status: "running" },
    ];
    ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({ ...atom, group_id: "g" }));
    ledger.groups[0].coordination_execution = { state: "idle", reason: null, waiting_for_task_ids: [] };
    ledger.tasks.forEach((task: Task) => { task.state = "integrated"; });
    ledger.facts.push({ id: "group-merged", kind: "pr_merged", subject_id: "g", status: "passed", source: "github", observed_at: at, sha: merge, evidence_ref: "merge" });
    ledger.facts.push({ id: "group-ci", kind: "ci_passed", subject_id: "g", status: "passed", source: "github", observed_at: at, sha: merge, evidence_ref: "ci" });
    apply(ledger, "group-close", request(ledger, "group-closeout", { group_id: "g" }, coordinator));
    expect(ledger.groups[0].state).toBe("closed");
    expect(ledger.groups[0].atoms.at(-1)?.status).toBe("completed");
    expect(ledger.groups[0].lifecycle.closed).toBe("passed");
  });

  test("replays a matching request and rejects ID reuse", () => {
    const ledger = fixture();
    approve(ledger);
    const first = request(ledger, "claim-a", {
      task_id: "a",
      operation_id: "dispatch-a",
    });
    apply(ledger, "dispatch-claim", first);
    expect((apply(ledger, "dispatch-claim", first) as any).code).toBe(
      "REPLAYED",
    );
    expect(() =>
      apply(ledger, "dispatch-claim", {
        ...first,
        payload: { task_id: "b", operation_id: "dispatch-b" },
      }),
    ).toThrow("different content");
  });

  test("conversation link verification requires an explicit recorded observation", () => {
    const ledger = fixture();
    expect(ledger.config.conversation_links_verified).toBe(false);
    apply(
      ledger,
      "link-verification",
      request(ledger, "link-verified", {
        verified: true,
        evidence: "observed browser opening the named conversation",
      }),
    );
    expect(ledger.config.conversation_links_verified).toBe(true);
    expect(ledger.events.at(-1)?.type).toBe("link_verification");
  });

  test("rejects a child PR from a different repository", () => {
    const ledger = fixture();
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-foreign", {
        task_id: "a",
        operation_id: "dispatch-foreign",
      }),
    );
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "bind-foreign", {
        operation_id: "dispatch-foreign",
        outcome: "succeeded",
        thread_id: "foreign-thread",
        native_evidence: { source: "create_thread" },
      }),
    );
    const actor = { role: "task", thread_id: "foreign-thread" } as const;
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "start-foreign",
        { task_id: "a", state: "running", occurred_at: at },
        actor,
      ),
    );
    const foreign = {
      provider: "github",
      repository: "other/repo",
      id: "1",
      url: "https://github.com/other/repo/pull/1",
    };
    expect(() =>
      apply(
        ledger,
        "task-pr",
        request(ledger, "foreign-pr", { task_id: "a", pr: foreign }, actor),
      ),
    ).toThrow("repository");
  });

  test("does not register a follow PR while the parent merge is in flight", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.tasks[0].thread_id = "task-a";
    ledger.tasks[0].state = "running";
    ledger.operations.push({
      id: "parent-merge",
      kind: "merge",
      actor_id: groupActor.thread_id,
      target_id: "g",
      status: "claimed",
      request: { mode: "parent", target_branch: "main" },
      expected_sha: base,
      receipt_fact_id: null,
      created_at: at,
      updated_at: at,
    });
    const pr = {
      provider: "github",
      repository: "example/repo",
      id: "follow-1",
      url: "https://github.com/example/repo/pull/2",
    };
    expect(() =>
      apply(
        ledger,
        "follow-pr-update",
        request(
          ledger,
          "follow-during-merge",
          {
            follow_pr_id: "follow-1",
            origin_task_id: "a",
            origin_group_id: "g",
            target_branch: "parent",
            pr,
            affected_task_ids: [],
          },
          { role: "task", thread_id: "task-a" },
        ),
      ),
    ).toThrow("merge is pending");
  });

  test("group closeout rejects an older CI pass after a newer failure", () => {
    const ledger = fixture();
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    for (const task of ledger.tasks) task.state = "integrated";
    ledger.facts.push(
      {
        id: "ci-pass",
        kind: "ci_passed",
        subject_id: "g",
        status: "passed",
        source: "github",
        observed_at: at,
        sha: merge,
        evidence_ref: "check-1",
      },
      {
        id: "ci-fail",
        kind: "ci_passed",
        subject_id: "g",
        status: "failed",
        source: "github",
        observed_at: "2026-01-01T01:00:00.000Z",
        sha: merge,
        evidence_ref: "check-2",
      },
    );
    expect(() =>
      apply(
        ledger,
        "group-close",
        request(ledger, "close-failed-ci", { group_id: "g" }, groupActor),
      ),
    ).toThrow("CI");
  });

  test("task-local direct delivery cannot claim parent merge or group closeout", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.tasks[0]!.thread_id = "task-a";
    const taskActor = { role: "task", thread_id: "task-a" } as const;
    const parentPr = {
      provider: "github",
      repository: "example/repo",
      id: "parent",
      url: "https://github.com/example/repo/pull/9",
    };
    const parentClaim = {
      mode: "parent",
      group_id: "g",
      target_branch: "main",
      expected_base_sha: base,
      expected_head_sha: head,
      pr: parentPr,
    };
    expect(() =>
      apply(
        ledger,
        "merge-claim",
        request(ledger, "task-parent-claim", parentClaim, taskActor),
      ),
    ).toThrow("delivery coordinator");

    ledger.groups[0]!.state = "merged";
    ledger.groups[0]!.merge_sha = merge;
    for (const task of ledger.tasks) task.state = "integrated";
    ledger.facts.push({
      id: "group-ci",
      kind: "ci_passed",
      subject_id: "g",
      status: "passed",
      source: "github",
      observed_at: at,
      sha: merge,
      evidence_ref: "checks",
    });
    expect(() =>
      apply(
        ledger,
        "group-close",
        request(ledger, "task-group-close", { group_id: "g" }, taskActor),
      ),
    ).toThrow("delivery coordinator");
    expect(ledger.groups[0]!.state).toBe("merged");
  });

  test.each([false, true])("group review binds the exact head before a child merge unlocks its successor (bootstrap=%s)", (bootstrap) => {
    const ledger = fixture();
    const coordinator = bootstrap ? main : groupActor;
    if (bootstrap) {
      ledger.groups[0].delivery_unit_kind = "bootstrap";
      ledger.groups[0].owner_kind = "main";
      ledger.groups[0].agent_thread_id = null;
    }
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-a", { task_id: "a", operation_id: "dispatch-a" }),
    );
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "bind-a", {
        operation_id: "dispatch-a",
        outcome: "succeeded",
        thread_id: "task-a",
        native_evidence: { source: "create_thread" },
      }),
    );
    const taskActor = { role: "task", thread_id: "task-a" } as const;
    expect(ledger.tasks.find((item) => item.id === "a")!.started_at).toBeNull();
    apply(
      ledger,
      "task-update",
      request(
        ledger,
        "start-a",
        { task_id: "a", state: "running", occurred_at: at },
        taskActor,
      ),
    );
    const pr = {
      provider: "github",
      repository: "example/repo",
      id: "1",
      url: "https://github.com/example/repo/pull/1",
    };
    apply(
      ledger,
      "task-pr",
      request(ledger, "task-pr", { task_id: "a", pr }, taskActor),
    );
    const claim = {
      operation_id: "merge-a",
      group_id: "g",
      task_id: "a",
      target_branch: "parent",
      expected_base_sha: base,
      expected_head_sha: head,
      pr,
    };
    expect(() =>
      apply(
        ledger,
        "merge-claim",
        request(ledger, "premature", claim, taskActor),
      ),
    ).toThrow("review");
    apply(
      ledger,
      "review-record",
      request(
        ledger,
        "review",
        {
          task_id: "a",
          base_sha: base,
          evidence: {
            id: "review-fact",
            kind: "child_review",
            subject_id: "a",
            status: "passed",
            source: coordinator.thread_id,
            observed_at: at,
            sha: head,
            evidence_ref: "review-proof",
          },
        },
        coordinator,
      ),
    );
    apply(
      ledger,
      "merge-claim",
      request(ledger, "claim-merge", claim, taskActor),
    );
    apply(
      ledger,
      "merge-resolve",
      request(
        ledger,
        "merge-result",
        {
          operation_id: "merge-a",
          outcome: "succeeded",
          provider_evidence: {
            id: "merge-fact",
            kind: "pr_merged",
            subject_id: "a",
            status: "passed",
            source: "github",
            observed_at: at,
            sha: merge,
            evidence_ref: "provider-receipt",
          },
          provider_observation: {
            pr,
            head_sha: head,
            base_sha: base,
            merge_sha: merge,
            state: "merged",
          },
        },
        taskActor,
      ),
    );
    expect(ready(ledger, "c")).toBe(true);
    expect(ledger.groups[0].current_sha).toBe(merge);
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "stale-c", {
          task_id: "c",
          operation_id: "dispatch-c",
        }),
      ),
    ).toThrow("base");
    apply(
      ledger,
      "task-base",
      request(ledger, "update-base-c", { task_id: "c", base_sha: merge }),
    );
    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "claim-c", {
          task_id: "c",
          operation_id: "dispatch-c",
        }),
      ),
    ).not.toThrow();
  });

  test("reconciles an external parent update-branch with exact provider evidence", () => {
    const ledger = fixture();
    const parentPr = {
      provider: "github",
      repository: "example/repo",
      id: "parent-1291",
      url: "https://github.com/example/repo/pull/1291",
    };
    ledger.groups[0]!.parent_pr = parentPr;
    const next = "c".repeat(40);
    const payload = {
      group_id: "g",
      provider_observation: {
        operation: "update-branch",
        branch: "parent",
        previous_sha: base,
        sha: next,
        parent_pr: parentPr,
        source: "github",
        evidence_ref: "github-update-branch-1291",
      },
    };

    expect(() =>
      apply(
        ledger,
        "group-base",
        request(
          ledger,
          "still-blocked",
          {
            group_id: "g",
            provider_observation: {
              branch: "parent",
              sha: next,
              source: "github",
              evidence_ref: "wrong-command",
            },
          },
          groupActor,
        ),
      ),
    ).toThrow("explicit reconciliation");
    expect(() =>
      apply(
        ledger,
        "group-base-reconcile",
        request(ledger, "reconcile-parent", payload, groupActor),
      ),
    ).not.toThrow();
    expect(ledger.groups[0]!.current_sha).toBe(next);
    expect(ledger.events.at(-1)).toMatchObject({
      type: "group_base_reconciled",
      data: {
        operation: "update-branch",
        previous_sha: base,
        sha: next,
        evidence_ref: "github-update-branch-1291",
      },
    });
  });

  test("rejects unsafe parent update-branch reconciliation without mutating the ledger", () => {
    const ledger = fixture();
    const parentPr = {
      provider: "github",
      repository: "example/repo",
      id: "parent-1291",
      url: "https://github.com/example/repo/pull/1291",
    };
    ledger.groups[0]!.parent_pr = parentPr;
    const next = "c".repeat(40);
    const basePayload = {
      group_id: "g",
      provider_observation: {
        operation: "update-branch",
        branch: "parent",
        previous_sha: base,
        sha: next,
        parent_pr: parentPr,
        source: "github",
        evidence_ref: "github-update-branch-1291",
      },
    };
    const before = JSON.stringify(ledger);
    expect(() =>
      apply(
        ledger,
        "group-base-reconcile",
        request(
          ledger,
          "wrong-operation",
          {
            ...basePayload,
            provider_observation: {
              ...basePayload.provider_observation,
              operation: "merge",
            },
          },
          groupActor,
        ),
      ),
    ).toThrow();
    expect(() =>
      apply(
        ledger,
        "group-base-reconcile",
        request(
          ledger,
          "wrong-old-sha",
          {
            ...basePayload,
            provider_observation: {
              ...basePayload.provider_observation,
              previous_sha: "d".repeat(40),
            },
          },
          groupActor,
        ),
      ),
    ).toThrow("ledger's current parent SHA");
    expect(() =>
      apply(
        ledger,
        "group-base-reconcile",
        request(
          ledger,
          "wrong-parent-pr",
          {
            ...basePayload,
            provider_observation: {
              ...basePayload.provider_observation,
              parent_pr: { ...parentPr, id: "other" },
            },
          },
          groupActor,
        ),
      ),
    ).toThrow("registered parent PR");
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("cut waits for an active merge and preserves the final integration boundary", () => {
    const ledger = fixture();
    approve(ledger);
    const deployment = {
      ...structuredClone(ledger.tasks[2]),
      id: "deploy",
      title: "Deploy",
      kind: "deployment" as const,
    };
    ledger.tasks.push(deployment);
    ledger.plans[0].nodes.push({
      id: "node-deploy",
      kind: "task",
      ref_id: "deploy",
      group_id: "g",
      label: "Deploy",
      estimate_minutes: null,
      estimate_basis: null,
      estimate_confidence: null,
    });
    const taskA = ledger.tasks.find((item) => item.id === "a")!;
    taskA.state = "integrated";
    ledger.events.push({
      id: "task-a-boundary",
      type: "task_integrated",
      subject_id: "a",
      actor_id: groupActor.thread_id,
      occurred_at: at,
      recorded_at: at,
      data: { task_id: "a", group_id: "g", state: "integrated" },
    });
    const taskB = ledger.tasks.find((item) => item.id === "b")!;
    taskB.state = "running";
    taskB.thread_id = "task-b";
    ledger.events.push({
      id: "task-b-boundary",
      type: "task_started",
      subject_id: "b",
      actor_id: "task-b",
      occurred_at: at,
      recorded_at: at,
      data: { task_id: "b", group_id: "g", state: "running" },
    });
    const actor = { role: "task", thread_id: "task-b" } as const;
    const pr = {
      provider: "github",
      repository: "example/repo",
      id: "2",
      url: "https://github.com/example/repo/pull/2",
    };
    apply(
      ledger,
      "task-pr",
      request(ledger, "pr-b", { task_id: "b", pr }, actor),
    );
    apply(
      ledger,
      "review-record",
      request(
        ledger,
        "review-b",
        {
          task_id: "b",
          base_sha: base,
          evidence: {
            id: "review-b",
            kind: "child_review",
            subject_id: "b",
            status: "passed",
            source: "group-thread",
            observed_at: at,
            sha: head,
            evidence_ref: "review-proof",
          },
        },
        groupActor,
      ),
    );
    const claim = {
      operation_id: "merge-b",
      group_id: "g",
      task_id: "b",
      target_branch: "parent",
      expected_base_sha: base,
      expected_head_sha: head,
      pr,
    };
    apply(ledger, "merge-claim", request(ledger, "claim-b", claim, actor));
    const cut = apply(
      ledger,
      "cut-claim",
      request(ledger, "cut-claim", {
        operation_id: "cut-op",
        group_id: "g",
        rule_id: "cut",
      }),
    ) as any;
    expect(cut.result.drained).toBe(false);
    const next = {
      id: "g-next",
      title: "Next",
      agent_thread_id: null,
      state: "planned",
      parent_branch: null,
      parent_pr: null,
      cut_sha: null,
      current_sha: null,
      merge_sha: null,
      requirements_path: null,
    };
    const cutPayload = {
      operation_id: "cut-op",
      cut_sha: merge,
      included_task_ids: ["a", "b"],
      next_group: next,
      provider_evidence: {
        source: "github",
        observed_at: at,
        sha: merge,
        evidence_ref: "cut-proof",
      },
    };
    expect(() =>
      apply(ledger, "cut-apply", request(ledger, "cut-too-early", cutPayload)),
    ).toThrow("pending merges");
    apply(
      ledger,
      "merge-resolve",
      request(
        ledger,
        "merge-b-result",
        {
          operation_id: "merge-b",
          outcome: "succeeded",
          provider_evidence: {
            id: "merge-b-fact",
            kind: "pr_merged",
            subject_id: "b",
            status: "passed",
            source: "github",
            observed_at: at,
            sha: merge,
            evidence_ref: "provider-receipt",
          },
          provider_observation: {
            pr,
            head_sha: head,
            base_sha: base,
            merge_sha: merge,
            state: "merged",
          },
        },
        actor,
      ),
    );
    const contaminated = structuredClone(cutPayload) as any;
    contaminated.next_group.coordination_execution = { state: "running", reason: null, waiting_for_task_ids: [] };
    expect(() => apply(ledger, "cut-apply", request(ledger, "cut-contaminated", contaminated))).toThrow("pre-existing runtime");
    const bootstrapCut = structuredClone(cutPayload) as any;
    bootstrapCut.next_group.delivery_unit_kind = "bootstrap";
    bootstrapCut.next_group.owner_kind = "main";
    const beforeRejectedCut = structuredClone(ledger);
    expect(() => apply(ledger, "cut-apply", request(ledger, "cut-bootstrap", bootstrapCut))).toThrow("only be created during run initialization");
    expect(ledger).toEqual(beforeRejectedCut);
    apply(ledger, "cut-apply", request(ledger, "cut-finished", cutPayload));
    expect(ledger.groups.find((item) => item.id === "g")!.cut_sha).toBe(merge);
    expect(ledger.plans[0]!.cut_rules[0]!.status).toBe("applied");
    expect(ledger.tasks.find((item) => item.id === "a")!.group_id).toBe("g");
    expect(ledger.tasks.find((item) => item.id === "b")!.group_id).toBe("g");
    expect(ledger.tasks.find((item) => item.id === "c")!.group_id).toBe(
      "g-next",
    );
    expect(ledger.tasks.find((item) => item.id === "deploy")!.group_id).toBe(
      "g",
    );
    const newBase = {
      group_id: "g-next",
      provider_observation: {
        branch: "next",
        sha: merge,
        source: "github",
        evidence_ref: "base-proof",
        ancestor_sha: merge,
      },
    };
    expect(() =>
      apply(ledger, "group-base", request(ledger, "too-early-base", newBase)),
    ).toThrow("not merged");
    ledger.groups.find((item) => item.id === "g")!.state = "merged";
    ledger.groups.find((item) => item.id === "g")!.merge_sha = merge;
    expect(() =>
      apply(ledger, "group-base", request(ledger, "new-base", newBase)),
    ).not.toThrow();
  });

  test("validates a starting task boundary after a dynamic cut", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.tasks.find((item) => item.id === "a")!.state = "integrated";
    ledger.events.push({
      id: "starting-cut-task-a",
      type: "task_integrated",
      subject_id: "a",
      actor_id: groupActor.thread_id,
      occurred_at: at,
      recorded_at: at,
      data: { task_id: "a", group_id: "g", state: "integrated" },
    });
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "starting-cut-claim", {
        task_id: "b",
        operation_id: "starting-cut-dispatch",
      }),
    );
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "starting-cut-bind", {
        operation_id: "starting-cut-dispatch",
        outcome: "succeeded",
        thread_id: "task-b",
        native_evidence: { source: "create_thread" },
      }),
    );
    const cut = apply(
      ledger,
      "cut-claim",
      request(ledger, "starting-cut-claim-op", {
        operation_id: "starting-cut-op",
        group_id: "g",
        rule_id: "cut",
      }),
    ) as any;
    const next = {
      id: "g-next",
      title: "Next",
      agent_thread_id: null,
      state: "planned",
      parent_branch: null,
      parent_pr: null,
      cut_sha: null,
      current_sha: null,
      merge_sha: null,
      requirements_path: null,
    };
    apply(
      ledger,
      "cut-apply",
      request(ledger, "starting-cut-apply", {
        operation_id: cut.result.operation_id,
        cut_sha: base,
        included_task_ids: ["a"],
        next_group: next,
        provider_evidence: {
          source: "github",
          observed_at: at,
          sha: base,
          evidence_ref: "starting-cut-proof",
        },
      }),
    );

    expect(ledger.tasks.find((item) => item.id === "b")!.state).toBe(
      "starting",
    );
    expect(() => validateLedger(ledger)).not.toThrow();
  });

  test("allows a plan revision after a dynamic cut", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.tasks.find((item) => item.id === "a")!.state = "integrated";
    ledger.events.push({
      id: "revision-cut-task-a",
      type: "task_integrated",
      subject_id: "a",
      actor_id: groupActor.thread_id,
      occurred_at: at,
      recorded_at: at,
      data: { task_id: "a", group_id: "g", state: "integrated" },
    });

    const cut = apply(
      ledger,
      "cut-claim",
      request(ledger, "revision-cut-claim", {
        operation_id: "revision-cut",
        group_id: "g",
        rule_id: "cut",
      }),
    ) as any;
    const next = {
      id: "g-next",
      title: "Next",
      agent_thread_id: null,
      state: "planned",
      parent_branch: null,
      parent_pr: null,
      cut_sha: null,
      current_sha: null,
      merge_sha: null,
      requirements_path: null,
    };
    apply(
      ledger,
      "cut-apply",
      request(ledger, "revision-cut-apply", {
        operation_id: cut.result.operation_id,
        cut_sha: base,
        included_task_ids: ["a"],
        next_group: next,
        provider_evidence: {
          source: "github",
          observed_at: at,
          sha: base,
          evidence_ref: "revision-cut-proof",
        },
      }),
    );

    const proposed = structuredClone(ledger.plans[0]!);
    proposed.id = "plan-revision";
    proposed.supersedes_id = ledger.active_plan_id;
    proposed.approval_id = null;
    proposed.nodes.find(
      (node) => node.kind === "task" && node.ref_id === "a",
    )!.label = "a revised";
    expect(() =>
      apply(
        ledger,
        "plan-propose",
        request(ledger, "plan-revision-propose", {
          plan: proposed,
          groups: structuredClone(ledger.groups),
          tasks: structuredClone(ledger.tasks),
        }),
      ),
    ).not.toThrow();
    expect(ledger.active_plan_id).toBe("plan-revision");
    expect(() => validateLedger(ledger)).not.toThrow();
  });

  test("rejects delivery-unit ownership rewrites in a plan revision", () => {
    const ledger = fixture();
    const proposed = structuredClone(ledger.plans[0]!);
    proposed.id = "plan-owner-rewrite";
    proposed.supersedes_id = ledger.active_plan_id;
    const groups = structuredClone(ledger.groups);
    groups[0]!.delivery_unit_kind = "bootstrap";
    groups[0]!.owner_kind = "main";
    groups[0]!.agent_thread_id = null;
    const originalGroups = structuredClone(ledger.groups);
    const originalEvents = structuredClone(ledger.events);
    expect(() => apply(ledger, "plan-propose", request(ledger, "owner-rewrite", {
      plan: proposed, groups, tasks: structuredClone(ledger.tasks),
    }))).toThrow("Plan revision cannot overwrite runtime group g");
    expect(ledger.groups).toEqual(originalGroups);
    expect(ledger.events).toEqual(originalEvents);
  });

  test("rejects a new bootstrap introduced by plan revision without changing history", () => {
    const ledger = fixture();
    const proposed = structuredClone(ledger.plans[0]!);
    proposed.id = "plan-retrofit-bootstrap";
    proposed.supersedes_id = ledger.active_plan_id;
    const newGroup = {
      ...structuredClone(ledger.groups[0]!), id: "new-bootstrap", state: "planned",
      delivery_unit_kind: "bootstrap", owner_kind: "main", agent_thread_id: null,
      parent_branch: null, parent_pr: null, current_sha: null,
    };
    const before = structuredClone(ledger);
    expect(() => apply(ledger, "plan-propose", request(ledger, "retrofit-bootstrap", {
      plan: proposed, groups: [...structuredClone(ledger.groups), newGroup],
      tasks: structuredClone(ledger.tasks),
    }))).toThrow("only be created during run initialization");
    expect(ledger).toEqual(before);
  });

  test("rejects pre-bound entities introduced by a plan revision", () => {
    const ledger = fixture();
    const proposed = structuredClone(ledger.plans[0]!);
    proposed.id = "plan-with-new-runtime";
    proposed.supersedes_id = ledger.active_plan_id;
    const newGroup = {
      ...structuredClone(ledger.groups[0]!),
      id: "g-new",
      agent_thread_id: "existing-thread",
      state: "active",
    };
    const newTask = {
      ...structuredClone(ledger.tasks[0]!),
      id: "d",
      group_id: "g-new",
      thread_id: "existing-task-thread",
      state: "running",
    };
    proposed.nodes.push({
      id: "node-d",
      kind: "task",
      ref_id: "d",
      group_id: "g-new",
      label: "d",
      estimate_minutes: null,
      estimate_basis: null,
      estimate_confidence: null,
    });

    expect(() =>
      apply(
        ledger,
        "plan-propose",
        request(ledger, "plan-prebound", {
          plan: proposed,
          groups: [...structuredClone(ledger.groups), newGroup],
          tasks: [...structuredClone(ledger.tasks), newTask],
        }),
      ),
    ).toThrow("New task d must start as planned and unbound");
  });
  test("creates a proactive notification intent and records Codex delivery outcomes", () => {
    const ledger = fixture();
    const task = ledger.tasks.find((item) => item.id === "a")!;
    task.thread_id = "task-a";
    task.state = "running";
    const taskActor = { role: "task", thread_id: "task-a" } as const;
    const update = apply(
      ledger,
      "task-update",
      request(
        ledger,
        "wait-with-notice",
        {
          task_id: "a",
          state: "waiting",
          detail: "Waiting for owner input",
          notification: { mode: "deliver", recipient: "owner" },
        },
        taskActor,
      ),
    ) as any;
    const notice = ledger.notifications[0]!;
    expect(update.result.notification_id).toBe(notice.id);
    expect(notice).toMatchObject({
      status: "pending",
      delivery_status: "pending",
      ack_status: "unacknowledged",
      attempts: 0,
    });

    const sent = apply(
      ledger,
      "notification-deliver",
      request(
        ledger,
        "deliver-notice",
        {
          notification_id: notice.id,
          delivery_attempt_id: "attempt-1",
          outcome: "sent",
          provider_receipt: {
            provider: "codex",
            evidence_ref: "codex-message-1",
            message_id: "message-1",
          },
        },
        taskActor,
      ),
    ) as any;
    const sentNotice = ledger.notifications.find(
      (item) => item.id === notice.id,
    )!;
    expect(sent.result).toMatchObject({
      notification_id: notice.id,
      delivery_attempt_id: "attempt-1",
      delivery_status: "sent",
      ack_status: "unacknowledged",
    });
    expect(sentNotice.last_attempt_id).toBe("attempt-1");

    const acknowledged = apply(
      ledger,
      "notification-ack",
      request(
        ledger,
        "ack-notice",
        {
          notification_id: notice.id,
          handling_evidence: "owner-read-and-handled",
        },
        main,
      ),
    ) as any;
    const acknowledgedNotice = ledger.notifications.find(
      (item) => item.id === notice.id,
    )!;
    expect(acknowledged.result.ack_status).toBe("acknowledged");
    expect(acknowledgedNotice.status).toBe("acknowledged");
  });

  test("supports none and legacy notify_main while rejecting duplicate delivery attempts", () => {
    const none = fixture();
    const noneTask = none.tasks.find((item) => item.id === "a")!;
    noneTask.thread_id = "task-a";
    noneTask.state = "running";
    apply(
      none,
      "task-update",
      request(
        none,
        "wait-without-notice",
        {
          task_id: "a",
          state: "waiting",
          detail: "No notification",
          notification: { mode: "none" },
        },
        { role: "task", thread_id: "task-a" },
      ),
    );
    expect(none.notifications).toHaveLength(0);

    const legacy = fixture();
    const legacyTask = legacy.tasks.find((item) => item.id === "a")!;
    legacyTask.thread_id = "task-a";
    legacyTask.state = "running";
    apply(
      legacy,
      "task-update",
      request(
        legacy,
        "legacy-notice",
        {
          task_id: "a",
          state: "waiting",
          detail: "Legacy notification",
          notify_main: true,
        },
        { role: "task", thread_id: "task-a" },
      ),
    );
    const notice = legacy.notifications[0]!;
    apply(
      legacy,
      "notification-deliver",
      request(
        legacy,
        "unknown-notice",
        {
          notification_id: notice.id,
          delivery_attempt_id: "attempt-unknown",
          outcome: "unknown",
          provider_receipt: {
            provider: "codex",
            evidence_ref: "codex-timeout",
          },
        },
        { role: "task", thread_id: "task-a" },
      ),
    );
    expect(
      legacy.notifications.find((item) => item.id === notice.id)!.status,
    ).toBe("unknown");
    expect(() =>
      apply(
        legacy,
        "notification-deliver",
        request(
          legacy,
          "blocked-retry",
          {
            notification_id: notice.id,
            delivery_attempt_id: "attempt-retry",
            outcome: "sent",
            provider_receipt: {
              provider: "codex",
              evidence_ref: "codex-retry",
            },
          },
          { role: "task", thread_id: "task-a" },
        ),
      ),
    ).toThrow("Unknown delivery must be reconciled");
    apply(
      legacy,
      "notification-reconcile",
      request(
        legacy,
        "reconcile-notice",
        {
          notification_id: notice.id,
          reconciliation_id: "reconcile-unknown",
          outcome: "failed",
          provider_receipt: {
            provider: "codex",
            evidence_ref: "codex-reconciled",
          },
        },
        { role: "main", thread_id: "main-thread" },
      ),
    );
    expect(() =>
      apply(
        legacy,
        "notification-deliver",
        request(
          legacy,
          "duplicate-attempt",
          {
            notification_id: notice.id,
            delivery_attempt_id: "attempt-unknown",
            outcome: "sent",
            provider_receipt: {
              provider: "codex",
              evidence_ref: "codex-reconciled",
            },
          },
          { role: "task", thread_id: "task-a" },
        ),
      ),
    ).toThrow("Delivery attempt identity already exists");
  });

  test("normalizes legacy notification rows without rewriting their meaning", () => {
    const ledger = fixture();
    ledger.notifications.push({
      id: "legacy-notification",
      event_id: "legacy-event",
      recipient_thread_id: "main-thread",
      status: "acknowledged",
      attempts: 0,
      updated_at: at,
    } as any);
    const normalized = validateLedger(ledger);
    expect(normalized.notifications[0]).toMatchObject({
      id: "legacy-notification",
      ledger_status: "committed",
      delivery_status: "sent",
      ack_status: "acknowledged",
      last_attempt_id: null,
      last_reconciliation_id: null,
    });
  });

  test("stores independent complete execution profiles and freezes after binding", () => {
    const ledger = fixture();
    const updated = apply(ledger, "execution-profile-update", request(ledger, "profile-a", {
      target_type: "task",
      target_id: "a",
      execution_profile: { model: "gpt-6.1-sol", thinking: "high" },
    }));
    expect((updated as any).result).toMatchObject({ target_id: "a" });
    expect(ledger.tasks[0].execution_profile).toEqual({ model: "gpt-6.1-sol", thinking: "high" });
    expect(ledger.groups[0].execution_profile).toBeNull();
    expect(() => apply(ledger, "execution-profile-update", request(ledger, "partial-profile", {
      target_type: "task", target_id: "a", execution_profile: { model: "gpt-6-luna" },
    }))).toThrow();
    ledger.tasks[0].thread_id = "created-thread";
    expect(() => apply(ledger, "execution-profile-update", request(ledger, "frozen-profile", {
      target_type: "task", target_id: "a", execution_profile: null,
    }))).toThrow("frozen");
  });
  test("native request freezes both editing and recommendation, including unknown creation", () => {
    const ledger = fixture(); approve(ledger);
    apply(ledger, "dispatch-claim", request(ledger, "claim-profile", { task_id: "a", operation_id: "profile-op" }));
    apply(ledger, "dispatch-bind-request", request(ledger, "native-profile", { operation_id: "profile-op", native_request_id: "native-profile" }));
    for (const command of ["execution-profile-update", "execution-profile-recommend"]) {
      expect(() => apply(ledger, command, request(ledger, command, { target_type: "task", target_id: "a", execution_profile: null }))).toThrow("frozen");
    }
    apply(ledger, "dispatch-resolve", request(ledger, "unknown-profile", { operation_id: "profile-op", outcome: "unknown" }));
    expect(() => apply(ledger, "execution-profile-update", request(ledger, "edit-unknown", { target_type: "task", target_id: "a", execution_profile: null }))).toThrow("frozen");
    expect(ledger.operations.find((item) => item.id === "profile-op")?.request.execution_profile).toEqual(ledger.config.execution_profile);
  });

  test("profile change cancels an unbound claim and recommendation preserves its audit history", () => {
    const ledger = fixture(); approve(ledger);
    apply(ledger, "dispatch-claim", request(ledger, "claim-profile", { task_id: "a", operation_id: "profile-op" }));
    apply(ledger, "execution-profile-update", request(ledger, "manual-profile", { target_type: "task", target_id: "a", execution_profile: { model: "gpt-6-luna", thinking: "high" } }));
    expect(ledger.operations.find((item) => item.id === "profile-op")?.status).toBe("failed");
    expect(ledger.events.find((item) => item.type === "dispatch_claim_replaced")?.data.previous_effective_profile).toEqual(ledger.config.execution_profile);
    expect(ledger.tasks[0].execution_profile_source).toBe("manual");
    apply(ledger, "execution-profile-recommend", request(ledger, "recommend-profile", { target_type: "task", target_id: "a" }));
    expect(ledger.tasks[0].execution_profile).toEqual({ model: "gpt-6.1-sol", thinking: "high" });
    expect(ledger.events.at(-1)?.data.previous_profile).toEqual({ model: "gpt-6-luna", thinking: "high" });
  });

  test("legacy profile migration requires a full explicit pair and exact revision", () => {
    const ledger = fixture(); ledger.config.execution_profile = null;
    expect(() => approve(ledger)).toThrow("read-only");
    expect(() => apply(ledger, "execution-profile-migrate", request(ledger, "partial", { execution_profile: { model: "gpt-6-luna" } }))).toThrow();
    const input = request(ledger, "migrate-profile", { execution_profile: { model: "gpt-6-luna", thinking: "medium" } });
    apply(ledger, "execution-profile-migrate", input);
    expect(ledger.revision).toBe(1);
    expect((apply(ledger, "execution-profile-migrate", input) as any).code).toBe("REPLAYED");
    expect(ledger.events.at(-1)?.type).toBe("execution_profile_migrated");
  });

});

describe("native CLI handoff contract", () => {
  function claimed() {
    const ledger = fixture(); approve(ledger);
    apply(ledger, "dispatch-claim", request(ledger, "cli-claim", { task_id: "a", operation_id: "cli-a" }));
    apply(ledger, "dispatch-bind-request", request(ledger, "cli-bind", { operation_id: "cli-a", native_request_id: "cli-request", creation_parameters: {
      title: "task", prompt: "formal", cwd: "/repo", transport: "codex-exec", execution_profile: ledger.config.execution_profile,
    } }));
    return ledger;
  }
  function resolve(ledger: ReturnType<typeof fixture>, exit_code = 0) {
    return request(ledger, "cli-resolve", { operation_id: "cli-a", outcome: "succeeded", thread_id: "cli-thread",
      native_evidence: { source: "multi-task-flow-cli", native_tool_name: "codex exec", operation_id: "cli-a", native_request_id: "cli-request",
        ...ledger.config.execution_profile, created_at: at, evidence_ref: "codex-exec:cli-request", thread_id: "cli-thread",
        exit_code, turn_completed: true, workspace_path: "/owned/worktree", initial_head: head } });
  }
  test("native success cannot omit the transport used by baseline and handoff gates", () => {
    for (const parameters of [undefined, { cwd: "/repo" }]) {
      const ledger = claimed();
      ledger.operations[0].request.creation_parameters = parameters;
      apply(ledger, "dispatch-progress", request(ledger, "observed", {
        operation_id: "cli-a", native_request_id: "cli-request", thread_id: "cli-thread",
      }));
      const before = JSON.stringify(ledger);
      expect(() => apply(ledger, "dispatch-resolve", resolve(ledger))).toThrow("bound native transport");
      expect(JSON.stringify(ledger)).toBe(before);
      expect(ledger.tasks[0].thread_id).toBeNull();
    }
  });
  test("identity is durable before binding; failed exit cannot bind and replay cannot create again", () => {
    const ledger = claimed();
    expect(() => apply(ledger, "dispatch-resolve", resolve(ledger))).toThrow("observed identity");
    const progress = request(ledger, "cli-observed", { operation_id: "cli-a", native_request_id: "cli-request", thread_id: "cli-thread" });
    apply(ledger, "dispatch-progress", progress);
    expect(ledger.tasks[0].thread_id).toBeNull();
    expect(ledger.operations[0].request.observed_thread_id).toBe("cli-thread");
    expect((apply(ledger, "dispatch-progress", progress) as any).code).toBe("REPLAYED");
    expect(() => apply(ledger, "dispatch-resolve", resolve(ledger, 1))).toThrow("CLI exit");
    apply(ledger, "dispatch-resolve", resolve(ledger));
    expect(ledger.tasks[0].thread_id).toBe("cli-thread");
    expect(ledger.notifications[0].recipient_thread_id).toBe("cli-thread");
    expect(ledger.notifications[0].delivery_status).toBe("pending");
    expect(() => apply(ledger, "dispatch-claim", request(ledger, "duplicate-create", { task_id: "a", operation_id: "second-a" }))).toThrow();
  });
  test("observed CLI identity cannot release the claim through failed or legacy evidence", () => {
    const ledger = claimed();
    apply(ledger, "dispatch-progress", request(ledger, "observed-before-failure", { operation_id: "cli-a", native_request_id: "cli-request", thread_id: "cli-thread" }));
    for (const native_tool_name of ["codex exec", "thread/start"]) {
      const failure = resolve(ledger);
      Object.assign(failure.payload, { outcome: "failed" });
      Object.assign(failure.payload.native_evidence, { native_tool_name, error: "Initialization failed", process_started: false, resources_created: false });
      expect(() => apply(ledger, "dispatch-resolve", failure)).toThrow();
      expect(ledger.operations[0].status).toBe("unknown");
      expect(ledger.operations[0].request.observed_thread_id).toBe("cli-thread");
      expect(() => apply(ledger, "dispatch-claim", request(ledger, `retry-${native_tool_name}`, { task_id: "a", operation_id: "duplicate-a" }))).toThrow();
    }
    const unobserved = claimed();
    const failure = resolve(unobserved);
    Object.assign(failure.payload, { outcome: "failed" });
    Object.assign(failure.payload.native_evidence, { error: "No event received after process start" });
    expect(() => apply(unobserved, "dispatch-resolve", failure)).toThrow("require reconciliation");
    expect(unobserved.operations[0].status).toBe("unknown");
  });
  test("same native request freezes every creation parameter, including transport", () => {
    const ledger = claimed();
    const parameters = structuredClone(ledger.operations[0].request.creation_parameters) as any;
    for (const change of [{ transport: undefined }, { cwd: "/another-repo" }, { prompt: "different task" },
      { title: "different title" }, { execution_profile: { model: "gpt-6-luna", thinking: "low" } }]) {
      const before = JSON.stringify(ledger);
      expect(() => apply(ledger, "dispatch-bind-request", request(ledger, `rebind-${Object.keys(change)[0]}`, {
        operation_id: "cli-a", native_request_id: "cli-request", creation_parameters: { ...parameters, ...change },
      }))).toThrow("frozen");
      expect(JSON.stringify(ledger)).toBe(before);
    }
    apply(ledger, "dispatch-bind-request", request(ledger, "identical-rebind", {
      operation_id: "cli-a", native_request_id: "cli-request", creation_parameters: parameters,
    }));
    apply(ledger, "dispatch-bind-request", request(ledger, "identity-only-rebind", {
      operation_id: "cli-a", native_request_id: "cli-request",
    }));
    expect(ledger.operations[0].request.creation_parameters).toEqual(parameters);
    expect(ledger.operations[0].status).toBe("unknown");
  });
  test("unknown reports retain creation facts across later empty reports and cannot release retry protection", () => {
    for (const report of [{ thread_id: "cli-thread" }, { native_evidence: { workspace_path: "/allocated" } },
      { native_evidence: { initial_head: head } }, { native_evidence: { exit_code: 1 } },
      { native_evidence: { turn_completed: true } }, { native_evidence: { events: ["turn.started"] } },
      { native_evidence: { process_started: true } }, { native_evidence: { resources_created: true } }]) {
      const ledger = claimed();
      apply(ledger, "dispatch-resolve", request(ledger, "known-unknown", { operation_id: "cli-a", outcome: "unknown", ...report }));
      const observed = structuredClone(ledger.operations[0].request.creation_observations);
      expect(Object.keys(observed as object).length).toBeGreaterThan(0);
      apply(ledger, "dispatch-resolve", request(ledger, "empty-unknown", { operation_id: "cli-a", outcome: "unknown" }));
      expect(ledger.operations[0].request.creation_observations).toEqual(observed);
      const failure = request(ledger, "false-preflight", { operation_id: "cli-a", outcome: "failed", native_evidence: {
        source: "multi-task-flow-cli", native_tool_name: "codex exec", operation_id: "cli-a", native_request_id: "cli-request",
        ...ledger.config.execution_profile, created_at: at, evidence_ref: "preflight:incorrect", error: "No resources",
        process_started: false, resources_created: false,
      } });
      expect(() => apply(ledger, "dispatch-resolve", failure)).toThrow("require reconciliation");
      expect(ledger.operations[0].status).toBe("unknown");
      expect(() => apply(ledger, "dispatch-claim", request(ledger, "retry-known", { task_id: "a", operation_id: "duplicate-a" }))).toThrow();
    }
  });
  test("historical unknown identity blocks failed resolution even without exec transport or progress event", () => {
    const ledger = claimed();
    delete (ledger.operations[0].request.creation_parameters as any).transport;
    ledger.operations[0].request.creation_result = { outcome: "unknown", thread_id: "prior-cli-thread" };
    const before = JSON.stringify(ledger);
    const failure = request(ledger, "historical-failure", { operation_id: "cli-a", outcome: "failed", native_evidence: {
      source: "multi-task-flow-cli", native_tool_name: "thread/start", operation_id: "cli-a", native_request_id: "cli-request",
      ...ledger.config.execution_profile, created_at: at, evidence_ref: "legacy:failure", error: "Failed",
    } });
    expect(() => apply(ledger, "dispatch-resolve", failure)).toThrow("require reconciliation");
    expect(JSON.stringify(ledger)).toBe(before);
    apply(ledger, "dispatch-resolve", request(ledger, "retain-history", { operation_id: "cli-a", outcome: "unknown" }));
    expect(ledger.operations[0].request.observed_thread_id).toBe("prior-cli-thread");
    expect(() => apply(ledger, "dispatch-resolve", request(ledger, "replace-known-id", {
      operation_id: "cli-a", outcome: "unknown", thread_id: "contradictory-thread",
    }))).toThrow("cannot change");
  });
  test("development waits for owned workspace readiness and the current parent SHA, separate from initial HEAD", () => {
    const ledger = claimed();
    apply(ledger, "dispatch-progress", request(ledger, "cli-observed", { operation_id: "cli-a", native_request_id: "cli-request", thread_id: "cli-thread" }));
    apply(ledger, "dispatch-resolve", resolve(ledger));
    const actor = { role: "task" as const, thread_id: "cli-thread" };
    expect(() => apply(ledger, "task-update", request(ledger, "too-early", { task_id: "a", state: "running", detail: "Start after readiness", occurred_at: at }, actor))).toThrow("baseline");
    apply(ledger, "task-runtime-observe", request(ledger, "initial-idle", {
      task_id: "a", thread_id: "cli-thread", runtime: "idle", turn_id: "completed-initialization", observed_at: new Date().toISOString(),
    }));
    expect(ledger.tasks[0].state).toBe("agent_idle");
    expect(() => apply(ledger, "task-update", request(ledger, "idle-too-early", { task_id: "a", state: "running", detail: "Resume after readiness", occurred_at: at }, actor))).toThrow("baseline");
    ledger.config.max_running_tasks = 1;
    ledger.resources = [ { id: "wt", kind: "worktree", target: "a", status: "active", evidence_ref: "owned:cli-thread" }, { id: "br", kind: "branch", target: "task-a", status: "active", evidence_ref: "owned:branch" } ];
    const payload = { target_type: "task", target_id: "a", stage: "workspace_ready", branch: "task-a", resource_ids: ["wt", "br"], evidence_ref: "git:clean" };
    expect(() => apply(ledger, "lifecycle-record", request(ledger, "missing-baseline", payload, actor))).toThrow();
    expect(() => apply(ledger, "lifecycle-record", request(ledger, "wrong-baseline", { ...payload, baseline: { sha: head, head, clean: true, source: "group:g" } }, actor))).toThrow("parent SHA");
    expect(() => apply(ledger, "lifecycle-record", request(ledger, "dirty-baseline", { ...payload, baseline: { sha: base, head: base, clean: false, source: "group:g" } }, actor))).toThrow();
    apply(ledger, "lifecycle-record", request(ledger, "ready-baseline", { ...payload, baseline: { sha: base, head: base, clean: true, source: "group:g" } }, actor));
    apply(ledger, "task-update", request(ledger, "start", { task_id: "a", state: "running", detail: "Start after readiness", occurred_at: at }, actor));
    expect(ledger.tasks[0].base_sha).toBe(base);
    expect((ledger.operations[0].request.creation_result as any).native_evidence.initial_head).toBe(head);
  });
});

test("native group retry ignores a failed attempt and still requires a fresh mainline baseline receipt", () => {
  const ledger = fixture(); approve(ledger);
  Object.assign(ledger.groups[0], { agent_thread_id: null, state: "planned", parent_branch: null, current_sha: null });
  const invoke = (command: string, requestId: string, payload: any, actor: Request["actor"] = main) => apply(ledger, command, request(ledger, requestId, payload, actor));
  invoke("dispatch-group-claim", "failed-cli", { group_id: "g", operation_id: "failed-cli" });
  invoke("dispatch-bind-request", "failed-bind", { operation_id: "failed-cli", native_request_id: "failed-native", creation_parameters: { title: "group", prompt: "formal", cwd: "/repo", execution_profile: ledger.config.execution_profile, transport: "codex-exec" } });
  invoke("dispatch-resolve", "failed-resolve", { operation_id: "failed-cli", outcome: "failed", native_evidence: { source: "multi-task-flow-cli", native_tool_name: "codex exec", operation_id: "failed-cli", native_request_id: "failed-native", ...ledger.config.execution_profile, evidence_ref: "codex:verified-no-resource", created_at: at, error: "Preflight verified process was not started and no resource was created", process_started: false, resources_created: false } });
  invoke("dispatch-group-claim", "group-cli", { group_id: "g", operation_id: "group-cli" });
  invoke("dispatch-bind-request", "group-bind", { operation_id: "group-cli", native_request_id: "group-native", creation_parameters: { title: "group", prompt: "formal", cwd: "/repo", execution_profile: ledger.config.execution_profile, transport: "codex-exec" } });
  expect(ledger.operations.at(-1)!.status).toBe("unknown");
  invoke("dispatch-progress", "group-observed", { operation_id: "group-cli", native_request_id: "group-native", thread_id: "group-thread" });
  invoke("dispatch-resolve", "group-resolved", { operation_id: "group-cli", thread_id: "group-thread", outcome: "succeeded", native_evidence: { source: "multi-task-flow-cli", native_tool_name: "codex exec", operation_id: "group-cli", native_request_id: "group-native", ...ledger.config.execution_profile, evidence_ref: "codex:group", created_at: at, thread_id: "group-thread", workspace_path: "/owned", initial_head: base, exit_code: 0, turn_completed: true } });
  expect(() => invoke("group-execution-update", "early-group", { group_id: "g", state: "running" }, groupActor)).toThrow("baseline");
  ledger.resources = [{ id: "gwt", kind: "worktree", target: "g", status: "active", evidence_ref: "owned" }, { id: "gbr", kind: "branch", target: "parent", status: "active", evidence_ref: "branch" }];
  const payload = { target_type: "group", target_id: "g", stage: "workspace_ready", branch: "parent", resource_ids: ["gwt", "gbr"], evidence_ref: "fresh-fetch" };
  expect(() => invoke("lifecycle-record", "no-fetch", { ...payload, baseline: { sha: head, head, clean: true, source: "remote:main" } }, groupActor)).toThrow("fresh remote fetch");
  expect(() => invoke("lifecycle-record", "stale-fetch", { ...payload, baseline: { sha: head, head, clean: true, source: "remote:main", fetched_at: at } }, groupActor)).toThrow("fresh remote fetch");
  invoke("lifecycle-record", "fresh-fetch", { ...payload, baseline: { sha: head, head, clean: true, source: "remote:main", fetched_at: new Date().toISOString() } }, groupActor);
  expect(ledger.groups[0].current_sha).toBe(head);
  invoke("group-execution-update", "group-start", { group_id: "g", state: "running" }, groupActor);
});
