import { execFileSync } from "node:child_process";
import { FlowError, stableHash } from "./common";

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new FlowError(`git command failed: git ${args.join(" ")}`, {
      cause: error,
    });
  }
}

export function gitCommit(repo: string, revision: string): string {
  const value = git(repo, ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (!/^[0-9a-f]{40}$/i.test(value))
    throw new FlowError(`git revision is not a commit: ${revision}`);
  return value.toLowerCase();
}

export function requireCleanCurrentHead(
  repo: string,
  requested?: string,
): [string, string] {
  if (git(repo, ["status", "--porcelain"]))
    throw new FlowError("repository has uncommitted changes");
  const head = gitCommit(repo, "HEAD");
  if (requested && gitCommit(repo, requested) !== head)
    throw new FlowError("requested head does not match the current HEAD");
  return [head, git(repo, ["rev-parse", "HEAD^{tree}"])];
}

export function gitIsAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repo,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function gitIsMovingRef(repo: string, revision: string): boolean {
  if (
    !/^(?:refs\/heads\/|refs\/remotes\/|origin\/|[A-Za-z0-9_.-]+$)/.test(
      revision,
    )
  )
    return false;
  const ref = revision.startsWith("refs/")
    ? revision
    : revision.startsWith("origin/")
      ? `refs/remotes/${revision}`
      : `refs/heads/${revision}`;
  try {
    git(repo, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitChangedPaths(
  repo: string,
  before: string,
  after: string,
): string[] {
  const output = git(repo, [
    "diff",
    "--name-only",
    "--no-renames",
    `${before}..${after}`,
  ]);
  return output ? output.split(/\r?\n/).filter(Boolean).sort() : [];
}

export function gitTree(repo: string, revision: string): string {
  return git(repo, ["rev-parse", `${revision}^{tree}`]);
}

export function gitPatchFingerprint(
  repo: string,
  before: string,
  after: string,
): string {
  return stableHash(
    git(repo, ["diff", "--no-ext-diff", "--binary", `${before}..${after}`]),
  );
}

export function gitLedgerRoot(repo: string): string {
  const path = git(repo, ["rev-parse", "--git-path", "codex-flow"]);
  return path.startsWith("/") ? path : `${repo}/${path}`;
}

export function classifyDelta(
  paths: string[],
  specChanged: boolean,
  mergeBefore: string,
  mergeAfter: string,
): { reusable: boolean; needs_attestation: boolean; reasons: string[] } {
  const normalized = paths
    .map((path) => path.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  const reasons: string[] = [];
  if (mergeBefore !== mergeAfter)
    reasons.push("effective_merge_result_changed");
  if (specChanged) reasons.push("spec_contract_changed");
  const prefixes = [
    ".github/workflows/",
    "skills/bin/",
    "src/",
    "lib/",
    "app/",
    "tests/",
    "test/",
    "skills/",
    "prompts/",
  ];
  const names = new Set([
    "AGENTS.md",
    "Dockerfile",
    "Makefile",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
    "pyproject.toml",
    "requirements.txt",
  ]);
  for (const path of normalized)
    if (names.has(path) || prefixes.some((prefix) => path.startsWith(prefix)))
      reasons.push(`effective_input_changed:${path}`);
  if (reasons.length)
    return {
      reusable: false,
      needs_attestation: false,
      reasons: [...new Set(reasons)].sort(),
    };
  if (!normalized.length)
    return { reusable: true, needs_attestation: false, reasons: ["no_delta"] };
  if (normalized.every(isProjectDocPath))
    return {
      reusable: true,
      needs_attestation: true,
      reasons: ["scoped_non_effective_delta"],
    };
  return {
    reusable: false,
    needs_attestation: false,
    reasons: ["unclassified_effective_input_delta"],
  };
}

function isProjectDocPath(path: string): boolean {
  return (
    path.startsWith("docs/") || path === "README.md" || path.endsWith(".md")
  );
}

export function specContractChanged(
  repo: string,
  before: string,
  after: string,
  paths: string[],
): boolean {
  return (
    paths.some(
      (path) => path.startsWith("docs/specs/") || path.startsWith("docs/adr/"),
    ) ||
    (gitPatchFingerprint(repo, before, after).length === 64 &&
      paths.some((path) => path.includes("SPEC.md")))
  );
}

export function effectiveMergeFingerprint(
  repo: string,
  base: string,
  head: string,
): string {
  return stableHash(git(repo, ["diff", "--no-ext-diff", `${base}...${head}`]));
}
