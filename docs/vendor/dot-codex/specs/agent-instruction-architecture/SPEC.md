# Agent Instruction Architecture

## Purpose

The repository uses a layered instruction architecture so persistent context contains only cross-task risk policy while detailed workflows remain discoverable on demand.

## Related ADRs

- [ADR 与 Topic Spec 的职责分离](../../adr/0001-compose-adrs-with-topic-specs.md)
- [PR Lifecycle Workflow Ownership](../../adr/0016-pr-lifecycle-workflow-ownership.md)

## Contract

### Global instructions

`AGENTS.md` contains only:

- the compact Koha identity and response defaults;
- authorization, destructive/external-action, privacy, credential, and Git remote-communication protections;
- uncertainty-based research policy;
- short task-to-Skill routing;
- short repository-wide storage and runtime invariants.

It must not duplicate stage procedures, status cards, helper tutorials, or tool-specific recipes owned by Skills.

### Deep shared workflow

`$project-engineering-workflow` is the single shared interface for direct software delivery. Its inputs are `flow_type`, `stop_condition`, and verified live facts. Its outputs are the current stage, first unfinished applicable gate, and terminal/block/handoff state.

Detailed CI, review, release, active-task, diagnosis, and receipt behavior lives in one shared reference or helper per concern and is read only when applicable.

### Thin adapters

- `$normal-flow` authorizes local delivery and stops at local can-open-PR.
- `$fast-flow` authorizes publication and PR convergence to its locked stop.
- `$local-merge-flow` forbids PR/push and stops for local merge approval.
- `$flow-continue` restores an existing lock; it never chooses a new flow.
- `$project-engineering-workflow` owns publication, current-head convergence, guarded merge, and post-merge progression through its phase-specific PR procedures.

Authorization does not transfer between adapters.

### Applicability

Spec, ADR, Solution, Project Docs, visual evidence, and release gates run only when their owning subject is relevant. Inapplicable gates are omitted instead of producing placeholder states.

ADR is the durable record of why a hard-to-reverse, non-obvious architecture or boundary tradeoff was selected; the owning Spec remains the current behavioral contract. An ADR/Spec conflict remains blocked until the active Spec is explicitly reconciled; neither document has automatic precedence.

### Compatibility

New Specs are slug-only. Historical ID repair is an internal `$docs-migrate` capability. Historical documents and replay fixtures may retain legacy tokens for evidence, but active instructions and indexes do not expose retired Skills.

## Quality budgets

- `AGENTS.md` is at most 10 KiB.
- `project-engineering-workflow` is at most 300 lines; PR procedures are disclosed references under that skill.
- The governed workflow instruction surface remains at least 30 percent smaller than its recorded baseline.
- Static checks enforce risk-core presence, adapter isolation, valid references, and retired-entry absence.
- Model replay evaluates observable routing, authorization, stopping, evidence, and prohibited actions twice per case. Risk cases require 100 percent; the complete suite requires at least 90 percent and may not regress below a separately recorded, suite/model-bound pre-change baseline artifact.

## Acceptance

- A local-delivery request cannot silently publish a branch or create a PR.
- Fast-track can publish and converges one owner-facing PR to `Step 5C Ready`.
- Local merge cannot push or create/update/merge a PR.
- Generic continuation restores the existing flow and first unfinished gate.
- Direct Step 2 records the ADR disposition, immutable ADR references, and a ready/blocked resolution alongside the Spec disposition.
- Remote communication changes and external side effects require confirmation.
- UI work triggers visual evidence; non-UI work does not.
- Temporally unstable or materially uncertain facts trigger research; stable repository facts do not require networking.
- Retired public entries have no active index or routing reference.

## References

- `AGENTS.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/project-engineering-workflow/references/`
- `skills/normal-flow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `docs/adr/0001-compose-adrs-with-topic-specs.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/project-engineering-workflow/references/pr-merge-procedure.md`
- `bin/instruction_architecture_check.py`
- `bin/instruction_behavior_replay.py`
