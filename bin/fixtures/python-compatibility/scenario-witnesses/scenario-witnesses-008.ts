import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_008: Record<string, ScenarioWitness> = {
  "bin/test_flow_continue_replay_check.py::test_fenced_switch_does_not_promote_a_visible_flow_mention":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name:
        "historical flow replay guards lock drift and Python route parity",
      batch_id: "historical-flow-replay-guard",
      invariant:
        "The named Bun batch test asserts the historical flow replay guard contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_continue_replay_check.py::test_fenced_switch_does_not_promote_a_visible_flow_mention to the historical flow replay guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_continue_replay_check.py::test_fenced_user_switch_is_not_a_flow_lock":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name:
        "historical flow replay guards lock drift and Python route parity",
      batch_id: "historical-flow-replay-guard",
      invariant:
        "The named Bun batch test asserts the historical flow replay guard contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_continue_replay_check.py::test_fenced_user_switch_is_not_a_flow_lock to the historical flow replay guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_continue_replay_check.py::test_flow_aliases_match_the_raw_plan_canonical_names":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name:
        "historical flow replay guards lock drift and Python route parity",
      batch_id: "historical-flow-replay-guard",
      invariant:
        "The named Bun batch test asserts the historical flow replay guard contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_continue_replay_check.py::test_flow_aliases_match_the_raw_plan_canonical_names to the historical flow replay guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_continue_replay_check.py::test_owner_projection_preserves_dev_plan_flow_lock":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name:
        "historical flow replay guards lock drift and Python route parity",
      batch_id: "historical-flow-replay-guard",
      invariant:
        "The named Bun batch test asserts the historical flow replay guard contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_continue_replay_check.py::test_owner_projection_preserves_dev_plan_flow_lock to the historical flow replay guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_active_legacy_high_requirement_is_retired_at_next_wave":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_active_legacy_high_requirement_is_retired_at_next_wave to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_active_manifest_restores_current_candidate_receipt_tests":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_active_manifest_restores_current_candidate_receipt_tests to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_active_pre_pr_acceptance_is_migrated_to_merge_proof":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "acceptance evidence binds candidate and deployment identities",
      batch_id: "acceptance-identity-binding",
      invariant:
        "The named Bun batch test asserts the acceptance identity binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_active_pre_pr_acceptance_is_migrated_to_merge_proof to the acceptance identity binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_authorize_repair_blocks_after_three_permits":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_authorize_repair_blocks_after_three_permits to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_bind_pr_accepts_a_pending_direct_review_assessment":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_bind_pr_accepts_a_pending_direct_review_assessment to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_bind_pr_accepts_a_recorded_direct_review_assessment":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "canonical JSON and hashes match the Python contract",
      batch_id: "flow-receipt-canonical-identity",
      invariant:
        "The named Bun batch test asserts the flow receipt canonical identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_bind_pr_accepts_a_recorded_direct_review_assessment to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_bind_pr_does_not_use_stale_review_assessment_as_a_gate":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_bind_pr_does_not_use_stale_review_assessment_as_a_gate to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_bound_pr_cannot_downgrade_a_mandatory_review_assessment":
    {
      test_file: "bin/tests/checks/flow_release.test.ts",
      test_name: "rejects unbound and stale release evidence",
      batch_id: "release-evidence-binding",
      invariant:
        "The named Bun batch test asserts the release evidence binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_bound_pr_cannot_downgrade_a_mandatory_review_assessment to the release evidence binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_cli_dispatches_complete_close_through_public_ledger_method":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_cli_dispatches_complete_close_through_public_ledger_method to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_cli_keeps_untyped_error_output_compatible": {
    test_file: "bin/tests/flow/flow.test.ts",
    test_name: "canonical JSON and hashes match the Python contract",
    batch_id: "flow-receipt-canonical-identity",
    invariant:
      "The named Bun batch test asserts the flow receipt canonical identity contract.",
    coverage_note:
      "Explicit static assignment for bin/test_flow_receipt.py::test_cli_keeps_untyped_error_output_compatible to the flow receipt canonical identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_flow_receipt.py::test_cli_preserves_adapter_error_provenance_through_live_fact_wrapper":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_cli_preserves_adapter_error_provenance_through_live_fact_wrapper to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_accepts_post_merge_receipt_without_premerge_binding":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_accepts_post_merge_receipt_without_premerge_binding to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_does_not_require_review_epoch_or_assessment":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_does_not_require_review_epoch_or_assessment to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_ignores_historical_non_convergent_review_state":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_ignores_historical_non_convergent_review_state to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_rejects_changed_live_merge_facts_without_sealing":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_rejects_changed_live_merge_facts_without_sealing to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_rejects_invalid_finality_and_timestamp_without_sealing":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_rejects_invalid_finality_and_timestamp_without_sealing to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_rejects_post_merge_receipt_for_a_different_pr":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_rejects_post_merge_receipt_for_a_different_pr to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_rejects_post_merge_receipt_when_live_merge_sha_differs":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_rejects_post_merge_receipt_when_live_merge_sha_differs to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_rejects_repository_binding_mismatch_without_sealing":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_rejects_repository_binding_mismatch_without_sealing to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_rejects_unavailable_live_merged_facts_without_sealing":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_rejects_unavailable_live_merged_facts_without_sealing to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_requires_acceptance_manifest_before_flow_complete":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_requires_acceptance_manifest_before_flow_complete to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_tier_two_pr_requires_post_merge_receipt":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_tier_two_pr_requires_post_merge_receipt to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_close_time_revalidation_rejects_an_unfinalized_tier_three_proof":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_close_time_revalidation_rejects_an_unfinalized_tier_three_proof to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_completed_local_merge_epoch_locks_the_review_tier":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "acceptance evidence binds candidate and deployment identities",
      batch_id: "acceptance-identity-binding",
      invariant:
        "The named Bun batch test asserts the acceptance identity binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_completed_local_merge_epoch_locks_the_review_tier to the acceptance identity binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_completed_sol_fallback_records_the_attempt_chain":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name: "terminal sealing archives immutable state and is idempotent",
      batch_id: "flow-terminal-sealing",
      invariant:
        "The named Bun batch test asserts the flow terminal sealing contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_completed_sol_fallback_records_the_attempt_chain to the flow terminal sealing batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_receipt.py::test_current_candidate_receipt_tests_are_not_excluded_from_validation":
    {
      test_file: "bin/tests/flow/flow.test.ts",
      test_name:
        "current-head attestation only reuses a receipt for an equivalent delta",
      batch_id: "current-head-receipt-freshness",
      invariant:
        "The named Bun batch test asserts the current-head receipt freshness contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_receipt.py::test_current_candidate_receipt_tests_are_not_excluded_from_validation to the current-head receipt freshness batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
