---
status: accepted
---

# Initiative Child Integration Uses Branch-Push CI

Child integration and final PR validation establish different facts. Child integration proves the exact merge on `prd/<topic>` and unlocks the next Initiative state; final PR validation proves the final promotion candidate.

## Decision

- Initiative uses one named `branch-push` check for Bootstrap activation and every child integration result.
- Evidence binds the integration branch, exact SHA, named check, `push` event, and run ID.
- Bootstrap activation uses `development_base` when the Spec is reused; when Bootstrap changes the Spec, it uses the committed Bootstrap SHA.
- Final PR checks remain final-promotion evidence. They cannot activate an Initiative, close a Ticket, or unlock a dependency.

## Consequences

- A Bootstrap cannot publish external topology until the required check has passed and the integration branch still points to that SHA.
- Repositories need one qualifying `prd/**` branch-push check. The flow does not manufacture an alternate CI path.
- Runtime validation and replay reject CI evidence that does not carry the exact branch, SHA, check, event, and run identity.

## Related Specs

- [Initiative flow](../specs/initiative-flow/SPEC.md)
