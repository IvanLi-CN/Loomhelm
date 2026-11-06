import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_024: Record<string, ScenarioWitness> = {
  "skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_parse_worktree_porcelain":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-context",
      invariant:
        "The named Bun batch test asserts the local merge closeout context contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_context.py::test_parse_worktree_porcelain to the local merge closeout context batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_clean_policy_contradicts_dirty_worktree":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-gate",
      invariant:
        "The named Bun batch test asserts the local merge closeout gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_clean_policy_contradicts_dirty_worktree to the local merge closeout gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_current_branch_is_not_base":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-gate",
      invariant:
        "The named Bun batch test asserts the local merge closeout gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_current_branch_is_not_base to the local merge closeout gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_merge_worktree_still_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-gate",
      invariant:
        "The named Bun batch test asserts the local merge closeout gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_merge_worktree_still_exists to the local merge closeout gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_pending_action_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-gate",
      invariant:
        "The named Bun batch test asserts the local merge closeout gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_pending_action_exists to the local merge closeout gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_topic_branch_status_unknown":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-gate",
      invariant:
        "The named Bun batch test asserts the local merge closeout gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_topic_branch_status_unknown to the local merge closeout gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_topic_branch_still_exists":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
      batch_id: "local-merge-closeout-gate",
      invariant:
        "The named Bun batch test asserts the local merge closeout gate contract.",
      coverage_note:
        "Explicit static assignment for skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_downgrades_when_topic_branch_still_exists to the local merge closeout gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_allocate_ignores_recent_pid_backed_stale_rows":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "native flock serializes competing allocations",
      batch_id: "port-registry-allocation-lock",
      invariant:
        "The named Bun batch test asserts the port registry allocation lock contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_allocate_ignores_recent_pid_backed_stale_rows to the port registry allocation lock batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_allocate_skips_used_random_block_for_foreign_scope":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "native flock serializes competing allocations",
      batch_id: "port-registry-allocation-lock",
      invariant:
        "The named Bun batch test asserts the port registry allocation lock contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_allocate_skips_used_random_block_for_foreign_scope to the port registry allocation lock batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_default_allocate_spreads_different_scopes":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "reuses a scope lease and keeps service offsets in its block",
      batch_id: "port-registry-scope-lease",
      invariant:
        "The named Bun batch test asserts the port registry scope lease contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_default_allocate_spreads_different_scopes to the port registry scope lease batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_default_allocate_uses_stable_scope_random_port_above_10000":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "native flock serializes competing allocations",
      batch_id: "port-registry-allocation-lock",
      invariant:
        "The named Bun batch test asserts the port registry allocation lock contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_default_allocate_uses_stable_scope_random_port_above_10000 to the port registry allocation lock batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_gc_removes_recent_pid_backed_stale_rows_without_ttl_wait":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "native flock serializes competing allocations",
      batch_id: "port-registry-allocation-lock",
      invariant:
        "The named Bun batch test asserts the port registry allocation lock contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_gc_removes_recent_pid_backed_stale_rows_without_ttl_wait to the port registry allocation lock batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_inspect_removes_recent_pid_backed_stale_lease":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "reuses a scope lease and keeps service offsets in its block",
      batch_id: "port-registry-scope-lease",
      invariant:
        "The named Bun batch test asserts the port registry scope lease contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_inspect_removes_recent_pid_backed_stale_lease to the port registry scope lease batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_register_reclaims_port_after_pid_backed_stale_cleanup":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "native flock serializes competing allocations",
      batch_id: "port-registry-allocation-lock",
      invariant:
        "The named Bun batch test asserts the port registry allocation lock contract.",
      coverage_note:
        "Explicit static assignment for skills/global-port-manager/scripts/test_port_registry.py::test_register_reclaims_port_after_pid_backed_stale_cleanup to the port registry allocation lock batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_apply_auto_records_action_and_reinspects":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment distinguishes safe fast-forward routes",
      batch_id: "base-alignment-route-selection",
      invariant:
        "The named Bun batch test asserts the base alignment route selection contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_apply_auto_records_action_and_reinspects to the base alignment route selection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_apply_auto_returns_owner_decision_exit_code":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name:
        "base alignment requires owner decisions for dirty or divergent bases",
      batch_id: "base-alignment-dirty-decision",
      invariant:
        "The named Bun batch test asserts the base alignment dirty decision contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_apply_auto_returns_owner_decision_exit_code to the base alignment dirty decision batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_creates_tracking_ref_when_local_base_missing":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment blocks a linked worktree owner",
      batch_id: "base-alignment-ownership",
      invariant:
        "The named Bun batch test asserts the base alignment ownership contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_creates_tracking_ref_when_local_base_missing to the base alignment ownership batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_marks_other_branch_non_checkout_ff":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name:
        "base alignment requires owner decisions for dirty or divergent bases",
      batch_id: "base-alignment-dirty-decision",
      invariant:
        "The named Bun batch test asserts the base alignment dirty decision contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_marks_other_branch_non_checkout_ff to the base alignment dirty decision batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_marks_primary_base_ff_only":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name:
        "base alignment requires owner decisions for dirty or divergent bases",
      batch_id: "base-alignment-dirty-decision",
      invariant:
        "The named Bun batch test asserts the base alignment dirty decision contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_marks_primary_base_ff_only to the base alignment dirty decision batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_switches_from_clean_head_branch":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment blocks a linked worktree owner",
      batch_id: "base-alignment-ownership",
      invariant:
        "The named Bun batch test asserts the base alignment ownership contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_switches_from_clean_head_branch to the base alignment ownership batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_safe_align_rebase_conflict_returns_recoverable_state":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment distinguishes safe fast-forward routes",
      batch_id: "base-alignment-route-selection",
      invariant:
        "The named Bun batch test asserts the base alignment route selection contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_safe_align_rebase_conflict_returns_recoverable_state to the base alignment route selection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_safe_align_rejects_non_primary_base_context":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment distinguishes safe fast-forward routes",
      batch_id: "base-alignment-route-selection",
      invariant:
        "The named Bun batch test asserts the base alignment route selection contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_safe_align_rejects_non_primary_base_context to the base alignment route selection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_safe_align_success_restores_stash_and_reports_aligned":
    {
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment distinguishes safe fast-forward routes",
      batch_id: "base-alignment-route-selection",
      invariant:
        "The named Bun batch test asserts the base alignment route selection contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_safe_align_success_restores_stash_and_reports_aligned to the base alignment route selection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_cli_usage_errors_use_reserved_exit_code":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "closed PRs and unavailable required reads fail closed",
      batch_id: "merge-preflight-fail-closed",
      invariant:
        "The named Bun batch test asserts the merge preflight fail closed contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_cli_usage_errors_use_reserved_exit_code to the merge preflight fail closed batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_cli_uses_exit_code_and_pretty_json_without_mutation":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "accepts a clean exact head and locks the live head",
      batch_id: "merge-preflight-exact-head",
      invariant:
        "The named Bun batch test asserts the merge preflight exact head contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_cli_uses_exit_code_and_pretty_json_without_mutation to the merge preflight exact head batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_closed_pr_is_blocked":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "accepts a clean exact head and locks the live head",
      batch_id: "merge-preflight-exact-head",
      invariant:
        "The named Bun batch test asserts the merge preflight exact head contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_closed_pr_is_blocked to the merge preflight exact head batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_dirty_tracked_untracked_and_submodule_state_blocks":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "accepts a clean exact head and locks the live head",
      batch_id: "merge-preflight-exact-head",
      invariant:
        "The named Bun batch test asserts the merge preflight exact head contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_dirty_tracked_untracked_and_submodule_state_blocks to the merge preflight exact head batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_local_or_expected_snapshot_mismatch_is_input_stale":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "closed PRs and unavailable required reads fail closed",
      batch_id: "merge-preflight-fail-closed",
      invariant:
        "The named Bun batch test asserts the merge preflight fail closed contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_local_or_expected_snapshot_mismatch_is_input_stale to the merge preflight fail closed batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_porcelain_parser_keeps_paths_with_spaces_and_renames":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "closed PRs and unavailable required reads fail closed",
      batch_id: "merge-preflight-fail-closed",
      invariant:
        "The named Bun batch test asserts the merge preflight fail closed contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_porcelain_parser_keeps_paths_with_spaces_and_renames to the merge preflight fail closed batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_preflight_never_invokes_mutating_git_or_gh_commands":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "closed PRs and unavailable required reads fail closed",
      batch_id: "merge-preflight-fail-closed",
      invariant:
        "The named Bun batch test asserts the merge preflight fail closed contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_preflight_never_invokes_mutating_git_or_gh_commands to the merge preflight fail closed batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
