import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_031: Record<string, ScenarioWitness> = {
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_late_batch_condition_result_cannot_reopen_an_expired_batch":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_late_batch_condition_result_cannot_reopen_an_expired_batch to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_late_passed_delivery_milestone_is_rejected_after_timeout":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_late_passed_delivery_milestone_is_rejected_after_timeout to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_deferred_event_is_rejected_without_consuming_queue":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_deferred_event_is_rejected_without_consuming_queue to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_dependency_objects_are_rejected":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_dependency_objects_are_rejected to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_task_milestones_are_rejected":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_task_milestones_are_rejected to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_v2_collection_entries_are_rejected_as_value_errors":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_malformed_v2_collection_entries_are_rejected_as_value_errors to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_mixed_batch_and_task_dependency_cycle_is_rejected":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_mixed_batch_and_task_dependency_cycle_is_rejected to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_multi_wave_batch_can_advance_before_future_wave_tasks_exist":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_multi_wave_batch_can_advance_before_future_wave_tasks_exist to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_observation_deadline_records_timeout_without_resetting_deadline":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_observation_deadline_records_timeout_without_resetting_deadline to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_observed_failure_blocks_step5c_with_timeout_fact":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_observed_failure_blocks_step5c_with_timeout_fact to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_out_of_order_event_is_deferred_until_dependency_is_ready":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_out_of_order_event_is_deferred_until_dependency_is_ready to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_overlapping_currently_runnable_tasks_across_different_wave_numbers_are_rejected":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_overlapping_currently_runnable_tasks_across_different_wave_numbers_are_rejected to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_owned_surfaces_must_remain_inside_the_repository":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_owned_surfaces_must_remain_inside_the_repository to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_completion_requires_batch_post_merge_acceptance":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_completion_requires_batch_post_merge_acceptance to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_finalize_requires_conversation_archive_receipt":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_finalize_requires_conversation_archive_receipt to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_merged_milestone_requires_all_tasks":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_merged_milestone_requires_all_tasks to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_task_condition_skip_can_reach_step5c_without_merge":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_child_task_condition_skip_can_reach_step5c_without_merge to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_drift_defers_non_condition_events":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_drift_defers_non_condition_events to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_side_merge_requires_task_pre_merge_acceptance":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_parent_side_merge_requires_task_pre_merge_acceptance to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_passed_milestone_requires_bound_sha_evidence":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_passed_milestone_requires_bound_sha_evidence to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pending_condition_defers_task_event":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pending_condition_defers_task_event to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_persisted_false_condition_requires_exact_plan_approval":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_persisted_false_condition_requires_exact_plan_approval to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_persisted_passed_milestone_requires_its_acceptance_phase":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_persisted_passed_milestone_requires_its_acceptance_phase to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_persisted_ready_task_requires_task_pre_merge_acceptance":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_persisted_ready_task_requires_task_pre_merge_acceptance to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_recovery_requires_valid_sha_evidence":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_recovery_requires_valid_sha_evidence to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_rejects_a_scope_with_only_optional_acceptance":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_rejects_a_scope_with_only_optional_acceptance to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_requires_task_pre_merge_acceptance":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_requires_task_pre_merge_acceptance to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_stale_base_cannot_reach_step5c":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_stale_base_cannot_reach_step5c to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_release_result_cannot_pass_after_observation_timeout":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_release_result_cannot_pass_after_observation_timeout to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_required_acceptance_skip_does_not_pass_a_gate":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_required_acceptance_skip_does_not_pass_a_gate to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
