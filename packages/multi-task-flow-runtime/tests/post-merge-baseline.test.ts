import { expect, test } from "bun:test";
import { apply } from "../lib/engine";
import { modernFixture, request } from "./role-flow-fixtures";

const at = "2026-01-01T00:00:00.000Z";
const merge = "c".repeat(40);
const main = { role: "main", thread_id: "main-thread" } as const;
const postMergeKinds = ["verification", "release", "deployment"] as const;

function run(
  ledger: ReturnType<typeof modernFixture>,
  command: string,
  requestId: string,
  payload: Record<string, unknown>,
  actor = main,
) {
  return apply(ledger, command, request(ledger, requestId, payload, actor));
}

function runPostMergeBaselineChain(kind: (typeof postMergeKinds)[number]) {
  const ledger = modernFixture();
  const group = ledger.groups.at(0);
  const task = ledger.tasks.at(0);
  if (!group || !task) throw new Error("post-merge fixture is incomplete");
  const dispatchOperationId = `dispatch-${kind}`;
  const taskThread = `task-${kind}`;

  task.kind = kind;
  group.state = "merged";
  group.merge_sha = merge;

  run(ledger, "dispatch-claim", `${kind}-dispatch-claim`, {
    task_id: task.id,
    operation_id: dispatchOperationId,
  });
  run(ledger, "dispatch-bind-request", `${kind}-dispatch-bind`, {
    operation_id: dispatchOperationId,
    native_request_id: `${kind}-native-request`,
    creation_parameters: {
      title: task.title,
      prompt: "post-merge task",
      cwd: "/workspace",
      execution_profile: ledger.config.execution_profile,
      transport: "codex-exec",
    },
  });
  run(ledger, "dispatch-progress", `${kind}-dispatch-progress`, {
    operation_id: dispatchOperationId,
    native_request_id: `${kind}-native-request`,
    thread_id: taskThread,
  });
  run(ledger, "dispatch-resolve", `${kind}-dispatch-resolve`, {
    operation_id: dispatchOperationId,
    outcome: "succeeded",
    thread_id: taskThread,
    native_evidence: {
      source: "multi-task-flow-cli",
      native_tool_name: "codex exec",
      operation_id: dispatchOperationId,
      native_request_id: `${kind}-native-request`,
      ...ledger.config.execution_profile,
      evidence_ref: `mock:${kind}:dispatch`,
      created_at: at,
      thread_id: taskThread,
      workspace_path: `/workspace/${kind}`,
      initial_head: merge,
      exit_code: 0,
      turn_completed: true,
    },
  });

  const actor = { role: "task" as const, thread_id: taskThread };
  run(
    ledger,
    "task-base",
    `${kind}-task-base`,
    {
      task_id: task.id,
      base_sha: merge,
      evidence: `mock:${kind}:base`,
    },
    actor,
  );

  const baseline = { sha: merge, head: merge, clean: true as const, source: "workspace-verifier" };
  run(
    ledger,
    "development-baseline-sync",
    `${kind}-baseline-sync`,
    {
      target_type: "task",
      target_id: task.id,
      dispatch_operation_id: dispatchOperationId,
      mode: "initial",
      expected_previous_baseline: null,
      expected_lineage_sha: merge,
      lineage_event_id: `${kind}-task-base`,
      branch: task.branch,
      resource_ids: ["task-worktree", "task-branch"],
      baseline,
      evidence_ref: `mock:${kind}:baseline`,
    },
    actor,
  );
  run(
    ledger,
    "lifecycle-record",
    `${kind}-workspace-ready`,
    {
      target_type: "task",
      target_id: task.id,
      stage: "workspace_ready",
      branch: task.branch,
      resource_ids: ["task-worktree", "task-branch"],
      baseline,
      evidence_ref: `mock:${kind}:workspace`,
    },
    actor,
  );
  run(
    ledger,
    "task-update",
    `${kind}-blocked`,
    {
      task_id: task.id,
      state: "blocked",
      detail: "waiting for post-merge verification input",
      occurred_at: at,
    },
    actor,
  );
  run(
    ledger,
    "task-update",
    `${kind}-resumed`,
    {
      task_id: task.id,
      state: "running",
      occurred_at: at,
    },
    actor,
  );

  return { ledger, task, dispatchOperationId };
}

test.each(postMergeKinds)(
  "%s tasks can restore task-base through blocked-to-running on merge_sha",
  (kind) => {
    const { ledger, dispatchOperationId } = runPostMergeBaselineChain(kind);
    const task = ledger.tasks.at(0);
    const dispatch = ledger.operations.find((item) => item.id === dispatchOperationId);
    if (!task || !dispatch)
      throw new Error("post-merge chain did not persist its task or dispatch");

    expect(task.base_sha).toBe(merge);
    expect(task.lifecycle.workspace_ready).toBe("passed");
    expect(dispatch.request.development_baseline).toMatchObject({ sha: merge, head: merge });
    expect(task.state).toBe("running");
    expect(ledger.events.some((event) => event.type === "task_blocked")).toBe(true);
    expect(ledger.events.some((event) => event.type === "task_resumed")).toBe(true);
    expect(ledger.events.some((event) => event.type === "task_started")).toBe(false);
  },
);

test("contribution task-base still requires the current delivery-unit SHA", () => {
  const ledger = modernFixture();
  const task = ledger.tasks.at(0);
  if (!task) throw new Error("contribution fixture is incomplete");
  expect(() =>
    run(ledger, "task-base", "contribution-stale-base", {
      task_id: task.id,
      base_sha: merge,
      evidence: "mock:contribution-base",
    }),
  ).toThrow("current parent SHA");
});
