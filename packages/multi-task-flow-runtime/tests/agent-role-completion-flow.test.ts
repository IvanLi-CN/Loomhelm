import { expect, test } from "bun:test";
import { createCliThread, initializationPrompt } from "../lib/codex-cli-create";
import { apply, authorize, type Request } from "../lib/engine";
import {
  deliveryTopologyForGroup,
  type Ledger,
  type Task,
  validateDeliveryTopologies,
  validateLedger,
} from "../lib/schema";

const at = "2026-01-01T00:00:00.000Z";
const base = "a".repeat(40);
const main = { role: "main", thread_id: "main-thread" } as const;

function fixture(): Ledger {
  const group = {
    id: "group-a",
    title: "交付单元 A",
    delivery_unit_kind: "regular",
    owner_kind: "group",
    agent_thread_id: "delivery-thread",
    state: "active",
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

test("mock Codex handshakes preserve Delivery Agent and Task Agent roles", async () => {
  const calls: Array<{ role?: string; prompt: string }> = [];
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
          calls.push({ role: input.role, prompt: initializationPrompt(input.role) });
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
  ];
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
  }));
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
  const ledger = fixture();
  const group = structuredClone(ledger.groups[0]);
  if (!group) throw new Error("fixture group missing");
  group.delivery_unit_kind = "bootstrap";
  group.owner_kind = "main";
  group.agent_thread_id = null;
  group.state = "planned";
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
