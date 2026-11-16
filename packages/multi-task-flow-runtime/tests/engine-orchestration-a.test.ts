import { describe, expect, test } from "bun:test";
import {
  apply,
  deliveryUnitPrMerged,
  ready,
  requireGroupDispatchGate,
  type Request,
} from "../lib/engine";
import { deriveExecutionPhase } from "../lib/revisions";
import { type Ledger, type Plan, type Task, validateLedger } from "../lib/schema";
import {
  at,
  base,
  head,
  groupActor,
  main,
  fixture,
  request,
  taskQuality,
  approve,
  approveV2,
  readyAtomicFixture,
  readyBootstrapFixture,
  v2Fixture,
  providerBranchReceipt,
  providerPrReceipt,
} from "./engine-fixtures";

describe("orchestration state", () => {
  test("allows the bound main conversation to manage only a bootstrap group", () => {
    const ledger = fixture();
    ledger.groups[0].delivery_unit_kind = "bootstrap";
    ledger.groups[0].owner_kind = "main";
    ledger.groups[0].agent_thread_id = null;
    const incoming = structuredClone(ledger.groups[0]);
    incoming.state = "blocked";
    expect(
      apply(ledger, "group-update", request(ledger, "bootstrap-update", { group: incoming })),
    ).toMatchObject({ result: { group_id: "g", state: "blocked" } });
    const regular = fixture();
    const regularIncoming = structuredClone(regular.groups[0]);
    regularIncoming.state = "blocked";
    expect(() =>
      apply(
        regular,
        "group-update",
        request(regular, "regular-main-update", { group: regularIncoming }),
      ),
    ).toThrow("Main conversation may update only the bootstrap delivery unit");
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
    predecessor.groups.push({
      ...structuredClone(predecessor.groups[0]),
      id: "other",
      delivery_unit_kind: "regular",
      owner_kind: "group",
      agent_thread_id: "other-thread",
    });
    predecessor.plans[0].nodes.push({
      ...predecessor.plans[0].nodes[0]!,
      id: "other-node",
      kind: "milestone",
      ref_id: null,
      group_id: "other",
    });
    predecessor.plans[0].edges.push({
      id: "other-before-bootstrap",
      from_node_id: "other-node",
      to_node_id: "node-a",
      requires: "completed",
    });
    expect(() => validateLedger(predecessor)).toThrow("Bootstrap cannot depend");
  });
  test("bootstrap parent merge claim uses main ownership and retains integration gates", () => {
    const ledger = fixture();
    ledger.groups[0].delivery_unit_kind = "bootstrap";
    ledger.groups[0].owner_kind = "main";
    ledger.groups[0].agent_thread_id = null;
    const pr = {
      provider: "github",
      repository: "example/repo",
      id: "9",
      url: "https://github.com/example/repo/pull/9",
    };
    ledger.groups[0].parent_pr = pr;
    ledger.groups[0].current_sha = head;
    approve(ledger);
    const payload = {
      mode: "parent",
      operation_id: "parent-merge",
      group_id: "g",
      target_branch: "main",
      expected_base_sha: base,
      expected_head_sha: head,
      owner_approval_id: "parent-approved",
      pr,
    };
    expect(() =>
      apply(ledger, "merge-claim", request(ledger, "premature-parent", payload)),
    ).toThrow("Contribution tasks are not integrated");
    for (const task of ledger.tasks) task.state = "integrated";
    expect(() =>
      apply(ledger, "merge-claim", request(ledger, "main-parent", payload)),
    ).not.toThrow();
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
      "task-quality-record",
      request(
        ledger,
        "task-review",
        {
          task_id: "a",
          base_sha: base,
          evidence: {
            id: "task-review-fact",
            kind: "task_quality",
            subject_id: "a",
            status: "passed",
            source: taskActor.thread_id,
            observed_at: at,
            sha: base,
            evidence_ref: "review-proof",
            quality: taskQuality("a", taskActor.thread_id, childPr.pr, base, base),
          },
        },
        taskActor,
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
      request(ledger, "task-close", { task_id: "a", state: "closed" }, taskActor),
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
    ).toThrow("parent PR is created and verified");
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
  test("rejects v2 contribution plans without publication actions", () => {
    const ledger = v2Fixture();
    ledger.plans[0].actions = [];
    expect(() =>
      apply(
        ledger,
        "plan-approve",
        request(ledger, "approve-without-publication-actions", {
          plan_id: "plan",
          approval_id: "approved-v2",
          authorized_actions: ["dispatch"],
          authorized_action_ids: [],
        }),
      ),
    ).toThrow("approved publication actions");
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
    ).toThrow("parent PR is created and verified");
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

  test("regular delivery units fail closed before coordinator binding", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.groups[0].agent_thread_id = null;
    const before = JSON.stringify(ledger);

    expect(() =>
      apply(
        ledger,
        "dispatch-claim",
        request(ledger, "unbound-task", { task_id: "a", operation_id: "unbound-task" }),
      ),
    ).toThrow("Task group is not bound");
    expect(JSON.stringify(ledger)).toBe(before);
    expect(() =>
      apply(
        ledger,
        "group-execution-update",
        request(ledger, "unbound-runtime", { group_id: "g", state: "running" }),
      ),
    ).toThrow("bound Delivery coordinator");
    expect(ledger.groups[0].coordination_execution.state).toBe("unknown");
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
    ledger.contract_version = 2;
    ledger.source_schema_version = 1;
    expect(ready(ledger, "c")).toBe(false);
    ledger.groups[0].state = "merged";
    ledger.groups[0].merge_sha = merge;
    ledger.groups[0].lifecycle.pr_merged = "passed";
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
      request(ledger, "start-atoms", { task_id: "a", state: "running", occurred_at: at }, actor),
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
    expect(ledger.tasks[0].atoms.map((atom) => atom.status)).toEqual(["completed", "running"]);
  });

  test("delivery-unit atoms and coordination waiting state are independent from contribution tasks", () => {
    const ledger = fixture();
    ledger.plans[0].group_atoms = [
      {
        id: "group-atom-one",
        title: "Prepare parent",
        group_id: "g",
        purpose: "Prepare",
        output: "Prepared",
        lifecycle_stage: null,
      },
      {
        id: "group-atom-two",
        title: "Close out",
        group_id: "g",
        purpose: "Close",
        output: "Closed",
        lifecycle_stage: null,
      },
    ];
    ledger.groups[0].atoms = ledger.plans[0].group_atoms
      .map((atom) => ({ ...atom, group_id: undefined, status: "planned" as const }))
      .map(({ group_id: _groupId, ...atom }) => atom);
    apply(
      ledger,
      "group-execution-update",
      request(
        ledger,
        "group-waiting",
        {
          group_id: "g",
          state: "waiting",
          reason: "等待贡献任务完成集成",
          waiting_for_task_ids: ["a"],
        },
        groupActor,
      ),
    );
    expect(ledger.groups[0].coordination_execution).toEqual({
      state: "waiting",
      reason: "等待贡献任务完成集成",
      waiting_for_task_ids: ["a"],
    });
    approve(ledger);
    apply(
      ledger,
      "group-atom-update",
      request(
        ledger,
        "group-atom-start",
        { group_id: "g", atom_id: "group-atom-one", state: "running" },
        groupActor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "group-atom-update",
        request(
          ledger,
          "group-atom-skip",
          { group_id: "g", atom_id: "group-atom-two", state: "running" },
          groupActor,
        ),
      ),
    ).toThrow("Earlier delivery-unit atoms");
    apply(
      ledger,
      "group-atom-update",
      request(
        ledger,
        "group-atom-done",
        { group_id: "g", atom_id: "group-atom-one", state: "completed" },
        groupActor,
      ),
    );
    apply(
      ledger,
      "group-atom-update",
      request(
        ledger,
        "group-atom-two-start",
        { group_id: "g", atom_id: "group-atom-two", state: "running" },
        groupActor,
      ),
    );
    expect(() =>
      apply(
        ledger,
        "group-execution-update",
        request(
          ledger,
          "group-bad-wait",
          { group_id: "g", state: "waiting", reason: "missing", waiting_for_task_ids: ["missing"] },
          groupActor,
        ),
      ),
    ).toThrow("contribution tasks");
  });

  test("runtime execution requires bound orchestration ownership", () => {
    const ledger = fixture();
    ledger.control.ownership = "uncertain";
    expect(() =>
      apply(
        ledger,
        "group-execution-update",
        request(
          ledger,
          "uncertain-runtime",
          {
            group_id: "g",
            state: "running",
            reason: null,
            waiting_for_task_ids: [],
          },
          groupActor,
        ),
      ),
    ).toThrow("ownership is not resolved");
  });

  test("active delivery units cannot become idle while a contribution task is ready", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.groups[0].coordination_execution = {
      state: "running",
      reason: null,
      waiting_for_task_ids: [],
    };
    expect(ready(ledger, "a")).toBe(true);
    expect(() =>
      apply(
        ledger,
        "group-execution-update",
        request(
          ledger,
          "group-idle-with-ready-task",
          {
            group_id: "g",
            state: "idle",
            reason: null,
            waiting_for_task_ids: [],
          },
          groupActor,
        ),
      ),
    ).toThrow("ready contribution task");
  });

  test("group activation cannot carry idle coordination with a ready contribution task", () => {
    const ledger = fixture();
    approve(ledger);
    ledger.groups[0].state = "planned";
    ledger.groups[0].coordination_execution = {
      state: "idle",
      reason: null,
      waiting_for_task_ids: [],
    };
    const incoming = structuredClone(ledger.groups[0]);
    incoming.state = "active";
    expect(() =>
      apply(
        ledger,
        "group-update",
        request(ledger, "group-active-idle-with-ready-task", { group: incoming }, groupActor),
      ),
    ).toThrow("ready contribution task");
  });

  test("migrated contract2 does not bypass atom lifecycle evidence", () => {
    const ledger = v2Fixture();
    ledger.contract_version = 2;
    ledger.source_schema_version = 1;
    const atom = {
      id: "prepare",
      title: "Prepare",
      purpose: "Prepare",
      output: "Ready",
      lifecycle_stage: "workspace_ready",
      status: "running",
    };
    ledger.groups[0].atoms = [atom];
    const { status, ...definition } = atom;
    ledger.plans[0].group_atoms = [{ ...definition, group_id: "g" }];
    approve(ledger);
    expect(() =>
      apply(
        ledger,
        "group-atom-update",
        request(
          ledger,
          "migrated-atom",
          { group_id: "g", atom_id: "prepare", state: "completed" },
          groupActor,
        ),
      ),
    ).toThrow("not passed");
    expect(ledger.groups[0].atoms[0].status).toBe("running");
  });

  test.each([false, true])(
    "group-close completes the closeout atom in the same transaction (bootstrap=%s)",
    (bootstrap) => {
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
        {
          id: "group-atom-one",
          title: "Merge",
          purpose: "Merge",
          output: "Merged",
          lifecycle_stage: "pr_merged",
          status: "completed",
        },
        {
          id: "group-atom-two",
          title: "Close",
          purpose: "Close",
          output: "Closed",
          lifecycle_stage: "closed",
          status: "running",
        },
      ];
      ledger.plans[0].group_atoms = ledger.groups[0].atoms.map(({ status, ...atom }: any) => ({
        ...atom,
        group_id: "g",
      }));
      ledger.groups[0].coordination_execution = {
        state: "waiting",
        reason: "merged closeout",
        waiting_for_task_ids: [],
      };
      ledger.tasks.forEach((task: Task) => {
        task.state = "integrated";
      });
      ledger.facts.push({
        id: "group-merged",
        kind: "pr_merged",
        subject_id: "g",
        status: "passed",
        source: "github",
        observed_at: at,
        sha: merge,
        evidence_ref: "merge",
      });
      ledger.facts.push({
        id: "group-ci",
        kind: "ci_passed",
        subject_id: "g",
        status: "passed",
        source: "github",
        observed_at: at,
        sha: merge,
        evidence_ref: "ci",
      });
      apply(
        ledger,
        "group-execution-update",
        request(
          ledger,
          "merged-closeout-idle",
          {
            group_id: "g",
            state: "idle",
            reason: null,
            waiting_for_task_ids: [],
          },
          coordinator,
        ),
      );
      apply(
        ledger,
        "group-close",
        request(ledger, "group-closeout", { group_id: "g" }, coordinator),
      );
      expect(ledger.groups[0].state).toBe("closed");
      expect(ledger.groups[0].atoms.at(-1)?.status).toBe("completed");
      expect(ledger.groups[0].lifecycle.closed).toBe("passed");
    },
  );


});

