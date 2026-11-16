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
  merge,
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
  test("replays a matching request and rejects ID reuse", () => {
    const ledger = fixture();
    approve(ledger);
    const first = request(ledger, "claim-a", {
      task_id: "a",
      operation_id: "dispatch-a",
    });
    apply(ledger, "dispatch-claim", first);
    expect((apply(ledger, "dispatch-claim", first) as any).code).toBe("REPLAYED");
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
      request(ledger, "start-foreign", { task_id: "a", state: "running", occurred_at: at }, actor),
    );
    const foreign = {
      provider: "github",
      repository: "other/repo",
      id: "1",
      url: "https://github.com/other/repo/pull/1",
    };
    expect(() =>
      apply(ledger, "task-pr", request(ledger, "foreign-pr", { task_id: "a", pr: foreign }, actor)),
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
      apply(ledger, "merge-claim", request(ledger, "task-parent-claim", parentClaim, taskActor)),
    ).toThrow("Delivery coordinator");

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
    ).toThrow("Delivery coordinator");
    expect(ledger.groups[0]!.state).toBe("merged");
  });

  test.each([false, true])(
    "group review binds the exact head before a child merge unlocks its successor (bootstrap=%s)",
    (bootstrap) => {
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
        request(ledger, "start-a", { task_id: "a", state: "running", occurred_at: at }, taskActor),
      );
      const pr = {
        provider: "github",
        repository: "example/repo",
        id: "1",
        url: "https://github.com/example/repo/pull/1",
      };
      apply(ledger, "task-pr", request(ledger, "task-pr", { task_id: "a", pr }, taskActor));
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
        apply(ledger, "merge-claim", request(ledger, "premature", claim, taskActor)),
      ).toThrow("quality proof");
      apply(
        ledger,
        "task-quality-record",
        request(
          ledger,
          "review",
          {
            task_id: "a",
            base_sha: base,
            evidence: {
              id: "review-fact",
              kind: "task_quality",
              subject_id: "a",
              status: "passed",
              source: taskActor.thread_id,
              observed_at: at,
              sha: head,
              evidence_ref: "review-proof",
              quality: taskQuality("a", taskActor.thread_id, pr, base, head),
            },
          },
          taskActor,
        ),
      );
      apply(ledger, "merge-claim", request(ledger, "claim-merge", claim, taskActor));
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
    },
  );

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
    apply(ledger, "task-pr", request(ledger, "pr-b", { task_id: "b", pr }, actor));
    apply(
      ledger,
      "task-quality-record",
      request(
        ledger,
        "review-b",
        {
          task_id: "b",
          base_sha: base,
          evidence: {
            id: "review-b",
            kind: "task_quality",
            subject_id: "b",
            status: "passed",
            source: actor.thread_id,
            observed_at: at,
            sha: head,
            evidence_ref: "review-proof",
            quality: taskQuality("b", actor.thread_id, pr, base, head),
          },
        },
        actor,
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
    expect(() => apply(ledger, "cut-apply", request(ledger, "cut-too-early", cutPayload))).toThrow(
      "pending merges",
    );
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
    contaminated.next_group.coordination_execution = {
      state: "running",
      reason: null,
      waiting_for_task_ids: [],
    };
    expect(() =>
      apply(ledger, "cut-apply", request(ledger, "cut-contaminated", contaminated)),
    ).toThrow("pre-existing runtime");
    const bootstrapCut = structuredClone(cutPayload) as any;
    bootstrapCut.next_group.delivery_unit_kind = "bootstrap";
    bootstrapCut.next_group.owner_kind = "main";
    const beforeRejectedCut = structuredClone(ledger);
    expect(() =>
      apply(ledger, "cut-apply", request(ledger, "cut-bootstrap", bootstrapCut)),
    ).toThrow("only be created during run initialization");
    expect(ledger).toEqual(beforeRejectedCut);
    apply(ledger, "cut-apply", request(ledger, "cut-finished", cutPayload));
    expect(ledger.groups.find((item) => item.id === "g")!.cut_sha).toBe(merge);
    expect(ledger.plans[0]!.cut_rules[0]!.status).toBe("applied");
    expect(ledger.tasks.find((item) => item.id === "a")!.group_id).toBe("g");
    expect(ledger.tasks.find((item) => item.id === "b")!.group_id).toBe("g");
    expect(ledger.tasks.find((item) => item.id === "c")!.group_id).toBe("g-next");
    expect(ledger.tasks.find((item) => item.id === "deploy")!.group_id).toBe("g");
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
    expect(() => apply(ledger, "group-base", request(ledger, "too-early-base", newBase))).toThrow(
      "not merged",
    );
    ledger.groups.find((item) => item.id === "g")!.state = "merged";
    ledger.groups.find((item) => item.id === "g")!.merge_sha = merge;
    expect(() => apply(ledger, "group-base", request(ledger, "new-base", newBase))).not.toThrow();
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

    expect(ledger.tasks.find((item) => item.id === "b")!.state).toBe("starting");
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
    proposed.nodes.find((node) => node.kind === "task" && node.ref_id === "a")!.label = "a revised";
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
    expect(() =>
      apply(
        ledger,
        "plan-propose",
        request(ledger, "owner-rewrite", {
          plan: proposed,
          groups,
          tasks: structuredClone(ledger.tasks),
        }),
      ),
    ).toThrow("Plan revision cannot overwrite runtime group g");
    expect(ledger.groups).toEqual(originalGroups);
    expect(ledger.events).toEqual(originalEvents);
  });

  test("rejects a new bootstrap introduced by plan revision without changing history", () => {
    const ledger = fixture();
    const proposed = structuredClone(ledger.plans[0]!);
    proposed.id = "plan-retrofit-bootstrap";
    proposed.supersedes_id = ledger.active_plan_id;
    const newGroup = {
      ...structuredClone(ledger.groups[0]!),
      id: "new-bootstrap",
      state: "planned",
      delivery_unit_kind: "bootstrap",
      owner_kind: "main",
      agent_thread_id: null,
      parent_branch: null,
      parent_pr: null,
      current_sha: null,
    };
    const before = structuredClone(ledger);
    expect(() =>
      apply(
        ledger,
        "plan-propose",
        request(ledger, "retrofit-bootstrap", {
          plan: proposed,
          groups: [...structuredClone(ledger.groups), newGroup],
          tasks: structuredClone(ledger.tasks),
        }),
      ),
    ).toThrow("only be created during run initialization");
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
    const sentNotice = ledger.notifications.find((item) => item.id === notice.id)!;
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
    const acknowledgedNotice = ledger.notifications.find((item) => item.id === notice.id)!;
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
    expect(legacy.notifications.find((item) => item.id === notice.id)!.status).toBe("unknown");
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
    const updated = apply(
      ledger,
      "execution-profile-update",
      request(ledger, "profile-a", {
        target_type: "task",
        target_id: "a",
        execution_profile: { model: "gpt-6.1-sol", thinking: "high" },
      }),
    );
    expect((updated as any).result).toMatchObject({ target_id: "a" });
    expect(ledger.tasks[0].execution_profile).toEqual({ model: "gpt-6.1-sol", thinking: "high" });
    expect(ledger.groups[0].execution_profile).toBeNull();
    expect(() =>
      apply(
        ledger,
        "execution-profile-update",
        request(ledger, "partial-profile", {
          target_type: "task",
          target_id: "a",
          execution_profile: { model: "gpt-6-luna" },
        }),
      ),
    ).toThrow();
    ledger.tasks[0].thread_id = "created-thread";
    expect(() =>
      apply(
        ledger,
        "execution-profile-update",
        request(ledger, "frozen-profile", {
          target_type: "task",
          target_id: "a",
          execution_profile: null,
        }),
      ),
    ).toThrow("frozen");
  });
  test("native request freezes both editing and recommendation, including unknown creation", () => {
    const ledger = fixture();
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-profile", { task_id: "a", operation_id: "profile-op" }),
    );
    apply(
      ledger,
      "dispatch-bind-request",
      request(ledger, "native-profile", {
        operation_id: "profile-op",
        native_request_id: "native-profile",
      }),
    );
    for (const command of ["execution-profile-update", "execution-profile-recommend"]) {
      expect(() =>
        apply(
          ledger,
          command,
          request(ledger, command, {
            target_type: "task",
            target_id: "a",
            execution_profile: null,
          }),
        ),
      ).toThrow("frozen");
    }
    apply(
      ledger,
      "dispatch-resolve",
      request(ledger, "unknown-profile", { operation_id: "profile-op", outcome: "unknown" }),
    );
    expect(() =>
      apply(
        ledger,
        "execution-profile-update",
        request(ledger, "edit-unknown", {
          target_type: "task",
          target_id: "a",
          execution_profile: null,
        }),
      ),
    ).toThrow("frozen");
    expect(
      ledger.operations.find((item) => item.id === "profile-op")?.request.execution_profile,
    ).toEqual(ledger.config.execution_profile);
  });

  test("profile change cancels an unbound claim and recommendation preserves its audit history", () => {
    const ledger = fixture();
    approve(ledger);
    apply(
      ledger,
      "dispatch-claim",
      request(ledger, "claim-profile", { task_id: "a", operation_id: "profile-op" }),
    );
    apply(
      ledger,
      "execution-profile-update",
      request(ledger, "manual-profile", {
        target_type: "task",
        target_id: "a",
        execution_profile: { model: "gpt-6-luna", thinking: "high" },
      }),
    );
    expect(ledger.operations.find((item) => item.id === "profile-op")?.status).toBe("failed");
    expect(
      ledger.events.find((item) => item.type === "dispatch_claim_replaced")?.data
        .previous_effective_profile,
    ).toEqual(ledger.config.execution_profile);
    expect(ledger.tasks[0].execution_profile_source).toBe("manual");
    apply(
      ledger,
      "execution-profile-recommend",
      request(ledger, "recommend-profile", { target_type: "task", target_id: "a" }),
    );
    expect(ledger.tasks[0].execution_profile).toEqual({ model: "gpt-6.1-sol", thinking: "high" });
    expect(ledger.events.at(-1)?.data.previous_profile).toEqual({
      model: "gpt-6-luna",
      thinking: "high",
    });
  });

  test("legacy profile migration requires a full explicit pair and exact revision", () => {
    const ledger = fixture();
    ledger.config.execution_profile = null;
    expect(() => approve(ledger)).toThrow("read-only");
    expect(() =>
      apply(
        ledger,
        "execution-profile-migrate",
        request(ledger, "partial", { execution_profile: { model: "gpt-6-luna" } }),
      ),
    ).toThrow();
    const input = request(ledger, "migrate-profile", {
      execution_profile: { model: "gpt-6-luna", thinking: "medium" },
    });
    apply(ledger, "execution-profile-migrate", input);
    expect(ledger.revision).toBe(1);
    expect((apply(ledger, "execution-profile-migrate", input) as any).code).toBe("REPLAYED");
    expect(ledger.events.at(-1)?.type).toBe("execution_profile_migrated");
  });

});

