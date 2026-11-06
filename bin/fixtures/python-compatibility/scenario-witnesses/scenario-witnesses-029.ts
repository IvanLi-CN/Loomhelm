import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_029: Record<string, ScenarioWitness> = {
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_parent_lineage_rejects_reused_historical_sha":
    {
      test_file: "bin/tests/waves/waves_closeout.test.ts",
      test_name:
        "closeout resource receipts remain independently bound and idempotent",
      batch_id: "wave-closeout-receipts",
      invariant:
        "The named Bun batch test asserts the wave closeout receipts contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_parent_lineage_rejects_reused_historical_sha to the wave closeout receipts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_pending_success_recovery_is_transactional":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v1 events are transactional and idempotent by event identity",
      batch_id: "wave-v1-event-identity",
      invariant:
        "The named Bun batch test asserts the wave v1 event identity contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_pending_success_recovery_is_transactional to the wave v1 event identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_pending_thread_binding_and_resource_identity_require_resolution":
    {
      test_file: "bin/tests/waves/waves_closeout.test.ts",
      test_name:
        "closeout resource receipts remain independently bound and idempotent",
      batch_id: "wave-closeout-receipts",
      invariant:
        "The named Bun batch test asserts the wave closeout receipts contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_pending_thread_binding_and_resource_identity_require_resolution to the wave closeout receipts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_reconcile_parent_sha_rejects_observed_drift":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v1 events are transactional and idempotent by event identity",
      batch_id: "wave-v1-event-identity",
      invariant:
        "The named Bun batch test asserts the wave v1 event identity contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_reconcile_parent_sha_rejects_observed_drift to the wave v1 event identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_rejects_forged_archive_status_and_weak_receipt":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 merge, archive, cleanup, and finalization remain compatible",
      batch_id: "wave-v1-closeout-lifecycle",
      invariant:
        "The named Bun batch test asserts the wave v1 closeout lifecycle contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_rejects_forged_archive_status_and_weak_receipt to the wave v1 closeout lifecycle batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_rejects_success_using_a_failed_cleanup_operation":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 merge, archive, cleanup, and finalization remain compatible",
      batch_id: "wave-v1-closeout-lifecycle",
      invariant:
        "The named Bun batch test asserts the wave v1 closeout lifecycle contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_rejects_success_using_a_failed_cleanup_operation to the wave v1 closeout lifecycle batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_rejects_unarchived_previous_wave":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 merge, archive, cleanup, and finalization remain compatible",
      batch_id: "wave-v1-closeout-lifecycle",
      invariant:
        "The named Bun batch test asserts the wave v1 closeout lifecycle contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_rejects_unarchived_previous_wave to the wave v1 closeout lifecycle batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_revalidates_archive_observation_execution_and_merge":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 merge, archive, cleanup, and finalization remain compatible",
      batch_id: "wave-v1-closeout-lifecycle",
      invariant:
        "The named Bun batch test asserts the wave v1 closeout lifecycle contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_recovery_revalidates_archive_observation_execution_and_merge to the wave v1 closeout lifecycle batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_release_prefers_preview_and_falls_back":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 merge, archive, cleanup, and finalization remain compatible",
      batch_id: "wave-v1-closeout-lifecycle",
      invariant:
        "The named Bun batch test asserts the wave v1 closeout lifecycle contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_release_prefers_preview_and_falls_back to the wave v1 closeout lifecycle batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_requested_operation_can_be_completed_on_recovery":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v1 events are transactional and idempotent by event identity",
      batch_id: "wave-v1-event-identity",
      invariant:
        "The named Bun batch test asserts the wave v1 event identity contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_requested_operation_can_be_completed_on_recovery to the wave v1 event identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_state_machine_and_identity_are_event_driven":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v1 events are transactional and idempotent by event identity",
      batch_id: "wave-v1-event-identity",
      invariant:
        "The named Bun batch test asserts the wave v1 event identity contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_state_machine_and_identity_are_event_driven to the wave v1 event identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_step5c_recovery_state_requires_terminal_facts":
    {
      test_file: "bin/tests/waves/waves_closeout.test.ts",
      test_name:
        "closeout resource receipts remain independently bound and idempotent",
      batch_id: "wave-closeout-receipts",
      invariant:
        "The named Bun batch test asserts the wave closeout receipts contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_step5c_recovery_state_requires_terminal_facts to the wave closeout receipts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_topology_and_merge_gate":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 merge, archive, cleanup, and finalization remain compatible",
      batch_id: "wave-v1-closeout-lifecycle",
      invariant:
        "The named Bun batch test asserts the wave v1 closeout lifecycle contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_flow.py::test_topology_and_merge_gate to the wave v1 closeout lifecycle batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_a_b_c_topology_has_two_parent_prs_and_one_direct_pr":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_a_b_c_topology_has_two_parent_prs_and_one_direct_pr to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_acceptance_is_bound_to_scope_and_phase":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_acceptance_is_bound_to_scope_and_phase to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_active_cross_batch_overlap_is_rejected":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "rejects simultaneously runnable cross-batch owned surface overlap",
      batch_id: "wave-v2-cross-batch-surface-ownership",
      invariant:
        "The named Bun batch test asserts that simultaneously runnable cross-batch tasks cannot overlap owned surfaces.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_active_cross_batch_overlap_is_rejected to the cross-batch owned-surface rejection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_advance_wave_rejects_a_wave_without_tasks":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_advance_wave_rejects_a_wave_without_tasks to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_advance_wave_rejects_skipping_a_declared_wave":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_advance_wave_rejects_skipping_a_declared_wave to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_completion_waits_for_observation":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_completion_waits_for_observation to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_condition_false_skips_the_batch_without_dispatch":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_condition_false_skips_the_batch_without_dispatch to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_dependency_rejects_integrated_milestone":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_dependency_rejects_integrated_milestone to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_event_rejects_task_identity_fields":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_event_rejects_task_identity_fields to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_release_and_observation_are_sha_bound_facts":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_batch_release_and_observation_are_sha_bound_facts to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_blocked_batch_cannot_advance_to_a_later_wave":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_blocked_batch_cannot_advance_to_a_later_wave to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_batch_status_requires_completed_facts":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_batch_status_requires_completed_facts to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_direct_task_requires_merged_milestone":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_direct_task_requires_merged_milestone to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_event_requires_parent_side_merge_fact":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_event_requires_parent_side_merge_fact to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_task_requires_current_batch_lineage":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
      batch_id: "wave-v2-acceptance-scope",
      invariant:
        "The named Bun batch test asserts the wave v2 acceptance scope contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_completed_task_requires_current_batch_lineage to the wave v2 acceptance scope batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_condition_facts_cannot_reverse_a_skip":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
      batch_id: "wave-v2-direct-merge-gate",
      invariant:
        "The named Bun batch test asserts the wave v2 direct merge gate contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_condition_facts_cannot_reverse_a_skip to the wave v2 direct merge gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_condition_false_skips_without_dispatch_and_unknown_waits":
    {
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v2 deferred events replay after the parent advances to their wave",
      batch_id: "wave-v2-deferred-replay",
      invariant:
        "The named Bun batch test asserts the wave v2 deferred replay contract.",
      coverage_note:
        "Explicit static assignment for skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_condition_false_skips_without_dispatch_and_unknown_waits to the wave v2 deferred replay batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
