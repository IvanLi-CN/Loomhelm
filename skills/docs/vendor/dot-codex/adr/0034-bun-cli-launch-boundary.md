# ADR 0034: Trusted Bun CLI Launch Boundary

- Status: Accepted
- Date: 2026-10-27
- Related: `docs/specs/bun-typescript-scripts/SPEC.md`, `docs/adr/0033-bun-typescript-script-runtime.md`, `docs/adr/0032-dev-plan-single-finalization-gate.md`

## Context

Bun evaluates configured preload hooks before a TypeScript entrypoint reaches its `main()` function. A candidate-root or input validation routine inside the TypeScript process therefore cannot establish a security boundary when a caller can set `BUN_OPTIONS` or `NODE_OPTIONS`. Direct source execution is useful during development, but it is not sufficient as the secure interface for commands that read or validate candidate plans.

## Decision

- Sensitive candidate-input CLIs MUST be entered through a repository-controlled launcher owned by the corresponding command surface.
- The launcher MUST clear `BUN_OPTIONS` and `NODE_OPTIONS`, select a repository-controlled Bun configuration, and then `exec` the TypeScript entrypoint while forwarding arguments, stdin, and the child exit code.
- The launcher is the trusted boundary. TypeScript validation remains responsible for candidate paths, files, and state after startup, but it is not responsible for preventing pre-main preload execution.
- Direct `bun run <entrypoint>.ts` remains a development and debugging interface only. Documentation and tests MUST distinguish it from the secure launcher path.
- The implementation MUST use a Bun configuration-control mechanism supported by the pinned Bun 1.4.4 runtime. It MUST NOT rely on an undocumented or unavailable `--no-config` flag.

## Alternatives Considered

- Validate `BUN_OPTIONS` and `NODE_OPTIONS` inside TypeScript: rejected because preload code executes before that validation.
- Treat direct `bun run` as secure: rejected because callers can influence pre-main runtime behavior.
- Remove all TypeScript entrypoints and expose only a compiled binary: deferred because it changes the repository's script interface and is outside this migration's compatibility scope.

## Consequences

- Sensitive command documentation gains an explicit launcher path and a development-only direct path.
- A small shell boundary becomes part of the security contract and must remain covered by hostile-environment tests.
- The launcher must track Bun 1.4.4 configuration semantics and fail closed if the controlled configuration cannot be selected.
- This boundary does not change plan schemas, candidate validation rules, state formats, or exit-code compatibility after startup.

## Verification

- Run each sensitive command through its launcher with hostile `BUN_OPTIONS` and `NODE_OPTIONS` values and confirm no preload hook executes.
- Confirm the launcher uses the repository-controlled Bun configuration and forwards stdin, arguments, diagnostics, and exit codes unchanged.
- Keep direct TypeScript invocation tests explicitly labeled as development-only coverage.
