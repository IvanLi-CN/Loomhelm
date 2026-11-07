import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseArguments, writeJson } from "../core/cli";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "../core/process";
import { normalizePath, parseWorktreePorcelain } from "./worktree";
import { createCandidateSandbox } from "./candidate_sandbox";
export const EXPECTED_GITHUB_OWNER = "ivanli-cn";
export const EXPECTED_GITHUB_REPO = "dot-codex";
export const REQUIRED_SURFACES = ["config.toml", "agents", "skills"] as const;
const GIT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);
export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}
export interface GitState {
  root: string;
  gitDir: string;
  commonDir: string;
  primaryWorktree: string;
  isLinkedWorktree: boolean;
}
export type CandidateRunner = (
  request: ProcessRequest,
) => Promise<ProcessResult>;
export interface FixedCheck {
  name: string;
  argv: string[];
}
export interface CandidateContextOptions {
  environ?: Record<string, string | undefined>;
  runner?: CandidateRunner;
  fixedChecks?: (candidate: string) => FixedCheck[];
  runtimeHome?: string;
}
export function sanitizedEnvironment(
  environ: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const clean = { ...environ };
  for (const name of Object.keys(clean))
    if (GIT_VARIABLES.has(name) || name.startsWith("GIT_CONFIG_"))
      delete clean[name];
  return clean;
}
async function git(
  cwd: string,
  args: string[],
  environ: Record<string, string | undefined>,
  runner: CandidateRunner,
  check = true,
): Promise<ProcessResult> {
  const result = await runner({
    command: "git",
    args,
    cwd,
    env: sanitizedEnvironment(environ),
  });
  if (check && result.exitCode !== 0)
    throw new ContextError(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result;
}

function resolveGitPath(cwd: string, raw: string): string {
  return normalizePath(
    raw === "~" || raw.startsWith("~/") || raw.startsWith("/")
      ? raw
      : resolve(cwd, raw),
  );
}

export async function gitState(
  cwd: string,
  environ: Record<string, string | undefined> = process.env,
  runner: CandidateRunner = runProcess,
): Promise<GitState | undefined> {
  const rootResult = await git(
    cwd,
    ["rev-parse", "--show-toplevel"],
    environ,
    runner,
    false,
  );
  if (rootResult.exitCode !== 0) return undefined;
  const root = normalizePath(rootResult.stdout.trim());
  const gitDir = resolveGitPath(
    cwd,
    (await git(cwd, ["rev-parse", "--git-dir"], environ, runner)).stdout.trim(),
  );
  const commonDir = resolveGitPath(
    cwd,
    (
      await git(cwd, ["rev-parse", "--git-common-dir"], environ, runner)
    ).stdout.trim(),
  );
  let primaryWorktree: string;
  if (commonDir.endsWith("/.git") || commonDir.endsWith("\\.git"))
    primaryWorktree = resolve(commonDir, "..");
  else {
    const listing = (
      await git(cwd, ["worktree", "list", "--porcelain"], environ, runner)
    ).stdout;
    const first = parseWorktreePorcelain(listing)[0]?.path;
    if (!first)
      throw new ContextError("unable to resolve the primary Git worktree");
    primaryWorktree = first;
  }
  return {
    root,
    gitDir,
    commonDir,
    primaryWorktree: normalizePath(primaryWorktree),
    isLinkedWorktree: gitDir !== commonDir,
  };
}

function githubIdentity(remote: string): [string, string, string] | undefined {
  const scp = /^git@([^:]+):(.+)$/.exec(remote);
  let host: string | undefined;
  let path: string | undefined;
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const url = new URL(remote);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  }
  const parts = (path ?? "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  return parts.length === 2 && parts.every(Boolean) && host
    ? [host.toLowerCase(), parts[0]!.toLowerCase(), parts[1]!.toLowerCase()]
    : undefined;
}

export async function isDotCodex(
  state: GitState | undefined,
  environ: Record<string, string | undefined> = process.env,
  runner: CandidateRunner = runProcess,
): Promise<boolean> {
  if (
    !state ||
    !REQUIRED_SURFACES.every((surface) =>
      existsSync(resolve(state.root, surface)),
    )
  )
    return false;
  const remote = await git(
    state.root,
    ["remote", "get-url", "origin"],
    environ,
    runner,
    false,
  );
  return (
    remote.exitCode === 0 &&
    githubIdentity(remote.stdout.trim())?.join("/") ===
      `github.com/${EXPECTED_GITHUB_OWNER}/${EXPECTED_GITHUB_REPO}`
  );
}

function runtimeHome(
  environ: Record<string, string | undefined>,
  override?: string,
): string {
  return normalizePath(
    override ?? environ.CODEX_HOME ?? resolve(homedir(), ".codex"),
  );
}

export async function inspectContext(
  cwd: string,
  mode: "read" | "write",
  options: CandidateContextOptions = {},
): Promise<Record<string, unknown>> {
  if (mode !== "read" && mode !== "write")
    throw new ContextError(`unsupported mode: ${mode}`);
  const resolvedCwd = normalizePath(cwd);
  const environ = options.environ ?? process.env;
  const runner = options.runner ?? runProcess;
  const activeRuntime = runtimeHome(environ, options.runtimeHome);
  const current = await gitState(resolvedCwd, environ, runner);
  const currentIsDotCodex = await isDotCodex(current, environ, runner);
  const runtime = existsSync(activeRuntime)
    ? await gitState(activeRuntime, environ, runner)
    : undefined;
  const runtimeIsDotCodex = await isDotCodex(runtime, environ, runner);
  const candidate =
    currentIsDotCodex && current?.isLinkedWorktree ? current.root : undefined;
  const primary =
    currentIsDotCodex && current
      ? current.primaryWorktree
      : runtimeIsDotCodex && runtime
        ? runtime.primaryWorktree
        : undefined;
  let denial: string | undefined;
  if (!current) denial = "current directory is not inside a Git worktree";
  else if (!currentIsDotCodex)
    denial = "current Git worktree is not IvanLi-CN/dot-codex";
  else if (!current.isLinkedWorktree)
    denial =
      "the primary dot-codex worktree is runtime state, not a write target";
  else if (!runtime || !runtimeIsDotCodex)
    denial = "the active runtime CODEX_HOME is not IvanLi-CN/dot-codex";
  else if (current.commonDir !== runtime.commonDir)
    denial =
      "the candidate and active runtime CODEX_HOME are not the same Git repository";
  else if (current.root === runtime.root)
    denial = "the candidate worktree is the active runtime CODEX_HOME";
  const payload = {
    ok: true,
    mode,
    cwd: resolvedCwd,
    repository_root: current?.root ?? null,
    candidate_root: candidate ?? null,
    primary_worktree: primary ?? null,
    git_metadata_root: current?.commonDir ?? null,
    runtime_home: activeRuntime,
    runtime_is_dot_codex: runtimeIsDotCodex,
    is_dot_codex: currentIsDotCodex,
    is_linked_worktree: current?.isLinkedWorktree ?? false,
    write_allowed: !denial,
    denial_reason: denial ?? null,
  };
  if (mode === "write" && denial) throw new ContextError(denial);
  return payload;
}

export function fixedChecks(candidate: string): FixedCheck[] {
  const test = (...paths: string[]): string[] => [
    process.execPath,
    "test",
    ...paths.map((path) => resolve(candidate, path)),
  ];
  // Runtime dashboard tests need local sockets and DOM setup; their package gate runs outside this offline sandbox.
  return [
    {
      name: "repository-contracts",
      argv: test(
        "skills/bin/tests/core/package_scripts.test.ts",
        "skills/bin/tests/flow/profile.test.ts",
        "skills/bin/tests/flow/flow.test.ts",
        "skills/bin/tests/checks/checks.test.ts",
        "skills/bin/tests/checks/multi-task-flow.test.ts",
        "skills/bin/tests/workspace/workspace.test.ts",
      ),
    },
    {
      name: "skills-index",
      argv: [
        process.execPath,
        "run",
        resolve(candidate, "skills/bin/skills_index_check.ts"),
        "--repo-root",
        candidate,
      ],
    },
    {
      name: "plan-contracts",
      argv: test(
        "skills/bin/tests/plan/shell.test.ts",
        "skills/bin/tests/plan/multi-task-flow.test.ts",
        "skills/bin/tests/plan/orchestration.test.ts",
        "skills/bin/tests/plan/acceptance.test.ts",
        "skills/bin/tests/plan/review.test.ts",
        "skills/bin/tests/plan/task_migration.test.ts",
      ),
    },
    {
      name: "source-policy",
      argv: [
        process.execPath,
        "run",
        resolve(candidate, "skills/bin/check_source_policy.ts"),
      ],
    },
    { name: "typecheck", argv: [process.execPath, "check"] },
  ].map((check) => ({
    ...check,
    argv: check.argv.map((value) =>
      value === "skills/bin/tests/workspace" ? resolve(candidate, value) : value,
    ),
  }));
}

export async function validateCandidate(
  cwd: string,
  options: CandidateContextOptions = {},
): Promise<Record<string, unknown>> {
  const environ = { ...(options.environ ?? process.env) };
  const runner = options.runner ?? runProcess;
  const context = await inspectContext(cwd, "write", {
    ...options,
    environ,
    runner,
  });
  const candidate = String(context.candidate_root);
  const checks = options.fixedChecks?.(candidate) ?? fixedChecks(candidate);
  const results: Record<string, unknown>[] = [];
  const sandbox = createCandidateSandbox(
    candidate,
    environ,
    runner,
    typeof context.git_metadata_root === "string"
      ? [context.git_metadata_root]
      : [],
  );
  sandbox.environment.PYTHONDONTWRITEBYTECODE = "1";
  try {
    for (const check of checks) {
      const result = await sandbox.run({
        command: check.argv[0]!,
        args: check.argv.slice(1),
        cwd: candidate,
        env: sandbox.environment,
      });
      results.push({
        name: check.name,
        argv: check.argv,
        returncode: result.exitCode,
        stdout: sandbox.redactOutput(result.stdout),
        stderr: sandbox.redactOutput(result.stderr),
      });
      if (result.exitCode !== 0) break;
    }
  } finally {
    sandbox.cleanup();
  }
  return {
    ok:
      results.length === checks.length &&
      results.every((result) => result.returncode === 0),
    context,
    checks: results,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments([
    ...argv.filter((value) => value !== "--pretty"),
    ...argv.filter((value) => value === "--pretty"),
  ]);
  const command = parsed.positional[0];
  const cwd = parsed.options.get("cwd");
  const mode = parsed.options.get("mode");
  if (
    typeof cwd !== "string" ||
    (command !== "inspect" && command !== "validate") ||
    (command === "inspect" && mode !== "read" && mode !== "write")
  ) {
    console.error("usage: inspect|validate --cwd PATH [--mode read|write]");
    return 2;
  }
  try {
    const result =
      command === "inspect"
        ? await inspectContext(cwd, mode as "read" | "write")
        : await validateCandidate(cwd);
    if (parsed.options.has("pretty"))
      console.log(JSON.stringify(result, null, 2));
    else writeJson(result);
    return result.ok === false ? 1 : 0;
  } catch (error) {
    writeJson({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
