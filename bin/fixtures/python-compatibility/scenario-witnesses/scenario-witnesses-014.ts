import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_014: Record<string, ScenarioWitness> = {
  "bin/test_plan_contract_check.py::test_provenance_check_allows_task_metadata":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name:
        "rejects malformed active multi-task topology, metadata, and nesting",
      batch_id: "plan-topology-contract",
      invariant:
        "The named Bun batch test asserts the plan topology contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_provenance_check_allows_task_metadata to the plan topology contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_raw_direct_plan_rejects_unclosed_fenced_block":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_raw_direct_plan_rejects_unclosed_fenced_block to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_release_decision_card_does_not_treat_route_absence_as_no_release":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "preserves standalone CLI cwd paths and argparse exit codes",
      batch_id: "plan-cli-argument-and-exit-parity",
      invariant:
        "The named Bun batch test asserts the plan CLI argument and exit parity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_release_decision_card_does_not_treat_route_absence_as_no_release to the plan CLI argument and exit parity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_space_flow_alias_lock_must_match_following_plan":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_space_flow_alias_lock_must_match_following_plan to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_step5c_plan_requires_displayable_runtime_decision_card":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name:
        "rejects malformed active multi-task topology, metadata, and nesting",
      batch_id: "plan-topology-contract",
      invariant:
        "The named Bun batch test asserts the plan topology contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_step5c_plan_requires_displayable_runtime_decision_card to the plan topology contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_v5_markdown_contract_freezes_final_base_and_canonical_spec":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "preserves standalone CLI cwd paths and argparse exit codes",
      batch_id: "plan-cli-argument-and-exit-parity",
      invariant:
        "The named Bun batch test asserts the plan CLI argument and exit parity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_v5_markdown_contract_freezes_final_base_and_canonical_spec to the plan CLI argument and exit parity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_v5_rejects_invalid_acceptance_mapping_and_evidence":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_v5_rejects_invalid_acceptance_mapping_and_evidence to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_v5_rejects_legacy_versions_and_ci_provisioning_fields":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "preserves standalone CLI cwd paths and argparse exit codes",
      batch_id: "plan-cli-argument-and-exit-parity",
      invariant:
        "The named Bun batch test asserts the plan CLI argument and exit parity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_v5_rejects_legacy_versions_and_ci_provisioning_fields to the plan CLI argument and exit parity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_v5_requires_branch_push_child_ci_and_exact_check":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "preserves standalone CLI cwd paths and argparse exit codes",
      batch_id: "plan-cli-argument-and-exit-parity",
      invariant:
        "The named Bun batch test asserts the plan CLI argument and exit parity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_v5_requires_branch_push_child_ci_and_exact_check to the plan CLI argument and exit parity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_v5_requires_schema_promotion_policy_and_completion_gate_for_every_ticket":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "preserves standalone CLI cwd paths and argparse exit codes",
      batch_id: "plan-cli-argument-and-exit-parity",
      invariant:
        "The named Bun batch test asserts the plan CLI argument and exit parity contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_v5_requires_schema_promotion_policy_and_completion_gate_for_every_ticket to the plan CLI argument and exit parity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_fifo_without_blocking":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_fifo_without_blocking to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_hardlinked_candidate_entrypoint":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_hardlinked_candidate_entrypoint to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_outside_candidate_input":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_outside_candidate_input to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_symlinked_candidate_entrypoint":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_manifest_route_rejects_symlinked_candidate_entrypoint to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_accepts_runtime_supported_terra_profile":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_accepts_runtime_supported_terra_profile to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_product_plan_md_wording_is_not_a_persisted_plan_artifact":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_product_plan_md_wording_is_not_a_persisted_plan_artifact to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_profile_is_validated": {
    test_file: "bin/tests/plan/acceptance.test.ts",
    test_name: "requires explicit direct and multi-task-flow phase bindings",
    batch_id: "plan-acceptance-phase-contract",
    invariant:
      "The named Bun batch test asserts the plan acceptance phase contract contract.",
    coverage_note:
      "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_profile_is_validated to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_profiled_task_keeps_all_display_guards":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_profiled_task_keeps_all_display_guards to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_ignores_heading_inside_fenced_code":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_ignores_heading_inside_fenced_code to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_ignores_heading_text_inside_prose":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_ignores_heading_text_inside_prose to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_duplicate_contract_section":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_duplicate_contract_section to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_duplicate_task_orchestration_section":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_duplicate_task_orchestration_section to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_empty_or_eof_duplicate_contract_section":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_empty_or_eof_duplicate_contract_section to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_proposed_plan_wrapper":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_proposed_plan_wrapper to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_unclosed_fenced_duplicate_heading":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_raw_rejects_unclosed_fenced_duplicate_heading to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_rejects_malformed_task_profiles":
    {
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name:
        "rejects malformed active multi-task topology, metadata, and nesting",
      batch_id: "plan-topology-contract",
      invariant:
        "The named Bun batch test asserts the plan topology contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_rejects_malformed_task_profiles to the plan topology contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_reuses_constraint_reference_guard":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_reuses_constraint_reference_guard to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_reuses_persisted_plan_artifact_guard":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_reuses_persisted_plan_artifact_guard to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_shell_route_accepts_topology_labels":
    {
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
      batch_id: "plan-acceptance-phase-contract",
      invariant:
        "The named Bun batch test asserts the plan acceptance phase contract contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_shell_route_accepts_topology_labels to the plan acceptance phase contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_plan_contract_check.py::test_wave_thread_v2_shell_route_matches_python_heading_tolerance":
    {
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "keeps raw-plan diagnostics through Bun without invoking Python",
      batch_id: "plan-shell-diagnostics",
      invariant:
        "The named Bun batch test asserts the plan shell diagnostics contract.",
      coverage_note:
        "Explicit static assignment for bin/test_plan_contract_check.py::test_wave_thread_v2_shell_route_matches_python_heading_tolerance to the plan shell diagnostics batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
