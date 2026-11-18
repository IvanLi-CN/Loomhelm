import { expect, test } from "bun:test";
import { canonicalizeContract3Plan } from "../lib/atomic-orchestration";
import { apply } from "../lib/engine";
import { protectedActionApproved, protectedActionTargetDigest } from "../lib/engine-support-core";
import { deliveryUnitPrMergedFromLedger } from "../lib/engine-support-gates";
import { defaultTaskAtoms } from "../lib/schema";
import { latestParentPrFact } from "../lib/view-readiness";
import { approve, at, fixture, groupActor, main, request } from "./engine-fixtures";
import { modernFixture, request as roleRequest } from "./role-flow-fixtures";

test("parent follow-up merge is rejected before a merged continuation exists", () => {
  const ledger = fixture();
  const originalParentPr = {
    provider: "github",
    repository: "example/repo",
    id: "139",
    url: "https://github.com/example/repo/pull/139",
  };
  const followUpPr = {
    provider: "github",
    repository: "example/repo",
    id: "146",
    url: "https://github.com/example/repo/pull/146",
  };
  ledger.groups[0].parent_pr = originalParentPr;
  for (const task of ledger.tasks) task.state = "integrated";
  approve(ledger);
  const mainBase = "d".repeat(40);
  const followUpHead = "e".repeat(40);
  expect(() =>
    apply(
      ledger,
      "merge-claim",
      request(
        ledger,
        "claim-parent-followup",
        {
          operation_id: "merge-parent-followup",
          group_id: "g",
          mode: "parent-followup",
          original_parent_pr: originalParentPr,
          original_parent_merge_sha: "c".repeat(40),
          target_branch: "main",
          expected_base_sha: mainBase,
          expected_head_sha: followUpHead,
          pr: followUpPr,
        },
        groupActor,
      ),
    ),
  ).toThrow("Only an active parent merge or an approved post-merge continuation");
});

