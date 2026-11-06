export type DirectEvidence = {
  kind: "bun-test";
  test_file: string;
  test_name: string;
};

export const EQUIVALENT: Record<string, DirectEvidence> = {
  "bin/test_plan_acceptance_manifest.py::test_high_risk_acceptance_requires_direct_evidence":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires direct evidence for high-risk acceptance",
    },
  "skills/project-engineering-workflow/scripts/test_merge_preflight.py::test_clean_exact_head_is_eligible_and_locks_live_head":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "accepts a clean exact head and locks the live head",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_blocks_linked_worktree_owner":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name: "base alignment blocks a linked worktree owner",
    },
  "bin/test_dot_codex_context.py::test_linked_candidate_is_accepted_only_with_its_runtime_repository":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows a linked candidate only with the matching runtime repository",
    },
  "bin/test_snapshot_local_image.py::test_repeated_snapshots_are_unique_and_ascii_safe":
    {
      kind: "bun-test",
      test_file: "bin/tests/visual/visual.test.ts",
      test_name: "snapshots are unique, immutable, and ASCII-safe",
    },
  "bin/test_code_hosting.py::test_asset_urls_are_immutable_and_provider_specific":
    {
      kind: "bun-test",
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "asset URLs are provider-specific and pinned to a revision",
    },
  "bin/test_spec_contract_check.py::test_task_state_and_missing_traceability_fail":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name:
        "rejects task-state sections, checkboxes, and missing traceability",
    },
  "bin/test_create_reg_cli_report.py::test_rejects_report_outputs_as_snapshot_inputs":
    {
      kind: "bun-test",
      test_file: "bin/tests/visual/visual.test.ts",
      test_name:
        "report creation and audit keep inputs symlinked and outputs independent",
    },
  "bin/test_plan_review_view.py::test_candidate_execution_rejects_symlinked_entrypoint":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "rejects a candidate entrypoint with a symlinked parent",
    },
  "bin/test_plan_review_view.py::test_projection_escapes_autolink_urls": {
    kind: "bun-test",
    test_file: "bin/tests/plan/review.test.ts",
    test_name: "escapes autolink URLs in copied plan text",
  },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_acceptance_scope_must_match_its_owner":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
    },
  "bin/test_plan_acceptance_manifest.py::test_gate_defaults_to_validation_and_accepts_delivery":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "normalizes strict entries and defaults the validation gate",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_related_adrs_accepts_bare_none":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/contract_migration.test.ts",
      test_name: "only accepts bare None for an empty Related ADR section",
    },
  "skills/find-next-plan/scripts/test_find_next_plan.py::test_lifecycle_specs_can_fall_back_to_legacy_plan_queue":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/plan_and_hardware.test.ts",
      test_name: "falls back from a lifecycle catalog to the legacy plan queue",
    },
  "skills/git-cleanup/scripts/test_local_merge_closeout_gate.py::test_allows_complete_when_only_unrelated_dirty_state_remains":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "allows unrelated dirty state for local merge and blocks a non-base branch",
    },
  "bin/test_code_hosting.py::test_supported_remote_forms_normalize_to_the_same_identity":
    {
      kind: "bun-test",
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "supported remote forms resolve to one canonical identity",
    },
  "bin/test_code_hosting.py::test_provider_evidence_redacts_credential_like_fields":
    {
      kind: "bun-test",
      test_file: "bin/tests/hosting/hosting.test.ts",
      test_name: "provider evidence redacts secret fields and URL credentials",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_new_legacy_plan_root_requires_canonical_spec_set":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
    },
  "bin/test_dot_codex_context.py::test_validation_stops_and_reports_a_fixed_check_failure":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "stops fixed validation at the first failing entrypoint",
    },
  "skills/git-cleanup/scripts/test_closeout_gate.py::test_allows_complete_when_all_required_states_are_closed":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name:
        "accepts complete PR cleanup only when every required state is closed",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_direct_mode_implementation_pr_is_final_pr":
    {
      kind: "bun-test",
      test_file: "bin/tests/waves/waves.test.ts",
      test_name: "v2 direct merge milestones require a native final PR receipt",
    },
  "bin/test_plan_review_view.py::test_candidate_file_route_rejects_fifo_without_blocking":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/shell.test.ts",
      test_name: "rejects a FIFO candidate entrypoint without blocking",
    },
  "bin/test_plan_contract_check.py::test_acceptance_manifest_failure_preserves_existing_output":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/shell.test.ts",
      test_name:
        "development-only direct Bun preserves output on acceptance failure",
    },
  "bin/test_plan_acceptance_manifest.py::test_empirical_assertions_require_concrete_values":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "checks concrete empirical assertions",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_spec_free_mode_blocks_on_spec_only_changes":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "blocks spec-free runs that touch a Spec",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_allocate_reuses_existing_lease_for_same_scope_and_service":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "reuses a scope lease and keeps service offsets in its block",
    },
  "skills/global-port-manager/scripts/test_port_registry.py::test_allocate_keeps_service_offsets_inside_existing_scope_block":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/workspace.test.ts",
      test_name: "reuses a scope lease and keeps service offsets in its block",
    },
  "skills/project-engineering-workflow/scripts/test_base_alignment_helper.py::test_plan_alignment_requires_owner_decision_on_dirty_primary_base":
    {
      kind: "bun-test",
      test_file: "bin/tests/workspace/base_alignment.test.ts",
      test_name:
        "base alignment requires owner decisions for dirty or divergent bases",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_impl_run_validates_every_changed_canonical_spec":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name:
        "validates every changed Spec when one implementation sync is requested",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_pr_ready_rejects_a_stale_batch_base_sha":
    {
      kind: "bun-test",
      test_file: "bin/tests/waves/waves.test.ts",
      test_name:
        "v1 parent SHA reconciliation blocks stale ready work and recovers on verification",
    },
  "skills/dev-plan/scripts/test_migrate_task_orchestration.py::test_partial_legacy_profile_markers_are_removed_before_fallback":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/task_migration.test.ts",
      test_name:
        "task migration converts legacy assignments with flow skill and fallback profile",
    },
  "skills/wave-thread-flow/scripts/test_wave_thread_v2.py::test_owned_surface_path_alias_overlap_is_rejected":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name:
        "matches Python owned-surface normalization before overlap checks",
    },
  "bin/test_plan_contract_check.py::test_direct_raw_plan_requires_explicit_acceptance_phase":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
    },
  "bin/test_plan_acceptance_manifest.py::test_direct_v1_requires_explicit_plan_scope_and_phase":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/acceptance.test.ts",
      test_name: "requires explicit direct and multi-task-flow phase bindings",
    },
  "bin/test_agent_profile_runtime.py::test_attester_derives_direct_requested_and_resolved_profile":
    {
      kind: "bun-test",
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
    },
  "bin/test_agent_profile_runtime.py::test_attester_derives_a_direct_agent_tool_profile":
    {
      kind: "bun-test",
      test_file: "bin/tests/flow/profile.test.ts",
      test_name: "native attestation derives a direct profile resolution",
    },
  "bin/test_wave_thread_plan_contract.py::test_v2_raw_plan_rejects_retired_duplicate_contract":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "rejects the retired duplicate contract heading",
    },
  "bin/test_wave_thread_plan_contract.py::test_v2_acceptance_scope_must_match_declared_owner":
    {
      kind: "bun-test",
      test_file: "bin/tests/plan/orchestration.test.ts",
      test_name: "keeps acceptance owner scope aligned with orchestration",
    },
  "skills/spec-sync/scripts/test_spec_drift_check.py::test_drifted_legacy_companion_resolves_to_canonical_path":
    {
      kind: "bun-test",
      test_file: "bin/tests/docs/spec_drift.test.ts",
      test_name: "maps a new proven legacy plan to its canonical companion set",
    },
};
