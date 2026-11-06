type JsonRecord = Record<string, unknown>;

const STATUS: Record<string, string> = {
  exists: "exists",
  missing: "missing",
  unknown: "unknown",
  存在: "exists",
  不存在: "missing",
  未检查: "unknown",
};
const REQUIRED: Record<string, string> = {
  yes: "yes",
  no: "no",
  unknown: "unknown",
  是: "yes",
  否: "no",
  未检查: "unknown",
};
const CLOSEOUT: Record<string, string> = {
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

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}
function bool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "y"].includes(value.trim().toLowerCase()))
      return true;
    if (["0", "false", "no", "n"].includes(value.trim().toLowerCase()))
      return false;
  }
  return Boolean(value);
}
function pathList(value: unknown): string[] {
  const values =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : value === undefined
          ? []
          : [value];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of values) {
    const path = text(item);
    if (path && !seen.has(path)) {
      seen.add(path);
      output.push(path);
    }
  }
  return output;
}
function normalized(
  value: unknown,
  table: Record<string, string>,
  fallback: string,
): string {
  return table[text(value)] ?? fallback;
}

export function normalizeCloseoutContext(raw: JsonRecord): JsonRecord {
  const local = record(raw.local_branch);
  const worktree = record(raw.pr_worktree);
  const remote = record(raw.remote_branch);
  const lease = record(raw.port_lease);
  return {
    result: text(raw.result),
    desired_closeout_status: normalized(
      raw.desired_closeout_status,
      CLOSEOUT,
      "partial",
    ),
    pending_user_decision: bool(raw.pending_user_decision),
    blocking_reason: text(raw.blocking_reason),
    local_branch: {
      name: text(local.name),
      status: normalized(local.status, STATUS, "unknown"),
      is_pr_head: bool(local.is_pr_head, true),
    },
    pr_worktree: {
      path: text(worktree.path),
      status: normalized(worktree.status, STATUS, "unknown"),
      is_clean:
        worktree.is_clean === null || worktree.is_clean === undefined
          ? null
          : bool(worktree.is_clean),
    },
    pr_worktree_required: normalized(
      raw.pr_worktree_required,
      REQUIRED,
      "unknown",
    ),
    remote_branch: {
      status: normalized(remote.status, STATUS, "unknown"),
      source_repo_unavailable: bool(remote.source_repo_unavailable),
    },
    port_lease: {
      status: normalized(lease.status, STATUS, "unknown"),
      scope_resolved: bool(lease.scope_resolved, true),
    },
    required_pr_worktree_paths: pathList(raw.required_pr_worktree_paths),
    observed_worktree_paths: pathList(raw.observed_worktree_paths),
    codex_managed_worktree_paths: pathList(raw.codex_managed_worktree_paths),
  };
}

function violation(code: string, message: string): JsonRecord {
  return { code, message };
}
function action(
  actionName: string,
  reason: string,
  extra: JsonRecord = {},
): JsonRecord {
  return { action: actionName, reason, ...extra };
}

