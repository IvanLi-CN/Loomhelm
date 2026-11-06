# Workflow Execution Receipts

## Related ADRs

- [0003 External Fact Delivery Gates](../../adr/0003-external-fact-delivery-gates.md)
- [0010 Post-Merge Flow Receipt Finality](../../adr/0010-post-merge-flow-receipt-finality.md)
- [0014 Direct Review Evidence](../../adr/0014-direct-review-evidence.md)

## Context and Scope

Long delivery tasks need reusable local validation facts across context compaction and documentation-only changes. The receipt ledger is non-tracked audit infrastructure for validation and lifecycle facts. It does not schedule, retain, validate, or gate code review.

## Requirements

### REQ-RECEIPT-CORE

- The receipt root resolves through `git rev-parse --git-path codex-flow`.
- The helper resolves from `${CODEX_HOME:-$HOME/.codex}/bin/flow_receipt.py` and selects the candidate with `--repo`; active instructions must not invoke a target-relative `bin/flow_receipt.py` path. The architecture check performs lexical normalization for quoting, slash escapes, repeated separators, and dot components including parent traversal. The canonical helper must be an exact path token and must be followed immediately by `--repo`; it does not execute or emulate generated shell/Python programs.
- `init`, validation `record`, `classify`, `status`, and `close` provide stable JSON output for audit use. Review commands are legacy compatibility surfaces, not direct-flow requirements.
- A validation receipt binds command, toolchain, effective inputs, acceptance evidence, current head, exit code, and log digest. Equivalent inputs may reuse a passed validation fact; required CI, GitHub, owner approval, release, and review evidence remain independent delivery facts.
- The ledger may record post-merge facts but cannot block merge cleanup or decide direct-flow completion.
- `bind-pr`, post-merge recording, and `close` retain only live PR identity, current base/head, merge SHA, finality, and validation lifecycle checks. Historical review assessment, review-wave, and convergence fields remain readable audit data and are never a retained lifecycle gate.
- Receipt lifecycle reads request only the PR facts needed for identity, refs, state, and merge finality; they use the adapter's explicit lightweight mode and do not request review/comment collections. Review-policy diagnosis remains on the complete PR-facts path.
- When a provider adapter failure is wrapped by a receipt lifecycle operation, the CLI keeps the compatibility `error` field and exit code while exposing the safe adapter `error_code` and `operation` fields when an explicit cause is available. Raw provider output and credentials remain excluded.
- `bind-pr` requires a live `OPEN` PR and `pr_bound_at` records that pre-merge binding when it occurs. `close --state complete` does not require that timestamp: a ledger initialized after merge, or initialized earlier without `bind-pr`, may complete only with one matching post-merge receipt, terminal finality bound to the merge SHA, and live `MERGED` PR facts for the same repository and PR. The ledger repository binding must match the current PR adapter's canonical provider, host, and repository identity. The merge time must be a valid timezone-qualified RFC 3339 timestamp. The receipt proves post-merge association; it does not claim a historical pre-merge binding.
- New `not-applicable` release finality requires `release_expected=false` and structured policy evidence bound to the same provider/repository, target branch, and merge SHA, with a policy locator and nonempty rationale. Record and complete recheck that binding against live merged PR facts; conflicting or missing fields cannot seal a new complete ledger. Historical receipts remain readable, but missing evidence is not promoted to a new completion. Structural consistency does not independently establish external policy truth.
- A `published` fact that supplies `release_expected` must use the boolean `true`; omission remains readable for older published receipt inputs.

### REQ-REVIEW-ORCHESTRATION-RETIREMENT

- `contracts/review-orchestration-retirement.md` is the authoritative inventory for review-only code that remains in `bin/flow_receipt.py` solely for legacy compatibility. Direct-flow cleanup must use it to distinguish retained validation/lifecycle behavior from direct-review retirement targets.
- Direct-flow skills must not invoke an inventory retirement target. Cleanup removes an entire named group and its replay/tests together; it does not remove validation, attestation, PR-audit, or post-merge behavior by name similarity.
- Archive-read compatibility is an explicit later decision. It must be removed or migrated together with the legacy schema fields it reads, never silently during direct-flow cleanup.

### REQ-VALIDATION-IDENTITY

- A stable validation key includes command, toolchain, declared input scope, normalized paths, and acceptance evidence. Execution identity additionally includes effective current inputs.
- Documentation-only deltas may use a helper-derived scoped validation attestation when effective inputs are unchanged. Code, test, build, workflow, contract, or effective merge changes invalidate affected validation facts.
- The helper never accepts caller-declared paths or SHAs as a substitute for Git-derived scope.

### REQ-EXECUTION-SAFETY

- Validation runs only in the current candidate worktree. The helper does not create synthetic repositories, worktrees, homes, review processes, network requests, or provider sessions.
- Ledger mutation is atomically locked. Long validation holds only its own execution identity lock. Failed, dirty, stale, or timed-out validations remain explicit audit facts.

## Verification

### VER-EXECUTION-RECEIPTS covers: REQ-RECEIPT-CORE, REQ-REVIEW-ORCHESTRATION-RETIREMENT, REQ-VALIDATION-IDENTITY, REQ-EXECUTION-SAFETY

- equivalent validation inputs reuse safely and effective changes invalidate affected validation facts;
- a late-initialized ledger and an earlier unbound ledger can close from matching live merged facts and finality without setting `pr_bound_at`;
- mismatched repository, PR, base/head, merge SHA, timestamp, finality, or unavailable/non-`MERGED` live facts keep an active ledger from completing;
- missing or conflicting no-release policy evidence is rejected while valid no-release evidence remains usable and historical receipts stay readable;
- ledger operations do not create or gate review waves, repair permits, or review evidence;
- current direct delivery combines GitHub facts, CI, validation, and direct review evidence without a receipt-led dependency.
- the retirement inventory names each live review-only CLI and source group; the architecture check fails if the inventory and helper drift apart.
