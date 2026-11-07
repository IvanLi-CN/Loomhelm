# Fresh Thread Dispatch Implementation

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: Fresh task creation is isolated from delivery and multi-task coordination.

## Implementation Coverage

- `REQ-FRESH-DISPATCH-001` through `REQ-FRESH-DISPATCH-006`: the `fresh-thread-dispatch` Skill and its handoff-envelope reference.
- `REQ-FRESH-DISPATCH-002` and `REQ-FRESH-DISPATCH-003`: `bin/modules/flow/fresh-thread-dispatch.ts` materializes the explicit default profile and canonical project/environment request shape. It requires a resolved task title, normalizes and validates it, forwards it as native `title`, and keeps dispatch metadata local. It resolves the Git-project fact before mapping an unstated environment to `worktree` or `local`, rejects missing metadata and explicit incompatible non-Git worktree requests, and fails closed before native creation rather than guessing.
- Native-create recovery preserves the exact operation, request, and `create_thread` tool identities; adapter-owned PreToolUse denials and runtime failures with complete native operation/request/tool/status/error identity are the only accepted rejection evidence. The trusted adapter validates raw provider results and emits opaque adapter failures; failure and denial wrappers remain private to the internal adapter and are omitted from the public waves barrel. The public waves API exposes only the claim-release operation, while parent-side request binding and success binding require the observed canonical tool and request identities, public claim release rejects raw caller mappings, and conflicting or missing identity aliases fail closed.
- Persisted failure receipts remain inspectable history, but a marker and recomputed digest cannot authorize a retry after JSON reload; the runtime retry path requires an adapter-owned receipt and replay requires an observed `dispatch_failure` event for the failed operation.
- `VER-FRESH-DISPATCH-001`: structured cases in the instruction behavior replay catalog and unit coverage that every case has a routing context.
- `VER-FRESH-DISPATCH-002`: the skill-creator validator, spec-contract checker, skills index check, and focused regression coverage for automatic Git-project `worktree` selection.
- `VER-FRESH-DISPATCH-003`: maintainer review of the assignment-scoped parent/child information boundary, including resource-disjoint retained parent work, platform-owned pending setup, fact provenance, child-authored output, and fail-closed relay ambiguity. The delivery record includes the merge-base SHA, reviewed head SHA, reviewed paths, scenario results, and a terminal `PASS` or `CHANGES REQUESTED` verdict; it remains deliberately outside automated and live-model acceptance thresholds.
- `VER-FRESH-DISPATCH-004`: focused unit tests cover default and explicit profile materialization, resolved-title normalization and bounds, nested environment shape, metadata separation, partial-profile rejection, and runtime failure receipt import.

## Remaining Gaps

- Live model replay remains an opt-in validation that requires an explicitly authorized model run; its cases are ready for that execution. Native platform binding from `clientThreadId` to a real `threadId` remains platform-owned and is not simulated by the local builder or adapter.

## Related Changes

- `skills/fresh-thread-dispatch/**`
- `docs/specs/agent-instruction-architecture/replay/cases.json`
- `bin/instruction_behavior_replay.py`
