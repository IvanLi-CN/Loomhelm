import {
  codexManagedPath,
  normalizePath,
  normalizePathList,
  parseWorktreePorcelain,
  runGit,
  type CommandRunner,
  type WorktreeRow,
} from "./worktree";

export interface CloseoutContextArgs {
  repoRoot: string;
  featureBranch?: string;
  prWorktreePath?: string;
  prWorktreeRequired?: "yes" | "no" | "unknown";
  requiredPrWorktreePaths?: string[];
  codexManagedWorktreePaths?: string[];
  result?: string;
  desiredCloseoutStatus?: string;
  pendingUserDecision?: boolean;
  blockingReason?: string;
  remoteBranchStatus?: string;
  remoteSourceRepoUnavailable?: boolean;
  portLeaseStatus?: string;
  portScopeResolved?: boolean;
}

export interface CloseoutContextDeps {
  runner?: CommandRunner;
  environ?: Record<string, string | undefined>;
}

function branchExists(
  repoRoot: string,
  branch: string,
  runner?: CommandRunner,
): Promise<boolean> {
  return runGit(
    repoRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { check: false, runner },
  ).then((result) => result.exitCode === 0);
}

function pickPrWorktreePath(args: {
  repoRoot: string;
  featureBranch: string;
  explicitPath: string;
  requiredPaths: string[];
  worktrees: WorktreeRow[];
  managedPaths: Set<string>;
}): string {
  if (args.explicitPath && !args.managedPaths.has(args.explicitPath))
    return args.explicitPath;
  for (const path of args.requiredPaths)
    if (!args.managedPaths.has(path)) return path;
  if (args.featureBranch) {
    const match = args.worktrees.find(
      (row) =>
        row.branch === args.featureBranch &&
        row.path !== args.repoRoot &&
        !args.managedPaths.has(row.path),
    );
    if (match) return match.path;
  }
  return "";
}

export async function buildCloseoutContext(
  args: CloseoutContextArgs,
  deps: CloseoutContextDeps = {},
): Promise<Record<string, unknown>> {
  const repoRoot = normalizePath(args.repoRoot);
  const runner = deps.runner;
  const environ = deps.environ ?? process.env;
  const worktrees = parseWorktreePorcelain(
    (await runGit(repoRoot, ["worktree", "list", "--porcelain"], { runner }))
      .stdout,
  );
  const observed = worktrees.map((row) => row.path);
  const featureBranch = args.featureBranch?.trim() ?? "";
  const requested = normalizePathList(args.requiredPrWorktreePaths ?? []);
  const explicit = args.prWorktreePath?.trim()
    ? normalizePath(args.prWorktreePath)
    : "";
  const scoped = [...(args.codexManagedWorktreePaths ?? [])];
  for (const path of [explicit, ...requested])
    if (path && codexManagedPath(path, environ)) scoped.push(path);
  if (featureBranch)
    for (const row of worktrees)
      if (row.branch === featureBranch && codexManagedPath(row.path, environ))
        scoped.push(row.path);
  const managed = normalizePathList(scoped);
  const managedSet = new Set(managed);
  const required = requested.filter((path) => !managedSet.has(path));
  const prPath = pickPrWorktreePath({
    repoRoot,
    featureBranch,
    explicitPath: explicit,
    requiredPaths: required,
    worktrees,
    managedPaths: managedSet,
  });
  if (prPath && !required.includes(prPath)) required.push(prPath);
  let requiredState = args.prWorktreeRequired ?? "unknown";
  const explicitManaged = Boolean(explicit && managedSet.has(explicit));
  if (prPath || required.length) requiredState = "yes";
  else if (explicitManaged) requiredState = "no";
  const byPath = new Map(worktrees.map((row) => [row.path, row]));
  const exists = Boolean(prPath && byPath.has(prPath));
  const status = prPath
    ? exists
      ? "存在"
      : "不存在"
    : requiredState === "no"
      ? "不存在"
      : "未检查";
  const clean = exists
    ? (
        await runGit(prPath, ["status", "--porcelain"], { runner })
      ).stdout.trim() === ""
    : null;
  const localStatus = featureBranch
    ? (await branchExists(repoRoot, featureBranch, runner))
      ? "存在"
      : "不存在"
    : "未检查";
  return {
    result: args.result?.trim() ?? "merged",
    desired_closeout_status: args.desiredCloseoutStatus?.trim() ?? "完成",
    pending_user_decision: args.pendingUserDecision ?? false,
    blocking_reason: args.blockingReason?.trim() ?? "",
    local_branch: {
      name: featureBranch,
      status: localStatus,
      is_pr_head: Boolean(featureBranch),
    },
    pr_worktree: { path: prPath, status, is_clean: clean },
    pr_worktree_required: requiredState,
    remote_branch: {
      status: args.remoteBranchStatus?.trim() ?? "未检查",
      source_repo_unavailable: args.remoteSourceRepoUnavailable ?? false,
    },
    port_lease: {
      status: args.portLeaseStatus?.trim() ?? "未检查",
      scope_resolved: args.portScopeResolved ?? true,
    },
    required_pr_worktree_paths: required,
    observed_worktree_paths: observed,
    codex_managed_worktree_paths: managed,
  };
}

export { parseWorktreePorcelain } from "./worktree";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cli = await import("./closeout_context_cli");
  return cli.main(argv);
}

if (import.meta.main) process.exitCode = await main();
