# ADR 0040: Keep Dev-plan Standalone and Move Its Implementation to TypeScript

- Status: Accepted
- Supersedes: [0037: Route Multi-task Flow Through Dev-plan](0037-dev-plan-multi-task-flow-routing.md)
- Related: [0032: One Finalization Gate for Dev-plan Owner Review](0032-dev-plan-single-finalization-gate.md), [0033: Bun + TypeScript Script Runtime](0033-bun-typescript-script-runtime.md), [0034: Trusted Bun CLI Launch Boundary](0034-bun-cli-launch-boundary.md)

## Context

`$dev-plan` is a temporary plan validation and owner-review capability. It must not become a runtime coordinator or exchange machine contracts with `$multi-task-flow`. The current routing and handoff design binds the two Skills and lets runtime initialization accept a plan-shaped input without proving that the standalone dev-plan finalizer passed it. The existing Bun launch boundary also requires a trusted pre-main environment scrub for sensitive candidate-input CLIs.

## Decision

`$dev-plan` is a standalone flow. Its only public operation is its own TypeScript finalizer, which runs the canonical dev-plan checker, derives the owner-facing projection from the same parsed facts, and returns exactly one `pass` or `reject` result. A passing result emits one transient `<proposed_plan>` and then stops.

`$dev-plan` MUST NOT invoke, import, route to, or exchange handoff fields with `$multi-task-flow`. It MUST NOT create or update a runtime ledger, task conversation, digest, handoff envelope, dashboard state, or other execution artifact.

`$multi-task-flow` remains an independent Skill with its own input contract and runtime validation. Historical records that contain the old binding remain read-only compatibility data; new runs MUST NOT create a dev-plan binding.

All checker, parser, projection, and finalizer logic moves to TypeScript running under the pinned Bun runtime. A minimal `plan-cli.sh` launcher remains only as the trusted boundary required by ADR 0034: it clears `BUN_OPTIONS` and `NODE_OPTIONS`, forwards arguments and stdin, and `exec`s the TypeScript entrypoint. It contains no dev-plan logic.

The old shell checker and shell finalizer implementations are removed. Documentation and tests use the TypeScript finalizer as the canonical interface, with the launcher treated as a security boundary rather than a second implementation.

## Consequences

The dev-plan contract, checker, projection, and tests have one implementation language and one finalization boundary. Multi-task runtime changes cannot silently alter dev-plan behavior, and a successful dev-plan response cannot start runtime execution. The repository must remove active dev-plan/multi-task handoff references, migrate shell fixtures to TypeScript, and retain hostile-environment coverage for the thin launcher.
