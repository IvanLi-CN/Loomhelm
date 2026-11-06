# Bun + TypeScript Project Scripts 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、当前状态、剩余缺口与 rollout 事实。

## Current Status

- Implementation: Cutover complete for the project-owned `bin/` and `skills/` script surface.
- Lifecycle: active
- Catalog note: The child cutover preserves the locked compatibility inventory and hands parent-branch integration to the `bun-migration` batch.

## Implementation Coverage

- Requirement coverage: The cutover implements the Bun/TypeScript entrypoint, compatibility adapter, domain test, source-policy, and active documentation portions of `REQ-BUN-SCRIPTS-001` through `REQ-BUN-SCRIPTS-004` and `REQ-BUN-SCRIPTS-006`.
- Verification commands: `bun run test:<domain>`, `bun run test:all`, `bun run check:source`, `bun check`, `bun fmt --check`, and `bun run validate` are defined in `package.json`.
- Platform-specific native suites are explicit: use `bun run test:native:core`, `bun run test:native:visual`, or `bun run test:native`; they are intentionally excluded from `test:all` and `validate`.
- `.github/workflows/bun-native-macos.yml` provides a manual-only macOS runner for the explicit native suites; it has no push or pull-request trigger and therefore cannot add a default test gate.
- Profile runtime state defaults canonicalize the operating system temporary parent before entering the strict native lock adapter; `bin/tests/flow/profile.test.ts` covers the macOS temporary-path alias regression.
- Rollout facts: The 82 maintained Python files are removed. The locked mapping fixture remains as historical compatibility evidence and records 986 scenarios; no active runtime state is migrated in place.

## Coverage / rollout summary

- Baseline: 82 project-owned Python files and 986 recorded test scenarios at the locked development baseline.
- Domains covered by the Bun suite: core, plan, flow, workspace, docs, visual, waves, and checks.
- Native evidence: Linux Agent VM checks and the same-input Python/Bun performance comparison are retained as historical candidate evidence. macOS-only native scenarios are complete for the current functional candidate through the manual GitHub Actions workflow; the default validation path remains native-free.

## Remaining Gaps

- The Linux performance report records 30 serial runs for cold start, plan parsing, and replay with p50, p95, and peak RSS. The macOS native report is bound to the functional candidate in `VALIDATION.md` and the linked workflow artifact.
- Historical mapping and replay records still contain `.py` source names by design; maintained executable paths and active Skill command examples use `.ts` and `bun`.

## Related Changes

- Child branch: `th/bun-typescript-scripts-cutover`.
- Acceptance: `task:cutover(A9)` with support for `A10` through `A13`.

## References

- `./SPEC.md`
- `./HISTORY.md`
