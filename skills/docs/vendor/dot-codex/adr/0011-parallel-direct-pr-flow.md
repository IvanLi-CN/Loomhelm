---
status: accepted
---

# Parallel Direct PR Flow

Purely independent repository slices may be delivered as a bounded cohort of 2..8 direct PR tasks. The cohort is coordinated by native Codex task Worktrees and milestone messages, while each task retains the existing `PR_ROLE=direct` and `$fast-flow` responsibilities.

## Decision

`parallel-pr` is a top-level coordinator flow when every task starts from one exact base, owns a disjoint surface, consumes named contracts without creating dependencies, and declares its merge mode. The parent creates tasks and receives milestones; it does not create Tickets, a tracking Issue, an integration branch, aggregate artifacts, or a persistent ledger.

Shared integration, dependency, topology freezing, or aggregate acceptance remains owned by `$initiative-flow`. A task that discovers one of those facts pauses and is rerouted rather than widening its surface silently.

## Merge boundary

`ready-only` is the default and stops at `Step 5C Ready`. `merge-on-green` is allowed only for a frozen named task after current PR metadata and current-head preflight prove that the repository can safely serialize merge and release work. The workflow PR merge procedure may downgrade to ready-only when those facts are absent.

## Consequences

- Cohort recovery uses durable task titles and PR metadata rather than a new cross-cohort ledger.
- One failed or blocked task does not cancel unrelated direct PRs.
- The flow reduces parent token cost after implementation starts, at the cost of requiring explicit scope and metadata reporting.

Related specification: [parallel-pr-flow](../specs/parallel-pr-flow/SPEC.md).
