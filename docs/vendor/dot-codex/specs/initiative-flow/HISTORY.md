# Initiative Flow Context

The durable boundaries behind this topic are:

- Bootstrap and Delivery are distinct approvals: the former establishes one immutable execution contract; the latter only consumes published topology.
- The initial integration frontier is activated by a single named branch-push check. Its identity is bound to the approved base or committed Bootstrap SHA according to Spec disposition.
- Ticket topology, native task registration, and delivery cannot proceed until that activation is ready and the integration branch still names its SHA.
- The local ledger proves transaction order but never replaces GitHub or Codex as the source of user-facing state.
- Drift is handled by cancellation and a fresh Bootstrap, preserving approved branch history and requiring explicit owner direction for any rewrite.

These constraints keep the lifecycle deterministic while leaving repository specific implementation, validation, and release evidence to the applicable delivery workflow.
