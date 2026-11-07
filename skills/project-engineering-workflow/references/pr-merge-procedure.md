# PR Merge Procedure

This procedure is the mechanical merge layer for workflow Step 6 and for eligible direct or coordinator-owned role envelopes. Historical role envelopes retain their own compatibility topology; the caller owns authorization, role-specific frontier checks, review/validation gates, release applicability, and the terminal flow decision.

## Operation Envelope

The caller supplies:

- `mode=merge|post-merge`;
- `PR_ROLE`, exact repository and PR number, expected base/head SHAs, candidate worktree and local ref;
- the explicit owner or frozen-role merge authorization for the current PR;
- the approved `merge_method=merge|squash|rebase` and `merge-only|merge+cleanup` stop condition;
- the current Step 5C release decision card and explicit owner confirmation including the version expectation. A single clear natural-language owner message may combine this confirmation with the request to continue; the caller must not require a response template or a second action turn;
- current live head/base, required checks, validation, review proof, visual evidence, and role-specific facts when the caller uses a historical role envelope.

The procedure returns the preflight receipt, locked head, terminal PR state, merge SHA, remote-head disposition, base-alignment result, Phase B image result, and post-merge facts needed by the caller.

## Preconditions

For `mode=merge`, require an open PR whose role/base/head match the envelope, whose live base/head OIDs equal `expected_base_sha`/`expected_head_sha`, a clean candidate whose local OID exactly matches the live head, a current CI result classified by `ci-tracking-short-contract.md` (`CI_GREEN`, an authoritative `CI_NOT_EXPECTED`, or a live reducer receipt that keeps policy observation explicitly unresolved without treating that observation alone as a blocker), with provider observation errors kept explicit, complete applicable validation and review proof, and a non-conflicting, non-dirty, non-behind, non-blocked mergeability result. `merge-ready` or `Step 5C Ready` never grants merge authorization. The decision card is not a release receipt; missing or conflicting live required facts or other gates block merge continuation, while a typed policy observation alone does not. For `mode=post-merge`, require the same role/base/head identity on an already merged PR, the recorded pre-merge base/head OIDs equal to `expected_base_sha`/`expected_head_sha`, the exact recorded `merge_sha`, and the caller's post-merge recovery facts. The target base ref may have advanced to the merge commit or later commits; refresh that current ref for alignment instead of comparing it to the pre-merge base. The local candidate may be absent when the caller is only converging remote post-merge facts. If the caller's formal review proof reports a `Design-Returning Review Finding`, stop and return that blocker; do not merge or relaunch review until the caller resolves the design and binds fresh evidence to the changed candidate.

## Merge operation

For `mode=merge`:

1. Reconfirm repository policy and the selected merge method.
2. Run `skills/project-engineering-workflow/scripts/merge_preflight.ts` before final live checks and again after any same-PR in-scope fix. Require `outcome=eligible` and use only its `merge_guard.locked_head` as the command head. Stale input, candidate drift, dirty worktrees, closed PRs, or an unsupported guard stop the path.
3. Validate the approved merge method against the explicit allowlist and execute exactly one guarded direct merge. Bind the command to the envelope's exact repository with `--repo "$REPO"`; a PR number without this binding is not sufficient. Do not accept a repository default or an interactive method prompt:

   ```bash
   bun bin/code_hosting.ts \
     --repo-root "$CANDIDATE_ROOT" --remote "$BASE_REMOTE" pr-merge \
     --number "$PR" --method "$MERGE_METHOD" \
     --expected-base "$LOCKED_BASE" --expected-head "$LOCKED_HEAD"
   ```

   Fail closed if the guard flag is unsupported. A merge-queue enqueue is not a merged terminal state; refresh live facts until the PR is actually merged or a concrete blocker is returned.

4. Fetch the resulting PR state and actual merge commit SHA. If the command outcome is ambiguous, inspect live facts before retrying and never issue a blind duplicate merge. These live merged-PR facts and the actual merge SHA constitute the Merge Receipt for Step 6. Launch target CI tracking and authorized independent release preparation immediately; do not wait for the ledger's terminal post-merge receipt or subsequent merge-scope operations.
5. For a merged UI PR, call `skills/ui-visual-evidence/scripts/pr_body_image_gate.ts` Phase B. It reads only the managed `## Visual Evidence` section, binds URLs to the merge SHA, verifies the selected platform's rendered Markdown HTML, and keeps the existing bounded retry semantics.
6. Resolve the live normalized `head_repository`, `head_ref`, and `is_cross_repository` immediately before remote-head cleanup. Delete only when `head_repository == REPO` and `head_ref` is non-empty, using the exact API ref and repository binding:

   ```bash
   bun bin/code_hosting.ts \
     --repo-root "$CANDIDATE_ROOT" --remote "$BASE_REMOTE" branch-delete \
     --branch "$HEAD_REF"
   ```

   Treat DELETE HTTP `200` or `204` as a successful deletion candidate. Treat DELETE HTTP `404` or `422` as an already-absent candidate because a previous attempt or repository auto-delete may have removed the ref; do not describe those responses as a successful DELETE. Any other DELETE response is a blocker. A delete `404` or delete `422` still requires the bound GET below to prove the final absence; the GET result is authoritative.

   The adapter performs the bound GET and accepts only HTTP `404` after the delete request:

   A verified `404` after DELETE `200/204` records `deleted`; a verified `404` after DELETE `404/422` records `already_absent`. A missing `404` result or any other response is a blocker. Fork, non-owner, protected, or unknown head states are explicit non-deleting terminal dispositions, never permission to guess a remote or ref.

7. Run `skills/project-engineering-workflow/scripts/base_alignment_helper.ts` against the primary worktree and PR base. Apply only its safe tracking-ref or fast-forward plan; dirty, ahead, diverged, and linked-worktree states return an owner decision or blocker.
8. Record the receipt against the actual merge SHA after terminal CI and release facts are available. The caller continues both tracks and selected-flow closeout.

For `mode=post-merge`, do not run `merge_preflight.ts` or `code_hosting.ts pr-merge`; this branch can never issue a second merge. Refresh the already merged PR and recorded `merge_sha`, then perform only the unfinished merge-scope/post-merge operations from the envelope:

1. Run Phase B image finalization when a merged UI PR still needs it.
2. Re-resolve `head_repository`, `head_ref`, and `is_cross_repository`. Delete and verify the exact API ref in that repository through the adapter's bound DELETE plus GET that proves HTTP `404`. DELETE `200/204` records `deleted`; DELETE `404/422` followed by `404` records `already_absent`; any other DELETE response or a non-`404` GET is a blocker. Report a fork, non-owner, protected, or unknown head as an explicit non-deleting disposition. Do not treat deletion as a merge operation.
3. Run `base_alignment_helper.ts` and apply only its safe plan, returning the existing owner-decision/blocker states for dirty, ahead, diverged, or linked worktrees.
4. Record or refresh the receipt against the exact `merge_sha`, then return the target/integration CI and release facts still required by the caller.

## Stop Conditions

`merge-only` leaves local cleanup untouched after merge-scope facts are verified. `merge+cleanup` delegates local cleanup to `$git-cleanup` only after remote-head disposition, base alignment, target/integration CI, and release terminal facts are established. Child PRs return their merge facts to the owning coordinator; the parent PR continues the shared post-merge release contract and its final merge remains owner-controlled.
