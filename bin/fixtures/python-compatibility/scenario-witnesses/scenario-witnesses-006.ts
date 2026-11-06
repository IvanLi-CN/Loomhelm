import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_006: Record<string, ScenarioWitness> = {
  "bin/test_code_hosting.py::test_unknown_host_is_rejected": {
    test_file: "bin/tests/hosting/hosting.test.ts",
    test_name: "supported remote forms resolve to one canonical identity",
    batch_id: "canonical-provider-identity",
    invariant:
      "The named Bun batch test asserts the canonical provider identity contract.",
    coverage_note:
      "Explicit static assignment for bin/test_code_hosting.py::test_unknown_host_is_rejected to the canonical provider identity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_create_reg_cli_report.py::test_audit_accepts_cwd_relative_report_path":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_accepts_cwd_relative_report_path to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_detects_deleted_snapshot": {
    test_file: "bin/tests/visual/visual.test.ts",
    test_name:
      "comparison reports transparent pixel changes and same-path current-only state",
    batch_id: "report-comparison-facts",
    invariant:
      "The named Bun batch test asserts the report comparison facts contract.",
    coverage_note:
      "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_detects_deleted_snapshot to the report comparison facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_create_reg_cli_report.py::test_audit_detects_modified_snapshot": {
    test_file: "bin/tests/visual/visual.test.ts",
    test_name:
      "sandbox logs reject pre-created symlinks without writing through them",
    batch_id: "sandbox-symlink-protection",
    invariant:
      "The named Bun batch test asserts the sandbox symlink protection contract.",
    coverage_note:
      "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_detects_modified_snapshot to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_dependency_path_that_traverses_symlink_before_parent":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_dependency_path_that_traverses_symlink_before_parent to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_duplicate_result_items":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_duplicate_result_items to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_extra_snapshot_artifact":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_extra_snapshot_artifact to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_hard_linked_report_artifacts":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_hard_linked_report_artifacts to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_hard_linked_snapshot_aliases":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_hard_linked_snapshot_aliases to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_incomplete_html_report":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_incomplete_html_report to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_manifest_filename_traversal":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_manifest_filename_traversal to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_noncanonical_report_scope":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_noncanonical_report_scope to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_report_outside_required_layout":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_report_outside_required_layout to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_snapshot_paths_outside_store":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_snapshot_paths_outside_store to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_manifest": {
    test_file: "bin/tests/visual/visual.test.ts",
    test_name:
      "sandbox logs reject pre-created symlinks without writing through them",
    batch_id: "sandbox-symlink-protection",
    invariant:
      "The named Bun batch test asserts the sandbox symlink protection contract.",
    coverage_note:
      "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_manifest to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
  },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_report_artifacts":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_report_artifacts to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_report_directory":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_report_directory to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_report_parent_component":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_symlinked_report_parent_component to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_unexpected_top_level_artifacts":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_unexpected_top_level_artifacts to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_audit_rejects_unlisted_diff_artifact":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_audit_rejects_unlisted_diff_artifact to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_clone_report_file_isolates_published_data_from_retained_descriptors":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_clone_report_file_isolates_published_data_from_retained_descriptors to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_fails_closed_without_supported_sandbox":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_fails_closed_without_supported_sandbox to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_preserves_replacement_staging_directory":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "report-comparison-facts",
      invariant:
        "The named Bun batch test asserts the report comparison facts contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_preserves_replacement_staging_directory to the report comparison facts batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rechecks_snapshot_hashes_before_publication":
    {
      test_file: "bin/tests/visual/report_create.test.ts",
      test_name:
        "report creation rechecks snapshot integrity and rolls back publication",
      batch_id: "report-snapshot-integrity",
      invariant:
        "The named Bun production-path test asserts snapshot rechecking and publication rollback.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rechecks_snapshot_hashes_before_publication to the production report snapshot-integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_and_cleans_renamed_runtime_directory":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_and_cleans_renamed_runtime_directory to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_extra_snapshot_input":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_extra_snapshot_input to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_filename_only_html_report":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_filename_only_html_report to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_hard_linked_reg_cli_outputs":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
      batch_id: "report-artifact-isolation",
      invariant:
        "The named Bun batch test asserts the report artifact isolation contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_hard_linked_reg_cli_outputs to the report artifact isolation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_html_without_app_script":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_html_without_app_script to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "bin/test_create_reg_cli_report.py::test_create_rejects_incomplete_html_report":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "sandbox logs reject pre-created symlinks without writing through them",
      batch_id: "sandbox-symlink-protection",
      invariant:
        "The named Bun batch test asserts the sandbox symlink protection contract.",
      coverage_note:
        "Explicit static assignment for bin/test_create_reg_cli_report.py::test_create_rejects_incomplete_html_report to the sandbox symlink protection batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
