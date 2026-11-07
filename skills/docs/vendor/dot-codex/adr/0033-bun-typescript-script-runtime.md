# ADR 0033: Bun + TypeScript Script Runtime

- Status: Accepted
- Date: 2026-10-27
- Related: `docs/specs/bun-typescript-scripts/SPEC.md`, `docs/adr/0022-sandboxed-reg-cli-report-execution.md`, `docs/adr/0029-wave-thread-delivery-batches.md`

## Context

The repository maintains a large set of Python command-line helpers, tests, and shell wrappers. The scripts are mostly standard-library code but include shared state formats, POSIX locks, process supervision, secure path handling, image comparison, and macOS sandboxed report generation. A runtime replacement can improve consistency and startup behavior only when those contracts are preserved and measured.

The migration also needs a test runner that supports focused domain execution without adding a second JavaScript test framework. Long files have made ownership and review harder, so the replacement needs a physical-line policy that forces responsibility-based module boundaries.

## Decision

- Use Bun 1.4.4 and TypeScript as the maintained script runtime, with strict compiler settings, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`.
- Use Bun's built-in `bun:test` runner. Expose `test:core`, `test:hosting`, `test:plan`, `test:flow`, `test:workspace`, `test:docs`, `test:visual`, `test:waves`, `test:checks`, `test:multi-task`, and `test:all`; platform-specific tests remain explicit and a skip is not a pass.
- Keep existing CLI directories and basenames, replacing `.py` with `.ts`. Shell wrappers may remain only as thin Bun forwarders that preserve arguments, stdin, and exit codes.
- Split shared behavior into typed modules and keep each handwritten TypeScript source file at or below 400 physical lines and each TypeScript test file at or below 600 physical lines, counting blank and comment lines. Formatting runs before the line counter, and no ignore or compression bypass is allowed.
- Preserve CLI diagnostics, machine output, state schemas, canonical JSON hashes, lock paths, atomic write order, historical JSONL parsing, and replay behavior. Existing runtime state is read and written through compatible formats without an in-place migration.
- Isolate `flock`, no-follow directory-descriptor reads, and macOS `clonefile` behind a small POSIX adapter. Use `bun:ffi` only at that boundary; missing capabilities fail explicitly and no unsafe realpath/open fallback is permitted. The experimental and platform-specific nature of this boundary is part of the contract.
- Use `sharp@0.35.5` for image decoding and encoding while preserving comparison and trim semantics. Keep the existing pinned `reg-cli@0.18.16`, Node/npm lockfile, two-stage sandbox, and publication isolation unchanged.
- Keep Python only as a read-only comparison implementation during the four-wave migration. Delete maintained Python sources and executable Python references only in the final cutover after compatibility evidence is complete.

## Alternatives Considered

- Keep Python and add Bun wrappers: rejected because it preserves the second runtime and does not make domain tests or module ownership consistent.
- Add Jest or Vitest: rejected because Bun already supplies the required test runner and an extra framework would add dependency and configuration surface.
- Replace native operations with portable but weaker filesystem fallbacks: rejected because path replacement, lock release, and sandbox boundaries are security and correctness contracts.
- Promise a fixed speedup: rejected because startup and workload performance must be measured on the same isolated environment and reported with p50, p95, RSS, and causes.

## Consequences

- The project has one maintained scripting runtime and one test command family, but migration requires a large compatibility fixture and explicit native validation.
- Bun FFI and sharp introduce platform/runtime boundaries that must be checked in the Agent VM and on macOS; unsupported capability is a visible failure.
- The physical-line policy creates more modules and review surfaces, while keeping files bounded and responsibilities clear.
- Node/npm remains a deliberate exception for the existing reg-cli sandbox, so “no project Python” does not mean “no other runtimes anywhere.”

## Verification

- `docs/specs/bun-typescript-scripts/SPEC.md` remains the normative behavior contract.
- `bun run check:source`, `bun check`, `bun fmt --check`, the domain test commands, Linux VM native scenarios, macOS smoke tests, and the same-input Python/Bun performance report are required before the parent reaches Step 5C.
