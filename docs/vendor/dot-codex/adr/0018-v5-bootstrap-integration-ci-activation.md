---
status: accepted
---

# V5 Bootstrap Integration CI Activation

Initiative Contract v5 is patched directly and is the only supported contract; earlier formats have no compatibility, migration, or recovery path. A provisional ledger permits only Bootstrap work before the first Integration CI: `reuse` activates from a passed exact-SHA branch-push check at `development_base`, while `refresh`, `create`, and `supersede` activate from the same check at their committed Bootstrap SHA. This preserves one named branch-push CI for both activation and later child integration without requiring a workflow to have run before the Bootstrap that introduces it. Only `spec.status=ready` permits external Tracking Issue and topology effects.

## Consequences

- A provisional Initiative cannot publish topology, create Ticket tasks, or recover from a missing ledger. A readable damaged provisional ledger without external topology may only be cancelled before a fresh Bootstrap.
- A failed activation may rerun only at the same initial integration SHA; changing Bootstrap content starts a fresh Bootstrap.
- If the integration branch no longer points to the CI SHA, activation stops. The provisional ledger may be closed as `cancelled`, but adopting that drift as a new base or deleting and recreating the branch is an explicit owner decision; the flow performs neither action automatically.
- The approved Bootstrap plan remains the authority for its one branch and commit. No CI provisioning mode, workflow digest, or additional plan field is introduced.
