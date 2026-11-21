# Plan finalization

The explicit `$dev-plan` route has one public finalization command.

It rejects NUL-containing input before invoking the raw checker and runs the canonical raw-plan checker internally.

It derives the projection only after that check passes, validates the projection, and returns the single final `pass` or `reject` result:

```bash
skills/bin/plan-cli.sh --input <raw-plan.md>
```

The launcher is the trusted boundary: it clears Bun and Node preload environment variables and selects `skills/bin/plan_bunfig.toml`. Direct `bun --no-install run skills/bin/plan_review_view.ts` remains a development-only diagnostic path and is not a secure interface for untrusted candidate input.

The finalizer has one public result: `pass` emits the projection and permits the explicit plan response; `reject` emits stable findings, no compliant projection, and blocks execution.

The `$dev-plan` response wraps a passing projection in exactly one `<proposed_plan>` block.

Use `bun --no-install run skills/bin/plan_contract_check.ts --plan -` only for focused raw-contract diagnostics or fixture tests.

Its standalone `PASS` is not an explicit `$dev-plan` finalization result.

For historical replay fixtures or runtime input, validate the in-memory state and task events with the dedicated compatibility checker before dispatch. Do not write the state into the project repository.

The TypeScript checker is the source of truth for exact field, executor, topology, and acceptance syntax.

The projection adapter must cover every direct task form accepted by that checker and reject any task it cannot project instead of silently omitting it.

Keep plan prose concise and write owner-facing text in Simplified Chinese unless the owner requests another language.

File inputs must resolve inside the candidate Worktree.

Use stdin or the current response for an in-memory raw-plan, and never point the projection entrypoint at runtime `CODEX_HOME` or another repository.

The file route must read through a no-follow traversal of every absolute candidate-root component and the requested path so a symlink swap cannot escape that boundary.

The requested path must name a regular file; non-regular inputs are rejected before reading.

Do not feed the projection, a historical JSONL session, or a persisted copy back into the raw-plan checker as a new plan.
