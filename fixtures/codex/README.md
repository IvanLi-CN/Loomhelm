# Codex content and event fixtures

This directory contains sanitized, test-only Codex app-server content and transport observations for `VER-LH-008`. It is not a public API contract and it does not enable control of an existing ChatGPT Desktop process.

Each JSONL line uses the `loomhelm.codex.fixture/v1` envelope. `payload` is the preserved app-server JSON-RPC object or an explicitly marked host observation/artifact snapshot; `source`, `stream`, and `sequence` describe the fixture record without replacing fields from the payload.

The parser derives a display category from the method and item type, but the original envelope and payload remain available for later renderers. Unknown methods, item types, and extension fields are valid input and are classified as `unknown` rather than rejected.

## Samples

| Sample | Provenance | Coverage |
| - | - | - |
| `samples/observed-control.jsonl` | Redacted R01 host-owned control observations | Agent message, command output, accept/decline approval, pending approval across bridge disconnect, reconnect/history reconciliation, steer and interrupt |
| `samples/content-and-artifacts.jsonl` | Current documented app-server shapes plus a fixture-only artifact snapshot | MCP tool item, file change approval, authoritative item completion, aggregated diff, plan/reasoning content, artifact metadata |
| `samples/unknown-event.jsonl` | Parser regression shape | Unknown method, unknown item type, unknown host observation, nested field preservation |

The `observed-r01` source is reduced from repository R01 evidence summaries and stable redacted references. It is not a raw app-server transcript. `protocol-shape` records exercise documented shapes that were not all observed in R01. `fixture-only` records are synthetic renderer inputs and must not be reported as runtime evidence.

## Parser

Run the focused parser tests from the repository root:

```sh
node --test fixtures/codex/parse.test.mjs
```

Print deterministic summaries for one or more fixtures:

```sh
node fixtures/codex/parse.mjs fixtures/codex/samples/observed-control.jsonl
```

The parser rejects malformed envelopes, unsupported streams, sensitive credential keys, and user-specific absolute paths. It permits unknown event content and preserves every field through `serializeFixture`.

## Display boundary

Phase-one basic display may render accumulated agent text, final message items, command/MCP/file-change state, approval request and resolution state, turn status, reconnect or uncertain state, and a safe artifact path/diff summary or link. The fallback for unknown content is readable metadata plus an inspectable raw payload; it must not execute arbitrary plugin UI or content.

Later rich renderers may add item-specific diff/source views, plan and reasoning summaries, images, dynamic tool content, and trusted MCP app views after their own public contract, authorization, and security review. The fixture parser intentionally does not choose or host those renderers.