function postMergeContinuationFixture() {
  const ledger = modernFixture();
  const group = ledger.groups[0]!;
  const parentPr = group.parent_pr!;
  const originalMerge = "c".repeat(64);
  const followUpHead = "e".repeat(64);
  const followUpMerge = "f".repeat(64);
  const followUpPr = {
    provider: "github",
    repository: "example/loomhelm",
    id: "follow-up",
    url: "https://github.com/example/loomhelm/pull/follow-up",
  };
  const task = structuredClone(ledger.tasks[0]!);
  task.id = "task-followup";
  task.title = "Post-merge contribution";
  task.owned_surfaces = ["src/post-merge"];
  task.base_sha = originalMerge;
  task.branch = task.id;
  task.atoms = defaultTaskAtoms(task.id);
  task.lifecycle = {
    workspace_ready: "unknown",
    pr_created: "unknown",
    pr_merged: "unknown",
    closed: "unknown",
  };
  ledger.tasks.push(task);

  const plan = ledger.plans[0]!;
  const templateNode = plan.nodes.find((node) => node.kind === "task")!;
  plan.nodes.push({
    ...structuredClone(templateNode),
    id: "node-followup",
    ref_id: task.id,
    label: task.title,
  });
  plan.atoms.push(
    ...task.atoms.map((atom) => ({
      id: atom.id,
      title: atom.title,
      task_id: task.id,
      purpose: "post-merge contribution atom",
      output: "post-merge contribution output",
    })),
  );
  plan.atomic_nodes.push(
    ...task.atoms.map((atom) => ({
      kind: "work" as const,
      id: atom.id,
      title: atom.title,
      purpose: "post-merge contribution atom",
      output: "post-merge contribution output",
      acceptance: [],
      activity_type: "contribution" as const,
      state: "planned" as const,
      scope: { kind: "task" as const, task_id: task.id, delivery_unit_id: group.id },
    })),
  );
  plan.atomic_edges.push(
    ...task.atoms.slice(1).map((atom, index) => ({
      id: `${task.id}-edge-${index}`,
      from_node_id: task.atoms[index]!.id,
      to_node_id: atom.id,
      requires: { kind: "source_terminal_success" as const },
    })),
  );
  plan.actions.push(
    {
      id: "publish-followup-branch",
      kind: "publish_branch",
      task_id: null,
      group_id: group.id,
      target_identity: `branch:${group.parent_branch}`,
    },
    {
      id: "publish-followup-pr",
      kind: "publish_pr",
      task_id: null,
      group_id: group.id,
      target_identity: "pr:follow-up",
    },
  );
  ledger.plans[0] = canonicalizeContract3Plan(plan, ledger.tasks);
  ledger.plans[0]!.revision = {
    execution_phase: "implementation",
    change_class: "implementation_high_impact",
    affected_task_ids: [task.id],
    affected_node_ids: ["node-followup"],
    affected_edge_ids: [],
    change_set: {
      added: [
        { path: `tasks[${task.id}]`, new_value: structuredClone(task) },
        {
          path: "plan.nodes[node-followup]",
          new_value: structuredClone(plan.nodes.at(-1)),
        },
        {
          path: "plan.actions[publish-followup-pr]",
          new_value: structuredClone(plan.actions.at(-1)),
        },
      ],
      removed: [],
      modified: [],
    },
    reason: {
      category: "discovered_constraint",
      summary: "A post-merge contribution is required to close the verified gap",
      evidence_refs: ["fixture:post-merge-gap"],
      impact: "Adds a planned contribution and a follow-up parent PR",
    },
    approval_required: true,
    paused_task_ids: [task.id],
  };

  group.state = "merged";
  group.current_sha = originalMerge;
  group.merge_sha = originalMerge;
  group.pr = {
    state: "merged",
    pr: parentPr,
    parent_branch: group.parent_branch!,
    merge_sha: originalMerge,
  };
  group.lifecycle.pr_merged = "passed";
  group.coordination_execution = { state: "idle", reason: null, waiting_for_task_ids: [] };
  const branchFact = ledger.facts.find(
    (fact) => fact.kind === "branch_published" && fact.subject_id === group.id,
  )!;
  branchFact.sha = originalMerge;
  if (branchFact.receipt) branchFact.receipt.head_sha = originalMerge;
  const mergeFactId = "group-parent-merge";
  ledger.facts.push({
    id: mergeFactId,
    kind: "pr_merged",
    subject_id: group.id,
    status: "passed",
    source: "github",
    observed_at: "2026-01-01T00:01:00.000Z",
    sha: originalMerge,
    evidence_ref: "fixture:parent-merge",
    receipt: {
      provider: "github",
      repository: "example/loomhelm",
      resource_type: "pr",
      resource_id: parentPr.id,
      branch: group.parent_branch!,
      target_branch: "main",
      base_sha: originalMerge,
      head_sha: originalMerge,
      merge_sha: originalMerge,
      pr: parentPr,
      state: "merged",
      evidence_ref: "fixture:parent-merge",
    },
  });
  ledger.operations.push({
    id: "group-parent-merge-op",
    kind: "merge",
    actor_id: group.agent_thread_id!,
    target_id: group.id,
    status: "succeeded",
    request: { mode: "parent", pr: parentPr },
    expected_sha: originalMerge,
    receipt_fact_id: mergeFactId,
    created_at: "2026-01-01T00:01:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
  });
  ledger.events.push({
    id: "followup-protected-approval",
    type: "protected_action_approved",
    subject_id: group.id,
    actor_id: main.thread_id,
    occurred_at: "2026-01-01T00:01:00.000Z",
    recorded_at: "2026-01-01T00:01:00.000Z",
    data: {
      kind: "delivery_unit_merge",
      approval_id: "followup-approval",
      target_digest: protectedActionTargetDigest({
        kind: "delivery_unit_merge",
        mode: "parent-followup",
        group_id: group.id,
        pr: followUpPr,
        expected_head_sha: followUpHead,
        expected_base_sha: originalMerge,
        target_branch: "main",
        original_parent_pr: parentPr,
        original_parent_merge_sha: originalMerge,
      }),
    },
  });
  return { ledger, group, task, parentPr, originalMerge, followUpPr, followUpHead, followUpMerge };
}

