---
title: Keep Agent Instructions Deep Behind Thin Adapters
module: codex-global-workflow
problem_type: workflow_issue
component: instruction-architecture
tags:
  - agents
  - skills
  - workflow
  - maintainability
status: active
related_specs:
  - docs/specs/agent-instruction-architecture/SPEC.md
resolution_type: architecture
---

# Keep Agent Instructions Deep Behind Thin Adapters

## Context

Agent repositories often accumulate the same safety rule, stage procedure, and status vocabulary in global instructions and several entry Skills. Larger models can follow long text, but duplication still creates conflicting authority, partial-read failures, and expensive persistent context.

## Symptoms

- A policy change requires editing many entrypoints.
- Similar flows accidentally inherit each other's authorization.
- Global instructions contain phase-specific recipes that most tasks never use.
- Status placeholders grow even when a gate is irrelevant.
- Compatibility aliases remain public long after migration.

## Resolution

Use three layers:

1. Keep only cross-task risk invariants and routing in global instructions.
2. Put shared stage semantics behind one deep module with a small input/output contract and progressively disclosed references.
3. Keep public flow entrypoints thin: trigger, authorization difference, stop condition, and delegation to the deep module.

Quality gates should be relevance-driven. A visual, documentation, or release contract is stronger when it runs exactly where its subject exists than when every task emits an unchecked placeholder.

When retiring an interface, remove it from active indexes and routes. Move any genuinely required historical repair capability under the canonical migration owner rather than preserving another public shim.

## Guardrails

- Never compress away authorization, irreversible-action, privacy, credential, or remote-communication protections.
- Keep distinct entrypoints when they grant materially different authority.
- Centralization is incomplete until active references and tests point to the new owner.
- Enforce byte/line budgets with static checks, but validate observable behavior with scenario replay; compression alone is not correctness.
- Replay assertions should target selected route, required confirmation, stop state, evidence, and forbidden action, not model wording.

## References

- `docs/specs/agent-instruction-architecture/SPEC.md`
- `skills/project-engineering-workflow/SKILL.md`
- `bin/instruction_architecture_check.py`
- `bin/instruction_behavior_replay.py`
