# R02 Codex Content and Event Fixture Research

## Decision

R02 adds a test-only `loomhelm.codex.fixture/v1` envelope and a small JavaScript parser under `fixtures/codex`. The envelope keeps the source JSON-RPC payload intact, records provenance and ordering, and derives a non-authoritative category for tests and future display adapters.

The fixture boundary is deliberately narrower than a product protocol. It provides evidence and repeatable parser inputs for `REQ-LH-009` and `VER-LH-008`; it does not finalize a public message schema, expose a Connector endpoint, or claim hot attachment to the current Desktop app-server.

## Evidence basis

The observed sample is reduced from the R01 host-owned control evidence in [host-control-summary.md](../../experiments/codex/evidence/host-control-summary.md), [stdio-proxy-prototype.md](../../experiments/codex/evidence/stdio-proxy-prototype.md), and [codex-r01-host-bridge-decision.md](codex-r01-host-bridge-decision.md). Those records establish redacted message, command, approval, interruption, bridge disconnect/reconnect, history reconciliation, steer, and cold restart observations for an independently owned app-server process.

The current Codex App Server documentation describes streamed `thread/*`, `turn/*`, `item/*`, and `serverRequest/resolved` notifications, treats final `item/completed` values as authoritative, and documents agent messages, command execution, file changes, MCP tool calls, dynamic tools, plans, reasoning, and aggregated diffs. The R02 shape-only samples follow those documented names while keeping their provenance separate from R01 runtime evidence. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

The R01 evidence does not contain a raw transcript and did not capture a file-change item or a persisted file artifact. Therefore the file-change and artifact snapshot records are explicitly `protocol-shape` or `fixture-only`; they are renderer inputs, not claims that R01 produced those bytes.

## Fixture contract

Each line contains `schema`, `source`, `stream`, `sequence`, and `payload`. `stream=app-server` carries a JSON-RPC request, response, or notification. `stream=host-observation` carries a redacted bridge lifecycle observation that is not an app-server method. `stream=artifact` carries a fixture-owned artifact snapshot and is not a server event.

The parser validates the envelope and redaction constraints, then exposes `method`, `itemType`, and `category` as derived indexes. It never rewrites or normalizes `payload`, so a future field remains available even when the current classifier does not understand its method or item type. `serializeFixture` round-trips the complete envelope and the regression test checks nested unknown fields.

The category mapping is intentionally additive: `message`, `tool`, `approval`, `interrupt`, `reconnect`, `artifact`, `lifecycle`, `rpc`, and `unknown`. Classification is a convenience for fixture assertions and must not become a lossy storage model.

## Phase-one display boundary

The initial display should cover readable agent messages, command and MCP tool progress, file-change status, approval requests and resolutions, turn completion including interruption, reconnect/reconciliation state, and a basic artifact path/diff summary. Unknown content should remain visible through a safe fallback with its type, status, relevant identifiers, and preserved raw payload available for inspection.

The initial display should not host arbitrary interactive plugin UI, execute renderer-provided code, promise raw reasoning as a user-facing feature, or invent a standalone artifacts surface. Rich renderers for diffs, plans, reasoning summaries, images, dynamic tools, and trusted MCP app content remain later work that requires a stable public contract, authorization rules, and an explicit security boundary.

`item/completed` is the authoritative final item for a unit of work. Streamed deltas are useful for progress but must not replace the final item when state is reconciled after a disconnect. A reconnect must read persisted thread/turn/item state before issuing another side-effecting command; an unknown side effect remains unknown until reconciliation establishes its result.

## Reproduction

Run `node --test fixtures/codex/parse.test.mjs` to validate every committed sample, deterministic summaries, round-trip field retention, coverage categories, unknown fallback, and redaction guards. Run `node fixtures/codex/parse.mjs fixtures/codex/samples/observed-control.jsonl` to inspect one summary without any runtime credentials or network access.

The samples contain no raw thread/session/turn/request identifiers, user-specific absolute paths, credentials, rollout transcript, or complete user message. The external Desktop-session acceptance remains blocked under R01 and is not changed by these fixtures.
