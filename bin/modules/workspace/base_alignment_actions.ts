import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { inspectAlignment, type BaseArgs } from "./base_alignment";

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function command(root: string, args: string[]): string[] {
  return ["git", "-C", root, ...args];
}

function git(root: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function requireGit(root: string, args: string[]): void {
  const result = git(root, args);
  if (result.status !== 0)
    throw new Error(
      "git " +
        args.join(" ") +
        " failed: " +
        (result.stderr || result.stdout).trim(),
    );
}

function value(payload: Record<string, unknown>, name: string): string {
  return typeof payload[name] === "string" ? String(payload[name]) : "";
}

function resultFacts(args: BaseArgs): Record<string, unknown> {
  return inspectAlignment({ ...args, refreshRemote: false });
}

function branchExists(root: string, branch: string): boolean {
  return (
    git(root, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch])
      .status === 0
  );
}

function backupBranch(root: string, base: string, requested: string): string {
  if (requested) return requested;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const stem = "backup/" + base + "-before-safe-align-" + stamp;
  let candidate = stem;
  let suffix = 2;
  while (branchExists(root, candidate)) candidate = stem + "-" + suffix++;
  return candidate;
}

function latestStash(root: string): string {
  return git(root, ["stash", "list", "-1", "--format=%gd"]).stdout.trim();
}

function rebaseInProgress(root: string): boolean {
  const merge = git(root, [
    "rev-parse",
    "--git-path",
    "rebase-merge",
  ]).stdout.trim();
  const apply = git(root, [
    "rev-parse",
    "--git-path",
    "rebase-apply",
  ]).stdout.trim();
  return Boolean(
    (merge && existsSync(resolve(root, merge))) ||
    (apply && existsSync(resolve(root, apply))),
  );
}

