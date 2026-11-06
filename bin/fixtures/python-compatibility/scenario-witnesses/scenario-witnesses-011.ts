import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_011: Record<string, ScenarioWitness> = {
  "bin/test_flow_receipt.py::test_validation_environment_preserves_normal_process_values":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "acceptance evidence binds candidate and deployment identities",
      batch_id: "acceptance-identity-binding",
      invariant:
        "The named Bun batch test asserts the acceptance identity binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_validation_environment_preserves_normal_process_values to the acceptance identity binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_validation_runner_does_not_use_a_login_shell":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_validation_runner_does_not_use_a_login_shell to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_active_review_spec_contracts_are_guarded":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_active_review_spec_contracts_are_guarded to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_adapter_prose_can_change_without_contract_failure":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_adapter_prose_can_change_without_contract_failure to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_blank_quote_line_closes_lazy_quote":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_blank_quote_line_closes_lazy_quote to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_binds_entry_mode":
    {
      test_file: "bin/tests/checks/candidate_tree_digest.test.ts",
      test_name:
        "candidate tree digest binds modes and rejects hidden or symlinked edits",
      batch_id: "candidate-tree-integrity",
      invariant:
        "The named Bun batch test binds committed tree entries to worktree content and mode.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_binds_entry_mode to the candidate tree integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_frames_blob_contents":
    {
      test_file: "bin/tests/checks/candidate_tree_digest.test.ts",
      test_name:
        "candidate tree digest binds modes and rejects hidden or symlinked edits",
      batch_id: "candidate-tree-integrity",
      invariant:
        "The named Bun batch test frames blob content and path metadata without collisions.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_frames_blob_contents to the candidate tree integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_rejects_hidden_skip_worktree_edit":
    {
      test_file: "bin/tests/checks/candidate_tree_digest.test.ts",
      test_name:
        "candidate tree digest binds modes and rejects hidden or symlinked edits",
      batch_id: "candidate-tree-integrity",
      invariant:
        "The named Bun batch test rejects clean-status skip-worktree content drift.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_rejects_hidden_skip_worktree_edit to the candidate tree integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_rejects_symlinked_parent":
    {
      test_file: "bin/tests/checks/candidate_tree_digest.test.ts",
      test_name:
        "candidate tree digest binds modes and rejects hidden or symlinked edits",
      batch_id: "candidate-tree-integrity",
      invariant:
        "The named Bun batch test rejects clean-status symlinked parent substitution.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_candidate_git_tree_digest_rejects_symlinked_parent to the candidate tree integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_context_and_active_spec_reject_legacy_design_gate":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_context_and_active_spec_reject_legacy_design_gate to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_convergence_boundaries_allow_concise_rewording_but_require_active_rules":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_convergence_boundaries_allow_concise_rewording_but_require_active_rules to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_empirical_acceptance_contract_guards_required_fields_and_consumers":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_empirical_acceptance_contract_guards_required_fields_and_consumers to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_explicit_quote_fence_close_releases_blockquote":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_explicit_quote_fence_close_releases_blockquote to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_explicit_thematic_break_ends_blockquote_before_active_contract":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_explicit_thematic_break_ends_blockquote_before_active_contract to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_four_space_thematic_break_remains_lazy_quote":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_four_space_thematic_break_remains_lazy_quote to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_historical_heading_inside_fence_cannot_satisfy_implementation_contract":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_historical_heading_inside_fence_cannot_satisfy_implementation_contract to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_historical_heading_inside_fence_does_not_truncate_active_contract":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_historical_heading_inside_fence_does_not_truncate_active_contract to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_historical_retired_terms_do_not_trigger_active_spec_checks":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_historical_retired_terms_do_not_trigger_active_spec_checks to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_html_blocks_are_non_operative_but_visible_to_serial_gate_scan":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_html_blocks_are_non_operative_but_visible_to_serial_gate_scan to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_invalid_backtick_info_string_is_not_a_fence":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_invalid_backtick_info_string_is_not_a_fence to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_late_resolution_is_owned_by_shared_contract_and_referenced_by_entries":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_late_resolution_is_owned_by_shared_contract_and_referenced_by_entries to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_legacy_step_four_serial_review_gate_is_rejected":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_legacy_step_four_serial_review_gate_is_rejected to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_missing_review_disposition_fails_in_isolated_copy":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_missing_review_disposition_fails_in_isolated_copy to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_pr_stage_barrier_replay_fixture_covers_active_and_quoted_contracts":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_pr_stage_barrier_replay_fixture_covers_active_and_quoted_contracts to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_pr_stage_parallel_contracts_guard_each_required_phrase":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_pr_stage_parallel_contracts_guard_each_required_phrase to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_pr_stage_replay_fixture_is_historical_not_live_candidate_proof":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_pr_stage_replay_fixture_is_historical_not_live_candidate_proof to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_quote_marker_inside_top_level_fence_does_not_close_fence":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_quote_marker_inside_top_level_fence_does_not_close_fence to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_quote_prefixed_fence_requires_quote_prefixed_content":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_quote_prefixed_fence_requires_quote_prefixed_content to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_quoted_text_cannot_satisfy_active_review_spec_contract":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_quoted_text_cannot_satisfy_active_review_spec_contract to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_instruction_architecture_check.py::test_release_planning_contract_guards_shared_reference_and_consumers":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name: "current instruction architecture and skills index are clean",
      batch_id: "instruction-architecture-contract",
      invariant:
        "The named Bun batch test asserts the instruction architecture contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_instruction_architecture_check.py::test_release_planning_contract_guards_shared_reference_and_consumers to the instruction architecture contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
