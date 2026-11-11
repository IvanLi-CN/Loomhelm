# ADR 0030: Reconcile delivery units after a parent PR follow-up merge

## Context

A delivery unit can merge its registered parent PR and later need a follow-up PR on the integration branch for changes that were discovered or completed after that merge. The original parent receipt remains authoritative for the first merge, while the follow-up merge determines the final delivery-unit SHA used by post-merge tasks and closeout.

## Decision

Add `merge-claim` mode `parent-followup` for the delivery coordinator. The claim must identify the registered parent PR, preserve its verified merge SHA, bind a distinct PR in the same repository, and target the repository integration branch. `merge-resolve` records the follow-up `pr_merged` fact, advances the delivery-unit current and merge SHA to the follow-up merge SHA, and marks the delivery unit merged without rewriting the original parent receipt.

## Consequences

The ledger can represent the real provider history when a parent PR is merged before a later mainline follow-up PR. Existing parent and child merge modes keep their exact publication and approval gates. A follow-up claim is independently verified against the provider before resolution and remains subject to the delivery-unit task integration and closeout gates.
