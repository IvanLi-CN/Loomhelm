import { resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "../core/process";

export type CommandRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly cwd: string,
    readonly result: ProcessResult,
  ) {
    super(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
    this.name = "GitCommandError";
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  options: {
    check?: boolean;
    env?: Record<string, string | undefined>;
    runner?: CommandRunner | undefined;
  } = {},
): Promise<ProcessResult> {
  const runner = options.runner ?? runProcess;
  const request: ProcessRequest = {
    command: "git",
    args,
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
  };
  const result = await runner(request);
  if ((options.check ?? true) && result.exitCode !== 0)
    throw new GitCommandError(args, cwd, result);
  return result;
}

export function normalizePath(value: string): string {
  const trimmed = value.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? `${homedir()}/${trimmed.slice(2)}`
        : trimmed;
  return resolve(expanded);
}

export function normalizePathList(values: unknown): string[] {
  const input =
    typeof values === "string" ? [values] : Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || !value.trim()) continue;
    const path = normalizePath(value);
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

export function isUnder(path: string, parent: string): boolean {
  const child = normalizePath(path);
  const root = normalizePath(parent);
  const suffix = relative(root, child);
  return !suffix.startsWith("..") && !isAbsolute(suffix);
}

export function codexManagedPath(
  path: string,
  environ: Record<string, string | undefined> = process.env,
): boolean {
  const home = normalizePath(environ.CODEX_HOME ?? "~/.codex");
  return isUnder(path, resolve(home, "worktrees"));
}

export interface WorktreeRow {
  path: string;
  branch: string;
  detached: boolean;
  [key: string]: unknown;
}

export function parseWorktreePorcelain(text: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let current: Partial<WorktreeRow> = {};
  const finish = () => {
    if (!current.path) {
      current = {};
      return;
    }
    rows.push({
      ...current,
      path: normalizePath(current.path),
      branch: current.branch ?? "",
      detached: current.detached ?? false,
    });
    current = {};
  };
  for (const line of [...text.split(/\r?\n/), ""]) {
    if (!line.trim()) {
      finish();
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).trim();
    if (key === "worktree") current.path = value;
    else if (key === "branch")
      current.branch = value.startsWith("refs/heads/")
        ? value.slice("refs/heads/".length)
        : value;
    else if (key === "detached") current.detached = true;
    else current[key] = value;
  }
  return rows;
}

export async function worktreeIsClean(
  path: string,
  runner?: CommandRunner,
): Promise<boolean> {
  const result = await runGit(path, ["status", "--porcelain"], { runner });
  return result.stdout.trim() === "";
}
