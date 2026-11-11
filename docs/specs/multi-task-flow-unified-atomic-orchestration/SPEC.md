# Unified atomic orchestration

## Scope

This topic defines the durable orchestration contract for the multi-task-flow ledger and viewer.

## Requirements

- `AtomicNode` and `AtomicEdge` are the only canonical dependency facts; Task and DeliveryUnit are peer projections of that graph.
- Work nodes use strict unions for activity type, scope and lifecycle; contribution and documentation are Task scoped, while verification, release and deployment may be Task or DeliveryUnit scoped.
- A planned milestone has at least one incoming edge or explicit acceptance criterion, and its runtime outcome is the full AND of all conditions.
- Contribution work may enter `starting` only after its DeliveryUnit has a PR and parent branch; the starting input does not require a commit hash.
- Task PR and DeliveryUnit PR facts use explicit union states, including provider-closed facts; legacy `parent_pr` remains read-only compatibility input.
- Task and DeliveryUnit business status is derived from canonical nodes and milestone outcomes; agent idle, waiting and disconnected observations are separate runtime observations.
- Legacy atoms, groups and coordination fields remain readable and migrate only when semantics are mechanical and recoverable.
- The aggregate dependency graph remains the default viewer entry and the atomic dependency graph exposes scope, conditions, evidence, derived status and blocker backtrace.

## Compatibility

The durable envelope remains schema version 2 while contract version 3 adds the canonical atomic graph. New writes use contract 3 fields; historical contract 2 ledgers remain readable and are migrated with a backup, revision check and idempotent request identity.
