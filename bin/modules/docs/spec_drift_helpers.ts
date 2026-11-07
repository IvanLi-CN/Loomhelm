import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { gitText, runGit } from "./git";
import { checkSpec, type SpecIssue } from "./spec_contract";
import {
  currentHash,
  isImplementationPath,
  parseNameStatus,
  pathCountsAsSpecSync,
  relatedAdrPaths,
  type DriftPathContext,
  type RenamePair,
} from "./spec_drift_paths";
import type { DriftResult } from "./spec_drift_types";

export interface ChangeSet {
  changed: string[];
  worktreeChanged: string[];
  deleted: string[];
  renames: RenamePair[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function result(
  exitCode: 0 | 2 | 3,
  status: DriftResult["status"],
  drift: DriftResult["drift"],
  evidence: string,
  reason: string,
): DriftResult {
  return {
    exitCode,
    status,
    drift,
    evidence,
    reason,
    stdout:
      [
        `Spec同步状态=${status}`,
        `Spec漂移=${drift}`,
        `Spec同步证据=${evidence}`,
        `结束原因=${reason}`,
      ].join("\n") + "\n",
  };
}

function commandLines(output: string | null): string[] {
  return output?.split(/\r?\n/).filter(Boolean) ?? [];
}

function addStatus(change: ChangeSet, line: string, worktree: boolean): void {
  const parsed = parseNameStatus(line);
  if (!parsed) return;
  const paths = parsed.path2 ? [parsed.path1, parsed.path2] : [parsed.path1];
  change.changed.push(...paths);
  if (worktree) change.worktreeChanged.push(...paths);
  if (parsed.status.startsWith("R")) {
    change.deleted.push(parsed.path1);
    change.renames.push({
      oldPath: parsed.path1,
      newPath: parsed.path2 as string,
    });
  }
  if (parsed.status.startsWith("D")) change.deleted.push(parsed.path1);
}

export function collectChanges(repoRoot: string, baseRef: string): ChangeSet {
  const change: ChangeSet = {
    changed: [],
    worktreeChanged: [],
    deleted: [],
    renames: [],
  };
  for (const line of commandLines(
    gitText(repoRoot, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-status",
      "-M",
      `${baseRef}...HEAD`,
    ]),
  ))
    addStatus(change, line, false);
  for (const args of [
    ["-c", "core.quotepath=false", "diff", "--name-status", "-M"],
    ["-c", "core.quotepath=false", "diff", "--name-status", "-M", "--cached"],
  ])
    for (const line of commandLines(gitText(repoRoot, args)))
      addStatus(change, line, true);
  for (const path of commandLines(
    gitText(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
  )) {
    if (
      isImplementationPath(path) ||
      path.startsWith("docs/specs/") ||
      path.startsWith("docs/plan/")
    ) {
      change.changed.push(path);
      change.worktreeChanged.push(path);
    }
  }
  change.changed = unique(change.changed);
  change.worktreeChanged = unique(change.worktreeChanged);
  change.deleted = unique(change.deleted);
  return change;
}

function currentBranch(repoRoot: string): string {
  return (
    gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? "HEAD"
  );
}

export function resolveBase(
  repoRoot: string,
  requested?: string,
): string | null {
  if (requested)
    return runGit(repoRoot, ["rev-parse", "--verify", requested]).exitCode === 0
      ? requested
      : null;
  const upstream = gitText(repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ])?.trim();
  const branch = currentBranch(repoRoot);
  const remotes = commandLines(gitText(repoRoot, ["remote"]));
  const remoteHeads = remotes
    .map(
      (remote) =>
        gitText(repoRoot, [
          "symbolic-ref",
          "--quiet",
          "--short",
          `refs/remotes/${remote}/HEAD`,
        ])?.trim() ??
        ["main", "master", "trunk", "develop"]
          .map((candidate) => `${remote}/${candidate}`)
          .find(
            (ref) =>
              runGit(repoRoot, ["rev-parse", "--verify", `refs/remotes/${ref}`])
                .exitCode === 0,
          ) ??
        "",
    )
    .filter(Boolean);
  const remoteHead = remoteHeads[0];
  if (upstream && remoteHead && upstream === remoteHead) return upstream;
  if (
    upstream &&
    /^(main|master|trunk|develop|release\/|hotfix\/|support\/)/.test(
      upstream.split("/").slice(1).join("/"),
    )
  )
    return upstream;
  if (remoteHead && branch === remoteHead.split("/").slice(1).join("/"))
    return remoteHead;
  if (remoteHead) return remoteHead;
  for (const candidate of ["main", "master", "trunk", "develop"])
    if (runGit(repoRoot, ["rev-parse", "--verify", candidate]).exitCode === 0)
      return candidate;
  return null;
}

function evidenceEntry(repoRoot: string, path: string): string {
  return `${path}@${currentHash({ repoRoot, baseRef: "" } as DriftPathContext, path)}`;
}
export function evidence(repoRoot: string, paths: string[]): string {
  return unique(paths)
    .map((path) => evidenceEntry(repoRoot, path))
    .join(",");
}

export function normalizeRepoPath(
  repoRoot: string,
  path: string,
): string | null {
  const candidate = path.replaceAll("\\", "/");
  const absolute = resolve(repoRoot, candidate);
  const relativePath = relative(resolve(repoRoot), absolute).replaceAll(
    "\\",
    "/",
  );
  if (relativePath === "" || relativePath === ".") return ".";
  return relativePath === ".." || relativePath.startsWith("../")
    ? null
    : relativePath;
}

function specIssueText(issues: SpecIssue[]): string {
  return issues
    .map(
      (issue) =>
        `path=${issue.path} code=${issue.code} msg=${issue.message}${issue.line === undefined ? "" : ` line=${issue.line}`}`,
    )
    .join("; ");
}

function stagedText(repoRoot: string, path: string): string | null {
  return gitText(repoRoot, ["show", `:${path}`]);
}

function isRegular(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function frozenAdrCheck(
  context: DriftPathContext,
  specs: string[],
  raw: string | undefined,
): string | null {
  if (raw === undefined || raw === "") return null;
  if (
    raw !== "none" &&
    (raw.startsWith(",") || raw.endsWith(",") || raw.includes(",,"))
  )
    return "invalid frozen ADR refs: empty entry";
  const frozen = raw === "none" ? [] : raw.split(",");
  const paths: string[] = [];
  let previous = "";
  for (const entry of frozen) {
    const match =
      /^(docs\/adr\/[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)@([0-9a-f]{40})$/.exec(
        entry,
      );
    if (!match?.[1] || !match[2]) return "invalid frozen ADR ref";
    if (previous && match[1] <= previous)
      return "invalid frozen ADR refs: paths must be unique and sorted";
    previous = match[1];
    paths.push(match[1]);
    const path = resolve(context.repoRoot, match[1]);
    if (!isRegular(path))
      return `frozen ADR ref is not a regular candidate file: ${match[1]}`;
    const index =
      gitText(context.repoRoot, ["ls-files", "-s", "--", match[1]]) ?? "";
    const indexSha = /^(?:100644|100755)\s+([0-9a-f]{40})\s+0\s/.exec(
      index,
    )?.[1];
    if (!indexSha)
      return `frozen ADR ref is not a regular index file: ${match[1]}`;
    if (indexSha !== match[2])
      return `frozen ADR ref drifted in index: ${match[1]}`;
    if (currentHash(context, match[1]) !== match[2])
      return `frozen ADR ref drifted: ${match[1]}`;
  }
  const candidateMembership = new Set<string>();
  const indexMembership = new Set<string>();
  for (const spec of specs) {
    const current = resolve(context.repoRoot, spec);
    if (!isRegular(current))
      return `frozen ADR membership has no regular candidate Spec: ${spec}`;
    const currentText = readFileSync(current, "utf8");
    for (const path of relatedAdrPaths(currentText, false, false).paths)
      candidateMembership.add(path);
    const currentIndex =
      gitText(context.repoRoot, ["ls-files", "-s", "--", spec]) ?? "";
    if (
      currentIndex &&
      !/^(?:100644|100755)\s+[0-9a-f]{40}\s+0\s/.test(currentIndex)
    )
      return `frozen ADR membership has no regular index Spec: ${spec}`;
    const staged = stagedText(context.repoRoot, spec);
    if (currentIndex && staged === null)
      return `frozen ADR membership cannot read index Spec: ${spec}`;
    for (const path of relatedAdrPaths(staged ?? "", false, false).paths)
      indexMembership.add(path);
  }
  if ([...candidateMembership].sort().join("\n") !== paths.join("\n"))
    return "frozen ADR membership drifted across candidate Specs";
  if ([...indexMembership].sort().join("\n") !== paths.join("\n"))
    return "frozen ADR membership drifted in index across candidate Specs";
  return null;
}

export function relatedAdrTargets(
  repoRoot: string,
  changed: string[],
): string[] {
  const targets: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) visit(path);
        continue;
      }
      if (
        !entry.isFile() ||
        entry.name !== "SPEC.md" ||
        !path.includes("/docs/specs/")
      )
        continue;
      const text = readFileSync(path, "utf8");
      for (const adr of changed)
        if (text.includes(`../../${adr.slice("docs/".length)}`))
          targets.push(path.slice(repoRoot.length + 1));
    }
  }
  const root = resolve(repoRoot, "docs/specs");
  if (existsSync(root)) visit(root);
  return unique(targets);
}

