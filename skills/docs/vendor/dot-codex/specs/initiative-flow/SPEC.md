# Initiative Flow

Initiative Flow is the multi-Ticket lifecycle for work that needs a shared integration branch, ordered Waves, native task Worktrees, and one final promotion. It is not a substitute for direct delivery or for `$to-tickets`.

## Related ADRs

- [ADR 与 Topic Spec 的职责分离](../../adr/0001-compose-adrs-with-topic-specs.md)
- [Initiative Child Integration Uses Branch-Push CI](../../adr/0009-initiative-child-integration-ci-boundary.md)
- [Parallel Direct PR Flow](../../adr/0011-parallel-direct-pr-flow.md)
- [PR Lifecycle Workflow Ownership](../../adr/0016-pr-lifecycle-workflow-ownership.md)
- [V5 Bootstrap Integration CI Activation](../../adr/0018-v5-bootstrap-integration-ci-activation.md)

## Scope

Use `initiative` only when at least two Tickets are independently acceptable and independently mergeable, and their delivery requires a shared integration mechanism. Purely independent direct PRs use `parallel-pr`; tightly coupled work uses direct delivery.

Bootstrap establishes the Initiative identity and one immutable execution contract. `$to-tickets` owns Ticket decomposition, owner approval, and Issue bodies. Delivery binds that published topology one-to-one to native task containers. Ticket-local agents use `$implement` and do not re-plan or alter the topology.

## V5 Contract

The only accepted contract has `schema_version=5` and `initiative_contract_version=5`. Bootstrap and Delivery freeze:

- the repository, topic, `prd/<topic>` integration branch, final base, and exact `development_base`;
- `spec_disposition=reuse|refresh|create|supersede`, canonical Spec path, and path-sorted ADR path/blob bindings;
- `integration_ci_surface={kind: branch-push, check: <exact-name>}` and `promotion_policy=final-only|checkpointed`;
- the published topology digest, source SHA, one Delivery task per Ticket, and each Ticket's completion gate.

Bootstrap contains no Ticket tasks. Delivery cannot add, replace, or rename a Ticket. Same-Wave Ticket write scopes cannot overlap; Ticket scopes never own `docs/adr/**`.

## Bootstrap Activation

The first passed named branch-push check activates the Initiative:

- `reuse` supplies passed evidence for `development_base` at `init`.
- `refresh`, `create`, and `supersede` supply JSON `null` at `init`, commit the approved Bootstrap, then record passed evidence for its `bootstrap_sha`.

Activation evidence always binds the exact SHA, current branch head, `prd/<topic>`, check name, `push` event, and run ID. No CI provisioning mode, workflow digest, or alternate activation plan field exists.

Before `spec.status=ready`, the guard permits only Bootstrap work and a same-SHA failed-CI rerun marked `rerun=true`. Tracking Issue creation, topology publication, Delivery binding, and task creation require ready state. Tracking Issue and topology actions recheck that the branch head equals the activated SHA. Child integration CI rechecks the merged SHA against the live branch head; final promotion rechecks that head and requires current PR checks, validation, and review proofs at the same SHA.

## Lifecycle

```text
init -> Spec resolve or bootstrap -> activation -> Tracking Issue
-> approved topology -> Delivery bind -> native tasks -> child integration
-> completion gates -> final promotion -> Tracking Issue close
```

Each external side effect is a guard transaction: `authorize -> tool call -> commit`. The common-dir ledger is an untracked execution receipt, not a product source of truth. GitHub Issues/PRs and Codex task state remain authoritative for their respective facts.

A missing or activation-less ready ledger is rejected. A readable damaged provisional ledger without external topology may only be cancelled; Bootstrap content change or branch drift then requires a fresh Bootstrap. The flow does not adopt drift, reset history, or rewrite branches.

## Ticket Completion And Promotion

Child integration CI is bound to the exact merged integration SHA, named branch-push check, source ref, push event, and run ID. Failed integration blocks dependent work until matching repaired evidence exists. A later Ticket binds the current passed integration frontier.

`integration` Ticket completion closes after matching integration CI. `published` and `observed` completion additionally require their matching promotion evidence. Final PR validation remains a separate proof and cannot substitute for Bootstrap activation or child integration.

The guard records validation, review proof, owner decisions, promotion, release/observation evidence, receipt sealing, retention, and final Tracking Issue close with their current SHA identities.

## Verification

- Contract normalizer and Markdown checker accept only the V5 shape.
- Guard tests cover both activation paths, failed same-SHA rerun, ready-state gating, branch-head drift, cancellation, and ledger rejection.
- Replay fixtures cover V5 Bootstrap and child CI identity failures.
- Static checks keep skill routing and the V5 documentation contract aligned.

## References

- `skills/initiative-flow/SKILL.md`
- `skills/initiative-flow/references/ticket-envelope.md`
- `skills/initiative-flow/scripts/initiative_flow_guard.py`
