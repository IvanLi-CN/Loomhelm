# Fast-track merge intent closeout 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Delivery role coverage: `direct|child|aggregate` 已在 fast-flow、PR create/merge 与 initiative handoff 对齐
- Lifecycle: active
- Catalog note: 普通“合并”完成 PR merge、远端 head 删除与 primary base 对齐；merge 后先跟踪 merge-SHA target CI，再判定仓库发布链。预期发版必须等待实际 Release/package/container 终态，并报告版本/tag、channel、SHA、链接、时间与产物摘要

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-17
- Legacy last-tracked: 2026-03-17
- Current lifecycle: active
- Catalog note: 普通“合并”完成 PR merge、删除远端 PR head，并让 Git primary worktree 的 PR base 包含最新 remote base；dirty/ahead/diverged 时进入待决策菜单，只有“合并并收尾”才进入本地 cleanup；merge 后按 merge SHA 使用 sub-agent 追踪目标分支 CI

## Delivery Milestones

- [x] M1: 建立规格与 README 索引
- [x] M2: 对齐 shared contracts 与入口 skill
- [x] M3: 扩展 replay checker 与 fixtures
- [x] M4: 跑本地校验并收口到 Step 5L Ready（local）
- [x] M5: 以 sub-agent 替换计划任务作为 PR/head 与 post-merge target-branch CI 的主追踪路径，将不变量下沉到共享 CI tracking contract，并保留 watcher/defer fallback
- [x] M6: 将 post-merge 扩展为 target CI + repository release chain 双终态门禁，并用 replay 覆盖发布状态机

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/fast-track-merge-intent-closeout/SPEC.md`
- `AGENTS.md`
- `skills/project-engineering-workflow/references/ci-tracking-short-contract.md`
- `skills/project-engineering-workflow/references/release-tracking-short-contract.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `skills/pr-post-merge-cleanup/SKILL.md`
- `skills/dev-plan/SKILL.md`
- `bin/pr_skill_replay_check.py`
- `docs/specs/fast-track-merge-intent-closeout/replay/*`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `ff72d05` fix(flow): align fast-track merge closeout semantics
- current worktree: add `skills/pr-merge/scripts/base_alignment_helper.py` plus unit coverage so merge-only closeout can inspect/apply primary-base alignment without relying on ad-hoc shell prose
- current worktree: make fast-track stop at aggregate `Step 5C Ready` until owner approves the current head SHA, while child merges return to integration CI instead of Step 6
- current worktree: extend the helper with `safe-align`, including backup-branch creation, `stash -u`, `rebase`, `stash apply`, and recoverable conflict reporting for owner-approved base alignment
- `b39a914` docs(specs): adopt topic-level spec model
- current worktree: distinguish plain merge from merge+cleanup; cleanup includes PR worktree deletion
- current worktree: once stop condition is `merge-only` / `merge+cleanup` and Step 5 merge path is active, same-PR in-scope writable convergence is on by default; `merge-ready` still stops at `Step 5C Ready`
- review follow-up: classify explicit cleanup phrases such as `合并 PR 并收尾` / `merge PR and cleanup` before plain merge-only substrings
- review follow-up: recognize flow-anchor stop conditions such as `收工条件=merge+cleanup` as merge+cleanup intent
- review follow-up: require actual cleanup evidence (`$pr-post-merge-cleanup`, `cleanup_skill_invoked=yes`, or `cleanup_proof`) instead of trusting assistant summary text such as `本地收尾=完成`
- review follow-up: keep explicit `merge+cleanup` anchors even when the same line contains readiness wording, and reject negated `$pr-post-merge-cleanup` mentions as cleanup proof
- review follow-up: require positive `cleanup_proof` values and restrict assistant-side cleanup intent to explicit state anchors, not option text
- review follow-up: preserve `merge-ready` for `准备好合并 PR`, reject `不会/不调用 $pr-post-merge-cleanup`, and keep assistant `merge+cleanup` state anchors even when the same line says proof is not ready
- review follow-up: reject future-tense `$pr-post-merge-cleanup` promises as cleanup proof; proof must come from positive structured fields
- review follow-up: allow positive cleanup proof on lines that also report merge-scope base update skips
- review follow-up: restrict merge evidence to actual merge tool invocations and cleanup proof to trusted final cleanup status, so diagnostic command text cannot satisfy merge/cleanup gates
- review follow-up: parse `gh` merge commands with global flags such as `--repo`, and require mutating `gh api --method PUT .../merge` before counting API calls as merge evidence
- review follow-up: enforce cleanup proof only after merge success evidence, so failed merge attempts do not require post-merge cleanup
- review follow-up: ignore `gh pr merge --help` as non-execution, and let later explicit merge-ready requests supersede earlier merge/cleanup intents
- review follow-up: unwrap `sh/bash/zsh -c` before detecting real `gh` merge calls
- review follow-up: scan simple shell command segments and scope merge evidence to the active intent
- review follow-up: prefer mutating merge segments when a shell command runs diagnostic `gh` calls first
- review follow-up: parse `shell` command arrays and let cleanup intent win over ready substrings
- review follow-up: reject future cleanup proof placeholders and keep active proof closeout blocking merge wording
- review follow-up: recognize path-qualified `gh` merge invocations by executable basename
- review follow-up: reuse merge-success parsing for final task closeout text
- owner correction: remote PR head deletion belongs to merge scope; local branch/worktree deletion remains cleanup
- owner correction: plain merge also owns Git primary worktree PR base alignment, where aligned means local base contains latest remote base; local PR topic branch/worktree deletion still remains cleanup
- owner correction: alignment means local base contains latest remote base; local ahead commits may remain after owner-approved safe alignment. plain merge auto-update is limited to clean exact/ff-only states; dirty/ahead/diverged primary base should become `主工作区基线更新=待主人决策` with a safe-align menu, and safe-align must restore dirty/untracked content to the worktree after stash/rebase.
- review follow-up: allow explicit fork/protected remote-head delete exemptions and detect `gh api ... -X DELETE` after the endpoint
- review follow-up: treat `[deleted] <branch>` as success even when branch names contain failure words, and reject negated fork diagnostics as exemptions
- review follow-up: parse common `git push origin --delete <branch>` / `git push origin -d <branch>` forms as remote PR head deletion proof
- review follow-up: reject `gh api ... -X DELETE` failure output such as `gh:` / HTTP 4xx as remote branch deletion proof
- review follow-up: require tool evidence for `远端分支=不存在`; assistant final status alone is not deletion proof
- review follow-up: treat explicit tool output such as `remote branch: not found` as successful absence verification
- review follow-up: accept deletion-looking output only from recognized delete or verification commands, not unrelated diagnostics
- review follow-up: reject failed `gh pr merge --delete-branch` deletion output and wrong-branch deletion when `headRefName` is known
- review follow-up: strip natural sentence punctuation from captured PR head names before matching deletion output
- review follow-up: parse compound remote-delete commands by shell segment before matching verification output
- review follow-up: require PR head evidence for branch-specific deletion proof and recurse into shell-wrapped compound deletes
- review follow-up: ignore shell redirection and pipeline suffixes when extracting `git push --delete` branch names
- review follow-up: normalize `refs/heads/` prefixes from git delete refspecs before matching PR head
- review follow-up: split multiline shell scripts and capture PR head names with non-alphanumeric ref characters such as `+`
- review follow-up: preserve `||` fallback semantics so a successful merge does not imply an unexecuted fallback branch delete
- review follow-up: require concrete fork, permission, or protection evidence before accepting remote branch deletion exemptions
- owner follow-up: merge-scope base alignment now has a dedicated helper that always resolves the Git primary worktree first, auto-applies only safe ff/tracking-ref updates, and leaves dirty/ahead/diverged primary-base states on the existing owner-decision path
- owner follow-up: once the owner explicitly chooses `安全对齐`, the helper now performs the rebase path itself and reports `backup_branch` / `stash_ref` / recoverable conflict state instead of forcing agents back into ad-hoc shell composition
- compression pass: reduce repeated skill prose while keeping the shared stop-condition contract as the single source of truth
- current worktree: split local Step 4 wording from live PR status: local handoff is now `可开 PR（local）`, while `merge-ready` / `Step 5C Ready` / `latest PR 可立即合并` require `PR状态=存在`; `pr_skill_replay_check.py` now reports `READY_CLAIM_WITHOUT_OPEN_PR` when this is violated
- merge-proof follow-up: terminal `task_complete.last_agent_message` is now treated as assistant text for ready-claim detection, and replay coverage includes a final-message-only false-claim case
- current worktree: replace the scheduled app-automation path with one low-cost sub-agent tracker per PR head SHA or merge SHA, centralize its invariants in the shared CI tracking contract, block main-agent on `wait_agent`, allow one transient rerun, and report code failures
- current worktree: add a separate release tracking contract and expand shared Step 6 into target-CI plus repository-release barriers; release snapshots now hand off intent only, expected releases wait up to 30 minutes for actual publication, and every remote merge reports release status
- review follow-up: once `merge+cleanup` already has a positive `cleanup_proof`, `flow-continue` must resume `$pr-merge` for unresolved Step 6 follow-up instead of rerunning `$git-cleanup`
- review follow-up: non-positive `cleanup_proof` values such as `blocked|pending|unchecked` must continue `$git-cleanup` rather than skipping ahead to `$pr-merge`
- review follow-up: `flow_continue_replay_check.py` now covers both the positive-proof resume path and the non-positive-proof keep-cleanup path with dedicated `docs/specs/fast-track-merge-intent-closeout/SPEC.md` replay cases
- review follow-up: CI tracker replay now requires a real `wait_agent` function call, validates a concrete SHA, and distinguishes historical `app-automation` state from an actual automation launch
- review follow-up: CI tracker replay now binds launch, wait, and SHA evidence to the same tracker instance, accepts automatic `push`-triggered PR checks, and ignores unrelated automation pause/archive calls
- review follow-up: CI tracker replay now matches `wait_agent.targets` and the reported SHA against the launch-bound tracker identity and SHA, with defer closeout kept separate from terminal tracker evidence
- review follow-up: CI tracker replay now accepts implicit `wait_agent` barriers, resolves spawned identities from function output/activity, preserves earlier matching waits, and checks the launch phase against the returned tracker card
- review follow-up: CI tracker replay now rejects launches without a status card, prefers concrete agent identities over task names, and ignores scheduled automation outside the active follow-up mode
- review follow-up: CI tracker replay now accepts the PR-head result card, requires completed wait output, and falls back to the returned checked SHA when spawn arguments cannot expose the encrypted prompt binding

