import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_023: Record<string, ScenarioWitness> = {
  "skills/find-next-plan/scripts/test_find_next_plan.py::test_lifecycle_repo_returns_no_task_queue":
    {
      test_file: "bin/tests/docs/plan_and_hardware.test.ts",
      test_name: "falls back from a lifecycle catalog to the legacy plan queue",
      batch_id: "plan-queue-fallback",
      invariant:
        "The named Bun batch test asserts the plan queue fallback contract.",
      coverage_note:
        "Explicit static assignment for skills/find-next-plan/scripts/test_find_next_plan.py::test_lifecycle_repo_returns_no_task_queue to the plan queue fallback batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/find-next-plan/scripts/test_find_next_plan.py::test_prefers_partial_over_ready":
    {
      test_file: "bin/tests/docs/plan_and_hardware.test.ts",
      test_name:
        "selects partial work before ready work and uses git creation time",
      batch_id: "next-plan-ordering",
      invariant:
        "The named Bun batch test asserts the next plan ordering contract.",
      coverage_note:
        "Explicit static assignment for skills/find-next-plan/scripts/test_find_next_plan.py::test_prefers_partial_over_ready to the next plan ordering batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/find-next-plan/scripts/test_find_next_plan.py::test_slug_only_lifecycle_catalog_returns_no_task_queue":
    {
      test_file: "bin/tests/docs/plan_and_hardware.test.ts",
      test_name: "falls back from a lifecycle catalog to the legacy plan queue",
      batch_id: "plan-queue-fallback",
      invariant:
        "The named Bun batch test asserts the plan queue fallback contract.",
      coverage_note:
        "Explicit static assignment for skills/find-next-plan/scripts/test_find_next_plan.py::test_slug_only_lifecycle_catalog_returns_no_task_queue to the plan queue fallback batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/find-next-plan/scripts/test_find_next_plan.py::test_uses_git_creation_time_instead_of_readme_row_order":
    {
      test_file: "bin/tests/docs/plan_and_hardware.test.ts",
      test_name:
        "selects partial work before ready work and uses git creation time",
      batch_id: "next-plan-ordering",
      invariant:
        "The named Bun batch test asserts the next plan ordering contract.",
      coverage_note:
        "Explicit static assignment for skills/find-next-plan/scripts/test_find_next_plan.py::test_uses_git_creation_time_instead_of_readme_row_order to the next plan ordering batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_allows_no_pr_worktree_required":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_allows_no_pr_worktree_required to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_classifies_current_native_task_worktree":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_classifies_current_native_task_worktree to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_collects_facts":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_collects_facts to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_does_not_adopt_unrelated_codex_worktrees":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_does_not_adopt_unrelated_codex_worktrees to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_excludes_codex_managed_worktree_from_manual_cleanup":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_excludes_codex_managed_worktree_from_manual_cleanup to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_keeps_port_scope_resolved_by_default":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_keeps_port_scope_resolved_by_default to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_marks_pr_worktree_missing":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_marks_pr_worktree_missing to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_preserves_explicit_unresolved_port_scope":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_build_context_preserves_explicit_unresolved_port_scope to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_context.py::test_parse_worktree_porcelain":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "parses live worktree rows and context facts",
      batch_id: "closeout-context-facts",
      invariant:
        "The named Bun batch test asserts the closeout context facts contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_context.py::test_parse_worktree_porcelain to the closeout context facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_complete_when_no_port_scope_was_resolved":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "accepts complete PR cleanup only when every required state is closed",
      batch_id: "closeout-completion-gate",
      invariant:
        "The named Bun batch test asserts the closeout completion gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_complete_when_no_port_scope_was_resolved to the closeout completion gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_complete_when_no_pr_worktree_was_required":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "accepts complete PR cleanup only when every required state is closed",
      batch_id: "closeout-completion-gate",
      invariant:
        "The named Bun batch test asserts the closeout completion gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_complete_when_no_pr_worktree_was_required to the closeout completion gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_source_repo_unavailable_remote_unknown_exception":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_source_repo_unavailable_remote_unknown_exception to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_blocks_manual_cleanup_of_codex_managed_worktree":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_blocks_manual_cleanup_of_codex_managed_worktree to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_local_pr_head_branch_still_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_local_pr_head_branch_still_exists to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_observed_worktree_paths_missing":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_observed_worktree_paths_missing to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_pending_user_decision_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "accepts complete PR cleanup only when every required state is closed",
      batch_id: "closeout-completion-gate",
      invariant:
        "The named Bun batch test asserts the closeout completion gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_pending_user_decision_exists to the closeout completion gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_port_lease_still_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_port_lease_still_exists to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_pr_worktree_exists_and_clean":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_pr_worktree_exists_and_clean to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_pr_worktree_requirement_unknown":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_pr_worktree_requirement_unknown to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_remote_pr_head_still_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_remote_pr_head_still_exists to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_required_pr_worktree_paths_missing":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_required_pr_worktree_paths_missing to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_required_pr_worktree_still_exists_by_observation":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "accepts complete PR cleanup only when every required state is closed",
      batch_id: "closeout-completion-gate",
      invariant:
        "The named Bun batch test asserts the closeout completion gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_downgrades_when_required_pr_worktree_still_exists_by_observation to the closeout completion gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_requires_native_archive_for_observed_codex_managed_worktree":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "protects native Worktrees and unresolved port leases",
      batch_id: "closeout-resource-protection",
      invariant:
        "The named Bun batch test asserts the closeout resource protection contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_closeout_gate.py::test_requires_native_archive_for_observed_codex_managed_worktree to the closeout resource protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_build_context_marks_present_merge_worktree":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-context",
      invariant:
        "The named Bun batch test asserts the local merge closeout context contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_build_context_marks_present_merge_worktree to the local merge closeout context batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_build_context_marks_removed_merge_worktree":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-context",
      invariant:
        "The named Bun batch test asserts the local merge closeout context contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_build_context_marks_removed_merge_worktree to the local merge closeout context batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_build_context_marks_unknown_topic_when_not_provided":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-context",
      invariant:
        "The named Bun batch test asserts the local merge closeout context contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_build_context_marks_unknown_topic_when_not_provided to the local merge closeout context batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
