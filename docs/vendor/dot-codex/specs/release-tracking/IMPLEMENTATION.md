# Release Tracking Implementation

`spec_disposition=update`; ADR 0027 records the ownership and identity tradeoffs.

Candidate source defines and registers the dedicated role and explicit spawn entrypoints, bounded handle waiting, manual `$flow-continue` recovery instructions, and separate origin/publication identity. Tracking automation is prohibited by the active contract; the runtime home is unchanged, so source validation does not establish that the current desktop session has loaded or started `release-tracker`.

The Step 5C card records preparation and trigger alongside its release inputs. A clear confirmation and merge request authorize those card-scoped actions; after a real merge, the caller starts target CI tracking and independent release preparation without waiting for unrelated cleanup, subject to target-repository release gates.

Normalized `post_merge_handoff` replay events bind one merge SHA and model tracker start, independent preparation, explicit blockers, CI waits and terminal results, and dispatch. They test ordering and repository gates; they are fixture inputs, not runtime authorization or external evidence.

Owner reports for an explicit Publication Identity require the fixed full origin SHA even when origin and publication match. Historical one-SHA normalized replay cards remain compatible; differing-SHA lineage cards continue to require full origin and publication commits and complete external transition evidence.

## Coverage

| Verification | Candidate evidence | Runtime boundary |
| - | - | - |
| VER-RELEASE-WIRING | Contract/config/profile consistency; missing registration, wrong profile, missing file, and incorrect entry are rejected | Dedicated role startup is unverified |
| VER-RELEASE-RECOVERY | Contract regression assertions cover trigger availability independence, one active observer handle, prohibited scheduling, fixed deadlines, quiet notifications, persisted retry allowance, and manual `$flow-continue` continuation | Runtime handle startup and deadline stopping are unverified |
| VER-RELEASE-IDENTITY | Semantic tests accept preparation-PR lineage and actual terminal deployment; reject broken, self-asserted, wrong-origin or conflicting lineage, missing deployment, unknown surfaces, and omitted alternate surface declarations | Actual production evidence remains per-release responsibility |
| VER-RELEASE-RETRY | Exact-run replay grants must precede mutation and be owner-authored, bound to epoch/origin/run, and not revoked; atomic run failure is distinct from nested surface failure; safety locators and CLI/environment repository targets are checked; conflicting aggregate facts and delayed observations cannot restore revoked permissions; all identifiable attempts and violations survive epoch changes; explicit retry attempts require receipt binding; external success clears only the restored run's failure | Persistence across real successors and continuation is unverified |

## Validation

- Fixed candidate checks: `python3 /Users/ivan/.codex/skills/dot-codex-development/scripts/context.py validate --cwd <candidate-root>`; repository contract tests and skill index checks.
- Task-specific tests: `python3 -m unittest bin.test_pr_skill_replay_check`; release lineage/deployment test methods include negative variants for malformed declarations and deployment identifiers.
- Tracking behavior replay: `python3 bin/release_tracking_replay_check.py --cases docs/specs/release-tracking/replay/cases.txt` rejects tracking heartbeat/cron launches, validates manual recovery anchors, and preserves unrelated automation compatibility.
- The focused replay schema uses `recovery_operation=none|authorized` to represent the existing operation receipt for the 30-minute/one-hour budget. A separate `tracking_scope_boundary` audit record distinguishes unrelated operations; tool arguments and assistant prose cannot erase an active tracking context. These normalized replay records are test inputs, not a runtime tool interface or a substitute for external authorization evidence.
- Release compatibility: all 148 release cases selected from `fast-track-merge-intent-closeout/replay/cases.txt` passed their expected positive/negative outcomes.
- All three changed topic SPECs passed `bin/spec_contract_check.py`.
- Validation and formal review bind the synchronized topic head and its live target-branch base; mainline synchronization requires refreshed evidence and does not install the candidate into the runtime home.

No release is triggered by this change. Candidate validation does not assert runtime rollout, actual production deployment, or runtime tracker startup; no tracking automation is created or modified.

Restored-run success must retain the bound run identity and commit, with a consistent terminal result. A contradictory success flag or another commit cannot clear unresolved failure, even if separate artifact evidence is complete.

