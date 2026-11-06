# Workflow Agent Model Selection Implementation

- The shared project-engineering direct-review contract now exposes the exact six-profile autonomous allowlist, independent lane-local selection, complete invocation-wide or named-lane owner overrides, and runtime-owned rejection without silent fallback.

- `bin/modules/flow/review-profile-policy.ts` owns direct-review complexity mapping and exact owner-pair forwarding without importing the runtime capability table.
- The direct-review selector requires lane-specific reasons for special or high-risk profiles and resolves invocation-wide versus named-lane overrides across the complete lane set.
- `bin/modules/flow/profile-hook.ts` validates explicit supported launch profiles and preserves native request identity aliases.
- The launch hook keeps autonomous selection to the four allowed model families and records only a session-scoped explicit model directive from the first non-empty `UserPromptSubmit` line.
- Direct review results record the selected profile and any high-effort reason.
- Historical coordinator task dispatch remains a separate compatibility contract: its task lock is forwarded verbatim, native-create request identity is bound independently of runtime capability support, and alias conflicts or deferred recovery context corruption fail closed.
- Runtime formal review first checks Review Readiness; plans carry only a profile recommendation, while each changed Candidate gets a fresh reviewer.
- Shared review routing does not use the flow receipt adapter to authorize profiles, concurrency, or evidence acceptance.
- This policy does not restore, refactor, or reclassify the retired review orchestration ladder; that retired boundary and its historical compatibility facts remain unchanged.
- Review findings use the shared In-Scope, Design-Returning, and Observation dispositions; only the first enters a bounded Repair Batch.
- Profile/recovery tests bind every continuation anchor field, including lane, scope, current locked flow, and cumulative Repair Batch count, before replay.
- Active Spec regression tests cover the shared disposition, `unchecked` evidence, and complete anchor contract in the model-selection topic.
- The same isolated-copy suite rejects retired review dispositions in this active Spec.
- ReviewReplay rejects missing dispositions and incomplete owner authorization anchors before mutating review state.
- The instruction architecture checker guards active review Specs, anchor boundaries, and consumer vocabulary against retired contract terms.
- The architecture checker also guards the readiness contract and ADR 0017 binding in isolated copies.
- Direct plan validation checks tier-consistent strategy/profile guidance, and ReviewReplay validates exact scope, non-empty actual profile, and unknown fields before terminal state.
- Direct plan validation requires Tier 3/4 strategy text to state a runtime formal-lane launch/create action and requires profile guidance to name a concrete supported model/effort pair; runtime reviewer identity stays fresh and dynamic.
- ReviewReplay rejects unknown finding dispositions before repair classification, preserving the fail-closed boundary for malformed results.
- ReviewReplay requires explicit readiness and demonstrated findings before initial launch or In-Scope repair.
- ReviewReplay validates the actual model/effort pair against the runtime's supported profile table and rejects unknown embedded finding dispositions.
- ReviewReplay requires the finding kind to be demonstrated before an In-Scope Repair Batch may mutate the candidate.
- Terminal structured findings are restricted to the explicit demonstrated or observation kinds.

## Verification

- `bun test bin/tests/flow bin/tests/waves`
- `bun run bin/wave_thread_flow.ts --compatibility-smoke`
- `bun run bin/compatibility_cli.ts wave_thread_replay_check`
- `bun run bin/compatibility_cli.ts wave_thread_roundtrip`
- `bun run bin/compatibility_cli.ts spec_contract_check --path docs/specs/wave-thread-flow/SPEC.md --repo-root .`
- `bun run bin/compatibility_cli.ts skills_index_check`
- `bun check`
- `git diff --check`

## Wave Thread 移除

Wave Thread 专属三档 Profile 与派发回放已经删除。直接 Review 和现行多任务流程的 Profile 规则继续由各自合同负责。
