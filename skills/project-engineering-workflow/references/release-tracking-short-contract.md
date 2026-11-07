# Release Tracking Short Contract

Use this contract for shared Step 6B, `$fast-flow`, `$flow-continue`, and the workflow PR merge procedure. Requirements: [Release Tracking](../../../skills/docs/vendor/dot-codex/specs/release-tracking/SPEC.md). Pre-merge route absence and a release decision card do not establish actual post-merge publication.

## Identity and publication proof

- Determine `release_expected=true|false|unknown` from repository-owned policy and live facts. A green intent, snapshot, build, or workflow is insufficient.
- Keep `target_repo + target_branch + target_sha` fixed as the Release Origin. `target_sha` is the originating merge SHA; `merge_sha` remains its legacy alias. Assign a stable `release_epoch` and record actual version/tag separately.
- Record `publication_sha` separately. If it differs from the origin, obtain external repository evidence for every preparation/run/PR/tag transition. Never replace the origin silently or accept a tag match as lineage proof.
- A normalized lineage card carries the same epoch and origin, `publication_sha`, an `origin_locator` for the full origin commit in the bound repository, and an ordered `release_lineage` list. Each edge has `source_sha`, `target_sha`, `relation`, and `evidence`: a repository-owned external fact containing those two SHAs, that relation, and an `external_locator`. Edges must be contiguous from the full origin SHA to the full publication SHA. The locator identifies the bound code-hosting repository's PR, commit, run, or repository artifact on the same code-hosting host as the origin locator; a bare `lineage_verified=true` or child assertion is insufficient.
- Discover every declared Release, package, container, and pipeline-owned deployment, including each concrete surface identity. Each must have terminal success, actual artifact/deployment identifiers, version/tag, publication SHA, time, and external locators. Deployment dispatch is not deployment success. Unknown surfaces remain unverified rather than being silently dropped.

## Role and ownership

- Use the runtime agent-spawn entrypoint with `agent_type="release-tracker"`, explicit `model=gpt-5.6-luna` and `effort=low` (`[gpt-5.6-luna, low]`). Direct and PTC transports are equivalent. Supply this contract and the complete origin, surface, authorization, retry, and observation-window state.
- A role is not a standalone tool: inspect the runtime role inventory and, if registered, attempt its spawn. Only an actual inventory or startup result establishes availability; report its factual reason without guessing auth, quota, or provider failures. Source configuration checks do not prove a running session has loaded that role.
- The main Agent owns release authorization and triggering. Tracker availability does not block an otherwise authorized merge or dispatch. Once triggered, missing observation leaves publication unverified and closeout incomplete.
- On a Merge Receipt, evaluate the confirmed release card against live policy and merge identity while target CI is tracked. Start authorized preparation that does not depend on CI immediately; dispatch only after repository-specific prerequisites pass. A manual workflow not yet triggered is not evidence of `release_expected=false`.
- One tracker owns live observation of one release epoch. The main Agent waits on its runtime-returned handle. Reuse an active tracker; create a successor only after the prior one is confirmed stopped or terminal. Do not fall back to a parent poller, repository watcher, transcript parser, generic agent, or implicit model switch.

## Recovery and shared deadline

- On unavailable or interrupted tracking, save a recovery anchor: chat, epoch, fixed origin, trigger time/receipt, run and surface locators, known lineage, active child handle, actual startup reason, retry record, window start, and absolute deadline. Preserve this state across successor trackers.
- Tracking MUST NOT create, update, or reuse an app automation, heartbeat, cron, or scheduler. The main Agent waits only on the runtime-returned tracker handle while it exists; a missing or interrupted handle returns `unavailable|incomplete` with its recovery anchor. The owner resumes with `$flow-continue`, which reuses the same identity, configured profile, and history rather than creating a scheduled poller or redispatching a release.
- Keep unchanged/non-actionable state quiet. Notify on completion, terminal failure after any permitted retry, required owner action, or budget exhaustion. If the tracker handle is unavailable, retain the anchor and report that precise gap for manual continuation.
- The initial wall-clock window starts at confirmed merge for an automatic release, or confirmed dispatch for a manual one. Without a release recovery operation, the absolute deadline is 30 minutes from that start.
- A permitted rerun or another explicitly authorized release recovery operation extends that same window to at most one hour from its start. Startup outages, waits, read-only checks, tracker recreation, and manual `$flow-continue` continuation never reset or extend it. No scheduler may continue observation past the deadline.
- At the deadline, stop observation and the child without cancelling the external release. Return incomplete with the recovery anchor. An explicit owner `$flow-continue` resumes the same bounded window when time remains, preserving the origin, deadline, lineage, and spent retry history; it never resets or extends the budget.

## Terminal and retry rules

- `发布状态=已发布` requires terminal success and matching actual identities for every declared surface, with verified lineage if the publication SHA differs. `release_expected=false` alone permits `发布状态=未触发`; unresolved applicability remains `unknown` or `未终态`.
- The tracker may rerun the same existing failed run at most once for the tracked release, when its task authorization permits it and attributable evidence proves `idempotent=true` and `retry_safe=true` for that exact run. Save the retry intent before mutation and the returned run/attempt receipt afterwards. An ambiguous prior retry consumes the allowance pending owner resolution.
- Require the run's own terminal failure, not a nested artifact failure. Provided safety locators and the actual rerun repository (including CLI flags and environment overrides) must match the bound run. Conflicting aggregate safety facts fail closed; delayed reads or older attempts cannot restore revoked failure or safety permissions. After retry, explicit attempt evidence must be bound to the retry receipt before it can prove publication. A newer successful observation of the same externally restored run clears only that run's unresolved failure; other failed surfaces remain unresolved.
- Never dispatch a replacement release, change inputs/version/channel/target, or restore a spent retry allowance by changing tracker, scheduler, or window. Other recovery mutations require their own explicit authorization.
- Observe every surface again after retry. Missing safety evidence, exhausted allowance, or continued failure requires owner action and unsuccessful closeout; a successful rerun workflow alone does not prove publication.

## Return fields

Return `phase=post_merge_release`, `bound_sha=<origin>`, `publication_sha`, `release_epoch`, `terminal_state=passed|failed|incomplete|unavailable`, the origin and per-surface facts/locators, retry record, window start/deadline, and any recovery anchor. `passed` requires complete external publication proof.

Always return `release_expected=true|false|unknown` and owner-facing fields:

- `发布状态=不适用|未触发|运行中|已发布|失败|未终态|未检查`
- `发布版本`, `发布tag`, `发布channel`, `发布起始sha`, `发布绑定sha`
- `发布workflow`, `发布URL`, `发布时间`, `发布产物`
- `发布处置=report-only|rerun-once|owner-action-required|none|未检查`

`发布起始sha` is the fixed origin; `发布绑定sha` is the actual publication SHA. For failures, include the failing surface and required owner action. For non-release merges, include one-line live evidence for `未触发`.