export function evaluateCloseoutGate(rawContext: JsonRecord): JsonRecord {
  const ctx = normalizeCloseoutContext(rawContext);
  const violations: JsonRecord[] = [];
  const nextActions: JsonRecord[] = [];
  const desired = String(ctx.desired_closeout_status);
  if (desired === "not_executed")
    return {
      allowed_complete: false,
      forced_closeout_status: INVERSE.not_executed,
      violations,
      next_actions: nextActions,
      normalized_context: ctx,
    };
  if (ctx.pending_user_decision)
    violations.push(
      violation(
        "PENDING_USER_DECISION",
        "仍有待用户确认动作，不能宣告本地收尾=完成。",
      ),
    );
  if (ctx.blocking_reason)
    violations.push(
      violation(
        "BLOCKING_REASON_PRESENT",
        `存在阻塞原因：${ctx.blocking_reason}`,
      ),
    );
  const required = ctx.required_pr_worktree_paths as string[];
  const observed = new Set(ctx.observed_worktree_paths as string[]);
  const managed = new Set(ctx.codex_managed_worktree_paths as string[]);
  const activeManaged = [...managed]
    .filter((path) => observed.has(path))
    .sort();
  const managedRequired = required.filter((path) =>
    activeManaged.includes(path),
  );
  if (managedRequired.length) {
    violations.push(
      violation(
        "CODEX_MANAGED_WORKTREE_MANUAL_CLEANUP_FORBIDDEN",
        `Codex 托管 task Worktree 必须由原生任务归档，不能纳入手工 cleanup：${managedRequired.join(", ")}`,
      ),
    );
    nextActions.push(
      action(
        "archive_codex_task",
        "Codex-managed Worktree must be archived by the native task lifecycle.",
        { paths: managedRequired },
      ),
    );
  }
  if (activeManaged.length) {
    violations.push(
      violation(
        "CODEX_MANAGED_WORKTREE_ARCHIVE_REQUIRED",
        `Codex 托管 task Worktree 仍存在，必须由原生任务归档后才能完成收尾：${activeManaged.join(", ")}`,
      ),
    );
    if (!managedRequired.length)
      nextActions.push(
        action(
          "archive_codex_task",
          "Codex-managed Worktree must be archived by the native task lifecycle.",
          { paths: activeManaged },
        ),
      );
  }
  if (desired === "complete") {
    if (ctx.pr_worktree_required === "yes" && !required.length)
      violations.push(
        violation(
          "REQUIRED_PR_WORKTREE_PATHS_MISSING",
          "缺少 required_pr_worktree_paths，不能宣告本地收尾=完成。",
        ),
      );
    else if (ctx.pr_worktree_required === "unknown" && !required.length)
      violations.push(
        violation(
          "PR_WORKTREE_REQUIREMENT_UNKNOWN",
          "PR worktree 是否曾被要求仍未知，不能宣告本地收尾=完成。",
        ),
      );
    if (!(ctx.observed_worktree_paths as string[]).length)
      violations.push(
        violation(
          "OBSERVED_WORKTREE_PATHS_MISSING",
          "缺少 observed_worktree_paths（未提供 git worktree 实测），不能宣告本地收尾=完成。",
        ),
      );
  }
  const remaining = required.filter((path) => observed.has(path));
  if (remaining.length) {
    violations.push(
      violation(
        "REQUIRED_PR_WORKTREE_STILL_EXISTS",
        `required PR 工作区仍存在，不能宣告本地收尾=完成：${remaining.join(", ")}`,
      ),
    );
    nextActions.push(
      action(
        "remove_pr_worktree_safe",
        "required PR worktree path still exists in git worktree list.",
        { path: remaining[0], paths: remaining },
      ),
    );
  }
  const local = record(ctx.local_branch);
  if (local.status === "unknown")
    violations.push(
      violation(
        "LOCAL_BRANCH_STATUS_UNKNOWN",
        "本地分支状态=未检查，不能宣告本地收尾=完成。",
      ),
    );
  else if (local.status === "exists" && local.is_pr_head) {
    violations.push(
      violation(
        "LOCAL_PR_HEAD_BRANCH_EXISTS",
        `PR head 本地分支仍存在（${text(local.name) || "<feature-branch>"}），不能宣告本地收尾=完成。`,
      ),
    );
    nextActions.push(
      action(
        "delete_local_feature_branch",
        "PR head local branch still exists after merge.",
      ),
    );
  }
  const pr = record(ctx.pr_worktree);
  if (pr.status === "unknown" && ctx.pr_worktree_required !== "no")
    violations.push(
      violation(
        "PR_WORKTREE_STATUS_UNKNOWN",
        "PR工作区状态=未检查，不能宣告本地收尾=完成。",
      ),
    );
  else if (pr.status === "exists") {
    if (pr.is_clean === true) {
      violations.push(
        violation(
          "PR_WORKTREE_EXISTS_CLEAN",
          "PR工作区仍存在且干净，需先删除后再宣告完成。",
        ),
      );
      nextActions.push(
        action("remove_pr_worktree_safe", "PR worktree exists and is clean.", {
          path: pr.path,
        }),
      );
    } else if (pr.is_clean === false) {
      violations.push(
        violation(
          "PR_WORKTREE_EXISTS_DIRTY",
          "PR工作区存在且脏，禁止自动删除，必须阻塞并询问用户。",
        ),
      );
      nextActions.push(
        action(
          "ask_user_dirty_worktree_options",
          "PR worktree exists and is dirty.",
          { path: pr.path },
        ),
      );
    } else
      violations.push(
        violation(
          "PR_WORKTREE_CLEAN_STATE_UNKNOWN",
          "PR工作区存在但 clean 状态未知，不能宣告完成。",
        ),
      );
  }
  const remote = record(ctx.remote_branch);
  if (remote.status === "exists")
    violations.push(
      violation(
        "REMOTE_PR_HEAD_BRANCH_EXISTS",
        "远端 PR head 分支仍存在，不能宣告本地收尾=完成。",
      ),
    );
  else if (remote.status === "unknown" && !remote.source_repo_unavailable)
    violations.push(
      violation(
        "REMOTE_BRANCH_STATUS_UNKNOWN",
        "远端分支状态=未检查（且并非源仓库不可用例外），不能宣告完成。",
      ),
    );
  const lease = record(ctx.port_lease);
  if (lease.status === "exists")
    violations.push(
      violation(
        "PORT_LEASE_STILL_EXISTS",
        "端口租约仍存在，不能宣告本地收尾=完成。",
      ),
    );
  else if (lease.scope_resolved && lease.status === "unknown")
    violations.push(
      violation(
        "PORT_LEASE_STATUS_UNKNOWN",
        "端口租约 scope 已可定位但状态未检查，不能宣告完成。",
      ),
    );
  const allowed = desired === "complete" && violations.length === 0;
  return {
    allowed_complete: allowed,
    forced_closeout_status: INVERSE[allowed ? "complete" : "partial"],
    violations,
    next_actions: nextActions,
    normalized_context: ctx,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cli = await import("./closeout_gate_cli");
  return cli.main(argv);
}

if (import.meta.main) process.exitCode = await main();
