# ADR 0026: Multi-task Flow proposal quality gates and execution boundary

## Context

Multi-task Flow can represent a dependency graph, estimates and acceptance scopes before implementation approval. The existing runtime validates graph shape, task ownership, handoff digests and later execution receipts, but a proposal can still omit concrete acceptance criteria, post-merge obligations or an explicit distinction between proposal visibility and scheduling authority. Delaying all of these checks until dispatch makes an incomplete plan look executable and moves avoidable design errors into runtime blocking.

## Decision

Treat `proposal`, `initialized run`, `scheduled run` and `completed run` as separate lifecycle stages. A proposal is reviewable but unschedulable. An initialized run has an authoritative ledger and owner binding. A scheduled run has an approved execution plan and may dispatch only the actions covered by that approval. A completed run requires every delivery unit to satisfy its closeout contract and leaves no unresolved operation or known follow PR.

Add a proposal completeness gate before approval. The gate validates the full dependency graph and reports all material issues together. It requires every task and delivery unit to have a structured acceptance contract, every delivery unit to declare its closeout path, every dependency edge to use documented lifecycle semantics, every regular delivery unit to declare coordinator readiness as a pre-activation requirement, and every low-confidence coarse estimate to carry decomposition evidence or an explicit rationale.

Keep acceptance contracts distinct from handoff scopes and digests. Scopes and digests provide stable ownership and integrity checks; the contract remains the source of observable criteria, evidence kinds, required checks and completion state. The dashboard presents both the contract summary and completeness diagnostics without inferring approval or readiness from a plan ID, graph node, estimate, live viewer or lease.

Keep bootstrap and regular ownership boundaries unchanged. Bootstrap is main-owned and may use the bound main conversation. A regular delivery unit remains group-owned and MUST bind an independent Delivery coordinator conversation before activation. The proposal may contain an unbound regular group, but approval and scheduling surfaces must identify that fact as a pending gate.

Require a delivery unit's closeout path to cover workspace readiness, parent branch and parent PR publication, merged-SHA CI, applicable release/deployment/verification work, known follow-PR reconciliation and final closeout. Runtime receipts remain authoritative for those facts; the proposal gate ensures that the applicable obligations are declared before approval.

## Consequences

Incomplete plans fail or are visibly blocked before owner approval instead of discovering missing work during dispatch or closeout. The dashboard becomes an honest review surface rather than an implicit execution authorization. The model gains structured acceptance data and proposal diagnostics, which requires additive schema/projection work and new candidate-plan fixtures; existing historical ledgers remain readable and are not silently rewritten.

The distinction between `integrated`, `completed`, `verified` and `closed` becomes reviewable at plan time and remains receipt-driven at runtime. A proposal can still show an unbound regular coordinator or absent branch/PR facts, because those are pre-activation facts; it must show them as unsatisfied requirements rather than treating them as successful evidence.

## Verification boundary

This ADR records the design contract only. It does not claim that the current validator, ledger schema or dashboard already implements these gates. Implementation must add proposal fixtures, validator tests, dashboard state tests and runtime regression coverage before the new requirements are treated as satisfied.

## References

- [客户端 Skills 与工程执行支持](../specs/client-skills/SPEC.md)
- [Multi-task Flow source contract](../../skills/docs/vendor/dot-codex/specs/multi-task-flow/SPEC.md)