test("approved plan revisions can dispatch a contribution after group merge", () => {
  const { ledger, task } = postMergeContinuationFixture();
  const result = apply(
    ledger,
    "dispatch-claim",
    roleRequest(ledger, "post-merge-dispatch", {
      task_id: task.id,
      operation_id: "post-merge-dispatch",
    }),
  ) as { result: { operation_id: string } };

  expect(result.result.operation_id).toBe("post-merge-dispatch");
  expect(ledger.groups[0]!.state).toBe("merged");
  expect(ledger.tasks.find((item) => item.id === task.id)?.state).toBe("planned");

  apply(
    ledger,
    "dispatch-bind-request",
    roleRequest(ledger, "post-merge-bind", {
      operation_id: "post-merge-dispatch",
      native_request_id: "native-post-merge-dispatch",
      creation_parameters: {
        title: task.title,
        prompt: "Continue the approved post-merge contribution",
        cwd: "/tmp/post-merge",
        execution_profile: ledger.config.execution_profile,
        transport: "codex-exec",
      },
    }),
  );
  expect(ledger.operations.find((item) => item.id === "post-merge-dispatch")?.status).toBe(
    "unknown",
  );
});

test("contract-3 dispatch requires the approved dispatch action", () => {
  const { ledger, task } = postMergeContinuationFixture();
  const approval = ledger.events.find((event) => event.type === "plan_approved");
  approval!.data.authorized_actions = ["publish_branch", "publish_pr", "merge"];

  expect(() =>
    apply(
      ledger,
      "dispatch-claim",
      roleRequest(ledger, "post-merge-dispatch-without-action", {
        task_id: task.id,
        operation_id: "post-merge-dispatch-without-action",
      }),
    ),
  ).toThrow("Action dispatch is not approved");
});

test("merged groups reject contributions without an approved plan revision", () => {
  const { ledger, task } = postMergeContinuationFixture();
  ledger.plans[0]!.revision = null;

  expect(() =>
    apply(
      ledger,
      "dispatch-claim",
      roleRequest(ledger, "post-merge-dispatch-without-revision", {
        task_id: task.id,
        operation_id: "post-merge-dispatch-without-revision",
      }),
    ),
  ).toThrow("Task group is not active or approved for a post-merge continuation");
});

test("a normal parent merge cannot reuse the merged continuation state", () => {
  const { ledger, group, parentPr, originalMerge } = postMergeContinuationFixture();

  expect(() =>
    apply(
      ledger,
      "merge-claim",
      roleRequest(
        ledger,
        "normal-parent-merge-after-merge",
        {
          operation_id: "normal-parent-merge-after-merge",
          mode: "parent",
          group_id: group.id,
          target_branch: "main",
          expected_base_sha: originalMerge,
          expected_head_sha: originalMerge,
          owner_approval_id: "followup-approval",
          pr: parentPr,
        },
        { role: "group", thread_id: group.agent_thread_id! },
      ),
    ),
  ).toThrow("Only an active parent merge or an approved post-merge continuation");
});

test("a follow-up merge approval is bound to its target digest", () => {
  const { ledger, group } = postMergeContinuationFixture();

  expect(() =>
    protectedActionApproved(
      ledger,
      "delivery_unit_merge",
      group.id,
      "followup-approval",
      "0".repeat(64),
    ),
  ).toThrow("Protected action delivery_unit_merge is not approved");
});

test("publication cannot claim a group branch while its merge is active", () => {
  const { ledger, group, originalMerge, followUpHead } = postMergeContinuationFixture();
  ledger.operations.push({
    id: "pending-follow-up-merge",
    kind: "merge",
    actor_id: group.agent_thread_id!,
    target_id: group.id,
    status: "claimed",
    request: { mode: "parent-followup" },
    expected_sha: originalMerge,
    receipt_fact_id: null,
    created_at: at,
    updated_at: at,
  });

  expect(() =>
    apply(
      ledger,
      "publish-branch-claim",
      roleRequest(
        ledger,
        "follow-up-branch-during-merge",
        {
          operation_id: "follow-up-branch-during-merge",
          action_id: "publish-followup-branch",
          target_type: "group",
          target_id: group.id,
          branch: group.parent_branch,
          expected_head_sha: followUpHead,
        },
        { role: "group", thread_id: group.agent_thread_id! },
      ),
    ),
  ).toThrow("A merge into this group is already pending");
});