export function strictCheck(repoRoot: string, spec: string): string | null {
  if (!existsSync(resolve(repoRoot, "bin/modules/docs/spec_contract.ts")))
    return null;
  const issues = checkSpec(resolve(repoRoot, spec), repoRoot);
  return issues.length ? specIssueText(issues) : null;
}

export function commitCoverage(
  context: DriftPathContext,
  specs: string[],
  worktreeSpec: Set<string>,
): string | null {
  const commits = commandLines(
    gitText(context.repoRoot, [
      "rev-list",
      "--topo-order",
      `${context.baseRef}..HEAD`,
    ]),
  );
  if (!commits.length) return null;
  const implCommits: string[] = [];
  const specCommits = new Map<string, string[]>();
  for (const spec of specs) specCommits.set(spec, []);
  for (const commit of commits) {
    const files = commandLines(
      gitText(context.repoRoot, [
        "show",
        "--pretty=format:",
        "--name-status",
        "--first-parent",
        commit,
      ]),
    );
    let implementation = false;
    for (const line of files) {
      const parsed = parseNameStatus(line);
      if (!parsed) continue;
      const paths = parsed.path2
        ? [parsed.path1, parsed.path2]
        : [parsed.path1];
      if (paths.some(isImplementationPath)) implementation = true;
      for (const [index, spec] of specs.entries())
        if (
          paths.some((path) => pathCountsAsSpecSync(path, dirname(spec), spec))
        )
          specCommits.get(spec)?.push(commit);
    }
    if (implementation) implCommits.push(commit);
  }
  for (const spec of specs) {
    if (worktreeSpec.has(spec)) continue;
    const associated = specCommits.get(spec) ?? [];
    if (implCommits.length && associated.length === 0)
      return `no associated spec commit found after implementation commits (${spec})`;
    for (const implementation of implCommits) {
      const covered = associated.some(
        (specCommit) =>
          runGit(context.repoRoot, [
            "merge-base",
            "--is-ancestor",
            implementation,
            specCommit,
          ]).exitCode === 0,
      );
      if (!covered)
        return `implementation changes are newer than associated spec commit (${spec})`;
    }
  }
  return null;
}
