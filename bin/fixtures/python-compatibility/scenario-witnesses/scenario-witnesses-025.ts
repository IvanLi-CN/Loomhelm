import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_025: Record<string, ScenarioWitness> = {
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_required_read_failure_is_indeterminate":
    {
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "closed PRs and unavailable required reads fail closed",
      batch_id: "merge-preflight-fail-closed",
      invariant:
        "The named Bun batch test asserts the merge preflight fail closed contract.",
      coverage_note:
        "Explicit static assignment for skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_required_read_failure_is_indeterminate to the merge preflight fail closed batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_ambiguous_legacy_plan_to_spec_mapping_requires_explicit_path":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_ambiguous_legacy_plan_to_spec_mapping_requires_explicit_path to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_ambiguous_legacy_spec_mapping_requires_explicit_path":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_ambiguous_legacy_spec_mapping_requires_explicit_path to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_asset_only_change_does_not_count_as_associated_spec_sync":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_asset_only_change_does_not_count_as_associated_spec_sync to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_base_backfilled_companions_still_block_feature_branch_without_them":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_base_backfilled_companions_still_block_feature_branch_without_them to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_committed_contract_only_spec_root_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_committed_contract_only_spec_root_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_committed_new_canonical_spec_with_impl_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_committed_new_canonical_spec_with_impl_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_companion_doc_change_counts_as_associated_spec_sync":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_companion_doc_change_counts_as_associated_spec_sync to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_deleted_required_companion_file_blocks_sync":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_deleted_required_companion_file_blocks_sync to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_deleting_all_companion_docs_still_blocks_sync":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_deleting_all_companion_docs_still_blocks_sync to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_committed_new_canonical_spec_still_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_committed_new_canonical_spec_still_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_contract_only_spec_root_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_contract_only_spec_root_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_deleting_entire_companion_spec_dir_blocks":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_deleting_entire_companion_spec_dir_blocks to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_heavily_edited_legacy_spec_only_move_stays_compatible":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_heavily_edited_legacy_spec_only_move_stays_compatible to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_legacy_plan_contract_subpath_requires_plan_or_canonical_set":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_legacy_plan_contract_subpath_requires_plan_or_canonical_set to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_legacy_spec_only_dir_remains_compatible":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_legacy_spec_only_dir_remains_compatible to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_new_canonical_spec_still_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_new_canonical_spec_still_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_new_legacy_plan_root_requires_canonical_spec_set":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_new_legacy_plan_root_requires_canonical_spec_set to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_renamed_companion_model_spec_dir_stays_compatible":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_docs_only_renamed_companion_model_spec_dir_stays_compatible to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_drifted_existing_legacy_spec_copy_resolves_to_canonical_path":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_drifted_existing_legacy_spec_copy_resolves_to_canonical_path to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_duplicate_same_id_new_spec_root_still_requires_companions":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_duplicate_same_id_new_spec_root_still_requires_companions to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_existing_legacy_spec_copy_resolves_to_slug_only_canonical_spec":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_existing_legacy_spec_copy_resolves_to_slug_only_canonical_spec to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_five_character_slug_prefix_is_not_mapped_without_legacy_proof":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
      batch_id: "spec-companion-mapping",
      invariant:
        "The named Bun batch test asserts the Spec companion mapping contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_five_character_slug_prefix_is_not_mapped_without_legacy_proof to the Spec companion mapping batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_accept_union_across_multiple_specs":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_accept_union_across_multiple_specs to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_blob_drift_without_a_new_spec_change":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_blob_drift_without_a_new_spec_change to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_empty_bindings":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
      batch_id: "spec-free-drift-block",
      invariant:
        "The named Bun batch test asserts the Spec-free drift block contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_empty_bindings to the Spec-free drift block batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_staged_only_blob_drift":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_staged_only_blob_drift to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_staged_only_spec_membership_drift":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_staged_only_spec_membership_drift to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_staged_only_spec_order_drift":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
      batch_id: "spec-implementation-sync",
      invariant:
        "The named Bun batch test asserts the Spec implementation sync contract.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_block_staged_only_spec_order_drift to the Spec implementation sync batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_reject_symlinked_candidate_spec":
    {
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "rejects symlinked candidate Specs in frozen ADR refs",
      batch_id: "frozen-adr-candidate-integrity",
      invariant:
        "The named Bun batch test asserts that frozen ADR validation rejects a symlinked candidate Spec.",
      coverage_note:
        "Explicit static assignment for skills/spec-sync/scripts/test_spec_drift_check.py::test_frozen_adr_refs_reject_symlinked_candidate_spec to the frozen candidate integrity batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
