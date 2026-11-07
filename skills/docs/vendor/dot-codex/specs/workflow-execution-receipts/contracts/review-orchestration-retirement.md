# Review Orchestration Retirement Inventory

`bin/flow_receipt.py` is retained for validation and lifecycle facts. This inventory identifies the separate review-orchestration subsystem that direct delivery no longer uses and that a later cleanup must remove as named groups.

## Retain

- Validation/lifecycle CLI and implementation: `init`, `acceptance-register`, `record --kind validation`, `record --kind attestation`, `record --kind post-merge`, `classify`, `status`, `close`, validation execution, scoped attestation, atomic storage, and post-merge fact recording.
- `bind-pr` may remain as validation-audit association only. Its current review-assessment, review-state, and convergence checks must be removed before treating that command as retained-only.

## Retire With Direct Review

### CLI and dispatch

- `review-assess` and `FlowLedger.assess_review_necessity`.
- `review-wave open`, `review-wave finalize`, and `review-wave authorize-repair`, plus `FlowLedger.open_review_wave`, `FlowLedger.finalize_review_wave`, and `FlowLedger.authorize_repair`.
- `convergence-reopen` and `FlowLedger.reopen_convergence`.
- `record --kind review`, `record --kind convergence`, `FlowLedger.record_subagent_review`, `FlowLedger.record_subagent_review_unavailable`, `FlowLedger.record_agent_review`, and `FlowLedger.record_convergence`.

### Review-only policy and persistence

- `REVIEW_MODEL_LADDER`, `DIRECT_REVIEW_LANE_PROFILES`, `review_model_fallbacks`, `direct_review_profile_resolution`, and `direct_wave_lane_profile_is_authorized`.
- `default_review_state`, `pending_review_assessment`, `migrated_review_assessment`, `review_mode_for_tier`, `parse_lane_spec`, `review_model_matches_lane`, `review_convergence_started`, `is_current_clear_required_review_wave`, `_review_state`, `_review_wave`, `_validate_lane_specs`, `_requires_current_review_proof`, `_review_tier`, `_require_review_assessment`, `_rederive_current_review_receipt`, and `_revalidate_current_review_set`.
- `structured_review_prompt`, structured review-result/task-receipt parsing, review artifacts, finding fingerprints, wave synthesis, and current-review revalidation.
- Active ledger `review`, `review_assessment`, `review_mode`, convergence fields that exist only for review, and their normalizers. `legacy_review` and legacy migration readers remain until an explicit archive-read migration or support-end decision.

### Source anchors

- `REVIEW_MODEL_LADDER`, `DIRECT_REVIEW_LANE_PROFILES`, `def review_model_fallbacks`, `def is_direct_review_model`, `def is_allowed_direct_review_profile`, `def direct_review_profile_resolution`, and `def direct_wave_lane_profile_is_authorized`.
- `def default_review_state`, `def pending_review_assessment`, `def migrated_review_assessment`, `def review_mode_for_tier`, `def parse_lane_spec`, `def review_model_matches_lane`, `def review_convergence_started`, `def is_current_clear_required_review_wave`, `def _review_state`, `def _review_wave`, `def _validate_lane_specs`, `def _requires_current_review_proof`, `def _review_tier`, `def _require_review_assessment`, `def _rederive_current_review_receipt`, and `def _revalidate_current_review_set`.
- `review-assess`, `review-wave`, `convergence-reopen`, `def assess_review_necessity`, `def open_review_wave`, `def finalize_review_wave`, `def authorize_repair`, `def reopen_convergence`, and `def record_convergence`.
- `def structured_review_prompt`, `def parse_review_result`, `def parse_agent_review_result`, `def parse_helper_task_receipt`, `def write_once_review_artifact`, `def review_artifact_path`, `def audit_review_artifacts`, `def remove_regular_review_artifact`, `def review_finding_fingerprint`, `def normalize_review_synthesis`, `def review_synthesis_input`, `def review_is_clear`, `def record_subagent_review`, `def record_subagent_review_unavailable`, and `def record_agent_review`.

### Companion cleanup

- When this subsystem is removed, delete or archive its review-only cases in `bin/test_flow_receipt.py`, `docs/specs/workflow-execution-receipts/replay/review-wave-cases.json`, `bin/review_proof_replay_check.py`, and any replay checker that accepts these commands.
- In that removal, delete active-spec references to receipt-led review, waves, permits, or `ReviewReceipt`. Keep historical records readable rather than rewriting archived ledger bytes.

## Removal Order

1. Make the retained validation/lifecycle commands independent of review state.
2. Remove each listed parser/dispatch surface and its complete implementation group.
3. Remove its tests, replay assets, and active-contract references.
4. Decide and execute archive-read migration separately, then remove legacy schema readers.

Use this inventory when an intentional removal changes one of these groups.
