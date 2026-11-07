# Wave Thread Flow History

Wave Thread Flow was the historical successor to the former Initiative and Parallel direct PR coordination models. Their specifications, ADRs, and replay fixtures remain readable for historical audit, but no new plan may select those routes.

The replacement preserves shared direct PR validation, review, publication, and release contracts while changing only the multi-task coordination boundary to a parent conversation, sibling child PRs, active event messages, and conversation-local parent state.

## Four-Level Delivery Batches

The historical model was Plan -> Delivery Batch -> Development Wave -> Task. A Delivery Batch was the unit of one final main-branch merge. One parent-child batch owned one parent PR and could schedule multiple waves; multiple parent PRs required multiple batches and an explicit reason for separate main-branch merges. A direct batch owned one wave and one task, whose implementation PR was also the final PR.

Runtime state uses schema version 2 and keeps batch-local SHA lineage, integration progress, delivery milestones, and resource closeout separate. v2 task and batch events are idempotent by stable identity, reject payload conflicts, defer missing prerequisites, and support deterministic replay. Legacy v1 state remains readable through a `default` batch adapter without rewriting the source.

Acceptance evidence is now bound to a task or batch scope and a lifecycle phase (`pre_merge`, `post_merge`, or `post_deploy`). Planned facts cannot prove publication or observation, and batch publication/deployment/observation must remain verifiably bound to the merged SHA lineage. Each new v2 batch carries an absolute observation_window.deadline; recovery cannot reset it. Conditions that are false are recorded as skips without resource creation; unknown conditions remain pending.

The v2 readiness gates now bind each acceptance item to its owning task or batch, require non-empty evidence and assertions for every acceptance item, require task `pre_merge` evidence before `pr_ready`, require batch `pre_merge` evidence before final readiness, require batch `post_merge` evidence before `merged` or `published`, require batch `post_deploy` evidence before `deployed` or `observed`, and retain timeout facts when an observation deadline expires. False condition results now require and persist the exact plan approval receipt, new delivery SHAs require structured native provider lineage receipts, milestone collections reject duplicate or unidentified records without being rewritten during validation, failed observations become blocked timeout facts, finalization is transactional across batches while persisting a timeout observed during a failed attempt, and legacy v1 string lineage evidence remains readable only through the explicit compatibility adapter.

Recovery now rejects self-authored completed merge payloads, parent-side merges without task pre-merge evidence, completed task evidence outside the current batch lineage, stale direct-PR base SHAs at Step 5C, passed milestones without bound prerequisite SHAs, late passed delivery milestones after timeout, and incomplete batch conditions or dependencies at Step 5C. v2 parent drift is recorded per batch, batch event scopes reject task/PR identity fields, and legacy events continue through an explicit adapter. Nested v2 tasks use the same native archive, closeout-target binding, and independent cleanup receipt APIs as legacy tasks, while each batch advances its own local wave without a cross-batch wave barrier.

The v2 plan parser now requires explicit milestone-qualified task and batch dependencies, preserves case-sensitive owned-surface identity during orchestration/contract cross-checks, and applies the same lexical path normalization used by runtime overlap isolation.

Runtime validation now applies the same explicit dependency and repository-relative surface rules to v2 manifests, treats required skipped acceptance as incomplete, rejects late publication after timeout, and preserves v1 multi-wave closeout when an earlier task merge remains on the legacy SHA history.

The plan-contract entrypoint now treats nested v2 batch -> wave -> task orchestration as the canonical raw-plan contract and keeps the old duplicated Wave Thread Contracts format only behind the explicit historical JSONL adapter, while preserving case-sensitive target branch identities.

The v2 shell route now recognizes standard batch topology labels after the batch identifier, and persisted passed milestones are rechecked against their required acceptance phase before recovery or finalization.

Persisted `pr_ready` and `completed` tasks are now rechecked for task-level `pre_merge` acceptance during v2 validation and final readiness, closing the parent-child recovery path that could otherwise trust a downgraded task acceptance record.

The v2 plan checker now requires every canonical batch's absolute observation deadline and every task's explicit `$skill` binding in Task Orchestration. Historical JSONL keeps its repeated section only for read-only compatibility; legacy string acceptance facts are read-adapted as `unknown` evidence while the original values remain preserved in `legacy_compat`.

## Child Conversation Closeout

The parent now treats `completed` as business completion only. After verifying that a child task has stopped and has no follow-up, it performs native conversation archive with an explicit envelope authorization and records a thread-bound, operation-bound receipt that remains pending on failure and is safe to retry. Worktree archive, branch cleanup, and port cleanup remain separate facts, so a merged child cannot be reported as fully closed until every applicable receipt is confirmed.

## 移除

按主人明确要求，删除 Skill 及底层历史兼容能力；不保留状态读取、事件回放或自动迁移。历史 ADR 与迁移基线作为证据保留。
