# PR Publication Procedure

This procedure is the mechanical publication layer for workflow Step 5. The caller owns flow authorization, role legality, applicable contracts, visual comparison, and the Step 5 stop condition. This procedure does not grant any of them.

## Operation Envelope

The caller supplies:

- `mode=publish|draft-bootstrap`;
- `PR_ROLE`, exact repository, target base ref and `expected_base_sha`, current topic head and `expected_head_sha`, and candidate worktree;
- the already-approved publication authorization;
- current validation, Spec/Solutions/Project Docs, the Step 4 readiness and Tier/rationale assessment, and Step 4B visual evidence facts; completed PR-stage formal findings are not required yet for a direct PR path and are created after exact live PR binding;
- the current stop condition and, for a parallel direct task, its frozen cohort/task metadata.

The procedure returns the live PR identity, base/head facts, draft state, managed-body result, image-gate result when applicable, bound candidate SHA, and the next workflow gate or concrete blocker. It does not decide or prove a post-merge release.

## Preconditions

Require a non-default topic head, a committed clean candidate whose OID equals `expected_head_sha`, an exact base whose OID equals `expected_base_sha`, unambiguous repository identity, and no suspicious credential-like content. Derive one current `pre_merge_release_route` immediately before the first remote mutation. An explicit valid target-repository contract or already-adopted project-local Policy Skill may return managed release-label groups. When no applicable route is exposed, return `no-managed-route` with an empty managed label set and continue; do not ask the owner for a route and do not block PR publication. This route result is not the release decision: before a merge continuation, Step 5C separately reads target policy and current PR facts and returns the decision card from `release-planning-short-contract.md`. Dot-codex never invents release labels and preserves post-merge release tracking as a separate contract. The resolver returns one structured route card bound to the current repository and current or pending PR identity: `pre_merge_release_route`, `route_source`, `target_repo`, `target_pr`, `current_repository_facts`, `current_pr_facts`, and `managed_release_labels`. Before an open PR exists, `target_pr` is explicitly `null` and `current_pr_facts` must state that no open PR exists for the exact head/base pair; the card must also carry `target_head` and `target_base` matching those facts. After PR creation or reuse, refresh the card with the positive PR number before any subsequent PR-scoped mutation. `route_source` is `repository-contract`, `project-policy`, or `none`; only the first two may return a non-empty managed-label set. Discovery checks the target checkout's explicit contract first, then a Policy Skill adopted by that target repository, and uses the approved code-hosting adapter for live identity facts. The global Skill catalog is not a target policy source. For a UI candidate, the caller must provide a completed current visual comparison and its explicit Task Evidence Set handoff. A draft bootstrap is feedback-only and may not bind receipt, CI, review, convergence, or merge readiness. CI facts are classified only through `ci-tracking-short-contract.md`. The publication path keeps provider policy observation separate from required-check evidence: `no checks reported` is not a blocker until live facts prove a required gate, while a policy `unknown|unavailable` observation is preserved and cannot be rewritten as either `checks_expected=no` or a failed required check.

## Procedure

1. Fetch live repository and PR facts with the approved code-hosting adapter. Never change remote URLs, upstreams, credentials, or required checks. For an existing PR, apply `pr-diagnosis-short-contract.md` §3 before proceeding.
2. Resolve the current route silently and emit the structured route card. If the route is `no-managed-route`, keep the managed-label set empty. Reconcile labels only when the card has a valid target-owned source and group; preserve unrelated labels and report policy diagnostics without converting them into an owner-supplied route decision.
3. Re-read the candidate and base OIDs immediately before pushing. If either differs from the envelope, return `input_stale` and require a fresh envelope.
4. Push the exact current head using the caller-approved target. Do not create a new branch or alter the current head while publishing.
5. Find an open PR for the exact head/base pair and require its managed delivery role metadata to equal `PR_ROLE`. Reuse one matching PR; create exactly one when none exists; stop if role metadata is absent/mismatched, the identity is ambiguous, or a duplicate would be created.
6. Re-read the live PR head/base after push and before body mutation. Any head or base drift from the envelope is `input_stale`; do not rewrite the body. Reapply the §3 freshness gate before body mutation or convergence launch.
7. Build the managed PR body from the current delivery role, Spec disposition, Solutions, Project Docs, validation, and custom notes. Preserve text between `<!-- CUSTOM_NOTES_START -->` and `<!-- CUSTOM_NOTES_END -->`.
8. When visual evidence applies, call `skills/ui-visual-evidence/scripts/pr_body_image_gate.ts` Phase A with the explicit Task Evidence Set or exclusive `--no-evidence`. Bind URLs to the live head branch and verify the result through the selected platform's rendered Markdown HTML. A new commit on the same branch does not rebind unchanged image paths.
9. Outside `draft-bootstrap`, bind validation and checks to the current PR head SHA, and carry the workflow-owned readiness assessment for the caller's Step 5B/5C gates. After exact live PR base/head binding, the direct PR path starts fresh PR-stage formal evidence in the same first round as required-CI tracking and waits for both to reach terminal state before convergence writes, finding disposition, or a Repair Batch. Apply the shared CI state matrix to the bound facts; exclude manual dispatch, schedule, release, deploy, and unrelated SHA runs, and refresh freshness/conflict before classifying absence. `flow_receipt.ts bind-pr` is only a validation-audit association and does not enforce that assessment or review convergence. This procedure does not invent a second review policy or a second merge review. A `Design-Returning Review Finding` from the caller's formal review lanes stops convergence until the caller resolves the design and refreshes the changed candidate's required lanes.

## Draft Bootstrap

For `mode=draft-bootstrap`, publish or reuse the feedback Draft, record its published SHA and approved-goals fingerprint, then return control to Step 3. Do not report `Step 5C Ready` and do not start required-CI tracking, formal review, receipt binding, or merge work.

## Safety

Every new candidate SHA restarts SHA-bound validation and check binding. A failure caused by unrelated architectural work belongs in a follow-up PR. This procedure never weakens tests, policy, or repository rules to obtain a green result.
