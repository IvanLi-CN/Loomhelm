import type { ScenarioWitness } from "../domain-witness-types";

export const SCENARIO_WITNESSES_022: Record<string, ScenarioWitness> = {
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_existing_wave_adds_profile_to_existing_task_line":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration preserves explicit profiles and strips invalid legacy metadata",
      batch_id: "task-migration-wave-normalization",
      invariant:
        "The named Bun batch test asserts the task migration wave normalization contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_existing_wave_adds_profile_to_existing_task_line to the task migration wave normalization batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_existing_wave_preserves_explicit_profile_and_normalizes_assign":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration preserves explicit profiles and strips invalid legacy metadata",
      batch_id: "task-migration-wave-normalization",
      invariant:
        "The named Bun batch test asserts the task migration wave normalization contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_existing_wave_preserves_explicit_profile_and_normalizes_assign to the task migration wave normalization batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_explicit_supported_profile_is_preserved":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_explicit_supported_profile_is_preserved to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_gpt6_supported_profile_is_preserved":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_gpt6_supported_profile_is_preserved to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_high_requirement_review_does_not_select_a_model":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_high_requirement_review_does_not_select_a_model to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_hyphenated_high_requirement_review_does_not_select_a_model":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration preserves explicit profiles and strips invalid legacy metadata",
      batch_id: "task-migration-wave-normalization",
      invariant:
        "The named Bun batch test asserts the task migration wave normalization contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_hyphenated_high_requirement_review_does_not_select_a_model to the task migration wave normalization batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_inline_task_parameters_are_not_stripped_as_profile_metadata":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_inline_task_parameters_are_not_stripped_as_profile_metadata to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_invalid_explicit_effort_falls_back_to_generic_default":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_invalid_explicit_effort_falls_back_to_generic_default to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_invalid_explicit_model_falls_back_to_generic_default":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration preserves explicit profiles and strips invalid legacy metadata",
      batch_id: "task-migration-wave-normalization",
      invariant:
        "The named Bun batch test asserts the task migration wave normalization contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_invalid_explicit_model_falls_back_to_generic_default to the task migration wave normalization batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_invalid_legacy_profile_falls_back_to_generic_default":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_invalid_legacy_profile_falls_back_to_generic_default to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_legacy_assign_adds_profile_to_delegated_sub_agent":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_legacy_assign_adds_profile_to_delegated_sub_agent to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_legacy_free_text_profile_is_converted_to_compact_profile":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_legacy_free_text_profile_is_converted_to_compact_profile to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_mixed_existing_wave_is_left_unchanged":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration preserves explicit profiles and strips invalid legacy metadata",
      batch_id: "task-migration-wave-normalization",
      invariant:
        "The named Bun batch test asserts the task migration wave normalization contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_mixed_existing_wave_is_left_unchanged to the task migration wave normalization batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_unsupported_lines_are_not_silently_rewritten":
    {
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
      batch_id: "task-migration-legacy-assignment",
      invariant:
        "The named Bun batch test asserts the task migration legacy assignment contract.",
      coverage_note:
        "Explicit static assignment for skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_unsupported_lines_are_not_silently_rewritten to the task migration legacy assignment batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_gen_legacy_spec_id.py::test_default_invocation_is_retired":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "keeps generation migration-only and avoids existing IDs",
      batch_id: "legacy-spec-id-generation",
      invariant:
        "The named Bun batch test asserts the legacy Spec ID generation contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_gen_legacy_spec_id.py::test_default_invocation_is_retired to the legacy Spec ID generation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_gen_legacy_spec_id.py::test_explicit_legacy_compatibility_can_generate_an_id":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "keeps generation migration-only and avoids existing IDs",
      batch_id: "legacy-spec-id-generation",
      invariant:
        "The named Bun batch test asserts the legacy Spec ID generation contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_gen_legacy_spec_id.py::test_explicit_legacy_compatibility_can_generate_an_id to the legacy Spec ID generation batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_confirmed_hygiene_rename_reports_git_mv_and_link_updates":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "requires a slug and confirmation before hygiene rename",
      batch_id: "migration-rename-guard",
      invariant:
        "The named Bun batch test asserts the migration rename guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_confirmed_hygiene_rename_reports_git_mv_and_link_updates to the migration rename guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_duplicate_legacy_topic_mappings_block_hygiene_rename":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "requires a slug and confirmation before hygiene rename",
      batch_id: "migration-rename-guard",
      invariant:
        "The named Bun batch test asserts the migration rename guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_duplicate_legacy_topic_mappings_block_hygiene_rename to the migration rename guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_proves_legacy_id_with_catalog_markdown_link_path":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_proves_legacy_id_with_catalog_markdown_link_path to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_proves_legacy_id_with_catalog_relative_code_path":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_proves_legacy_id_with_catalog_relative_code_path to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_reads_legacy_catalog_from_git_baseline":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_reads_legacy_catalog_from_git_baseline to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_requires_explicit_kebab_topic_for_legacy_directory":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_hygiene_requires_explicit_kebab_topic_for_legacy_directory to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_legacy_id_directory_requires_rename_confirmation":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "requires a slug and confirmation before hygiene rename",
      batch_id: "migration-rename-guard",
      invariant:
        "The named Bun batch test asserts the migration rename guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_legacy_id_directory_requires_rename_confirmation to the migration rename guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_legacy_plan_maps_to_slug_only_spec_and_records_pending_delete":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_legacy_plan_maps_to_slug_only_spec_and_records_pending_delete to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_plan_without_a_kebab_slug_requires_explicit_topic":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "requires a slug and confirmation before hygiene rename",
      batch_id: "migration-rename-guard",
      invariant:
        "The named Bun batch test asserts the migration rename guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_plan_without_a_kebab_slug_requires_explicit_topic to the migration rename guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_plan_without_legacy_id_proof_retains_its_full_slug":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_plan_without_legacy_id_proof_retains_its_full_slug to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_protected_branch_is_read_only":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "requires a slug and confirmation before hygiene rename",
      batch_id: "migration-rename-guard",
      invariant:
        "The named Bun batch test asserts the migration rename guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_protected_branch_is_read_only to the migration rename guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_relative_inbound_markdown_link_is_reported":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_relative_inbound_markdown_link_is_reported to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_slug_conflict_blocks_new_migration":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "maps a proven legacy plan and reports inbound links",
      batch_id: "legacy-plan-migration-guard",
      invariant:
        "The named Bun batch test asserts the legacy plan migration guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_slug_conflict_blocks_new_migration to the legacy plan migration guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
  "skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_slug_only_directory_with_id_like_prefix_requires_legacy_proof":
    {
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "requires a slug and confirmation before hygiene rename",
      batch_id: "migration-rename-guard",
      invariant:
        "The named Bun batch test asserts the migration rename guard contract.",
      coverage_note:
        "Explicit static assignment for skills/docs-migrate/scripts/test_specs_migrate_guard.py::test_slug_only_directory_with_id_like_prefix_requires_legacy_proof to the migration rename guard batch. This is an auditable domain-batch explanation, not a one-test-per-method equivalence claim.",
    },
};
