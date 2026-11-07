---
status: accepted
---

# Direct PR Merge Preflight

## Context

Direct PR merge authorization should identify the PR the owner approved, while the exact commit being merged is a live remote fact. Requiring the owner to copy or repeat a SHA adds friction without proving that the candidate worktree still represents that PR head. An unguarded merge also leaves a race between the final inspection and the GitHub merge action.

## Decision

- Add `skills/pr-merge/scripts/merge_preflight.py` as a narrow, read-only check of live PR head/base, candidate ref OID, and candidate worktree cleanliness. It reports machine-readable facts and locks the live head only when all required facts are eligible.
- Bind direct merge intent to the explicit PR identity. The Agent passes the preflight receipt's locked head to `gh pr merge --match-head-commit`; stale snapshots, candidate drift, dirty/closed PRs, and unsupported guard capability fail closed.
- Keep CI, review, Spec, visual evidence, release, and child/checkpoint/ aggregate role-specific approval outside this preflight contract.

## Consequences

- Owners authorize the PR without entering or repeating a SHA; the final machine receipt records the exact head used by the guarded merge.
- Same-PR in-scope fixes can continue under the existing merge intent, but must produce a fresh eligible preflight before merge.
- A changed candidate, remote head/base snapshot, closed PR, dirty worktree, or missing `--match-head-commit` support stops the path instead of silently falling back to an unguarded merge.

## Related Specs

- [Fast-track merge intent closeout](../specs/fast-track-merge-intent-closeout/SPEC.md)
