import { describe, expect, test } from "bun:test";
import { apply, type Request } from "../lib/engine";
import { type Ledger, type Task, validateLedger } from "../lib/schema";
import {
  approve,
  at,
  base,
  fixture,
  groupActor,
  head,
  main,
  merge,
  readyAtomicFixture,
  request,
  taskQuality,
  v2Fixture,
} from "./engine-fixtures";

function contract3ReconciliationFixture() {
  const ledger = readyAtomicFixture();
  ledger.contract_version = 3;
  ledger.source_schema_version = null;
  ledger.tasks[0]!.atoms[0]!.status = "completed";
  ledger.tasks[0]!.atoms[1]!.status = "completed";
  return ledger;
}

test("native group retry ignores a failed attempt and still requires a fresh mainline baseline receipt", () => {
  const ledger = fixture();
  approve(ledger);
  Object.assign(ledger.groups[0], {
    agent_thread_id: null,
    state: "planned",
    parent_branch: null,
    current_sha: null,
  });
  const invoke = (
    command: string,
    requestId: string,
    payload: any,
    actor: Request["actor"] = main,
  ) => apply(ledger, command, request(ledger, requestId, payload, actor));
  invoke("dispatch-group-claim", "failed-cli", { group_id: "g", operation_id: "failed-cli" });
  invoke("dispatch-bind-request", "failed-bind", {
    operation_id: "failed-cli",
    native_request_id: "failed-native",
    creation_parameters: {
      title: "group",
      prompt: "formal",
      cwd: "/repo",
      execution_profile: ledger.config.execution_profile,
      transport: "codex-exec",
    },
  });
  invoke("dispatch-resolve", "failed-resolve", {
    operation_id: "failed-cli",
    outcome: "failed",
    native_evidence: {
      source: "multi-task-flow-cli",
      native_tool_name: "codex exec",
      operation_id: "failed-cli",
      native_request_id: "failed-native",
      ...ledger.config.execution_profile,
      evidence_ref: "codex:verified-no-resource",
      created_at: at,
      error: "Preflight verified process was not started and no resource was created",
      process_started: false,
      resources_created: false,
    },
  });
  invoke("dispatch-group-claim", "group-cli", { group_id: "g", operation_id: "group-cli" });
  expect(() =>
    invoke("dispatch-bind-request", "reused-bind", {
      operation_id: "group-cli",
      native_request_id: "failed-native",
      creation_parameters: {
        title: "group",
        prompt: "formal",
        cwd: "/repo",
        execution_profile: ledger.config.execution_profile,
        transport: "codex-exec",
      },
    }),
  ).toThrow("already claimed");
  invoke("dispatch-bind-request", "group-bind", {
    operation_id: "group-cli",
    native_request_id: "group-native",
    creation_parameters: {
      title: "group",
      prompt: "formal",
      cwd: "/repo",
      execution_profile: ledger.config.execution_profile,
      transport: "codex-exec",
    },
  });
  expect(ledger.operations.at(-1)!.status).toBe("unknown");
  invoke("dispatch-progress", "group-observed", {
    operation_id: "group-cli",
    native_request_id: "group-native",
    thread_id: "group-thread",
  });
  invoke("dispatch-resolve", "group-resolved", {
    operation_id: "group-cli",
    thread_id: "group-thread",
    outcome: "succeeded",
    native_evidence: {
      source: "multi-task-flow-cli",
      native_tool_name: "codex exec",
      operation_id: "group-cli",
      native_request_id: "group-native",
      ...ledger.config.execution_profile,
      evidence_ref: "codex:group",
      created_at: at,
      thread_id: "group-thread",
      workspace_path: "/owned",
      initial_head: base,
      exit_code: 0,
      turn_completed: true,
    },
  });
  ledger.groups[0]!.state = "active";
  expect(() =>
    invoke(
      "group-execution-update",
      "early-group",
      { group_id: "g", state: "running" },
      groupActor,
    ),
  ).toThrow("baseline");
  ledger.resources = [
    { id: "gwt", kind: "worktree", target: "g", status: "active", evidence_ref: "owned" },
    { id: "gbr", kind: "branch", target: "parent", status: "active", evidence_ref: "branch" },
  ];
  const payload = {
    target_type: "group",
    target_id: "g",
    stage: "workspace_ready",
    branch: "parent",
    resource_ids: ["gwt", "gbr"],
    evidence_ref: "fresh-fetch",
  };
  expect(() =>
    invoke(
      "lifecycle-record",
      "no-fetch",
      { ...payload, baseline: { sha: head, head, clean: true, source: "remote:main" } },
      groupActor,
    ),
  ).toThrow("fresh remote fetch");
  expect(() =>
    invoke(
      "lifecycle-record",
      "stale-fetch",
      {
        ...payload,
        baseline: { sha: head, head, clean: true, source: "remote:main", fetched_at: at },
      },
      groupActor,
    ),
  ).toThrow("fresh remote fetch");
  invoke(
    "lifecycle-record",
    "fresh-fetch",
    {
      ...payload,
      baseline: {
        sha: head,
        head,
        clean: true,
        source: "remote:main",
        fetched_at: new Date().toISOString(),
      },
    },
    groupActor,
  );
  expect(ledger.groups[0].current_sha).toBe(head);
  invoke("group-execution-update", "group-start", { group_id: "g", state: "running" }, groupActor);
});

