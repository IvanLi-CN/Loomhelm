# ADR 0032: One Finalization Gate for Dev-Plan Owner Review

- Status: Accepted
- Date: 2026-10-26
- Related: `docs/adr/0030-dev-plan-single-source-wave-thread.md`, `docs/adr/0031-dev-plan-owner-review-projection.md`

## Context

Explicit `$dev-plan` output has two necessary concerns.

The canonical raw-plan must satisfy the machine contract, and the owner-facing response must be a complete readable projection.

Treating those checks as separate public gates makes a raw-plan pass look like a successful plan response even when the projection is missing or inconsistent.

The projection also needs task titles, purposes, and outputs.

Reconstructing those fields from a second task list would reintroduce the duplication that ADR 0030 removed.

## Decision

Use `bin/plan-cli.sh` as the only finalization route for explicit `$dev-plan`.

It runs the canonical raw-plan checker, parses the same canonical facts, and derives the transient owner-facing view.

It validates the view and returns one result: `pass` with projection output or `reject` with stable findings and no output.

`bun run bin/plan_contract_check.ts --plan` remains a lower-level raw-contract diagnostic and compatibility test entrypoint.

Its success alone does not authorize an explicit plan response.

Native Codex Plan Mode without `$dev-plan` remains outside this route.

New v2 task lines carry non-empty `title`, `purpose`, and `outputs` fields alongside execution fields.

The projection renders nine fixed sections and a Mermaid graph from those canonical facts.

It is stdout-only, is never persisted, and is never reparsed as an execution contract.

The projection's task-card section also renders every non-empty canonical batch lifecycle field.

Finalizer rejection messages expose stable finding codes without echoing raw plan content.

Historical compatibility requires one proposed-plan block, and section extraction ignores headings inside fenced examples.

The finalizer also rejects NUL input before raw checking and preserves direct task profile syntax in the owner-facing task card.

It rejects task and acceptance-card drift plus duplicate route-driving sections before adapting direct facts.

It opens every absolute tool-root component without following symlinks. The tool root is the selected entrypoint’s installation or candidate root, independent of the business project and working directory. Ordinary projects invoke a trusted installed entrypoint with stdin; dot-codex development validates the current candidate entrypoint and its paired checker, not runtime or another checkout.

It also ignores fenced proposed-plan markers in both Python and shell historical validation.

The file input route is tool-root-bound (relative paths are relative to that root), traverses directories and the final file with no-follow descriptors, and rejects non-regular inputs before reading.

Historical JSONL and proposed-plan wrappers are rejected by the projection route.

Historical duplicated contracts remain readable only through the explicit legacy parser.

Its wrapper extractor stops at the first valid closing marker and rejects extra markers.

Accepted flow aliases are normalized before canonical route selection.

Direct-task skill annotations are preserved in the owner-facing card wherever the accepted task syntax places them.

Every direct task form accepted by the raw checker must either project successfully or produce a rejection rather than disappear.

## Alternatives Considered

- Keep raw validation and projection validation as separate user-facing gates: rejected because either failure must produce the same blocked plan result. Separate success states are misleading.
- Make the projection a second machine-readable contract: rejected because it duplicates execution facts and creates drift risk.
- Change native Plan Mode to use the projection route: rejected because the custom contract is authorized only by explicit `$dev-plan`.
- Drop historical JSONL compatibility: rejected because replay and audit inputs still require read-only support.

## Consequences

Explicit `$dev-plan` has one clear success boundary and one clear failure shape.

The raw checker remains reusable for focused diagnostics, while the finalizer owns the combined decision.

New v2 fixtures must include display metadata.

Projection tests must verify section order, graph presence, fact coverage, stdout-only behavior, and tool-root path isolation in both installed and candidate invocation scenarios.

This decision changes Markdown plan finalization only.

It does not change Wave Thread runtime events, Worktrees, PR lifecycle, SHA lineage, archive behavior, or release semantics.
