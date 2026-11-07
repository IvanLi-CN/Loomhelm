---
name: normal-flow
description: "Normal delivery flow ending at local can-open-PR handoff."
---

# Normal flow

Use only when the owner explicitly selects `normal`.

## Authorization

- Execute local Step 1-4 from `$project-engineering-workflow` without routine confirmation.
- Local implementation, validation, documentation, and signed-off commits are authorized within scope.
- Push, PR creation, and PR-stage writable convergence are not authorized.

## Stop condition

Stop only at a real blocker or `Step 4 Ready` (`可开 PR（local）`). Before that handoff, record the Agent's Tier 1..4 review necessity assessment and rationale; there is no categorical rubric. At success report the commits, validation, base sync, review tier, and applicable contract evidence, then state that nothing was pushed and no PR was created.

When the plan declares `empirical_acceptance=required`, Step 4 evidence must include a passed card bound to the current Candidate SHA, acceptance contract, and scenario set. A missing or stale card is a blocker, not an inferred pass. An empirical failure after a comparable pass is diagnosis-only and does not open another Repair Batch or formal review wave.

Step 4 and local review consume only `pre_merge` acceptance evidence bound to the Candidate SHA. `post_merge` evidence waits for a real Merge Receipt and `merge_sha`. `post_deploy` evidence also waits for a structured `deployment_identity` whose source and bound SHA match the Merge Receipt SHA. Local readiness is not Flow Complete, and missing post-merge or deployment identity remains an owner-action blocker.

A later generic continuation may enter the shared workflow PR publication procedure for PR setup, but it does not silently grant writable PR convergence. That requires explicit PR convergence/fast-track intent.
