# Local merge closeout

Use `MODE=local-merge` after `$local-merge-flow` completed the local merge and the owner explicitly requested cleanup.

Required facts:

- `base_branch`
- `current_branch`
- `topic_branch`
- `merge_worktree_path` when an isolated merge worktree was used
- `optional_push_status`
- dirty-worktree classification: `clean|preserved_unrelated|skipped_conflict|user_decision_required`

Closeout proof must include:

- `base_branch`
- `current_branch`
- `worktree_clean`
- `topic_branch_present`
- `head_sha`
- `base_head_sha`
- `optional_push_status`
- `dirty_worktree_policy`
- `topic_branch_action`
- `merge_worktree_status`
- `pending_cleanup_action`

Completion requires:

- current branch is the base branch
- topic branch is absent
- merge worktree is not still present
- pending cleanup action is `none`
- dirty worktree policy is either `clean` or `preserved_unrelated`

The local merge caller owns the merge decision and proof freshness. This skill owns branch/worktree/lease cleanup and structured `cleanup_proof`.

Helper scripts:

```bash
GIT_CLEANUP_SKILL_DIR="<path-to-loaded-git-cleanup-skill-dir>"
bun --no-install "$GIT_CLEANUP_SKILL_DIR/scripts/local_merge_closeout_context.ts" --repo-root "<repo>" --base-branch "<base>" ...
bun --no-install "$GIT_CLEANUP_SKILL_DIR/scripts/local_merge_closeout_gate.ts" --input-json '<closeout_context_json>'
```
