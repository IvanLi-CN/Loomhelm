# ADR 0017: Review Readiness And Runtime Launch

- Status: accepted
- Date: 2026-09-14

## Context

Direct Tier 3/4 plans had begun to describe formal review as a fixed set of named sub-agents and model profiles. That made a plan look like an execution schedule, encouraged reuse of terminal reviewers, and obscured the fact that a candidate may not be reviewable until its behavior, acceptance, scope, contracts, validation, and applicable visual evidence are settled.

Repair batches also need a precise boundary. Re-running every conceptual lane after every small repair wastes review capacity, while retaining evidence after a shared-contract or high-risk change can miss a regression.

## Decision

1. Review Readiness is a hard gate for formal review. Approved behavior and acceptance, scope, and required contracts must be stable; no design decision may remain unresolved; and the current Candidate must have completed applicable validation and visual evidence. If the gate is not satisfied, the flow returns to the design or evidence gate and does not launch formal lanes.
2. Direct Tier 3/4 plans and new Wave Thread v2 plans that reach Step 5C record only the Tier, rationale, runtime launch strategy, and a supported profile recommendation. Task Orchestration must not name formal reviewer agents, lanes, or actual reviewer profiles. Wave Thread v2 uses the same shared Review Readiness and fresh-lane launch boundary; its task dispatch profile lock remains independent from formal review lane selection. Non-formal read-only analysis sidecars remain allowed.
3. Once readiness is true, the runtime creates fresh formal reviewers for the current Candidate. Tier 3 starts with its four conceptual required lanes; Tier 4 adds one or two selected dynamic lanes. These conceptual lanes do not define a fixed reviewer count for every later Repair Batch. Every changed Candidate uses a fresh `fork_turns=none` reviewer, and a terminal reviewer is retired.
4. A Repair Batch refreshes only lanes proven affected by the current Git delta. Unknown scope, shared-contract changes, security/schema/transaction/ protocol/concurrency/persistence/migration changes, high-risk changes, or base drift refresh every required lane. Retained results are valid only in the same active convergence run while their source base/head, scope, and delta remain inspectable.
5. A `Design-Returning Review Finding` returns to design and cannot enter the ordinary repair loop. `Review Observation` is report-only, and missing, stale, malformed, or unavailable evidence remains `unchecked`. A complete clear terminal result may contain a blocking finding; it remains review evidence and follows the disposition rules.
6. The launch boundary is stage-aware. For a direct PR, `Step 4 Ready` records Review Readiness and applicable pre-PR proof without requiring completed PR-stage findings or dispositions; after exact live PR base/head binding, fresh PR-stage formal review starts in parallel with CI, and the main Agent waits for both terminal states before convergence. No disposition, write, or Repair Batch may occur while either track is live. Local-merge formal review remains complete before `Step 5L`.

## Consequences

- Runtime evidence reflects the actual host-supported model/effort pair without making a plan promise an unavailable model or effort.
- Formal review launches happen only for a reviewable candidate, and each changed candidate has an unambiguous reviewer lifecycle.
- Direct PR review evidence is created at the live PR binding boundary, so `Step 4 Ready` remains a readiness handoff while CI and PR-stage review can share the first live round.
- Small, proven-local repairs avoid unnecessary lane work; broad or uncertain changes retain the complete required coverage.
- The plan checker can reject formal predeclaration without rejecting ordinary read-only sidecars.

## Alternatives Rejected

- Predeclaring four named sub-agents in every plan: rejected because it couples planning to runtime capacity and prevents independent fresh launches.
- Reusing terminal reviewers for later candidates: rejected because the result is bound to the prior candidate head.
- Refreshing only one lane for unknown or shared-contract changes: rejected because affected scope cannot be demonstrated safely.

## Related Specs

- [Local Review Necessity And Evidence](../specs/mandatory-local-review-proof/SPEC.md)
- [PR convergence batching](../specs/pr-convergence-batching/SPEC.md)
- [Workflow Agent Model Selection](../specs/workflow-agent-model-selection/SPEC.md)