test("group closeout waits for an unmerged continuation publication", () => {
  const { ledger, group, originalMerge, followUpPr } = postMergeContinuationFixture();
  for (const task of ledger.tasks) task.state = "integrated";
  group.atoms.forEach((atom, index) => {
    atom.status = index === group.atoms.length - 1 ? "running" : "completed";
  });
  ledger.facts.push({
    id: "post-merge-ci",
    kind: "ci_passed",
    subject_id: group.id,
    status: "passed",
    source: "github",
    observed_at: "2026-01-01T00:03:00.000Z",
    sha: originalMerge,
    evidence_ref: "fixture:post-merge-ci",
  });
  ledger.facts.push({
    id: "pending-follow-up-pr-fact",
    kind: "pr_published",
    subject_id: group.id,
    status: "passed",
    source: "github",
    observed_at: "2026-01-01T00:04:00.000Z",
    sha: "e".repeat(64),
    evidence_ref: "fixture:pending-follow-up-pr",
    continuation: true,
    receipt: {
      provider: "github",
      repository: "example/loomhelm",
      resource_type: "pr",
      resource_id: followUpPr.id,
      branch: group.parent_branch!,
      target_branch: "main",
      base_sha: originalMerge,
      head_sha: "e".repeat(64),
      merge_sha: null,
      pr: followUpPr,
      state: "open",
      evidence_ref: "fixture:pending-follow-up-pr",
    },
  });

  expect(() =>
    apply(
      ledger,
      "group-close",
      roleRequest(
        ledger,
        "close-before-follow-up-merge",
        {
          group_id: group.id,
        },
        { role: "group", thread_id: group.agent_thread_id! },
      ),
    ),
  ).toThrow("A post-merge continuation PR has not been merged");
});

