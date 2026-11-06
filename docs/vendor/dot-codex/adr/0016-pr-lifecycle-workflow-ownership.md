---
status: accepted
---

# PR Lifecycle Workflow Ownership

## Context

This ADR remains scoped to direct delivery, Initiative promotion, and visual evidence. Wave Thread delivery batches are governed by ADR 0029 and the wave-thread-flow SPEC. These paths all need PR publication and merge operations, but their authorization and state machines are different. Separate PR Skills duplicated shared workflow gates and made the public Skill index expose multiple competing lifecycle entrypoints.

## Decision

- `$project-engineering-workflow` owns the direct PR lifecycle: Step 5 publication/convergence and Step 6 merge/post-merge progression.
- Mechanical publication and guarded merge operations live in workflow references and workflow-owned scripts. They accept a standard operation envelope and return live facts; they do not grant authorization or decide Initiative role legality.
- `$initiative-flow` owns child/checkpoint/aggregate topology for the legacy Initiative flow, role-specific preconditions, exact-SHA approvals, integration CI, promotion, and closeout.
- `$ui-visual-evidence` owns the Phase A/B PR body image gate, because its inputs and validation are the Task Evidence Set and managed visual section.
- The former `pr-create`, `pr-merge`, and `github-pr-body-images` public Skill entries are retired without compatibility shells. Historical Specs and replay fixtures remain readable; active instructions route to the canonical owners.

## Consequences

Workflow stages have one direct PR entrypoint while the legacy role-specific flows retain their own state machines. Phase A/B image publication remains available to the workflow and Initiative callers without exposing a second lifecycle. Static and replay checks must validate canonical owner routes and preserve legacy fixture parsing without allowing legacy routes in active instructions.

## Related Specs

- [Agent Instruction Architecture](../specs/agent-instruction-architecture/SPEC.md)
- [Shared UI Visual Evidence Gate](../specs/shared-ui-visual-evidence-gate/SPEC.md)
- [Initiative Delivery Flow](../specs/initiative-flow/SPEC.md)
