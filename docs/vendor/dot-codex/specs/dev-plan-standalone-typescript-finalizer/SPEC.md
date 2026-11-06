# Dev-plan Standalone TypeScript Finalizer

## Context and Scope

This topic defines the standalone `$dev-plan` validation and owner-review boundary, including its TypeScript migration and trusted launcher. It does not define runtime task orchestration, ledgers, task conversations, dashboards, or `$multi-task-flow` behavior.

## Terms and Interfaces

- `Dev-plan finalizer`: the single public operation that validates a canonical raw plan and emits either a compliant transient projection or a rejection.
- `Security launcher`: the minimal pre-main launcher that removes unsafe Bun and Node preload environment variables before executing the TypeScript finalizer.
- `Runtime orchestration`: an independent execution capability such as `$multi-task-flow`; it is outside the dev-plan boundary.

## Requirements

### REQ-DPF-001

The explicit `$dev-plan` route MUST use only its own checker, parser, projection and finalizer. A successful finalization MUST terminate the dev-plan route after emitting one transient `<proposed_plan>`.

### REQ-DPF-002

The finalizer MUST return exactly one machine result: `pass` with the owner-facing projection or `reject` with stable findings and no compliant projection. The projection MUST be derived from the same canonical facts that passed raw-plan validation.

### REQ-DPF-003

The dev-plan implementation MUST NOT invoke, import, route to, or exchange machine-readable fields with `$multi-task-flow` or any other runtime coordinator. It MUST NOT create or modify a runtime ledger, task conversation, dashboard state, handoff envelope or execution digest.

### REQ-DPF-004

Checker, parser, projection and finalizer logic MUST be maintained in TypeScript under the pinned Bun runtime. The old shell implementations MUST be removed rather than retained as alternate business-logic paths.

### REQ-DPF-005

The trusted launcher MAY remain a shell script only as a security boundary. It MUST clear `BUN_OPTIONS` and `NODE_OPTIONS`, forward arguments and stdin unchanged, execute the TypeScript finalizer, and forward its exit status. It MUST contain no plan parsing or validation logic.

### REQ-DPF-006

The canonical finalizer interface MUST support file and stdin input, preserve stable diagnostics and exit semantics, and produce no persistent plan or runtime artifact.

### REQ-DPF-007

The checker MUST continue to enforce the complete dev-plan contract, including required sections, locked flow decision fields, task orchestration structure, wave/task syntax, acceptance coverage and projection completeness.

### REQ-DPF-008

Tests MUST prove the TypeScript finalizer rejects malformed plans, emits one projection for valid plans, remains independent from `$multi-task-flow`, and preserves hostile-environment launcher behavior.

## Verification

### VER-DPF-001

- Method: TypeScript unit and fixture tests for canonical parsing, raw-plan validation and projection validation.
- covers: `REQ-DPF-001`, `REQ-DPF-002`, `REQ-DPF-006`, `REQ-DPF-007`
- Pass condition: Invalid flow decisions, missing waves, malformed tasks and incomplete acceptance are rejected; valid plans produce one compliant transient projection.

### VER-DPF-002

- Method: Repository reference scan and isolated integration tests.
- covers: `REQ-DPF-003`
- Pass condition: The dev-plan package has no active multi-task-flow imports, handoff fields, ledger writes or runtime coordinator calls.

### VER-DPF-003

- Method: Bun launcher tests with hostile `BUN_OPTIONS` and `NODE_OPTIONS`, argument/stdin forwarding and exit-code checks.
- covers: `REQ-DPF-004`, `REQ-DPF-005`
- Pass condition: Only the TypeScript implementation executes, preload injection is prevented, and launcher behavior is transparent.

### VER-DPF-004

- Method: Bun regression suite covering malformed plans, valid projection count, forbidden runtime references and launcher behavior.
- covers: `REQ-DPF-008`
- Pass condition: The migrated TypeScript path rejects invalid plans, emits exactly one projection for valid input, remains independent from `$multi-task-flow`, and preserves the security launcher contract.

## Related ADRs

- [0032: One Finalization Gate for Dev-Plan Owner Review](../../adr/0032-dev-plan-single-finalization-gate.md)
- [0033: Bun + TypeScript Script Runtime](../../adr/0033-bun-typescript-script-runtime.md)
- [0034: Trusted Bun CLI Launch Boundary](../../adr/0034-bun-cli-launch-boundary.md)
- [0040: Keep Dev-plan Standalone and Move Its Implementation to TypeScript](../../adr/0040-dev-plan-standalone-typescript-finalizer.md)
