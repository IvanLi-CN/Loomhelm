# Shared Execution Receipt Contract

`${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/bin/flow_receipt.ts --repo <candidate>` maintains non-tracked validation and lifecycle facts below `git rev-parse --git-path codex-flow`. Always pass `--repo <candidate>`; do not copy the helper into the candidate. Code-hosting PRs, required CI, repository validation, release artifacts, and direct review evidence remain authoritative for delivery. Review execution and review gates never depend on this ledger.

## Identity and reuse

- A validation proof key binds the exact command, toolchain fingerprint, declared input scope, normalized paths, acceptance evidence, and clean repository HEAD. A receipt records the run id, flow type, base/head SHAs, exit code, log path/digest, and evidence appropriate to that validation.
- Exact effective-input matches reuse a passed validation receipt without rerunning. Docs-only deltas may use a scoped attestation after the helper verifies the actual Git delta and current base.
- Code, tests, build inputs, workflow files, canonical Spec contracts, or an effective merge result invalidate affected receipts. Required CI and owner approval always bind the current SHA and are never rebound by a local receipt.
- Historical review fields are audit data only. They do not affect current review evidence or direct delivery eligibility. `bind-pr`, post-merge recording, and `close` do not require a review assessment, review wave, or convergence state.
- `bind-pr --pr-ref` may link a live PR to an audit run. Direct PR convergence refreshes normalized base/head facts and OPEN state with the selected platform adapter; it does not require this audit metadata. These lifecycle reads pass the adapter's lightweight related-facts option; complete review/comment collections remain available to callers that explicitly need review-policy facts.

## Budgets and lifecycle

- Validation `record` runs the command itself and enforces the 1800-second hard budget unless an exact tracked known-long command grants a longer budget.
- Use the ledger only for validation audit, scoped attestations, and lifecycle notes. Do not start review waves, record review receipts, consume repair permits, or use `close` to decide a Tier 3/4 review outcome.
- A successful clean pre-PR validation may advance the candidate `head_sha`. Failed, dirty, preflight, or PR-bound attempts may not. `close` accepts an explicit terminal state, archives the ledger atomically, and does not rebuild or verify an Agent transcript.
- Command logs stay below the ledger's dedicated execution directory. Ledger writes use a shared lock, temporary file, and atomic replacement; archived run ids are immutable.

## CLI

- `init`: create or resume a validation-audit ledger with an acceptance manifest and existing PR binding.
- `bind-pr --pr-ref`: bind a created/reused live PR to the current ledger.
- `record --kind validation`: execute and record a validation fact.
- `record --kind attestation`: add a scoped docs-only delta attestation.
- `record --kind post-merge --post-merge-evidence-file`: record the live MERGED PR identity plus terminal target-CI and release facts. The evidence binds the live PR's original base/head and actual merge SHA; a stale local binding is recovered from those live facts without consulting a historical review assessment. Identical merge identities are reusable, while conflicting evidence is immutable. For `release.status=not-applicable`, provide `release_expected=false` and `policy_evidence` with `repository` (`provider`, `host`, `full_name`), `target_branch`, `merge_sha`, `policy_locator`, and `reason`. The helper compares the identity with the live merged PR and checks structural consistency; callers remain responsible for verifying the policy itself. Historical evidence remains readable but cannot seal a new completion without these fields.
- `classify`: classify a path/effective-merge delta as reusable or invalidating.
- `status`: report validation state and any `legacy_review_history` for audit.
- `close`: archive the audit ledger after its own validation lifecycle; it is not a direct-review or merge gate.

Lifecycle CLI failures preserve the compatibility `error` field and exit code. When an explicit cause chain contains a typed provider adapter failure, the same JSON error object also exposes its safe `error_code` and `operation`; raw provider output, stderr, and credentials are never emitted.
