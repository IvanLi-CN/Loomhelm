import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_026: Record<string, ScenarioWitness> = {
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_none_blocks_new_related_adr_membership":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_none_blocks_new_related_adr_membership to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_heavily_edited_legacy_spec_only_move_stays_compatible_without_rename_detection":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_heavily_edited_legacy_spec_only_move_stays_compatible_without_rename_detection to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_impl_change_without_spec_paths_stays_unchecked_by_default":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_impl_change_without_spec_paths_stays_unchecked_by_default to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_impl_run_validates_unchanged_spec_that_references_changed_adr":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_impl_run_validates_unchanged_spec_that_references_changed_adr to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_list_none_remains_compatible_for_companion_only_change":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_list_none_remains_compatible_for_companion_only_change to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_commit_history_sync_does_not_require_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_commit_history_sync_does_not_require_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_path_counts_as_associated_spec_sync_without_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_path_counts_as_associated_spec_sync_without_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_path_resolves_to_renamed_canonical_spec":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_path_resolves_to_renamed_canonical_spec to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_path_resolves_to_slug_only_canonical_spec":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_plan_path_resolves_to_slug_only_canonical_spec to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_spec_path_resolves_to_slug_only_canonical_spec":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_spec_path_resolves_to_slug_only_canonical_spec to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_spec_path_resolves_via_git_rename":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_spec_path_resolves_via_git_rename to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_spec_without_related_adrs_remains_compatible":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_spec_without_related_adrs_remains_compatible to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_to_wrong_slug_does_not_bypass_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_legacy_to_wrong_slug_does_not_bypass_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_long_lived_branch_new_spec_root_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_long_lived_branch_new_spec_root_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_missing_required_spec_file_blocks_sync":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_missing_required_spec_file_blocks_sync to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_new_canonical_spec_requires_companion_docs":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_new_canonical_spec_requires_companion_docs to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_accepts_path_sorted_current_refs_and_missing_status":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_accepts_path_sorted_current_refs_and_missing_status to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_deleted_staged_adr_candidate":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_deleted_staged_adr_candidate to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_duplicate_none_entries":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_duplicate_none_entries to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_duplicates":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_duplicates to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_invalid_staged_spec_candidate":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_invalid_staged_spec_candidate to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_missing_target":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_missing_target to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_superseded_target":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_superseded_target to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_unsorted_paths":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_unsorted_paths to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_when_only_the_referenced_adr_changes":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_blocks_when_only_the_referenced_adr_changes to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_rejects_list_none":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_rejects_list_none to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_rename_between_unrelated_legacy_ids_does_not_bypass_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_rename_between_unrelated_legacy_ids_does_not_bypass_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_renamed_companion_model_spec_must_move_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_renamed_companion_model_spec_must_move_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_renamed_legacy_spec_only_dir_stays_compatible":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_renamed_legacy_spec_only_dir_stays_compatible to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_slug_only_spec_without_related_adrs_blocks_when_touched":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_slug_only_spec_without_related_adrs_blocks_when_touched to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