test("contract-3 baseline sync refreshes an advanced lineage without changing native creation evidence", () => {
  const ledger = fixture();
  approve(ledger);
  ledger.contract_version = 3;
  apply(
    ledger,
    "dispatch-claim",
    request(ledger, "baseline-claim", { task_id: "a", operation_id: "baseline-op" }),
  );
  apply(
    ledger,
    "dispatch-bind-request",
    request(ledger, "baseline-bind", {
      operation_id: "baseline-op",
      native_request_id: "baseline-native",
      creation_parameters: {
        title: "task",
        prompt: "formal",
        cwd: "/repo",
        transport: "codex-exec",
        execution_profile: ledger.config.execution_profile,
      },
    }),
  );
  apply(
    ledger,
    "dispatch-progress",
    request(ledger, "baseline-progress", {
      operation_id: "baseline-op",
      native_request_id: "baseline-native",
      thread_id: "baseline-thread",
    }),
  );
  apply(
    ledger,
    "dispatch-resolve",
    request(ledger, "baseline-resolve", {
      operation_id: "baseline-op",
      outcome: "succeeded",
      thread_id: "baseline-thread",
      native_evidence: {
        source: "multi-task-flow-cli",
        native_tool_name: "codex exec",
        operation_id: "baseline-op",
        native_request_id: "baseline-native",
        ...ledger.config.execution_profile,
        created_at: at,
        evidence_ref: "codex:baseline",
        thread_id: "baseline-thread",
        workspace_path: "/owned/baseline",
        initial_head: head,
        exit_code: 0,
        turn_completed: true,
      },
    }),
  );
  ledger.resources = [
    { id: "baseline-wt", kind: "worktree", target: "a", status: "active", evidence_ref: "owned" },
    {
      id: "baseline-branch",
      kind: "branch",
      target: "task-a",
      status: "active",
      evidence_ref: "branch",
    },
  ];
  const actor = { role: "task" as const, thread_id: "baseline-thread" };
  ledger.groups[0]!.current_sha = base;
  ledger.tasks[0]!.base_sha = base;
  const initialBaseline = {
    sha: base,
    head: base,
    clean: true as const,
    source: "workspace-verifier",
  };
  apply(
    ledger,
    "development-baseline-sync",
    request(
      ledger,
      "baseline-initial",
      {
        target_type: "task",
        target_id: "a",
        dispatch_operation_id: "baseline-op",
        mode: "initial",
        expected_previous_baseline: null,
        expected_lineage_sha: base,
        lineage_event_id: "initial",
        branch: "task-a",
        resource_ids: ["baseline-wt", "baseline-branch"],
        baseline: initialBaseline,
        evidence_ref: "git:initial",
      },
      actor,
    ),
  );
  expect(ledger.operations[0]!.request.development_baseline).toEqual(initialBaseline);
  expect(ledger.facts.at(-1)!.kind).toBe("baseline_verified");
  expect(ledger.events.at(-1)!.type).toBe("development_baseline_synchronized");
  const initialHead = (ledger.operations[0]!.request.creation_result as any).native_evidence
    .initial_head;

  ledger.groups[0]!.current_sha = head;
  ledger.tasks[0]!.base_sha = head;
  ledger.events.push({
    id: "lineage-advance",
    type: "group_base_reconciled",
    subject_id: "g",
    actor_id: "group-thread",
    occurred_at: at,
    recorded_at: at,
    data: { sha: head, previous_sha: base },
  });
  const refreshed = { sha: head, head, clean: true as const, source: "workspace-verifier" };
  apply(
    ledger,
    "development-baseline-sync",
    request(
      ledger,
      "baseline-refresh",
      {
        target_type: "task",
        target_id: "a",
        dispatch_operation_id: "baseline-op",
        mode: "refresh",
        expected_previous_baseline: initialBaseline,
        expected_lineage_sha: head,
        lineage_event_id: "lineage-advance",
        branch: "task-a",
        resource_ids: ["baseline-wt", "baseline-branch"],
        baseline: refreshed,
        evidence_ref: "git:refresh",
      },
      actor,
    ),
  );
  expect(ledger.operations[0]!.request.development_baseline).toEqual(refreshed);
  expect((ledger.operations[0]!.request.creation_result as any).native_evidence.initial_head).toBe(
    initialHead,
  );
  expect(ledger.facts.filter((item) => item.kind === "baseline_verified")).toHaveLength(2);
  expect(
    (
      apply(
        ledger,
        "development-baseline-sync",
        request(
          ledger,
          "baseline-refresh",
          {
            target_type: "task",
            target_id: "a",
            dispatch_operation_id: "baseline-op",
            mode: "refresh",
            expected_previous_baseline: initialBaseline,
            expected_lineage_sha: head,
            lineage_event_id: "lineage-advance",
            branch: "task-a",
            resource_ids: ["baseline-wt", "baseline-branch"],
            baseline: refreshed,
            evidence_ref: "git:refresh",
          },
          actor,
        ),
      ) as any
    ).code,
  ).toBe("REPLAYED");
  const before = JSON.stringify(ledger);
  expect(() =>
    apply(
      ledger,
      "development-baseline-sync",
      request(
        ledger,
        "stale-refresh",
        {
          target_type: "task",
          target_id: "a",
          dispatch_operation_id: "baseline-op",
          mode: "refresh",
          expected_previous_baseline: initialBaseline,
          expected_lineage_sha: base,
          lineage_event_id: "lineage-advance",
          branch: "task-a",
          resource_ids: ["baseline-wt", "baseline-branch"],
          baseline: initialBaseline,
          evidence_ref: "git:stale",
        },
        actor,
      ),
    ),
  ).toThrow("current development baseline");
  expect(JSON.stringify(ledger)).toBe(before);
});