function conflictedFiles(root: string): string[] {
  return git(root, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function applyAuto(args: BaseArgs): [Record<string, unknown>, number] {
  const before = inspectAlignment(args);
  const state = value(before, "state");
  if (state === "blocked") return [before, 11];
  if (state === "owner_decision") return [before, 10];
  const root = value(before, "repo_root");
  const primary = value(before, "primary_worktree");
  const base = value(before, "base_branch");
  const remote = value(before, "base_remote_ref");
  const localSha = value(before, "local_base_sha");
  const remoteSha = value(before, "remote_base_sha");
  const action = value(before, "recommended_action");
  const commands: string[][] = [];
  if (action === "create_tracking_ref") {
    const args = ["branch", "--track", base, remote];
    commands.push(command(primary, args));
    requireGit(primary, args);
  } else if (action === "pull_ff_only") {
    const args = ["merge", "--ff-only", remote];
    commands.push(command(primary, args));
    requireGit(primary, args);
  } else if (action === "switch_then_pull_ff_only") {
    const switchArgs = ["switch", base];
    const mergeArgs = ["merge", "--ff-only", remote];
    commands.push(command(primary, switchArgs), command(primary, mergeArgs));
    requireGit(primary, switchArgs);
    requireGit(primary, mergeArgs);
  } else if (action === "update_local_ref_ff_only") {
    if (!localSha || !remoteSha)
      throw new Error(
        "cannot fast-forward local ref without both local and remote shas",
      );
    const updateArgs = [
      "update-ref",
      "refs/heads/" + base,
      remoteSha,
      localSha,
    ];
    commands.push(command(root, updateArgs));
    requireGit(root, updateArgs);
  } else if (action !== "none") {
    throw new Error("unsupported auto action: " + action);
  }
  const after = inspectAlignment(args);
  return [
    {
      ...after,
      applied_action: action || "none",
      applied_commands: commands,
      previous_state: state,
    },
    0,
  ];
}

function safeAlignFailure(
  args: BaseArgs,
  before: Record<string, unknown>,
  commands: string[][],
  backup: string,
  stash: string,
  operation: string,
  reason: string,
  failed: string[],
): Record<string, unknown> {
  const facts = resultFacts(args);
  const primary =
    value(before, "primary_worktree") || value(facts, "primary_worktree");
  return {
    ...facts,
    state: "recoverable_conflict",
    merge_scope_status: "待主人决策",
    recommended_action: "manual_resume_required",
    owner_options: [],
    previous_state: value(before, "state"),
    applied_action: "safe_align_partial",
    applied_commands: commands,
    backup_branch: backup,
    stash_ref: stash,
    operation_status: operation,
    failed_command: failed,
    reason,
    rebase_in_progress: rebaseInProgress(primary),
    conflicted_files: conflictedFiles(primary),
    resume_hint:
      operation === "rebase_conflict"
        ? "Resolve conflicts in " +
          primary +
          " and continue with `git rebase --continue`."
        : "Resolve conflicts in " +
          primary +
          "; the stash backup remains at " +
          (stash || "stash@{0}") +
          ".",
  };
}

export function safeAlign(args: BaseArgs): [Record<string, unknown>, number] {
  const before = inspectAlignment(args);
  const state = value(before, "state");
  const action = value(before, "recommended_action");
  if (state === "blocked") return [before, 11];
  if (state !== "owner_decision" || action !== "owner_decision_safe_align")
    return [
      {
        ...before,
        safe_align_requested: true,
        safe_align_supported: false,
        reason:
          value(before, "reason") ||
          "safe-align is only supported after the owner chooses the safe-align decision path",
      },
      10,
    ];
  const root = value(before, "primary_worktree") || value(before, "repo_root");
  const base = value(before, "base_branch");
  const primaryBranch = value(before, "primary_branch");
  if (primaryBranch !== base)
    return [
      {
        ...before,
        safe_align_requested: true,
        safe_align_supported: false,
        reason:
          "safe-align only runs when the primary worktree is currently on " +
          base +
          "; current primary branch is " +
          (primaryBranch || "unknown"),
      },
      10,
    ];
  const remote = value(before, "base_remote_ref");
  const commands: string[][] = [];
  const backup = backupBranch(root, base, args.backupBranch ?? "");
  const branchArgs = ["branch", backup, base];
  commands.push(command(root, branchArgs));
  requireGit(root, branchArgs);
  const dirty = before.primary_clean !== true;
  let stash = "";
  if (dirty) {
    const message =
      "safe-align " +
      base +
      " onto " +
      remote +
      " (" +
      new Date().toISOString() +
      ")";
    const stashArgs = ["stash", "push", "-u", "-m", message];
    commands.push(command(root, stashArgs));
    requireGit(root, stashArgs);
    stash = latestStash(root);
    if (!stash)
      throw new Error(
        "safe-align expected a stash backup, but no stash ref was created",
      );
  }
  const rebaseArgs = ["rebase", remote];
  commands.push(command(root, rebaseArgs));
  const rebase = git(root, rebaseArgs);
  if (rebase.status !== 0)
    return [
      safeAlignFailure(
        args,
        before,
        commands,
        backup,
        stash,
        "rebase_conflict",
        (rebase.stderr || rebase.stdout).trim(),
        command(root, rebaseArgs),
      ),
      12,
    ];
  if (stash) {
    const stashArgs = ["stash", "apply", stash];
    commands.push(command(root, stashArgs));
    const applied = git(root, stashArgs);
    if (applied.status !== 0)
      return [
        safeAlignFailure(
          args,
          before,
          commands,
          backup,
          stash,
          "stash_apply_conflict",
          (applied.stderr || applied.stdout).trim(),
          command(root, stashArgs),
        ),
        12,
      ];
  }
  const after = resultFacts(args);
  const relation = value(after, "base_relation");
  if (relation !== "equal" && relation !== "ahead_contains_remote")
    throw new Error(
      "safe-align completed but local base still does not contain the remote base (relation=" +
        (relation || "unknown") +
        ")",
    );
  const reason =
    relation === "ahead_contains_remote"
      ? "local " + base + " now contains " + remote
      : "local " + base + " now equals " + remote;
  return [
    {
      ...after,
      state: "aligned",
      merge_scope_status: "已更新",
      recommended_action: "none",
      owner_options: [],
      previous_state: value(before, "state"),
      applied_action: "safe_align",
      applied_commands: commands,
      backup_branch: backup,
      stash_ref: stash,
      operation_status: "completed",
      reason: dirty
        ? reason + "; dirty/untracked content restored to the primary worktree"
        : reason,
    },
    0,
  ];
}
