import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface AlignmentFacts {
  repo_root: string;
  base_branch: string;
  base_remote_ref: string;
  base_remote_name: string;
  base_remote_branch: string;
  head_branch: string;
  primary_worktree: string;
  primary_branch: string;
  primary_clean: boolean;
  worktrees: Array<{ path: string; branch: string; detached: boolean }>;
  base_holders: string[];
  linked_base_holders: string[];
  local_base_exists: boolean;
  remote_base_exists: boolean;
  local_base_sha: string;
  remote_base_sha: string;
  base_relation: string;
  fetch_error: string;
}

export interface BaseArgs {
  repoRoot: string;
  baseBranch: string;
  baseRemoteRef: string;
  headBranch: string;
  refreshRemote: boolean;
  backupBranch?: string;
}

function git(root: string, args: string[], required = true): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  if (required && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error("git " + args.join(" ") + " failed: " + detail);
  }
  return (result.stdout || "").trim();
}

function succeeds(root: string, args: string[]): boolean {
  return (
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status === 0
  );
}

function remoteParts(value: string): {
  display: string;
  canonical: string;
  remoteName: string;
  remoteBranch: string;
} {
  const short = value.replace(/^refs\/remotes\//, "");
  const slash = short.indexOf("/");
  if (slash < 0)
    return {
      display: short,
      canonical: value,
      remoteName: "",
      remoteBranch: "",
    };
  const remoteName = short.slice(0, slash);
  const remoteBranch = short.slice(slash + 1);
  return {
    display: remoteName + "/" + remoteBranch,
    canonical: "refs/remotes/" + remoteName + "/" + remoteBranch,
    remoteName,
    remoteBranch,
  };
}

function parseWorktrees(text: string): AlignmentFacts["worktrees"] {
  const output: AlignmentFacts["worktrees"] = [];
  let current: Partial<AlignmentFacts["worktrees"][number]> = {};
  const flush = (): void => {
    if (!current.path) return;
    output.push({
      path: resolve(current.path),
      branch: current.branch ?? "",
      detached: current.detached ?? false,
    });
    current = {};
  };
  for (const line of [...text.split(/\r?\n/), ""]) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1).trim();
    if (key === "worktree") current.path = value;
    else if (key === "branch")
      current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
  }
  return output;
}

function relation(root: string, local: string, remote: string): string {
  if (!local) return "missing_local_base";
  if (!remote) return "missing_remote_ref";
  if (local === remote) return "equal";
  const localAncestor = succeeds(root, [
    "merge-base",
    "--is-ancestor",
    local,
    remote,
  ]);
  const remoteAncestor = succeeds(root, [
    "merge-base",
    "--is-ancestor",
    remote,
    local,
  ]);
  if (localAncestor && !remoteAncestor) return "behind_ff_only";
  if (remoteAncestor && !localAncestor) return "ahead_contains_remote";
  return "diverged";
}

export function planAlignment(facts: AlignmentFacts): Record<string, unknown> {
  const {
    base_branch: base,
    base_remote_ref: remote,
    head_branch: head,
    primary_branch: primary,
    primary_clean: clean,
    base_relation: state,
    linked_base_holders: linked,
  } = facts;
  const owner = (action: string, reason: string, options: string[]) => ({
    state: "owner_decision",
    merge_scope_status: "待主人决策",
    recommended_action: action,
    reason,
    owner_options: options,
  });
  if (facts.fetch_error)
    return {
      state: "blocked",
      merge_scope_status: "阻断",
      recommended_action: "blocked_fetch_failed",
      reason: facts.fetch_error,
      owner_options: [],
    };
  if (linked.length)
    return {
      state: "blocked",
      merge_scope_status: "阻断",
      recommended_action: "blocked_linked_worktree_owns_base",
      reason:
        "base branch " +
        base +
        " is checked out in linked worktree " +
        linked[0],
      owner_options: [],
    };
  if (state === "missing_remote_ref")
    return {
      state: "blocked",
      merge_scope_status: "阻断",
      recommended_action: "blocked_missing_remote_ref",
      reason: "remote ref " + remote + " is missing or unresolved",
      owner_options: [],
    };
  if (primary === base) {
    if (!clean)
      return owner(
        "owner_decision_safe_align",
        "primary worktree is on " +
          base +
          " but has dirty or untracked changes",
        ["安全对齐", "保持阻断", "稍后处理"],
      );
    if (state === "equal")
      return {
        state: "aligned",
        merge_scope_status: "已更新",
        recommended_action: "none",
        reason: base + " already equals " + remote,
        owner_options: [],
      };
    if (state === "behind_ff_only")
      return {
        state: "auto_updatable",
        merge_scope_status: "待自动更新",
        recommended_action: "pull_ff_only",
        reason:
          base + " can fast-forward to " + remote + " in the primary worktree",
        owner_options: [],
      };
    if (state === "ahead_contains_remote" || state === "diverged")
      return owner(
        "owner_decision_safe_align",
        base +
          " is " +
          state +
          " relative to " +
          remote +
          " while checked out in the primary worktree",
        ["安全对齐", "保持阻断", "稍后处理"],
      );
  }
  if (state === "missing_local_base")
    return {
      state: "auto_updatable",
      merge_scope_status: "待自动更新",
      recommended_action: "create_tracking_ref",
      reason:
        "local base branch " + base + " is missing but " + remote + " exists",
      owner_options: [],
    };
  if (primary === head && head) {
    if (state === "equal" || state === "ahead_contains_remote")
      return {
        state: "aligned",
        merge_scope_status: "已更新",
        recommended_action: "none",
        reason: "local " + base + " already contains " + remote,
        owner_options: [],
      };
    if (!clean)
      return owner(
        "owner_decision_dirty_head_branch",
        "primary worktree is still on PR head branch " + head + " and is dirty",
        ["保持阻断", "稍后处理"],
      );
    if (state === "behind_ff_only")
      return {
        state: "auto_updatable",
        merge_scope_status: "待自动更新",
        recommended_action: "switch_then_pull_ff_only",
        reason:
          "primary worktree is on PR head branch " +
          head +
          "; switching to " +
          base +
          " and fast-forwarding is safe",
        owner_options: [],
      };
    return owner(
      "owner_decision_safe_align_later",
      "local " +
        base +
        " is " +
        state +
        " relative to " +
        remote +
        " while primary worktree is on " +
        head,
      ["安全对齐", "保持阻断", "稍后处理"],
    );
  }
  if (state === "equal" || state === "ahead_contains_remote")
    return {
      state: "aligned",
      merge_scope_status: "已更新",
      recommended_action: "none",
      reason: "local " + base + " already contains " + remote,
      owner_options: [],
    };
  if (state === "behind_ff_only")
    return {
      state: "auto_updatable",
      merge_scope_status: "待自动更新",
      recommended_action: "update_local_ref_ff_only",
      reason:
        "local " +
        base +
        " can fast-forward to " +
        remote +
        " without switching the primary worktree",
      owner_options: [],
    };
  return owner(
    "owner_decision_safe_align_later",
    "local " +
      base +
      " diverges from " +
      remote +
      " outside the checked-out primary branch",
    ["安全对齐", "保持阻断", "稍后处理"],
  );
}