test("external merge reconciliation accepts an unbound task PR binding without regressing lineage", () => {
  const ledger = contract3ReconciliationFixture();
  const group = ledger.groups[0]!;
  const task = ledger.tasks[0]!;
  const pr = {
    provider: "github",
    repository: "example/repo",
    id: "1",
    url: "https://github.com/example/repo/pull/1",
  };
  group.parent_branch = "parent";
  group.pr = { state: "published", pr, parent_branch: "parent" };
  task.thread_id = "task-a";
  task.state = "waiting";
  task.branch = "branch-a";
  task.base_sha = base;
  task.pr = { state: "unbound" };
  task.execution_owner = "task_agent";
  task.conversation_policy = "task_agent";
  task.delivery_policy = "child_pr";
  const quality = {
    id: "quality-a",
    kind: "task_quality" as const,
    subject_id: task.id,
    status: "passed" as const,
    source: task.thread_id,
    observed_at: at,
    sha: head,
    evidence_ref: "workspace:/tmp/task-a",
    quality: taskQuality(task.id, task.thread_id, pr, base, head),
  };
  const observation = {
    provider: "github",
    repository: "example/repo",
    resource_type: "pr" as const,
    resource_id: "1",
    branch: "branch-a",
    target_branch: "parent",
    base_sha: base,
    head_sha: head,
    merge_sha: merge,
    pr,
    state: "merged" as const,
    evidence_ref: "https://github.com/example/repo/pull/1",
  };
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-recovery", {
      kind: "delivery_unit_recovery",
      target_id: group.id,
      approval_id: "recovery-a",
    }),
  );
  const beforeMismatch = JSON.stringify(ledger);
  for (const pending of [
    { kind: "publish_pr" as const, target_id: task.id, request: {} },
    { kind: "merge" as const, target_id: group.id, request: { mode: "parent" } },
    { kind: "merge" as const, target_id: group.id, request: { mode: "child", task_id: "b" } },
  ]) {
    const candidate = structuredClone(ledger);
    candidate.operations.push({
      id: "pending-operation",
      actor_id: "main-thread",
      status: "claimed",
      expected_sha: base,
      receipt_fact_id: null,
      created_at: at,
      updated_at: at,
      ...pending,
    });
    const before = JSON.stringify(candidate);
    expect(() =>
      apply(
        candidate,
        "task-external-merge-reconcile",
        request(candidate, "pending-reconcile", {
          task_id: task.id,
          pr,
          provider_observation: observation,
          quality_evidence: quality,
          merge_sha: merge,
          recovery_approval_id: "recovery-a",
        }),
      ),
    ).toThrow("unresolved operation");
    expect(JSON.stringify(candidate)).toBe(before);
  }
  expect(() =>
    apply(
      ledger,
      "task-external-merge-reconcile",
      request(ledger, "reconcile-wrong-merge-sha", {
        task_id: task.id,
        pr,
        provider_observation: { ...observation, merge_sha: head },
        quality_evidence: quality,
        merge_sha: merge,
        recovery_approval_id: "recovery-a",
      }),
    ),
  ).toThrow("Historical merge SHA");
  expect(JSON.stringify(ledger)).toBe(beforeMismatch);
  const result = apply(
    ledger,
    "task-external-merge-reconcile",
    request(ledger, "reconcile-a", {
      task_id: task.id,
      pr,
      provider_observation: observation,
      quality_evidence: quality,
      merge_sha: merge,
      recovery_approval_id: "recovery-a",
    }),
  );
  expect(result).toMatchObject({
    result: { task_id: task.id, state: "integrated", current_group_sha: merge },
  });
  expect(ledger.tasks[0]!.pr).toMatchObject({ state: "merged", pr, merge_sha: merge });
  expect(ledger.tasks[0]!.lifecycle).toMatchObject({ pr_created: "passed", pr_merged: "passed" });
  expect(ledger.facts.map((fact) => fact.kind)).toEqual([
    "task_quality",
    "pr_published",
    "pr_merged",
  ]);
  expect(ledger.events.at(-1)).toMatchObject({
    type: "external_merge_reconciled",
    data: { quality_fact_id: "quality-a", current_group_sha: merge },
  });
  expect(
    apply(
      ledger,
      "task-external-merge-reconcile",
      request(ledger, "reconcile-a", {
        task_id: task.id,
        pr,
        provider_observation: observation,
        quality_evidence: quality,
        merge_sha: merge,
        recovery_approval_id: "recovery-a",
      }),
    ),
  ).toMatchObject({ code: "REPLAYED" });
});

