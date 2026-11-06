import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_005: Record<string, ScenarioWitness> = {
  "bin/test_agent_vm_migration_check.py::test_history_is_an_exact_exception_and_cannot_supply_commands":
    {
      test_file: "bin/tests/checks/agent_vm.test.ts",
      test_name:
        "Agent VM migration preserves clean routes and rejects retired fixtures",
      batch_id: "agent-vm-route-policy",
      invariant:
        "The named Bun batch test proves a clean candidate remains clean while retired routes, recreated Skills, and duplicate index rows are rejected.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_vm_migration_check.py::test_history_is_an_exact_exception_and_cannot_supply_commands to the Agent VM route policy batch. The witness includes the clean current checkout and negative fixture cases.",
    },
  "bin/test_agent_vm_migration_check.py::test_nested_agents_rules_and_python_are_scanned":
    {
      test_file: "bin/tests/checks/agent_vm.test.ts",
      test_name:
        "Agent VM migration preserves clean routes and rejects retired fixtures",
      batch_id: "agent-vm-route-policy",
      invariant:
        "The named Bun batch test proves a clean candidate remains clean while retired routes, recreated Skills, and duplicate index rows are rejected.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_vm_migration_check.py::test_nested_agents_rules_and_python_are_scanned to the Agent VM route policy batch. The witness includes the clean current checkout and negative fixture cases.",
    },
  "bin/test_code_hosting.py::test_branch_delete_422_or_404_followed_by_404_is_already_absent":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_branch_delete_422_or_404_followed_by_404_is_already_absent to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_branch_delete_422_with_present_ref_remains_a_blocker":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_branch_delete_422_with_present_ref_remains_a_blocker to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_branch_delete_requires_bound_not_found_verification":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_branch_delete_requires_bound_not_found_verification to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_encoded_repository_separator_is_rejected": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "supported remote forms resolve to one canonical identity",
    batch_id: "canonical-provider-identity",
    invariant:
      "The named Bun batch test asserts the canonical provider identity contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_encoded_repository_separator_is_rejected to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_gitea_ci_accepts_direct_task_array_and_filters_other_heads":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "asset URLs are provider-specific and pinned to a revision",
      batch_id: "provider-asset-revision-binding",
      invariant:
        "The named Bun batch test asserts the provider asset revision binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_gitea_ci_accepts_direct_task_array_and_filters_other_heads to the provider asset revision binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_gitea_ci_falls_back_to_runs_when_tasks_are_unsupported":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_gitea_ci_falls_back_to_runs_when_tasks_are_unsupported to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_gitea_ci_query_binds_runs_to_exact_sha": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "provider evidence redacts secret fields and URL credentials",
    batch_id: "provider-evidence-redaction",
    invariant:
      "The named Bun batch test asserts the provider evidence redaction contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_gitea_ci_query_binds_runs_to_exact_sha to the provider evidence redaction batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_gitea_ci_rejects_stale_status_response": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "supported remote forms resolve to one canonical identity",
    batch_id: "canonical-provider-identity",
    invariant:
      "The named Bun batch test asserts the canonical provider identity contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_gitea_ci_rejects_stale_status_response to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_gitea_ci_rejects_status_response_without_sha":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_gitea_ci_rejects_status_response_without_sha to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_gitea_json_body_uses_tea_data_flag": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name:
      "provider commands stay repository-bound and forward JSON bodies",
    batch_id: "repository-bound-provider-command",
    invariant:
      "The named Bun batch test asserts the repository-bound provider command contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_gitea_json_body_uses_tea_data_flag to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_gitea_merge_sends_expected_head_and_reads_merged_result":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_gitea_merge_sends_expected_head_and_reads_merged_result to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_gitea_pr_facts_normalize_refs_and_merge_state":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "provider evidence redacts secret fields and URL credentials",
      batch_id: "provider-evidence-redaction",
      invariant:
        "The named Bun batch test asserts the provider evidence redaction contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_gitea_pr_facts_normalize_refs_and_merge_state to the provider evidence redaction batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_gitea_rerun_accepts_empty_ack_then_verifies_exact_sha":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_gitea_rerun_accepts_empty_ack_then_verifies_exact_sha to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_gitea_rerun_reports_unsupported_capability": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "asset URLs are provider-specific and pinned to a revision",
    batch_id: "provider-asset-revision-binding",
    invariant:
      "The named Bun batch test asserts the provider asset revision binding contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_gitea_rerun_reports_unsupported_capability to the provider asset revision binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_github_api_command_uses_bound_endpoint_without_unsupported_repo_flag":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_github_api_command_uses_bound_endpoint_without_unsupported_repo_flag to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_github_branch_delete_uses_git_ref_endpoint": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "asset URLs are provider-specific and pinned to a revision",
    batch_id: "provider-asset-revision-binding",
    invariant:
      "The named Bun batch test asserts the provider asset revision binding contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_github_branch_delete_uses_git_ref_endpoint to the provider asset revision binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_github_ci_policy_200_exposes_required_contexts":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "provider evidence redacts secret fields and URL credentials",
      batch_id: "provider-evidence-redaction",
      invariant:
        "The named Bun batch test asserts the provider evidence redaction contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_github_ci_policy_200_exposes_required_contexts to the provider evidence redaction batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_github_ci_policy_404_is_confirmed_no_policy":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_github_ci_policy_404_is_confirmed_no_policy to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_github_ci_policy_read_failures_are_explicitly_unavailable":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_github_ci_policy_read_failures_are_explicitly_unavailable to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_github_plan_limited_protection_does_not_bypass_protected_branch":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_github_plan_limited_protection_does_not_bypass_protected_branch to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_github_plan_limited_protection_uses_confirmed_unprotected_branch":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name:
        "provider commands stay repository-bound and forward JSON bodies",
      batch_id: "repository-bound-provider-command",
      invariant:
        "The named Bun batch test asserts the repository-bound provider command contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_github_plan_limited_protection_uses_confirmed_unprotected_branch to the repository-bound provider command batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_lightweight_pr_facts_skip_related_collections_for_both_providers":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "asset URLs are provider-specific and pinned to a revision",
      batch_id: "provider-asset-revision-binding",
      invariant:
        "The named Bun batch test asserts the provider asset revision binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_lightweight_pr_facts_skip_related_collections_for_both_providers to the provider asset revision binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_nonstandard_remote_port_is_rejected": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "supported remote forms resolve to one canonical identity",
    batch_id: "canonical-provider-identity",
    invariant:
      "The named Bun batch test asserts the canonical provider identity contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_nonstandard_remote_port_is_rejected to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_code_hosting.py::test_pr_selector_cannot_redirect_from_approved_base_remote":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_pr_selector_cannot_redirect_from_approved_base_remote to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_provider_pr_identity_mismatch_fails_closed": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "provider PR identity mismatch fails closed",
    batch_id: "provider-pr-identity-contract",
    invariant:
      "The named Bun test rejects mismatched PR number, base repository, and canonical URL identities.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_provider_pr_identity_mismatch_fails_closed to the provider PR identity contract. The witness tests the mismatch invariant directly.",
  },
  "bin/test_code_hosting.py::test_provider_pr_url_must_be_canonical_https_binding":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "asset URLs are provider-specific and pinned to a revision",
      batch_id: "provider-asset-revision-binding",
      invariant:
        "The named Bun batch test asserts the provider asset revision binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_provider_pr_url_must_be_canonical_https_binding to the provider asset revision binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_provider_repository_identity_rejects_path_control_characters":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_provider_repository_identity_rejects_path_control_characters to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_code_hosting.py::test_unique_repository_resolution_uses_the_matching_gitea_remote":
    {
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
      batch_id: "canonical-provider-identity",
      invariant:
        "The named Bun batch test asserts the canonical provider identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_code_hosting.py::test_unique_repository_resolution_uses_the_matching_gitea_remote to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
