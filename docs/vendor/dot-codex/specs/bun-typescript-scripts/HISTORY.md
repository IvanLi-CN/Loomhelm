# Bun + TypeScript Project Scripts 主题历史

> 这里记录主题局部生命周期、替换、兼容性与必要背景；完整 ADR 取舍保留在 `docs/adr/`。

## Lifecycle / Compatibility

- New active topic introduced for the `bun-migration` delivery batch.
- Python compatibility remains read-only during migration; historical JSONL and command examples remain readable after cutover.
- The cutover removes the 82 maintained Python entrypoints, retains the locked 986-scenario mapping fixture, and exposes Bun/TypeScript replacements plus domain test scripts.

## Replacements / Background

- The topic replaces project-owned Python script execution with Bun + TypeScript while retaining existing Node/npm support for reg-cli.
- The initial contract is paired with `docs/adr/0033-bun-typescript-script-runtime.md`.

## Related Changes

- Child cutover branch: `th/bun-typescript-scripts-cutover`.
- Parent integration remains the responsibility of the `bun-migration` batch; no parent merge is performed by this task.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