test("legacy external merge reconciliation ignores task atom completion gates", () => {
  const ledger = fixture();
  const group = ledger.groups[0]!;
  const task = ledger.tasks[0]!;
  const pr = {
    provider: "github",
    repository: "example/repo",
    id: "legacy-1",
    url: "https://github.com/example/repo/pull/legacy-1",
  };
  group.parent_branch = "parent";
  group.pr = { state: "published", pr, parent_branch: "parent" };
  task.thread_id = "task-a";
  task.state = "waiting";
  task.branch = "branch-a";
  task.pr = { state: "unbound" };
  task.execution_owner = "task_agent";
  task.conversation_policy = "task_agent";
  task.delivery_policy = "child_pr";
  task.atoms = [{ id: "legacy-pending", title: "pending", status: "planned" }];
  ledger.plans[0]!.atoms = [
    {
      id: "legacy-pending",
      title: "pending",
      task_id: task.id,
      purpose: "pending",
      output: "pending",
    },
  ];
  const quality = {
    id: "legacy-quality",
    kind: "task_quality" as const,
    subject_id: task.id,
    status: "passed" as const,
    source: task.thread_id,
    observed_at: at,
    sha: head,
    evidence_ref: "workspace:/tmp/legacy-task-a",
    quality: taskQuality(task.id, task.thread_id, pr, base, head),
  };
  const observation = {
    provider: "github",
    repository: "example/repo",
    resource_type: "pr" as const,
    resource_id: pr.id,
    branch: "branch-a",
    target_branch: "parent",
    base_sha: base,
    head_sha: head,
    merge_sha: merge,
    pr,
    state: "merged" as const,
    evidence_ref: "https://github.com/example/repo/pull/legacy-1",
  };
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-legacy-recovery", {
      kind: "delivery_unit_recovery",
      target_id: group.id,
      approval_id: "legacy-recovery",
    }),
  );
  expect(
    apply(
      ledger,
      "task-external-merge-reconcile",
      request(ledger, "reconcile-legacy", {
        task_id: task.id,
        pr,
        provider_observation: observation,
        quality_evidence: quality,
        merge_sha: merge,
        recovery_approval_id: "legacy-recovery",
      }),
    ),
  ).toMatchObject({ result: { task_id: task.id, state: "integrated" } });
});

