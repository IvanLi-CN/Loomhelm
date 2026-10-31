# ADR 0013: Immutable browser principal binding

## Context

The browser session bootstrap returns the current principal, but a long-lived Web assembly previously reused a mutable cookie-backed client after the cookie session changed. A response or mutation from the replacement principal could therefore be attributed to the old assembly's query keys or write flow. Principal cache cleanup also had an awaited interval during which a stale assembly could be published.

## Decision

After a successful same-origin bootstrap, the Web application creates a generated client bound immutably to the returned principal and the local session epoch. Every protected request from that client carries one `X-Loomhelm-Expected-Principal` header. Server middleware resolves the principal from the current request session or bearer credential and compares it to the header before protected handlers run; missing headers retain the existing compatibility behavior, while bootstrap and OIDC discovery/callback routes remain unbound. Empty, malformed, duplicate and mismatched values fail with HTTP 401 without disclosing either identity.

The client checks its binding before sending a request and again when a non-401 response completes. Invalidated bindings cannot silently rebind, populate the old cache or replay the side effect. The provider waits for previous-principal query cancellation/removal and checks the session generation again before exposing the replacement assembly. Confirmed task creation uses the exact `task:<id>` reconciliation scope for relationship and stale-completion outcomes; ID-less, mismatched and otherwise ambiguous create outcomes retain their conservative creation barrier.

## Consequences

Cookie rotation cannot make an old production assembly accept data or perform a mutation as the replacement principal. Existing browser and native callers without the header remain compatible, and no endpoint, database schema or durable state format changes. The browser client gains a small explicit binding API and invalidated requests surface a configuration error rather than being retried. A replacement assembly must complete bootstrap and cache cleanup before it becomes visible.

## Compatibility

This is `public_api=minor` because the generated client gains an additive binding capability and the server accepts an optional request header. It is `persistent_state=patch` because no migration or durable format changes. Existing clients and bearer requests without the header retain their prior authentication path.

## References

- [Phase-one specification](../specs/phase1-core/SPEC.md)
- [Implementation coverage](../specs/phase1-core/IMPLEMENTATION.md)
- [U02 recovery completeness](0008-u02-recovery-completeness.md)
