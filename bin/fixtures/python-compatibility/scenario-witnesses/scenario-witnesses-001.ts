import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_001: Record<string, ScenarioWitness> = {
  "bin/test_agent_profile_runtime.py::test_agent_fallback_creates_a_consumed_permit":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "fallback permits are keyed by the canonical logical identity",
      batch_id: "fallback-permit-identity",
      invariant:
        "The named Bun batch test asserts the fallback permit identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_agent_fallback_creates_a_consumed_permit to the fallback permit identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attest_cli_enforces_review_constraints":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation enforces review constraints",
      batch_id: "native-profile-attestation-constraints",
      invariant:
        "The named Bun batch test rejects candidate-head, result-digest, and fork-turn constraint violations.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attest_cli_enforces_review_constraints to the native profile attestation constraint batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_accepts_a_direct_explicit_pair_that_differs_from_preference":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_accepts_a_direct_explicit_pair_that_differs_from_preference to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_accepts_a_non_child_parent_source_descriptor":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_accepts_a_non_child_parent_source_descriptor to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_accepts_an_id_only_native_call_identity":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_accepts_an_id_only_native_call_identity to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_accepts_compaction_replayed_parent_metadata_with_mutable_details":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_accepts_compaction_replayed_parent_metadata_with_mutable_details to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_accepts_compaction_replayed_session_meta_with_same_identity":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "fallback permits are keyed by the canonical logical identity",
      batch_id: "fallback-permit-identity",
      invariant:
        "The named Bun batch test asserts the fallback permit identity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_accepts_compaction_replayed_session_meta_with_same_identity to the fallback permit identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_binds_child_runtime_to_the_expected_candidate_head":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation enforces review constraints",
      batch_id: "native-profile-attestation-constraints",
      invariant:
        "The named Bun batch test binds the child runtime to the expected candidate repository head.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_binds_child_runtime_to_the_expected_candidate_head to the native profile attestation constraint batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_discovers_session_metadata_after_a_valid_preamble":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_discovers_session_metadata_after_a_valid_preamble to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_fails_closed_for_an_invalid_duplicate_parent_rollout":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation rejects duplicate parent rollouts",
      batch_id: "native-profile-attestation-negative",
      invariant:
        "The named Bun batch test rejects ambiguous duplicate parent transcripts.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_fails_closed_for_an_invalid_duplicate_parent_rollout to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_ignores_a_different_session_with_a_matching_filename_fragment":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_ignores_a_different_session_with_a_matching_filename_fragment to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_ignores_nested_parent_metadata_replayed_into_child_transcript":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_ignores_nested_parent_metadata_replayed_into_child_transcript to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_ignores_non_native_child_activity_replayed_into_parent":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_ignores_non_native_child_activity_replayed_into_parent to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_ignores_replayed_parent_completion_and_rejects_stale_child_result":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name:
        "native attestation rejects replayed parent and stale child result",
      batch_id: "native-profile-attestation-result-binding",
      invariant:
        "The named Bun batch test rejects replayed parent records and stale or non-unique child completions.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_ignores_replayed_parent_completion_and_rejects_stale_child_result to the native profile attestation result-binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_ignores_replayed_parent_metadata_and_context":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_ignores_replayed_parent_metadata_and_context to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_a_non_string_expected_child_thread_id":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_a_non_string_expected_child_thread_id to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_a_structured_non_child_parent_source_descriptor":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_a_structured_non_child_parent_source_descriptor to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_a_transcript_changed_after_its_initial_read":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_a_transcript_changed_after_its_initial_read to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_activity_after_final_child_completion":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_activity_after_final_child_completion to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_ambiguous_parent_session_metadata":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_ambiguous_parent_session_metadata to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_an_extra_matching_child_rollout":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_an_extra_matching_child_rollout to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_an_omitted_started_profile":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_an_omitted_started_profile to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_an_unknown_runtime_record_type":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_an_unknown_runtime_record_type to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_an_unsupported_explicit_runtime_profile":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_an_unsupported_explicit_runtime_profile to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_conflicting_duplicate_child_metadata":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_conflicting_duplicate_child_metadata to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_conflicting_replayed_child_session_meta":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_conflicting_replayed_child_session_meta to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_drift_across_all_non_replayed_child_turns":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_drift_across_all_non_replayed_child_turns to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_incomplete_replayed_child_session_meta":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_incomplete_replayed_child_session_meta to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_malformed_native_spawn_arguments":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_malformed_native_spawn_arguments to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_agent_profile_runtime.py::test_attester_rejects_mismatch_and_runtime_profile_drift":
    {
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
      batch_id: "native-profile-attestation",
      invariant:
        "The named Bun batch test asserts the native profile attestation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_agent_profile_runtime.py::test_attester_rejects_mismatch_and_runtime_profile_drift to the native profile attestation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