test("external merge reconciliation preserves mismatch protection for a registered child PR", () => {
  const ledger = contract3ReconciliationFixture();
  const group = ledger.groups[0]!;
  const task = ledger.tasks[0]!;
  const registeredPr = {
    provider: "github",
    repository: "example/repo",
    id: "registered",
    url: "https://github.com/example/repo/pull/2",
  };
  const observedPr = {
    provider: "github",
    repository: "example/repo",
    id: "observed",
    url: "https://github.com/example/repo/pull/1",
  };
  group.parent_branch = "parent";
  group.pr = {
    state: "published",
    pr: registeredPr,
    parent_branch: "parent",
  };
  task.thread_id = "task-a";
  task.state = "waiting";
  task.branch = "branch-a";
  task.base_sha = base;
  task.pr = {
    state: "open",
    pr: registeredPr,
    branch: "branch-a",
    base_branch: "parent",
  };
  task.execution_owner = "task_agent";
  task.conversation_policy = "task_agent";
  task.delivery_policy = "child_pr";
  const quality = {
    id: "quality-a",
    kind: "task_quality" as const,
    subject_id: task.id,
    status: "passed" as const,
    source: task.thread_id,
    observed_at: at,
    sha: head,
    evidence_ref: "workspace:/tmp/task-a",
    quality: taskQuality(task.id, task.thread_id, observedPr, base, head),
  };
  const observation = {
    provider: "github",
    repository: "example/repo",
    resource_type: "pr" as const,
    resource_id: "observed",
    branch: "branch-a",
    target_branch: "parent",
    base_sha: base,
    head_sha: head,
    merge_sha: merge,
    pr: observedPr,
    state: "merged" as const,
    evidence_ref: "https://github.com/example/repo/pull/1",
  };
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-recovery", {
      kind: "delivery_unit_recovery",
      target_id: group.id,
      approval_id: "recovery-a",
    }),
  );
  expect(() =>
    apply(
      ledger,
      "task-external-merge-reconcile",
      request(ledger, "reconcile-a", {
        task_id: task.id,
        pr: observedPr,
        provider_observation: observation,
        quality_evidence: quality,
        merge_sha: merge,
        recovery_approval_id: "recovery-a",
      }),
    ),
  ).toThrow("Historical merge PR does not match the registered task PR");
  expect(task.pr).toEqual({
    state: "open",
    pr: registeredPr,
    branch: "branch-a",
    base_branch: "parent",
  });
});

test("external merge reconciliation rejects incomplete quality evidence without mutation", () => {
  const ledger = contract3ReconciliationFixture();
  const group = ledger.groups[0]!;
  const task = ledger.tasks[0]!;
  const pr = {
    provider: "github",
    repository: "example/repo",
    id: "1",
    url: "https://github.com/example/repo/pull/1",
  };
  group.parent_branch = "parent";
  group.pr = { state: "published", pr, parent_branch: "parent" };
  task.thread_id = "task-a";
  task.state = "waiting";
  task.branch = "branch-a";
  task.base_sha = base;
  const observation = {
    provider: "github",
    repository: "example/repo",
    resource_type: "pr" as const,
    resource_id: "1",
    branch: "branch-a",
    target_branch: "parent",
    base_sha: base,
    head_sha: head,
    merge_sha: merge,
    pr,
    state: "merged" as const,
    evidence_ref: "github://pr/1",
  };
  apply(
    ledger,
    "protected-approve",
    request(ledger, "approve-recovery", {
      kind: "delivery_unit_recovery",
      target_id: group.id,
      approval_id: "recovery-a",
    }),
  );
  const before = JSON.stringify(ledger);
  expect(() =>
    apply(
      ledger,
      "task-external-merge-reconcile",
      request(ledger, "reconcile-a", {
        task_id: task.id,
        pr,
        provider_observation: observation,
        quality_evidence: {
          id: "quality-a",
          kind: "task_quality",
          subject_id: task.id,
          status: "passed",
          source: "wrong-thread",
          observed_at: at,
          sha: head,
          evidence_ref: "github://quality",
          quality: taskQuality(task.id, "wrong-thread", pr, base, head),
        },
        merge_sha: merge,
        recovery_approval_id: "recovery-a",
      }),
    ),
  ).toThrow("source-bound task quality");
  expect(JSON.stringify(ledger)).toBe(before);
});