Duplicate MCP text/structured facts retain the same unresolved run state. Provided safety locators are parsed and checked rather than ignored when malformed or on another host; rerun target resolution preserves explicit host precedence and exported shell context. Attempt receipts update state only after matching epoch, commit, run locator, and consistent run status.

Aggregate conflict checks cover all validated locator and commit fields, including both orderings; attempt-specific URLs must agree with declared attempts. Surface failures are tracked by concrete locator and invalidate that identity's earlier success facts. Only a later complete success observation for the same identity and publication commit/tag clears its failure; partial, stale, or different-surface evidence leaves it unresolved.

Invalid run context is excluded before collecting nested publication evidence. Explicit attempt URLs participate in retry freshness even when `run_attempt` is omitted. Each concrete surface preserves its latest observation start across crossed failure/success responses; an older response cannot lower that mark, and a newer nonterminal observation invalidates earlier success evidence. Legacy observation-only GitHub Enterprise and failure cards without a discovered run ID remain compatible.

An explicitly malformed attempt is rejected rather than treated as an omitted legacy field. Concrete surface identity remains known after its success proof is invalidated, so later state-only observations at that bound URL can revoke old proof without repeating the SHA; restoration still requires complete fresh identity evidence.

Current invalid safety observations revoke older retry permission without granting new permission; delayed observations remain excluded. The expected next attempt is only a lower bound, and explicit post-retry attempts require a valid result from the exact mutation to bind the returned receipt. A newer nonterminal parent run prevents published closeout until a fresh consistent success observation restores its terminal proof.

Observation freshness is evaluated after both field and locator attempts are resolved. Current invalid observations advance the read-start watermark when revoking permission, so a delayed positive response cannot restore it. Invalid current parent state also revokes old failure permission and terminal proof; malformed or unbound attempt fields do not suppress that revocation, while proven old attempts and delayed reads remain excluded.

Request-bound attempts participate in the same eligibility check before any failure or publication proof is collected. Conflicting current/old attempt indicators cannot establish a stale observation. Semantically duplicate run cards ignore unrelated metadata; multiple distinct current run objects retain revocation rather than disappearing. A bound GitHub read can attribute an invalid-locator state for revocation, but never supplies successful identity proof or mutation permission.

Bound reads also recognize native status-only responses without a normalized run ID, including protocol wrappers, while unrelated nested artifact states remain separate. Request and response attempt conflicts reject positive failure, safety, and publication proof before collection; current invalid responses retain their revocation effect.

Known read targets must agree with the response's bound repository and run before failure, safety, or publication proof is collected. Native ID duplicate fragments are checked in both aggregation orders even without normalized safety fields. Aggregate conflicts in all existing run-state aliases, including `success`, revoke run proof and permit a later complete success observation to restore it. The origin commit locator remains separate from the run locator and must retain the bound origin repository, commit, and consistent code-hosting host.

Native API read attribution resolves endpoint options in either order, leading-slash and absolute API URLs, explicit hostname precedence, and inherited shell environment through the existing target resolver. Absolute URL hosts remain authoritative. Surface revocation scans original observations, including JSON protocol text, so aggregation order cannot discard a same-surface failure or nonterminal fact; a later complete success observation may restore that identity's proof.

Native GitHub `id`/`databaseId` and `attempt` fields retain identity and freshness meaning, including `gh run view --attempt`/`-a` selections. Every existing commit alias is checked consistently, including identity-only protocol fragments in either aggregation order. Same-repository/run REST self locators are equivalent to their GitHub web locators; standard REST auxiliary links remain constrained to their repository and, where applicable, run, without substituting for self identity. Foreign or malformed locators remain invalid. Protocol and explicit `run`/`runs` containers preserve negative safety facts as well as atomic run state, leaving nested jobs and artifact workflow provenance outside run terminal state.

Deterministic rerun fixtures encode an existing task grant in an owner message as `release_retry_authorization` with `allowed`, `release_epoch`, `target_repo`, `target_branch`, `target_sha`, and `release_run_id`. This is a normalized replay receipt; it does not impose a required response format on the owner or replace runtime authorization checks.