test("post-merge follow-up publication preserves the original parent PR receipt", () => {
  const { ledger, group, parentPr, originalMerge, followUpPr, followUpHead, followUpMerge } =
    postMergeContinuationFixture();
  group.current_sha = followUpHead;
  for (const task of ledger.tasks) {
    task.state = "integrated";
    if (task.id === "task-followup") for (const atom of task.atoms) atom.status = "completed";
  }

  apply(
    ledger,
    "publish-branch-claim",
    roleRequest(
      ledger,
      "follow-up-branch-claim",
      {
        operation_id: "follow-up-branch-op",
        action_id: "publish-followup-branch",
        target_type: "group",
        target_id: group.id,
        branch: group.parent_branch,
        expected_head_sha: followUpHead,
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );
  apply(
    ledger,
    "publish-branch-resolve",
    roleRequest(
      ledger,
      "follow-up-branch-resolve",
      {
        operation_id: "follow-up-branch-op",
        outcome: "succeeded",
        fact_id: "follow-up-branch-fact",
        provider_receipt: {
          provider: "github",
          repository: "example/loomhelm",
          resource_type: "branch",
          resource_id: group.parent_branch,
          branch: group.parent_branch,
          target_branch: null,
          base_sha: null,
          head_sha: followUpHead,
          pr: null,
          state: "exists",
          evidence_ref: "fixture:follow-up-branch",
        },
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );
  apply(
    ledger,
    "publish-pr-claim",
    roleRequest(
      ledger,
      "follow-up-pr-claim",
      {
        operation_id: "follow-up-pr-op",
        action_id: "publish-followup-pr",
        target_type: "group",
        target_id: group.id,
        branch: group.parent_branch,
        target_branch: "main",
        expected_base_sha: originalMerge,
        expected_head_sha: followUpHead,
        pr: followUpPr,
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );
  apply(
    ledger,
    "publish-pr-resolve",
    roleRequest(
      ledger,
      "follow-up-pr-resolve",
      {
        operation_id: "follow-up-pr-op",
        outcome: "succeeded",
        fact_id: "follow-up-pr-fact",
        provider_receipt: {
          provider: "github",
          repository: "example/loomhelm",
          resource_type: "pr",
          resource_id: followUpPr.id,
          branch: group.parent_branch,
          target_branch: "main",
          base_sha: originalMerge,
          head_sha: followUpHead,
          merge_sha: null,
          pr: followUpPr,
          state: "open",
          evidence_ref: "fixture:follow-up-pr",
        },
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );

  apply(
    ledger,
    "merge-claim",
    roleRequest(
      ledger,
      "follow-up-merge-claim",
      {
        operation_id: "follow-up-merge-op",
        mode: "parent-followup",
        group_id: group.id,
        original_parent_pr: parentPr,
        original_parent_merge_sha: originalMerge,
        target_branch: "main",
        expected_base_sha: originalMerge,
        expected_head_sha: followUpHead,
        owner_approval_id: "followup-approval",
        pr: followUpPr,
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );
  apply(
    ledger,
    "merge-resolve",
    roleRequest(
      ledger,
      "follow-up-merge-resolve",
      {
        operation_id: "follow-up-merge-op",
        outcome: "succeeded",
        provider_evidence: {
          id: "follow-up-merge-fact",
          kind: "pr_merged",
          subject_id: group.id,
          status: "passed",
          source: "github",
          observed_at: "2026-01-01T00:02:00.000Z",
          sha: followUpMerge,
          evidence_ref: "fixture:follow-up-merge",
          receipt: {
            provider: "github",
            repository: "example/loomhelm",
            resource_type: "pr",
            resource_id: followUpPr.id,
            branch: group.parent_branch,
            target_branch: "main",
            base_sha: originalMerge,
            head_sha: followUpHead,
            merge_sha: followUpMerge,
            pr: followUpPr,
            state: "merged",
            evidence_ref: "fixture:follow-up-merge",
          },
        },
        provider_observation: {
          pr: followUpPr,
          head_sha: followUpHead,
          base_sha: originalMerge,
          merge_sha: followUpMerge,
          state: "merged",
        },
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );

  const updatedGroup = ledger.groups[0]!;
  expect(updatedGroup.pr).toMatchObject({
    state: "merged",
    pr: parentPr,
    merge_sha: originalMerge,
  });
  expect(updatedGroup.parent_pr).toEqual(parentPr);
  expect(updatedGroup.current_sha).toBe(followUpHead);
  expect(updatedGroup.merge_sha).toBe(followUpMerge);
  expect(deliveryUnitPrMergedFromLedger(ledger, updatedGroup)).toBe(true);
  expect(latestParentPrFact(ledger, updatedGroup.id)?.receipt?.pr).toEqual(parentPr);

  expect(() =>
    apply(
      ledger,
      "merge-claim",
      roleRequest(
        ledger,
        "follow-up-merge-replay",
        {
          operation_id: "follow-up-merge-replay",
          mode: "parent-followup",
          group_id: group.id,
          original_parent_pr: parentPr,
          original_parent_merge_sha: originalMerge,
          target_branch: "main",
          expected_base_sha: originalMerge,
          expected_head_sha: followUpHead,
          owner_approval_id: "followup-approval",
          pr: followUpPr,
        },
        { role: "group", thread_id: group.agent_thread_id! },
      ),
    ),
  ).toThrow("Protected action delivery_unit_merge approval has already been used");
});

test("post-merge follow-up publication waits for new contribution atoms", () => {
  const { ledger, group, originalMerge, followUpPr, followUpHead } = postMergeContinuationFixture();
  group.current_sha = followUpHead;
  for (const task of ledger.tasks) task.state = "integrated";

  apply(
    ledger,
    "publish-branch-claim",
    roleRequest(
      ledger,
      "follow-up-branch-claim",
      {
        operation_id: "follow-up-branch-op",
        action_id: "publish-followup-branch",
        target_type: "group",
        target_id: group.id,
        branch: group.parent_branch,
        expected_head_sha: followUpHead,
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );
  apply(
    ledger,
    "publish-branch-resolve",
    roleRequest(
      ledger,
      "follow-up-branch-resolve",
      {
        operation_id: "follow-up-branch-op",
        outcome: "succeeded",
        fact_id: "follow-up-branch-fact",
        provider_receipt: {
          provider: "github",
          repository: "example/loomhelm",
          resource_type: "branch",
          resource_id: group.parent_branch,
          branch: group.parent_branch,
          target_branch: null,
          base_sha: null,
          head_sha: followUpHead,
          pr: null,
          state: "exists",
          evidence_ref: "fixture:follow-up-branch",
        },
      },
      { role: "group", thread_id: group.agent_thread_id! },
    ),
  );

  expect(() =>
    apply(
      ledger,
      "publish-pr-claim",
      roleRequest(
        ledger,
        "follow-up-pr-claim",
        {
          operation_id: "follow-up-pr-op",
          action_id: "publish-followup-pr",
          target_type: "group",
          target_id: group.id,
          branch: group.parent_branch,
          target_branch: "main",
          expected_base_sha: originalMerge,
          expected_head_sha: followUpHead,
          pr: followUpPr,
        },
        { role: "group", thread_id: group.agent_thread_id! },
      ),
    ),
  ).toThrow("Contribution task atoms must complete before parent PR publication");
});
