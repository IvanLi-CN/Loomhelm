import { expect, test } from "bun:test";
import { createCliThread, initializationPrompt } from "../lib/codex-cli-create";
import { apply, authorize, type Request } from "../lib/engine";
import {
  deliveryTopologyForGroup,
  type Task,
  validateDeliveryTopologies,
  validateLedger,
} from "../lib/schema";

import { taskQuality } from "./engine-fixtures";
import { mockCli } from "./role-flow-cli";
import { fixture, modernFixture, request } from "./role-flow-fixtures";

const at = "2026-01-01T00:00:00.000Z";
const base = "a".repeat(40);
const main = { role: "main", thread_id: "main-thread" } as const;
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
          calls.push({ role: inputRole, prompt: input.prompt });
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
  expect(calls[0]?.prompt).toBe("formal handoff follows");
  expect(calls[1]?.prompt).toBe("formal handoff follows");
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

test("contract-3 public CLI completes every child PR before DeliveryUnit closeout", async () => {
  const initial = modernFixture();
  const approval = initial.events.find((e) => e.type === "plan_approved")!;
  approval.data.authorized_actions = ["dispatch", "publish_branch", "publish_pr", "merge"];
  initial.resources.push(
    ...initial.tasks.slice(1).flatMap((t) => [
      {
        id: `${t.id}-worktree`,
        kind: "worktree" as const,
        target: t.id,
        status: "active" as const,
        evidence_ref: "mock:workspace",
      },
      {
        id: `${t.id}-branch`,
        kind: "branch" as const,
        target: t.branch!,
        status: "active" as const,
        evidence_ref: "mock:branch",
      },
    ]),
  );
  const cli = mockCli(initial);
  let seq = 0;
  async function run(
    command: string,
    payload: Record<string, unknown>,
    actor = main as Request["actor"],
  ) {
    const response = await cli.run(command, payload, { actor });
    if (response.exit !== 0) throw new Error(`${command}: ${JSON.stringify(response)}`);
    return response;
  }
  async function acknowledgeAll() {
    for (const n of cli.store.read().notifications.filter((n) => n.ack_status !== "acknowledged")) {
      if (n.delivery_status !== "sent") {
        // Claim and reconcile an actual native notification intent; mock only its platform receipt.
        if (n.delivery_status !== "unknown")
          await run("notification-prepare", { notification_id: n.id });
        const ledger = cli.store.read();
        const notice = ledger.notifications.find((x) => x.id === n.id)!;
        const claim = ledger.events.findLast(
          (e) => e.data.delivery_attempt_id === notice.last_attempt_id && e.data.prompt_digest,
        )!;
        await run("notification-reconcile", {
          notification_id: n.id,
          delivery_attempt_id: notice.last_attempt_id,
          reconciliation_id: `receipt-${++seq}`,
          outcome: "sent",
          provider_receipt: {
            provider: "codex-app-tools",
            evidence_ref: "mock:message",
            recipient_thread_id: n.recipient_thread_id,
            prompt_digest: claim.data.prompt_digest,
          },
        });
      }
      const l = cli.store.read();
      const actor: Request["actor"] =
        n.recipient_thread_id === l.control.owner_thread_id
          ? main
          : l.groups.some((g) => g.agent_thread_id === n.recipient_thread_id)
            ? { role: "group", thread_id: n.recipient_thread_id }
            : { role: "task", thread_id: n.recipient_thread_id };
      await run(
        "notification-ack",
        { notification_id: n.id, handling_evidence: "mock:handled" },
        actor,
      );
    }
  }
  const group = initial.groups[0]!;
  const delivery = { role: "group", thread_id: group.agent_thread_id! } as const;
  try {
    for (const task of initial.tasks) {
      await acknowledgeAll();
      await run("dispatch-claim", { task_id: task.id, operation_id: `dispatch-${task.id}` });
      await run("conversation-create", {
        operation_id: `dispatch-${task.id}`,
        title: task.title,
        prompt: "Complete the approved task",
      });
      await acknowledgeAll();
      const bound = cli.store.read().tasks.find((t) => t.id === task.id)!;
      const actor = { role: "task", thread_id: bound.thread_id! } as const;
      await run(
        "development-baseline-sync",
        {
          target_type: "task",
          target_id: task.id,
          dispatch_operation_id: `dispatch-${task.id}`,
          mode: "initial",
          expected_previous_baseline: null,
          expected_lineage_sha: base,
          lineage_event_id: "initial",
          branch: task.branch,
          resource_ids:
            task.id === "task-a"
              ? ["task-worktree", "task-branch"]
              : [`${task.id}-worktree`, `${task.id}-branch`],
          baseline: { sha: base, head: base, clean: true, source: "mock-verifier" },
          evidence_ref: "mock:baseline",
        },
        actor,
      );
      await run("task-update", { task_id: task.id, state: "running", occurred_at: at }, actor);
      for (const atom of bound.atoms.filter(
        (a) => !["pr_merged", "closed"].includes(a.lifecycle_stage ?? ""),
      )) {
        for (const state of ["running", "completed"])
          await run("atom-update", { task_id: task.id, atom_id: atom.id, state }, actor);
      }
      const pr = {
        provider: "github",
        repository: "example/loomhelm",
        id: task.id,
        url: `https://github.com/example/loomhelm/pull/${task.id}`,
      };
      const branchReceipt = {
        provider: "github",
        repository: "example/loomhelm",
        resource_type: "branch",
        resource_id: task.branch,
        branch: task.branch,
        target_branch: null,
        base_sha: null,
        head_sha: base,
        pr: null,
        state: "exists",
        evidence_ref: "mock:branch",
      };
      await run(
        "publish-branch-claim",
        {
          target_type: "task",
          target_id: task.id,
          action_id: `publish-${task.id}-branch`,
          operation_id: `branch-${task.id}`,
          branch: task.branch,
          expected_head_sha: base,
        },
        actor,
      );
      await run(
        "publish-branch-resolve",
        {
          operation_id: `branch-${task.id}`,
          outcome: "succeeded",
          fact_id: `branch-fact-${task.id}`,
          provider_receipt: branchReceipt,
        },
        actor,
      );
      const receipt = {
        ...branchReceipt,
        resource_type: "pr",
        resource_id: pr.id,
        pr,
        target_branch: group.parent_branch,
        base_sha: base,
        state: "open",
        evidence_ref: "mock:pr",
      };
      await run(
        "publish-pr-claim",
        {
          target_type: "task",
          target_id: task.id,
          action_id: `publish-${task.id}-pr`,
          operation_id: `pr-${task.id}`,
          branch: task.branch,
          target_branch: group.parent_branch,
          expected_head_sha: base,
          expected_base_sha: base,
          pr,
        },
        actor,
      );
      await run(
        "publish-pr-resolve",
        {
          operation_id: `pr-${task.id}`,
          outcome: "succeeded",
          fact_id: `pr-fact-${task.id}`,
          provider_receipt: receipt,
        },
        actor,
      );
      await run(
        "task-quality-record",
        {
          task_id: task.id,
          base_sha: base,
          evidence: {
            id: `quality-${task.id}`,
            kind: "task_quality",
            subject_id: task.id,
            status: "passed",
            source: actor.thread_id,
            observed_at: at,
            sha: base,
            evidence_ref: "mock:quality",
            quality: taskQuality(task.id, actor.thread_id, pr, base, base),
          },
        },
        actor,
      );
      await run(
        "merge-claim",
        {
          operation_id: `merge-${task.id}`,
          mode: "child",
          group_id: group.id,
          task_id: task.id,
          target_branch: group.parent_branch,
          expected_base_sha: base,
          expected_head_sha: base,
          pr,
        },
        actor,
      );
      const evidence = {
        id: `merge-fact-${task.id}`,
        kind: "pr_merged",
        subject_id: task.id,
        status: "passed",
        source: "github",
        observed_at: at,
        sha: base,
        evidence_ref: "mock:merge",
        receipt: { ...receipt, state: "merged", merge_sha: base, evidence_ref: "mock:merge" },
      };
      const observation = { pr, base_sha: base, head_sha: base, merge_sha: base, state: "merged" };
      for (const bad of [null, { ...evidence.receipt, state: "closed" }]) {
        const before = JSON.stringify(cli.store.read());
        expect(
          (
            await cli.run(
              "merge-resolve",
              {
                operation_id: `merge-${task.id}`,
                outcome: "succeeded",
                provider_evidence: { ...evidence, receipt: bad },
                provider_observation: observation,
              },
              { actor },
            )
          ).exit,
        ).not.toBe(0);
        expect(JSON.stringify(cli.store.read())).toBe(before);
      }
      await run("merge-resolve", { operation_id: `merge-${task.id}`, outcome: "unknown" }, actor);
      expect(cli.store.read().operations.find((o) => o.id === `merge-${task.id}`)?.status).toBe(
        "unknown",
      );
      expect(
        (await cli.run("group-close", { group_id: group.id }, { actor: delivery })).exit,
      ).not.toBe(0);
      await run(
        "merge-resolve",
        {
          operation_id: `merge-${task.id}`,
          outcome: "succeeded",
          provider_evidence: evidence,
          provider_observation: observation,
        },
        actor,
      );
      const closeout = bound.atoms.find((a) => a.lifecycle_stage === "closed")!;
      for (const state of ["running", "completed"])
        await run("atom-update", { task_id: task.id, atom_id: closeout.id, state }, actor);
      await run("task-update", { task_id: task.id, state: "closed", occurred_at: at }, actor);
    }
    await run("protected-approve", {
      kind: "delivery_unit_merge",
      target_id: group.id,
      approval_id: "parent-approved",
    });
    const pr = group.parent_pr!;
    await run(
      "publish-branch-claim",
      {
        target_type: "group",
        target_id: group.id,
        action_id: "publish-group-branch",
        operation_id: "parent-branch",
        branch: group.parent_branch,
        expected_head_sha: base,
      },
      delivery,
    );
    await run(
      "publish-branch-resolve",
      {
        operation_id: "parent-branch",
        outcome: "succeeded",
        fact_id: "parent-branch-fact",
        provider_receipt: {
          provider: "github",
          repository: "example/loomhelm",
          resource_type: "branch",
          resource_id: group.parent_branch,
          branch: group.parent_branch,
          target_branch: null,
          base_sha: null,
          head_sha: base,
          pr: null,
          state: "exists",
          evidence_ref: "mock:branch",
        },
      },
      delivery,
    );
    await run(
      "publish-pr-claim",
      {
        target_type: "group",
        target_id: group.id,
        action_id: "publish-group-pr",
        operation_id: "parent-pr",
        branch: group.parent_branch,
        target_branch: "main",
        expected_base_sha: base,
        expected_head_sha: base,
        pr,
      },
      delivery,
    );
    await run(
      "publish-pr-resolve",
      {
        operation_id: "parent-pr",
        outcome: "succeeded",
        fact_id: "parent-pr-fact",
        provider_receipt: {
          provider: "github",
          repository: "example/loomhelm",
          resource_type: "pr",
          resource_id: pr.id,
          pr,
          branch: group.parent_branch,
          target_branch: "main",
          base_sha: base,
          head_sha: base,
          state: "open",
          evidence_ref: "mock:pr",
        },
      },
      delivery,
    );
    await run(
      "merge-claim",
      {
        operation_id: "parent-merge",
        mode: "parent",
        group_id: group.id,
        pr,
        target_branch: "main",
        expected_base_sha: base,
        expected_head_sha: base,
        owner_approval_id: "parent-approved",
      },
      delivery,
    );
    await run(
      "merge-resolve",
      {
        operation_id: "parent-merge",
        outcome: "succeeded",
        provider_evidence: {
          id: "parent-merge-fact",
          kind: "pr_merged",
          subject_id: group.id,
          status: "passed",
          source: "github",
          observed_at: at,
          sha: base,
          evidence_ref: "mock:parent-merge",
          receipt: {
            provider: "github",
            repository: "example/loomhelm",
            resource_type: "pr",
            resource_id: pr.id,
            pr,
            branch: group.parent_branch,
            target_branch: "main",
            base_sha: base,
            head_sha: base,
            merge_sha: base,
            state: "merged",
            evidence_ref: "mock:parent-merge",
          },
        },
        provider_observation: {
          pr,
          base_sha: base,
          head_sha: base,
          merge_sha: base,
          state: "merged",
        },
      },
      delivery,
    );
    for (const atom of cli.store
      .read()
      .groups[0]?.atoms.filter((a) => a.status !== "completed" && a.lifecycle_stage !== "closed")) {
      for (const state of ["running", "completed"])
        await run("group-atom-update", { group_id: group.id, atom_id: atom.id, state }, delivery);
    }
    await run(
      "fact-record",
      {
        fact: {
          id: "merged-ci",
          kind: "ci_passed",
          subject_id: group.id,
          status: "passed",
          source: "github",
          observed_at: at,
          sha: base,
          evidence_ref: "mock:ci",
        },
      },
      delivery,
    );
    await run(
      "group-execution-update",
      { group_id: group.id, state: "idle", observed_at: at },
      delivery,
    );
    await run("group-close", { group_id: group.id }, delivery);
    await acknowledgeAll();
    const final = validateLedger(cli.store.read());
    expect(final.tasks.every((t) => t.state === "closed" && t.lifecycle.closed === "passed")).toBe(
      true,
    );
    expect(final.groups[0]?.state).toBe("closed");
    expect(final.operations.filter((o) => o.kind === "merge")).toHaveLength(4);
    expect(final.operations.every((o) => o.status === "succeeded")).toBe(true);
    expect(final.notifications.every((n) => n.ack_status === "acknowledged")).toBe(true);
    expect(cli.calls()).toEqual(["create", "create", "create"]);
  } finally {
    cli.cleanup();
  }
}, 30000);

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

  const integrated = ["task-a", "task-b"].map(
    (id) =>
      ({
        id,
        group_id: "integrated",
        kind: "contribution",
        disposition: "active",
        execution_owner: "task_agent",
        conversation_policy: "task_agent",
        delivery_policy: "child_pr",
      }) as const,
  );
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
