# ADR 0007: Explicit session creation identity

## Context

The command protocol uses caller-provided identities to distinguish retries from new work. Session creation omitted that field, allowing a Connector implementation to hash project, task and prompt contents as the creation identity. Two deliberate requests with identical content could then return one old Session instead of creating distinct conversations. Generating a new identity on every transport attempt would introduce the opposite failure after an ACK is lost.

## Decision

Require `command_id` on `CreateSessionRequest` and preserve it on both Gateway inputs and their adapter calls. Reject a missing or whitespace-only identity before opening a transport. The caller allocates one stable identifier for each deliberate creation intent and reuses it while retrying or reconciling that intent.

After authorization, the durable controller must return or reconcile the same Session for the same identity and unchanged payload, reject changed payload under that identity with `idempotency_conflict`, and preserve distinct identities even for identical prompts. Unknown execution cannot be retried as new work until reconciled. Authorization must precede returning any prior result; knowing an identifier does not grant access to another user's conversation.

The Connector owns the durable implementation and its local journal migration. It may read legacy prompt-derived records to reconcile existing work, but must not guess a new caller identity from those records or silently treat them as new creation requests. Its compatibility record must identify supported old states and fail closed outside the demonstrated window. This protocol change neither rewrites the journal nor proves that an old binary can safely access a changed journal format.

## Consequences

Callers must supply the creation identity explicitly, and the Gateway can distinguish a deliberate new conversation from a retry before choosing transport ownership. The public API impact is `major` because a previously optional-by-absence request field becomes mandatory; no released-version number is selected here. The protocol-only persistent-state impact is `patch`; the Connector's implementation must classify and verify any durable journal change separately. This extends the command-identity rules in ADR 0003 without replacing its other contracts.

Boundary tests establish missing-identity rejection and unchanged identity propagation, including distinct intents with identical prompts. They do not establish journal deduplication, ACK-loss recovery or real Codex execution; those remain Connector and integrated-controller acceptance requirements.

## References

- [Versioned public protocol](0003-public-protocol-and-reconciliation.md)
- [Phase-one specification](../specs/phase1-core/SPEC.md)
