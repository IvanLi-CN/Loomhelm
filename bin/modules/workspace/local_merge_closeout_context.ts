import {
  normalizePath,
  parseWorktreePorcelain,
  runGit,
  type CommandRunner,
} from "./worktree";

export interface LocalMergeCloseoutArgs {
  repoRoot: string;
  baseBranch: string;
  topicBranch?: string;
  mergeWorktreePath?: string;
  desiredCloseoutStatus?: string;
  pendingCleanupAction?: string;
  dirtyWorktreePolicy?: string;
  topicBranchAction?: string;
  blockingReason?: string;
  optionalPushStatus?: string;
}

export interface LocalMergeCloseoutDeps {
  runner?: CommandRunner;
}

async function branchExists(
  repoRoot: string,
  branch: string,
  runner?: CommandRunner,
): Promise<boolean> {
  return (
    (
      await runGit(
        repoRoot,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { check: false, runner },
      )
    ).exitCode === 0
  );
}

async function revision(
  repoRoot: string,
  ref: string,
  runner?: CommandRunner,
): Promise<string> {
  const result = await runGit(repoRoot, ["rev-parse", ref], {
    check: false,
    runner,
  });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

export async function buildLocalMergeCloseoutContext(
  args: LocalMergeCloseoutArgs,
  deps: LocalMergeCloseoutDeps = {},
): Promise<Record<string, unknown>> {
  const repoRoot = normalizePath(args.repoRoot);
  const runner = deps.runner;
  const worktrees = parseWorktreePorcelain(
    (await runGit(repoRoot, ["worktree", "list", "--porcelain"], { runner }))
      .stdout,
  );
  const observed = worktrees.map((row) => row.path);
  const mergePath = args.mergeWorktreePath?.trim()
    ? normalizePath(args.mergeWorktreePath)
    : "";
  const mergeStatus = !mergePath
    ? "not_applicable"
    : observed.includes(mergePath)
      ? "still_present"
      : "removed";
  const currentBranch = (
    await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { runner })
  ).stdout.trim();
  const clean =
    (
      await runGit(repoRoot, ["status", "--porcelain"], { runner })
    ).stdout.trim() === ""
      ? "yes"
      : "no";
  const topicBranch = args.topicBranch?.trim() ?? "";
  return {
    desired_closeout_status: args.desiredCloseoutStatus?.trim() ?? "完成",
    pending_cleanup_action: args.pendingCleanupAction?.trim() ?? "none",
    dirty_worktree_policy: args.dirtyWorktreePolicy?.trim() ?? "clean",
    topic_branch_action: args.topicBranchAction?.trim() ?? "not_needed",
    blocking_reason: args.blockingReason?.trim() ?? "",
    base_branch: args.baseBranch.trim(),
    current_branch: currentBranch,
    worktree_clean: clean,
    topic_branch: topicBranch,
    topic_branch_present: topicBranch
      ? (await branchExists(repoRoot, topicBranch, runner))
        ? "yes"
        : "no"
      : "unknown",
    head_sha: await revision(repoRoot, "HEAD", runner),
    base_head_sha: await revision(repoRoot, args.baseBranch, runner),
    optional_push_status: args.optionalPushStatus?.trim() ?? "未请求",
    merge_worktree: { path: mergePath, status: mergeStatus },
    observed_worktree_paths: observed,
  };
}

export { parseWorktreePorcelain } from "./worktree";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cli = await import("./local_merge_closeout_context_cli");
  return cli.main(argv);
}

if (import.meta.main) process.exitCode = await main();
