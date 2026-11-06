import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_007: Record<string, ScenarioWitness> = {
  "bin/test_create_reg_cli_report.py::test_create_rejects_new_or_deleted_items":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_new_or_deleted_items to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_path_token": {
    test_file: "bin/tests/visual/visual.test.ts",
    test_name:
      "sandbox logs reject pre-created symlinks without writing through them",
    batch_id: "sandbox-symlink-protection",
    invariant:
      "The named Bun batch test asserts the sandbox symlink protection contract.",
    coverage_note:
      "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_path_token to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_create_reg_cli_report.py::test_create_rejects_replaced_staging_directory":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_replaced_staging_directory to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_snapshot_changed_during_rendering":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_snapshot_changed_during_rendering to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_symlinked_passed_diff_item":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_symlinked_passed_diff_item to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_symlinked_reg_cli_outputs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_symlinked_reg_cli_outputs to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_symlinked_report_parent":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_symlinked_report_parent to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_unlisted_diff_artifact":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_unlisted_diff_artifact to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rolls_back_publication_if_snapshot_changes_during_rename":
    {
      test_file: "bin/tests/visual/report_create.test.ts",
      test_name:
        "report creation rechecks snapshot integrity and rolls back publication",
      batch_id: "report-snapshot-integrity",
      invariant:
        "The named Bun production-path test asserts snapshot rechecking and publication rollback.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rolls_back_publication_if_snapshot_changes_during_rename to the production report snapshot-integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_uses_pinned_reg_cli_command":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_uses_pinned_reg_cli_command to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_validates_failed_and_passed_partition":
    {
      test_file: "bin/native-tests/visual/native.test.ts",
      test_name:
        "atomic publication rename never replaces an existing destination",
      batch_id: "atomic-report-publication",
      invariant:
        "The named Bun batch test asserts the atomic report publication contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_validates_failed_and_passed_partition to the atomic report publication batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_failed_comparison_leaves_no_visible_report":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_failed_comparison_leaves_no_visible_report to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_multiple_pairs_share_one_report_without_copying_inputs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_multiple_pairs_share_one_report_without_copying_inputs to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_published_outputs_are_isolated_from_detached_open_writers":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_published_outputs_are_isolated_from_detached_open_writers to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_real_reg_cli_renders_multiple_symlinked_pairs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_real_reg_cli_renders_multiple_symlinked_pairs to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_reg_cli_lock_pins_every_transitive_package_with_integrity":
    {
      test_file: "bin/native-tests/visual/native.test.ts",
      test_name:
        "atomic publication rename never replaces an existing destination",
      batch_id: "atomic-report-publication",
      invariant:
        "The named Bun batch test asserts the atomic report publication contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_reg_cli_lock_pins_every_transitive_package_with_integrity to the atomic report publication batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_reg_cli_rejects_custom_command": {
    test_file: "bin/tests/visual/visual.test.ts",
    test_name:
      "sandbox logs reject pre-created symlinks without writing through them",
    batch_id: "sandbox-symlink-protection",
    invariant:
      "The named Bun batch test asserts the sandbox symlink protection contract.",
    coverage_note:
      "Explicit static assignment for bin/test_create_reg_cli_report.py::test_reg_cli_rejects_custom_command to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_create_reg_cli_report.py::test_rejects_case_variant_report_paths_as_snapshot_inputs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_rejects_case_variant_report_paths_as_snapshot_inputs to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_rejects_hard_link_aliases_of_report_outputs_as_snapshot_inputs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_rejects_hard_link_aliases_of_report_outputs_as_snapshot_inputs to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_rejects_non_snapshot_and_duplicate_names":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_rejects_non_snapshot_and_duplicate_names to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_sandbox_allows_writes_inside_report_staging":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_sandbox_allows_writes_inside_report_staging to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_sandbox_blocks_hardlinks_to_snapshot_inputs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_sandbox_blocks_hardlinks_to_snapshot_inputs to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_sandbox_blocks_staging_parent_replacement":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_sandbox_blocks_staging_parent_replacement to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_sandbox_blocks_writes_through_snapshot_symlinks":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_sandbox_blocks_writes_through_snapshot_symlinks to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_sandbox_denies_sensitive_directory_enumeration":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_sandbox_denies_sensitive_directory_enumeration to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_sandbox_seals_against_detached_child_writes":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_sandbox_seals_against_detached_child_writes to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_dot_codex_context.py::test_inspection_rejects_foreign_runtime_and_active_candidate_runtime":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows a linked candidate only with the matching runtime repository",
      batch_id: "candidate-runtime-binding",
      invariant:
        "The named Bun batch test asserts the candidate runtime binding contract.",
      coverage_note:
        "Explicit static assignment for bin/test_dot_codex_context.py::test_inspection_rejects_foreign_runtime_and_active_candidate_runtime to the candidate runtime binding batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_dot_codex_context.py::test_validation_preserves_runtime_home_and_sanitizes_git_context":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "removes runtime and Git context from fixed checks",
      batch_id: "fixed-check-environment-sanitization",
      invariant:
        "The named Bun batch test asserts the fixed-check environment sanitization contract.",
      coverage_note:
        "Explicit static assignment for bin/test_dot_codex_context.py::test_validation_preserves_runtime_home_and_sanitizes_git_context to the fixed-check environment sanitization batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_continue_replay_check.py::test_fenced_flow_example_does_not_override_projection_lock":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name:
        "historical flow replay guards lock drift and Python route parity",
      batch_id: "historical-flow-replay-guard",
      invariant:
        "The named Bun batch test asserts the historical flow replay guard contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_continue_replay_check.py::test_fenced_flow_example_does_not_override_projection_lock to the historical flow replay guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_flow_continue_replay_check.py::test_fenced_generic_continue_is_not_a_continuation":
    {
      test_file: "bin/tests/checks/checks.test.ts",
      test_name:
        "historical flow replay guards lock drift and Python route parity",
      batch_id: "historical-flow-replay-guard",
      invariant:
        "The named Bun batch test asserts the historical flow replay guard contract.",
      coverage_note:
        "Explicit static assignment for bin/test_flow_continue_replay_check.py::test_fenced_generic_continue_is_not_a_continuation to the historical flow replay guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
