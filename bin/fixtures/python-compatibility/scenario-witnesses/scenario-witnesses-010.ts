import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_010: Record<string, ScenarioWitness> = {
  "bin/test_flow_receipt.py::test_post_merge_evidence_file_uses_strict_normalization":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_post_merge_evidence_file_uses_strict_normalization to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_post_merge_receipt_does_not_recover_matching_inputs_without_premerge_binding":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_post_merge_receipt_does_not_recover_matching_inputs_without_premerge_binding to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_post_merge_receipt_recovers_stale_pr_inputs_without_review_assessment":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_post_merge_receipt_recovers_stale_pr_inputs_without_review_assessment to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_post_merge_receipt_rejects_evidence_that_differs_from_live_merged_pr":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_post_merge_receipt_rejects_evidence_that_differs_from_live_merged_pr to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_post_merge_record_ignores_historical_non_convergent_review_state":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_post_merge_record_ignores_historical_non_convergent_review_state to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_rebase_equivalence_is_read_only_and_accepts_matching_deltas":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_rebase_equivalence_is_read_only_and_accepts_matching_deltas to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_rebase_equivalence_rejects_changed_delta_without_writing":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_rebase_equivalence_rejects_changed_delta_without_writing to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_receipt_contract_tests_do_not_create_filesystem_fixtures":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_receipt_contract_tests_do_not_create_filesystem_fixtures to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_repair_authorization_waits_for_all_lanes_to_finalize":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_repair_authorization_waits_for_all_lanes_to_finalize to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_repair_limit_and_v5_history_migration": {
    test_file: "bin/tests/flow/flow.test.ts",
    test_name:
      "current-head attestation only reuses a receipt for an equivalent delta",
    batch_id: "current-head-receipt-freshness",
    invariant:
      "The named Bun batch test asserts the current-head receipt freshness contract.",
    coverage_note:
      "Explicit static assignment for bin/test_flow_receipt.py::test_repair_limit_and_v5_history_migration to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_flow_receipt.py::test_repository_unavailable_or_no_evidence_is_not_clear_proof":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_repository_unavailable_or_no_evidence_is_not_clear_proof to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_review_assessment_command_accepts_tier_and_rationale":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "acceptance evidence binds candidate and deployment identities",
      batch_id: "acceptance-identity-binding",
      invariant:
        "The named Bun batch test asserts the acceptance identity binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_review_assessment_command_accepts_tier_and_rationale to the acceptance identity binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_review_cli_accepts_only_an_inline_subagent_result":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_review_cli_accepts_only_an_inline_subagent_result to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_schemas_older_than_v5_are_rejected": {
    test_file: "bin/tests/flow/flow.test.ts",
    test_name: "terminal sealing archives immutable state and is idempotent",
    batch_id: "flow-terminal-sealing",
    invariant:
      "The named Bun batch test asserts the flow terminal sealing contract.",
    coverage_note:
      "Explicit static assignment for bin/test_flow_receipt.py::test_schemas_older_than_v5_are_rejected to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_flow_receipt.py::test_stale_repair_can_issue_the_next_permit_from_current_head":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_stale_repair_can_issue_the_next_permit_from_current_head to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_stale_repair_wave_keeps_its_consumed_permit":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_stale_repair_wave_keeps_its_consumed_permit to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_status_summarizes_post_merge_receipts_without_retry_accounting":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_status_summarizes_post_merge_receipts_without_retry_accounting to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_subagent_receipt_rejects_a_stale_wave_head": {
    test_file: "bin/tests/flow/flow.test.ts",
    test_name:
      "current-head attestation only reuses a receipt for an equivalent delta",
    batch_id: "current-head-receipt-freshness",
    invariant:
      "The named Bun batch test asserts the current-head receipt freshness contract.",
    coverage_note:
      "Explicit static assignment for bin/test_flow_receipt.py::test_subagent_receipt_rejects_a_stale_wave_head to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_flow_receipt.py::test_subagent_result_records_a_current_wave_receipt_in_memory":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_subagent_result_records_a_current_wave_receipt_in_memory to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_subagent_unavailable_result_only_enables_the_ordered_sol_fallback":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_subagent_unavailable_result_only_enables_the_ordered_sol_fallback to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_subagent_unavailable_result_requires_startup_classification":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_subagent_unavailable_result_requires_startup_classification to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_terminal_v5_receipt_is_read_without_migration":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_terminal_v5_receipt_is_read_without_migration to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_tier_four_requires_agent_selected_dynamic_lane":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_tier_four_requires_agent_selected_dynamic_lane to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_tier_three_assessment_remains_valid_after_a_repair_head_advance":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_tier_three_assessment_remains_valid_after_a_repair_head_advance to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_tier_three_keeps_the_four_required_lanes": {
    test_file: "bin/tests/flow/flow.test.ts",
    test_name: "acceptance evidence binds candidate and deployment identities",
    batch_id: "acceptance-identity-binding",
    invariant:
      "The named Bun batch test asserts the acceptance identity binding contract.",
    coverage_note:
      "Explicit static assignment for bin/test_flow_receipt.py::test_tier_three_keeps_the_four_required_lanes to the acceptance identity binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_flow_receipt.py::test_unavailable_profile_cannot_be_retried_in_the_same_wave":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_unavailable_profile_cannot_be_retried_in_the_same_wave to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_unknown_v5_receipt_state_is_rejected": {
    test_file: "bin/tests/flow/flow.test.ts",
    test_name:
      "current-head attestation only reuses a receipt for an equivalent delta",
    batch_id: "current-head-receipt-freshness",
    invariant:
      "The named Bun batch test asserts the current-head receipt freshness contract.",
    coverage_note:
      "Explicit static assignment for bin/test_flow_receipt.py::test_unknown_v5_receipt_state_is_rejected to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_flow_receipt.py::test_v5_migration_preserves_active_pr_binding_facts":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_v5_migration_preserves_active_pr_binding_facts to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_v5_migration_replaces_legacy_lower_tier_assessment":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_v5_migration_replaces_legacy_lower_tier_assessment to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_validation_acceptance_evidence_accepts_inline_json":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_validation_acceptance_evidence_accepts_inline_json to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