## Remaining Gaps

- review follow-up: CI tracker replay now requires terminal post-merge result/disposition fields and detects scheduled launches that precede their legacy status card
- review follow-up: CI tracker replay now derives phase only from structured launch metadata or canonical tracker names, validates post-merge-only fields, and filters negated automation mentions

- Replay checker coverage for the release state machine is implemented in this change and must remain green with the existing CI tracker suite.

## Current Validation

- `pr_skill_replay_check.py`: passed, including published, not-triggered, snapshot-early-close, running, failed, retry-success, timeout, SHA/tag mismatch, and metadata-missing cases
- review follow-up: every completed remote merge now requires an explicit release status/expectation; published evidence is bound to actual tag/SHA, package/container-only evidence is accepted, contradictory expectation/status pairs fail, and timeout requires an incomplete-state recovery anchor
- review follow-up: publication proof now preserves raw tool strings, rejects draft-only timestamps, scopes evidence to the current expectation/repository epoch, requires an actual artifact SHA, enforces one proven-safe rerun, and requires tool-side skip/absence evidence for `release_expected=false`
- review follow-up: structured disabled decisions retain boolean values, container tags are bound to the reported version, pre-release CI reruns are excluded, and release idempotency proof must be relevant and precede the single rerun
- review follow-up: GitHub drafts require `published_at`, publication identity is bound per tool fact, timeout requires `未终态`, release reruns bind an explicit run id, and successful closeout requires an explicit positive expectation
- review follow-up: release reruns honor `gh` global flags, no-release decisions require evidence beyond a bare boolean, and a single publication fact must bind repository/tag/SHA while the reported version matches that identity
- review follow-up: release expectations now accept only trusted assistant merge-status cards or structured discovery booleans, every non-N/A release outcome requires an expectation decision, and merge+cleanup resumes unresolved Step 6B after cleanup
- review follow-up: structured discovery identity keeps its keys, publication evidence is split per artifact object with inherited parent identity, and expectation epoch changes clear all release identity state
- review follow-up: release expectations and rerun safety now require structured attributable evidence, every declared surface must publish, and final URL/time are bound to observed artifact metadata with ISO-8601 validation
- review follow-up: structured `release_epoch` distinguishes tracker heartbeats from new identities; same-epoch cards preserve and accumulate state, epoch changes reset it, inherited rerun flags are parsed, and assistant prose cannot overwrite repo/SHA/tag discovery
- review follow-up: published closeout requires a trusted discovery `target_sha`, rerun detection scans every shell segment, and same-epoch no-release heartbeats preserve earlier repository evidence
- review follow-up: workflow URLs bind the observed release run, tag comparison normalizes optional `v`, no-release evidence stays attributable to discovery, and declared package/image identities support names that differ from the source repository
- review follow-up: no-release decisions require the full merge identity, explicitly non-success artifact records cannot prove publication, and local merges may report the release surface as not applicable
- review follow-up: stringified JSON publication lists retain per-artifact atomicity, release reruns reject every mismatched run id, and a release epoch cannot rebind repository/SHA/tag identity
- review follow-up: expectation cannot flip inside one release epoch, optional `v` prefixes remain equivalent in final tag checks, and failed closeout requires a bound live failure fact
- review follow-up: pre-discovery reruns require structured Step 6A transient-CI identity, missing-epoch heartbeats cannot reset release identity, and `release_expected=unknown` remains a valid unresolved state
- review follow-up: release reruns now require a failure fact for the exact tracked run, batched failure facts stay atomic per run, and declared surfaces are accepted only from the active release epoch
- review follow-up: actual publication facts now reject explicit cross-epoch evidence, while GitHub Release and Actions path recognition supports the active GitHub Enterprise host
- review follow-up: structured release discovery now unwraps JSON-string and text-content tool outputs before evaluating expectation, epoch, surfaces, identities, and retry evidence
- review follow-up: split structured content blocks are merged, and every declared package/container identity must have its own atomic terminal publication fact
- review follow-up: atomic facts reject any conflicting tag/SHA, same-epoch cards may add an immutable run ID, and scalar conflicts survive split-content normalization
- review follow-up: release reruns bind any explicit `gh --repo/-R` target to the tracked repository, while equivalent short/full SHA and optional-`v` tag representations remain compatible
- review follow-up: pre-release Step 6A rerun evidence also binds `target_repo`, preventing cross-repository run-ID collisions before release discovery
- review follow-up: structured PR-head CI reruns remain outside release retry safety, non-GHCR package URLs bind their repository, and container alias tags coexist with the version tag
- review follow-up: release identity now includes the target branch, and explicit tracker-unavailable outcomes may return `未终态` immediately with a recovery anchor
- review follow-up: every rerun in a compound shell command is counted independently, and standard MCP `structuredContent` discovery output is decoded
- review follow-up: every same-epoch tracker card keeps repository/branch/SHA/tag identity immutable, and a `gh run rerun` without a literal run ID is an unsafe retry
- review follow-up: actual package/container publication requires an explicit terminal surface marker, release rerun invalidates prior failure evidence, and failed closeout reports both failing surface and owner disposition
- review follow-up: `发布状态=不适用` is permitted only when neither trusted release context nor a remote-merge signal exists; local merge wording alone does not invalidate it
- review follow-up: a remote merge becomes release context only after the merge call's success evidence, so failed merge attempts retain `发布状态=不适用`
- review follow-up: expected or unresolved releases must retain all owner-facing fields even when not terminal-success, and structured `success=false` is a failure fact for the bound run
- review follow-up: structured merge-success facts establish remote release context, while a target-SHA-matching failure workflow URL binds its repository without an optional release run ID
- review follow-up: direct structured expectation fields are conflict-normalized, and release run identity starts only from explicit release-run fields rather than arbitrary workflow URLs
- review follow-up: every remote merge success spelling establishes post-merge release context, and every expected release outcome retains the complete owner-facing field set, including published and untriggered results
- `flow_continue_replay_check.py`: passed for both the historical `docs/specs/flow-continue-lock-guard/SPEC.md` suite and the `docs/specs/fast-track-merge-intent-closeout/SPEC.md` cleanup/release resume suite
- Python compile, plan contract replay, `git diff --check`, and spec drift: passed
- review-proof historical replay: blocked by a pre-existing missing `sessions/2026/03/16/...jsonl` fixture referenced by its cases file
- `spec_disposition=update`
- `solution_disposition=none`
- `project_doc_disposition=update` (`AGENTS.md`, `skills/README.md`)
- `视觉证据=不适用`; reason: workflow/docs/checker-only change with no rendered UI surface

## References

- `./SPEC.md`
- `./HISTORY.md`
