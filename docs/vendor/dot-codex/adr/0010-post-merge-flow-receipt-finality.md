---
status: accepted
---

# Post-Merge Flow Receipt Finality

`flow_receipt.py` must treat pre-merge OPEN PR binding and post-merge finality as different facts. Direct and aggregate flows record an explicit merge receipt containing the original PR head/base and the actual GitHub merge SHA; only after applicable Step 6 CI, release, deployment, or publication facts are terminal may the run be sealed as `complete`. This preserves the existing fail-closed OPEN binding while preventing a successfully merged PR from leaving its receipt permanently active.

A ledger may be initialized after merge or may lack a pre-merge binding record. In either case, a post-merge association is valid only when the repository-bound PR identity, live `MERGED` facts, merge receipt, and terminal finality agree. This association does not backfill or claim a historical OPEN binding.

## Considered Options

- Reuse the OPEN-only binding check after merge: rejected because GitHub changes the PR state to `MERGED`, making normal successful merges impossible to close.
- Accept `MERGED` directly in `close`: rejected because it could mark a run complete before post-merge delivery facts have settled.
- Leave the receipt active and rely on an external control-plane record: rejected because the run loses an auditable link to the actual merge SHA and can block later work in the same worktree.

## Consequences

- `gh_pr_binding_facts()` remains OPEN-only; a separate merged-facts path validates `MERGED`, the original head/base, `mergeCommit.oid`, and `mergedAt`.
- The first implementation targets direct and aggregate PRs. Child and checkpoint completion remains owned by `$initiative-flow` for the legacy Initiative flow; Wave Thread batches use the milestone and closeout contract in ADR 0029 and `docs/specs/wave-thread-flow/SPEC.md`.
- Existing active ledgers are recovered separately after their Step 6 facts are verified; this decision does not authorize remote or ledger mutation by itself.
- `pr_bound_at` records an actual pre-merge binding and is not required to complete a ledger whose post-merge receipt and live merged facts validate.
