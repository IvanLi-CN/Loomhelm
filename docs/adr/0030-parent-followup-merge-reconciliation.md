# ADR 0030: Reconcile delivery units after a parent PR follow-up merge

## Context

A delivery unit can merge its registered parent PR and later need a follow-up PR on the integration branch for changes that were discovered or completed after that merge. The original parent receipt remains authoritative for the first merge, while the follow-up merge determines the final delivery-unit SHA used by post-merge tasks and closeout.

## Decision

Add `merge-claim` mode `parent-followup` for the delivery coordinator. The claim is valid only for a contract-3-or-newer delivery unit that is already merged and has an approved plan revision adding active contribution work; a normal `parent` claim remains valid only while the delivery unit is active. The claim must identify the registered parent PR, preserve its verified merge SHA, bind a distinct PR in the same repository, and target the repository integration branch. Its protected approval binds a SHA-256 digest of the complete follow-up target and is consumed once. `merge-resolve` records the follow-up `pr_merged` fact, advances the delivery-unit `merge_sha` to the follow-up merge SHA used by post-merge tasks and closeout, preserves `current_sha` as the verified head of the delivery-unit parent branch, and marks the delivery unit merged without rewriting the original parent receipt.

## Consequences

The ledger can represent the real provider history when a parent PR is merged before a later mainline follow-up PR. `current_sha` and `merge_sha` retain separate lineage roles: the former guards subsequent parent-branch publication, while the latter identifies the target-branch merge used for downstream post-merge work. Continuation `pr_published` facts carry an explicit marker so current readers exclude them from the canonical parent PR projection, while closeout keeps the delivery unit open until the corresponding follow-up merge succeeds. Existing parent and child merge modes keep their exact publication and approval gates. A follow-up claim is independently verified against the provider before resolution and remains subject to the delivery-unit task integration and closeout gates.