export function inspectAlignment(args: BaseArgs): Record<string, unknown> {
  const root = resolve(args.repoRoot);
  const parsedRemote = remoteParts(args.baseRemoteRef);
  let fetchError = "";
  if (args.refreshRemote && parsedRemote.remoteName) {
    const result = spawnSync(
      "git",
      ["-C", root, "fetch", "--prune", parsedRemote.remoteName],
      {
        encoding: "utf8",
      },
    );
    if (result.status !== 0)
      fetchError = (result.stderr || result.stdout || "").trim();
  }
  const worktrees = parseWorktrees(
    git(root, ["worktree", "list", "--porcelain"]),
  );
  if (!worktrees.length)
    throw new Error("git worktree list returned no worktrees");
  const primary = worktrees[0]!;
  const local = git(
    root,
    ["rev-parse", "--verify", "refs/heads/" + args.baseBranch],
    false,
  );
  const remote = git(
    root,
    ["rev-parse", "--verify", parsedRemote.canonical],
    false,
  );
  const baseHolders = worktrees
    .filter((item) => item.branch === args.baseBranch)
    .map((item) => item.path);
  const linked = baseHolders.filter((path) => path !== primary.path);
  const facts: AlignmentFacts = {
    repo_root: root,
    base_branch: args.baseBranch,
    base_remote_ref: parsedRemote.display || args.baseRemoteRef,
    base_remote_name: parsedRemote.remoteName,
    base_remote_branch: parsedRemote.remoteBranch,
    head_branch: args.headBranch,
    primary_worktree: primary.path,
    primary_branch: git(primary.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    primary_clean: git(primary.path, ["status", "--porcelain"]) === "",
    worktrees,
    base_holders: baseHolders,
    linked_base_holders: linked,
    local_base_exists: Boolean(local),
    remote_base_exists: Boolean(remote),
    local_base_sha: local,
    remote_base_sha: remote,
    base_relation: relation(root, local, remote),
    fetch_error: fetchError,
  };
  return { ...facts, ...planAlignment(facts), mutation: "not_requested" };
}

export async function main(argv: string[]): Promise<number> {
  const command = argv.find((item) => !item.startsWith("--")) ?? "inspect";
  const value = (name: string, fallback = ""): string => {
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "--" + name) return argv[index + 1] ?? fallback;
      if (argv[index]?.startsWith("--" + name + "="))
        return argv[index]!.slice(name.length + 3);
    }
    return fallback;
  };
  try {
    const args: BaseArgs = {
      repoRoot: value("repo-root", process.cwd()),
      baseBranch: value("base-branch"),
      baseRemoteRef: value("base-remote-ref"),
      headBranch: value("head-branch"),
      refreshRemote: argv.includes("--refresh-remote"),
      backupBranch: value("backup-branch"),
    };
    let payload: Record<string, unknown>;
    let exitCode = 0;
    if (command === "inspect") payload = inspectAlignment(args);
    else if (command === "apply-auto") {
      const { applyAuto } = await import("./base_alignment_actions");
      [payload, exitCode] = applyAuto(args);
    } else if (command === "safe-align") {
      const { safeAlign } = await import("./base_alignment_actions");
      [payload, exitCode] = safeAlign(args);
    } else throw new Error("unsupported command: " + command);
    console.log(
      argv.includes("--pretty")
        ? JSON.stringify(payload, null, 2)
        : JSON.stringify(payload),
    );
    return exitCode;
  } catch (error) {
    console.error(
      "[ERROR] " + (error instanceof Error ? error.message : String(error)),
    );
    return 2;
  }
}
