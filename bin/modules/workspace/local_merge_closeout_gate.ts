type JsonRecord = Record<string, unknown>;
const STATUS: Record<string, string> = {
  完成: "complete",
  部分完成: "partial",
  未执行: "not_executed",
  complete: "complete",
  partial: "partial",
  not_executed: "not_executed",
};
const INVERSE = {
  complete: "完成",
  partial: "部分完成",
  not_executed: "未执行",
} as const;
const DIRTY = new Set([
  "clean",
  "preserved_unrelated",
  "skipped_conflict",
  "user_decision_required",
]);
const TOPIC = new Set([
  "not_needed",
  "deleted_safe",
  "deleted_forced",
  "skipped",
]);
const MERGE = new Set([
  "not_applicable",
  "removed",
  "still_present",
  "skipped",
]);
const PENDING = new Set([
  "none",
  "switch_to_base",
  "delete_topic_branch",
  "remove_merge_worktree",
  "ask_user",
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function text(value: unknown): string {
  return String(value ?? "").trim();
}
function status(value: unknown): string {
  return STATUS[text(value)] ?? "partial";
}
function yesNo(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  const key = text(value);
  return key === "yes" || key === "是"
    ? "yes"
    : key === "no" || key === "否"
      ? "no"
      : key;
}

export function normalizeLocalMergeCloseoutContext(
  raw: JsonRecord,
): JsonRecord {
  const merge = record(raw.merge_worktree);
  const dirty = text(raw.dirty_worktree_policy);
  const topic = text(raw.topic_branch_action);
  const pending = text(raw.pending_cleanup_action);
  const mergeStatus = text(merge.status);
  return {
    desired_closeout_status: status(raw.desired_closeout_status),
    pending_cleanup_action: PENDING.has(pending) ? pending : "ask_user",
    dirty_worktree_policy: DIRTY.has(dirty) ? dirty : "user_decision_required",
    topic_branch_action: TOPIC.has(topic) ? topic : "skipped",
    blocking_reason: text(raw.blocking_reason),
    base_branch: text(raw.base_branch),
    current_branch: text(raw.current_branch),
    worktree_clean: yesNo(raw.worktree_clean),
    topic_branch: text(raw.topic_branch),
    topic_branch_present: yesNo(raw.topic_branch_present),
    head_sha: text(raw.head_sha),
    base_head_sha: text(raw.base_head_sha),
    optional_push_status: text(raw.optional_push_status),
    merge_worktree: {
      path: text(merge.path),
      status: MERGE.has(mergeStatus)
        ? mergeStatus
        : merge.path
          ? "still_present"
          : "not_applicable",
    },
    observed_worktree_paths: Array.isArray(raw.observed_worktree_paths)
      ? raw.observed_worktree_paths.map(text)
      : [],
  };
}

function violation(code: string, message: string): JsonRecord {
  return { code, message };
}
function action(
  name: string,
  reason: string,
  extra: JsonRecord = {},
): JsonRecord {
  return { action: name, reason, ...extra };
}

export function evaluateLocalMergeCloseoutGate(
  rawContext: JsonRecord,
): JsonRecord {
  const ctx = normalizeLocalMergeCloseoutContext(rawContext);
  const violations: JsonRecord[] = [];
  const nextActions: JsonRecord[] = [];
  if (ctx.desired_closeout_status === "not_executed")
    return {
      allowed_complete: false,
      forced_closeout_status: INVERSE.not_executed,
      violations,
      next_actions: nextActions,
      normalized_context: ctx,
    };
  if (ctx.blocking_reason)
    violations.push(
      violation(
        "BLOCKING_REASON_PRESENT",
        `存在阻塞原因：${ctx.blocking_reason}`,
      ),
    );
  if (ctx.pending_cleanup_action !== "none") {
    violations.push(
      violation(
        "PENDING_CLEANUP_ACTION",
        `仍有未完成 cleanup 动作：${ctx.pending_cleanup_action}`,
      ),
    );
    nextActions.push(
      action(
        String(ctx.pending_cleanup_action),
        "cleanup proof still reports a pending local cleanup action.",
      ),
    );
  }
  if (!ctx.base_branch || !ctx.current_branch)
    violations.push(
      violation(
        "BASE_OR_CURRENT_BRANCH_UNKNOWN",
        "缺少 base/current branch 事实，不能宣告本地收尾=完成。",
      ),
    );
  else if (ctx.current_branch !== ctx.base_branch) {
    violations.push(
      violation(
        "CURRENT_BRANCH_NOT_BASE",
        `当前仍停在 ${ctx.current_branch}，尚未回到基线分支 ${ctx.base_branch}。`,
      ),
    );
    nextActions.push(
      action(
        "switch_to_base",
        "cleanup is not complete until the worktree is back on the base branch.",
      ),
    );
  }
  if (ctx.topic_branch_present === "yes") {
    violations.push(
      violation(
        "TOPIC_BRANCH_STILL_EXISTS",
        `topic 分支仍存在：${ctx.topic_branch || "<topic-branch>"}`,
      ),
    );
    nextActions.push(
      action(
        "delete_topic_branch",
        "topic branch is still present after local merge cleanup.",
      ),
    );
  } else if (ctx.topic_branch_present === "unknown")
    violations.push(
      violation(
        "TOPIC_BRANCH_STATUS_UNKNOWN",
        "topic 分支状态未知，不能宣告本地收尾=完成。",
      ),
    );
  const merge = record(ctx.merge_worktree);
  if (merge.status === "still_present") {
    violations.push(
      violation(
        "MERGE_WORKTREE_STILL_PRESENT",
        "merge worktree 仍存在，不能宣告本地收尾=完成。",
      ),
    );
    nextActions.push(
      action(
        "remove_merge_worktree",
        "merge worktree path is still present in git worktree observations.",
        { path: merge.path },
      ),
    );
  } else if (merge.status === "skipped")
    violations.push(
      violation(
        "MERGE_WORKTREE_SKIPPED",
        "merge worktree cleanup 被跳过，不能宣告本地收尾=完成。",
      ),
    );
  if (
    ctx.dirty_worktree_policy === "skipped_conflict" ||
    ctx.dirty_worktree_policy === "user_decision_required"
  )
    violations.push(
      violation(
        "DIRTY_WORKTREE_POLICY_BLOCKS_COMPLETE",
        `当前脏工作区策略=${ctx.dirty_worktree_policy}，不能宣告本地收尾=完成。`,
      ),
    );
  else if (ctx.dirty_worktree_policy === "clean" && ctx.worktree_clean === "no")
    violations.push(
      violation(
        "WORKTREE_DIRTY_BUT_POLICY_CLEAN",
        "worktree 仍为脏状态，但 dirty_worktree_policy=clean。",
      ),
    );
  else if (
    ctx.dirty_worktree_policy === "preserved_unrelated" &&
    !["no", "yes"].includes(String(ctx.worktree_clean))
  )
    violations.push(
      violation(
        "WORKTREE_CLEAN_STATE_UNKNOWN",
        "worktree clean 状态未知，不能宣告本地收尾=完成。",
      ),
    );
  if (!ctx.head_sha || !ctx.base_head_sha)
    violations.push(
      violation(
        "HEAD_SHA_MISSING",
        "缺少 head/base head SHA，cleanup proof 不可核验。",
      ),
    );
  const allowed =
    ctx.desired_closeout_status === "complete" && violations.length === 0;
  return {
    allowed_complete: allowed,
    forced_closeout_status: INVERSE[allowed ? "complete" : "partial"],
    violations,
    next_actions: nextActions,
    normalized_context: ctx,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cli = await import("./local_merge_closeout_gate_cli");
  return cli.main(argv);
}

if (import.meta.main) process.exitCode = await main();
