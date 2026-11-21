# Direct delivery invariants

Detail for the `Invariants` section of the workflow Skill. Each rule is owned here; the Skill keeps only the summary.

## Write ownership

`main-agent` is the sole file writer in a direct flow (`main-agent` 是唯一修复者). Sidecars inspect CI, review, Spec, or Solution state; the Release Tracker's only permitted mutation is the explicitly authorized safe rerun defined by its shared contract.

## Evidence placement

Freeze tracked source, tests, contracts, and docs before final validation. Keep current-SHA results in active flow evidence or SHA-bound external artifacts; result collection leaves the candidate unchanged and starts no review wave. Prepare repository-required tracked records before freeze, naming the implementation/run described. Real repairs invalidate affected evidence; required CI passes on the live PR head.

## Release route and decision card

Before the first PR publication mutation, derive the runtime `pre_merge_release_route` from current repository and PR facts. An explicit valid repository contract or adopted project-local Policy Skill may expose managed release-label groups. An absent, unsupported, or non-applicable contract resolves to `no-managed-route` with an empty managed-label set; publication continues and the generic flow does not ask the owner to classify the route.

Pre-merge route evidence is routing input only. It does not establish `release_expected`, a version, a release tag, or publication. Step 6 keeps its merge-SHA-bound release contract as the sole source of actual release facts.

At Step 5C for `merge-ready`, `merge-only`, and `merge+cleanup`, return a decision card covering publish applicability, components, channel, bump rule, predicted version, target identity, and policy source. `merge-ready` may stop after displaying the card; `merge-only` and `merge+cleanup` require explicit owner confirmation including the version expectation before merge continuation. One clear natural-language owner message may provide that confirmation and the continuation request together; callers must not require a fixed reply format or a second action turn. Missing or conflicting policy/facts are `unknown`/blocked; `no-managed-route` is not a no-release decision.

## Phase-aware acceptance

`pre_merge` consumes only Candidate/PR-head evidence; `post_merge` requires a real Merge Receipt and its `merge_sha`; `post_deploy` additionally requires a structured `deployment_identity` whose source and bound SHA match that merge SHA. Review Readiness, PR convergence, and Step 5C consume only `pre_merge` items.

`merge-ready / Step 5C Ready` is a pre-merge stop, never Flow Complete. `merge-only` enters post-merge processing only after owner confirmation and an actual Merge Receipt. Missing publish facts or deployment identity is an owner-action blocker; it is not inferred as `not_required`.

## Review tier and readiness

A direct flow records an Agent-chosen Tier 1..4 necessity assessment and concise rationale in its current review evidence before PR convergence or terminal local-merge completion. There is no automatic task-category rubric. Tier 1 has no review gate; Tier 2 permits optional advisory review; Tier 3 and Tier 4 require clear evidence produced by read-only sub-agents. Plans supply runtime guidance, not a reviewer schedule.

Review readiness requires approved behavior, acceptance, scope, and required contracts settled, no unresolved design decision, and current-candidate validation plus applicable visual evidence. The initial Tier 3/4 coverage is created fresh for the ready Candidate; later Repair Batches refresh comprehensive review and refresh specialists according to proven impact.

Recommended request profiles, repository formal-review request, parent-owned requested profile, runtime-owned errors, and refresh rules belong to `review-proof-short-contract.md`; consult it at readiness. Review output contains content evidence only; the parent request is the sole profile record.

## Repair threshold

A formal review wave must reach terminal structured results for every required lane before the main Agent writes the candidate. Before the first wave, freeze a Scope Envelope; before each Repair Batch write, freeze a Repair Manifest. Only an eligible current-PR `In-Scope Review Finding` mapped to that envelope and manifest and meeting the priority-aware threshold enters one root-cause Repair Batch. An unmapped or out-of-envelope change is Scope-Returning and stops convergence. A low-priority finding may be recorded as `repair_not_required_low_priority` and accompany a clear review without blocking delivery. An authorized late deferral follows the contract's Late PR resolution and Authorized follow-up delivery rules. A `Design-Returning Review Finding` returns to design before a changed candidate is reviewed, and a `Review Observation` is report-only.

The initial wave permits an optional P2-only repair. From the second wave onward, a low-priority P2 may enter a Repair Batch only with an eligible P0/P1 finding or a qualifying current-Candidate CI failure; P3 and lower findings stay non-blocking. A qualifying CI failure is attributable to in-scope code, tests, or configuration. CI infrastructure failure, flakiness, cancellation, timeout, missing results, and other unavailable evidence remain CI/evidence blockers and do not authorize opportunistic repair. Report accepted low-priority findings at the next owner-facing stop. Safety boundaries, required acceptance, and `Design-Returning` findings keep their hard gates regardless of priority.

## Empirical acceptance

When a direct plan declares `empirical_acceptance=required`, the current Candidate must carry a passed, SHA/contract/scenario-bound evidence card from `references/empirical-acceptance-short-contract.md` before local readiness, formal review, Step 5C, or Step 5L. A missing, stale, failed, or unavailable card blocks the gate without creating a Repair Batch. An empirical failure after a comparable pass is diagnosis-only.
