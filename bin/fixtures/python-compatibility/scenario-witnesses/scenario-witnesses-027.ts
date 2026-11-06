import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_027: Record<string, ScenarioWitness> = {
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_slug_rename_without_legacy_catalog_proof_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_slug_rename_without_legacy_catalog_proof_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_slug_with_legacy_like_prefix_requires_related_adrs_without_identity_proof":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_slug_with_legacy_like_prefix_requires_related_adrs_without_identity_proof to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_disposition_env_passes_without_spec_paths":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_disposition_env_passes_without_spec_paths to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_free_flag_passes_without_spec_paths":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_free_flag_passes_without_spec_paths to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_free_mode_blocks_when_spec_files_changed":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_free_mode_blocks_when_spec_files_changed to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_only_legacy_canonical_dir_is_still_valid_sync_target":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_only_legacy_canonical_dir_is_still_valid_sync_target to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_untouched_legacy_spec_allows_companion_only_change":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_untouched_legacy_spec_allows_companion_only_change to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_untouched_slug_only_spec_without_related_adrs_remains_compatible":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_untouched_slug_only_spec_without_related_adrs_remains_compatible to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_valid_slug_is_not_stripped_without_legacy_proof":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_valid_slug_is_not_stripped_without_legacy_proof to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_current_only_has_no_baseline_or_heatmap_and_requires_confirmation":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "visual-comparison-report",
      invariant:
        "The named Bun batch test asserts the visual comparison report contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_current_only_has_no_baseline_or_heatmap_and_requires_confirmation to the visual comparison report batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_duplicate_destination_is_ambiguous":
    {
      test_file: "bin/native-tests/visual/native.test.ts",
      test_name: "HTML reports require an exact, duplicate-free comparison set",
      batch_id: "visual-comparison-set-contract",
      invariant:
        "The named Bun batch test asserts the visual comparison set contract contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_duplicate_destination_is_ambiguous to the visual comparison set contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_invalid_base_sha_is_unavailable_not_current_only":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "visual-comparison-report",
      invariant:
        "The named Bun batch test asserts the visual comparison report contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_invalid_base_sha_is_unavailable_not_current_only to the visual comparison report batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_no_follow_open_rejects_symlinked_external_ancestor":
    {
      test_file: "bin/native-tests/visual/native.test.ts",
      test_name: "HTML reports require an exact, duplicate-free comparison set",
      batch_id: "visual-comparison-set-contract",
      invariant:
        "The named Bun batch test asserts the visual comparison set contract contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_no_follow_open_rejects_symlinked_external_ancestor to the visual comparison set contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_rgba_alpha_difference_is_visible":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "visual-comparison-report",
      invariant:
        "The named Bun batch test asserts the visual comparison report contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_rgba_alpha_difference_is_visible to the visual comparison report batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_same_path_blob_is_compared_and_heatmap_contains_rgba_difference":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "visual-comparison-report",
      invariant:
        "The named Bun batch test asserts the visual comparison report contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_same_path_blob_is_compared_and_heatmap_contains_rgba_difference to the visual comparison report batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_standard_external_temp_candidate_is_readable":
    {
      test_file: "bin/native-tests/visual/native.test.ts",
      test_name: "HTML reports require an exact, duplicate-free comparison set",
      batch_id: "visual-comparison-set-contract",
      invariant:
        "The named Bun batch test asserts the visual comparison set contract contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_standard_external_temp_candidate_is_readable to the visual comparison set contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_symlinked_candidate_is_unavailable":
    {
      test_file: "bin/native-tests/visual/native.test.ts",
      test_name: "HTML reports require an exact, duplicate-free comparison set",
      batch_id: "visual-comparison-set-contract",
      invariant:
        "The named Bun batch test asserts the visual comparison set contract contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_symlinked_candidate_is_unavailable to the visual comparison set contract batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_unreadable_base_blob_is_unavailable":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "visual-comparison-report",
      invariant:
        "The named Bun batch test asserts the visual comparison report contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_unreadable_base_blob_is_unavailable to the visual comparison report batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_unreadable_candidate_is_unavailable":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "comparison reports transparent pixel changes and same-path current-only state",
      batch_id: "visual-comparison-report",
      invariant:
        "The named Bun batch test asserts the visual comparison report contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_compare_visual_evidence.py::test_unreadable_candidate_is_unavailable to the visual comparison report batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_body_html_is_final_gate":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_body_html_is_final_gate to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_body_html_rejects_http_transport_for_same_host_assets":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_body_html_rejects_http_transport_for_same_host_assets to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_cli_parser_exposes_mutually_exclusive_selection":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_cli_parser_exposes_mutually_exclusive_selection to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_managed_section_rewrite_accepts_atx_closing_markers":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_managed_section_rewrite_accepts_atx_closing_markers to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_managed_section_rewrite_ignores_fenced_heading_examples":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_managed_section_rewrite_ignores_fenced_heading_examples to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_deduplicates_paths_in_first_seen_order_and_ignores_spec":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_deduplicates_paths_in_first_seen_order_and_ignores_spec to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_evidence_and_no_evidence_are_mutually_exclusive":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_evidence_and_no_evidence_are_mutually_exclusive to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_no_evidence_writes_none_and_removes_old_managed_sections":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_no_evidence_writes_none_and_removes_old_managed_sections to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_rejects_local_image_absent_from_pr_head_tree":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_rejects_local_image_absent_from_pr_head_tree to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_rejects_missing_and_non_image_paths":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_rejects_missing_and_non_image_paths to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_requires_explicit_task_declaration":
    {
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "owner-facing gate accepts snapshots and rejects remote, relative, and missing links",
      batch_id: "pr-body-image-gate",
      invariant:
        "The named Bun batch test asserts the PR body image gate contract.",
      coverage_note:
        "Explicit static assignment for skills/ui-visual-evidence/scripts/test_pr_body_image_gate.py::test_phase_a_requires_explicit_task_declaration to the PR body image gate batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
