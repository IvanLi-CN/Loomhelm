# ADR 0029: Wave Thread Four-Level Delivery Batches

- Status: Accepted for historical compatibility; superseded for active routing
- Superseded for active routing by: `docs/adr/0037-dev-plan-multi-task-flow-routing.md`
- Supersedes: `docs/adr/0028-wave-thread-coordinator.md`
- Date: 2026-10-24

## Context

This ADR applies only to the retired `wave-thread` coordinator and its read-only compatibility inputs. It does not govern the active `multi-task-flow` route, whose runtime ledger decision is recorded in ADR 0037.

The original Wave Thread contract described parent and task conversations plus waves, but it did not name the unit that owns one final merge. That ambiguity made a single parent PR look like one PR per wave and did not define how several independent main-branch merges should be represented. Event and acceptance evidence also lacked an explicit batch scope and lifecycle phase.

## Decision

Adopt the stable hierarchy Plan -> Delivery Batch -> Development Wave -> Task. The Plan owns one coordination conversation. A Delivery Batch owns one final main-branch merge, its parent branch/PR when using parent-child topology, its SHA lineage, milestones, release facts, and resource closeout. A Development Wave is a consecutive scheduling round inside a batch. A Task owns one isolated worktree, one implementation branch, one declared surface, one native task identity, and one implementation PR.

Use one parent-child batch with one parent PR by default, even when the batch needs multiple waves. Create multiple batches only when separate main-branch merges are required. The direct topology is reserved for one wave with one task; its implementation PR is the final PR to the target branch and there is no parent PR. Sibling PRs always target their owning batch parent branch; child PR chains, PR identity reuse, and stacked metadata are invalid.

Represent the model in schema version 2. Task events use `wave-thread/v2` with stable `event_id`, `plan_id`, `batch_id`, and scope. Batch events carry release and milestone facts without a fabricated task. Same identity and payload is idempotent; conflicting payloads fail transactionally; missing prerequisites are deferred and replayable. v1 input is read-adapted into one `default` batch while preserving source facts and legacy closeout evidence.

Bind dependencies to explicit task or batch milestones. There is no cross-batch global wave barrier. Conditions remain unknown until resolved; an approved false condition records a skip without creating resources. Acceptance evidence names task/batch scope and `pre_merge`, `post_merge`, or `post_deploy` phase. Each v2 batch declares an absolute `observation_window.deadline`; publication, deployment, and observation remain batch facts bound to the merged SHA or a verifiable shared lineage, and recovery cannot reset that deadline.

Acceptance entries are owned by the matching task or batch. Task `pr_ready` consumes the task's pre-merge evidence; final readiness consumes the batch's pre-merge evidence; parent-child finalization additionally requires native child conversation archive receipts. Deadline evaluation records the expired phase, missing evidence, and original absolute deadline without treating timeout as success.

## Consequences

The parent conversation remains the coordination owner for the historical wave-thread route, and that route still contains no runtime coordination ledger. The active `multi-task-flow` route is governed by ADR 0037 and owns one authoritative runtime ledger. Existing v1 plans and manifests remain readable, while new multi-batch plans must use the explicit v2 syntax.
