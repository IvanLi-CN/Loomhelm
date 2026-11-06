# Bun + TypeScript Project Scripts

> This file is the durable topic requirements contract. Current implementation facts belong in `IMPLEMENTATION.md`; lifecycle and change references belong in `HISTORY.md`.

## Context and Scope

- Context: Project-maintained Python scripts make the repository depend on a second scripting runtime and keep testing split across bespoke entrypoints.
- In scope: Project-owned command-line scripts, shell wrappers, script tests, shared runtime adapters, and the documented command surface under `bin/`, `skills/`, and repository entrypoints.
- Out of scope: Third-party Python, unrelated projects, existing Node/npm tooling used by reg-cli, and active `CODEX_HOME` deployment.

## Terms and Interfaces

- `script`: A project-owned executable helper or test entrypoint that is currently implemented in Python or embeds Python in a shell wrapper.
- `domain test`: A Bun test command scoped to one migration domain, such as `test:plan` or `test:visual`.
- `compatibility surface`: CLI arguments, exit codes, diagnostics, machine-readable output, persisted state, hashes, locks, historical JSONL, and replay semantics.
- `trusted launch boundary`: A repository-controlled launcher that clears runtime preload environment variables, selects a repository-controlled Bun configuration, and then invokes a sensitive TypeScript CLI.
- Interface: Existing script directory and basename, with `.py` replaced by `.ts`; shell wrappers remain thin argument/stdin/exit-code forwarders.

## Requirements

### REQ-BUN-SCRIPTS-001

- The system MUST provide project-owned script and test entrypoints through Bun and TypeScript without requiring Python at runtime.
- Inputs: Existing CLI arguments, stdin, environment, files, and historical records.
- Outputs: The same documented exit codes, diagnostics, machine output, state schema, and replay behavior unless a separately approved contract changes it.

### REQ-BUN-SCRIPTS-002

- The system MUST preserve the compatibility surface while splitting implementation into typed modules and thin CLI entrypoints.
- Inputs: Existing commands and persisted state, including concurrent and interrupted operations.
- Outputs: Stable hashes, lock paths, atomic write order, path-safety failures, process cleanup, and historical parser behavior.

### REQ-BUN-SCRIPTS-003

- The system MUST use Bun's built-in test runner and expose independently runnable domain commands plus one full-suite command.
- Inputs: Domain fixtures and platform-specific native scenarios.
- Outputs: Domain test results where skipped platform tests are distinguishable from passing tests.

### REQ-BUN-SCRIPTS-004

- Handwritten TypeScript source files MUST be at most 400 physical lines and TypeScript test files MUST be at most 600 physical lines, counting blank and comment lines.
- Inputs: Formatted source and test files in the maintained script surfaces.
- Outputs: A source-policy check that fails closed on an over-limit file and cannot be bypassed with compression or ignore directives.

### REQ-BUN-SCRIPTS-005

- The system MUST isolate narrow native capabilities behind explicit adapters and fail closed when the required platform capability is unavailable.
- Inputs: POSIX locking, no-follow path operations, macOS clonefile, and sandboxed image-report workflows.
- Outputs: Measured native behavior and an auditable platform boundary rather than an unsafe fallback.

### REQ-BUN-SCRIPTS-006

- Sensitive candidate-input CLIs MUST be entered through a trusted launch boundary that clears `BUN_OPTIONS` and `NODE_OPTIONS`, supplies a repository-controlled Bun configuration, and preserves arguments, stdin, and exit codes.
- Direct `bun run <entrypoint>.ts` invocation MAY remain available for development diagnostics, but MUST NOT be treated as a secure interface for untrusted candidate input because Bun can execute preload configuration before TypeScript validation runs.
- Inputs: Candidate files, command-line arguments, stdin, environment, and the repository-controlled launcher configuration.
- Outputs: The same CLI compatibility surface after the launch boundary is established, with preload execution outside the candidate-controlled environment excluded.

## Verification

### VER-BUN-SCRIPTS-001

- Method: Run `bun run test:all` and each domain command against the compatibility fixture and migrated test corpus.
- covers: `REQ-BUN-SCRIPTS-001`, `REQ-BUN-SCRIPTS-002`, `REQ-BUN-SCRIPTS-003`
- Pass condition: All baseline scenarios have a passing or explicitly equivalent Bun test, and the documented CLI surface runs in an isolated environment without an executable Python dependency.

### VER-BUN-SCRIPTS-002

- Method: Run `bun run check:source`, `bun check`, and `bun fmt --check`.
- covers: `REQ-BUN-SCRIPTS-004`
- Pass condition: No maintained source or test file exceeds its physical-line limit and strict type/format checks pass.

### VER-BUN-SCRIPTS-003

- Method: Execute Linux VM and macOS native scenarios for lock contention, interruption, path replacement, sandboxed report generation, and source-hash revalidation.
- covers: `REQ-BUN-SCRIPTS-005`
- Pass condition: Mutual exclusion, release, traversal rejection, sandbox scope, and hash invariants are observed and recorded for the candidate.

### VER-BUN-SCRIPTS-004

- Method: Invoke every sensitive candidate-input CLI through its repository-controlled launcher with hostile `BUN_OPTIONS` and `NODE_OPTIONS` values, then compare arguments, stdin, exit codes, and diagnostics with a clean environment.
- covers: `REQ-BUN-SCRIPTS-006`
- Pass condition: Preload hooks do not execute, the controlled Bun configuration is used, and direct TypeScript invocation is documented as a development-only path.

## Related ADRs

- [ADR 0033: Bun + TypeScript Script Runtime](../../adr/0033-bun-typescript-script-runtime.md)
- [ADR 0034: Trusted Bun CLI Launch Boundary](../../adr/0034-bun-cli-launch-boundary.md)

## Visual Evidence

- None

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
