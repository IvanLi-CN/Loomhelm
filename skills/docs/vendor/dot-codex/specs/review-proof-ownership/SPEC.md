# Review proof ownership

> Superseded for direct delivery by [`mandatory-local-review-proof`](../mandatory-local-review-proof/SPEC.md). This topic preserves historical ownership context only and defines no active direct-flow routing, gate, or `ReviewReceipt` producer.

## Related ADRs

- [0013 Review necessity tiering](../../adr/0013-review-necessity-tiering.md)

## Context and Scope

Earlier receipt schemas derived review provenance from native child tasks and runtime transcripts. That transport-specific model is retained only to explain historical v5 ledger fields. Schema v6 replaces it for direct delivery with the sub-agent structured receipt contract.

### Goals

- Preserve the meaning of historical native-agent receipt fields for audit.
- Direct new implementation to the active transport-neutral specification.

### Non-goals

- Define a current delivery review gate or a review runner.
- Change CI tracker, GitHub, or release-fact behavior.

## Requirements

### REQ-HISTORICAL-NATIVE-REVIEW

- Historical native task, child-ID, transcript, and `agent-review` fields remain readable audit data only when carried from an active v5 ledger.
- New direct flows must use the schema v6 sub-agent-only `record --kind review` path from the successor specification. Historical data cannot satisfy a current-head mandatory proof.

## Verification

### VER-HISTORICAL-OWNERSHIP covers: REQ-HISTORICAL-NATIVE-REVIEW

- An active v5 ledger migrates without changing its retained review bytes; v1-v4 direct ledgers are rejected.
- A direct v6 receipt rejects native transcript or child-provenance as proof.

## Visual Evidence

- Not applicable: this topic has no visual delivery surface.
