# Topic-level Spec model

## Context and Scope

This topic defines the durable `docs/specs/<slug>/` model for long-lived requirements and boundaries. It applies to new or intentionally modified canonical Specs; untouched legacy and external documents remain readable compatibility inputs.

## Terms and Interfaces

- `SPEC.md`: normative topic requirements and verification contract.
- `IMPLEMENTATION.md`: implementation coverage, current status, rollout facts, and commands.
- `HISTORY.md`: lifecycle, compatibility, ADR background, and PR/commit/review associations.
- Interface: the three-file directory plus optional contracts and normative owner-facing visual assets.

## Requirements

### REQ-SPECMODEL-001

Every new canonical topic MUST provide `SPEC.md`, `IMPLEMENTATION.md`, and `HISTORY.md`; the topic directory MUST use a stable lowercase kebab-case slug.

### REQ-SPECMODEL-002

`SPEC.md` MUST contain stable `REQ-*` requirements, stable `VER-*` verification entries, explicit normative boundaries, and a `## Related ADRs` section that is a bare `None` line or path-sorted links to current ADRs. Each requirement MUST be covered by at least one `VER-*` entry.

### REQ-SPECMODEL-003

`SPEC.md` MUST NOT contain task state, execution orchestration, PR/change lists, test command lists, checkbox progress, or unresolved business questions. Workflow topics MAY describe PR and Phase behavior when it is part of the normative contract.

### REQ-SPECMODEL-004

Implementation status, rollout detail, verification commands, and remaining gaps MUST be recorded in `IMPLEMENTATION.md`; topic-local lifecycle, replacement, compatibility, ADR background, and PR/commit/review references MUST be recorded in `HISTORY.md`.

### REQ-SPECMODEL-005

`Visual Evidence` in `SPEC.md`, when present, MUST contain only normative owner-facing assets. A Task Evidence Set and PR image selection MUST remain ephemeral workflow inputs owned by the visual evidence and PR skills.

## Verification

### VER-SPECMODEL-001

- Method: `python3 bin/spec_contract_check.py --path docs/specs/<slug>/SPEC.md`, `skills/spec-sync/scripts/spec_drift_check.sh`, and the Initiative ADR contract guard.
- covers: `REQ-SPECMODEL-001`, `REQ-SPECMODEL-002`, `REQ-SPECMODEL-003`
- Pass condition: canonical structure, REQ/VER traceability, bare `None` or canonical Related ADR links, and forbidden task-state boundaries are validated consistently.

### VER-SPECMODEL-002

- Method: companion-doc inspection and `skills/spec-sync/scripts/spec_drift_check.sh`.
- covers: `REQ-SPECMODEL-004`, `REQ-SPECMODEL-005`
- Pass condition: implementation/change facts are absent from `SPEC.md` and visual workflow assets retain their existing Phase A/B ownership.

## Related ADRs

- [Scope authority and topic Spec boundaries](../../adr/0004-scope-authority-and-topic-spec-boundaries.md)
- [Topic Spec Skill naming and compatibility boundary](../../adr/0005-topic-spec-skill-naming.md)

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
