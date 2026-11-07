import { parseArguments, writeJson } from "../core/cli";
import {
  buildCloseoutContext,
  type CloseoutContextArgs,
} from "./closeout_context";

function option(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

function required(options: Map<string, string | true>, name: string): string {
  const value = option(options, name);
  if (!value) throw new Error(`missing required option: --${name}`);
  return value;
}

function repeated(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === `--${name}`) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) values.push(value);
      index += 1;
    } else if (token?.startsWith(`--${name}=`)) {
      values.push(token.slice(name.length + 3));
    }
  }
  return values;
}

function booleanOption(
  argv: string[],
  name: string,
  fallback: boolean,
): boolean {
  let value = fallback;
  for (const token of argv) {
    if (token === `--${name}`) value = true;
    if (token === `--no-${name}`) value = false;
  }
  return value;
}

function normalizeArguments(argv: string[]): string[] {
  const flags = new Set([
    "--pretty",
    "--pending-user-decision",
    "--no-pending-user-decision",
    "--remote-source-repo-unavailable",
    "--no-remote-source-repo-unavailable",
    "--port-scope-resolved",
    "--no-port-scope-resolved",
  ]);
  return [
    ...argv.filter((value) => !flags.has(value)),
    ...argv.filter((value) => flags.has(value)),
  ];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(normalizeArguments(argv));
    const requiredStatus =
      option(parsed.options, "pr-worktree-required") ?? "unknown";
    if (!["yes", "no", "unknown"].includes(requiredStatus))
      throw new Error(`invalid --pr-worktree-required: ${requiredStatus}`);
    const args: CloseoutContextArgs = {
      repoRoot: required(parsed.options, "repo-root"),
      featureBranch: option(parsed.options, "feature-branch") ?? "",
      prWorktreePath: option(parsed.options, "pr-worktree-path") ?? "",
      prWorktreeRequired: requiredStatus as "yes" | "no" | "unknown",
      requiredPrWorktreePaths: repeated(argv, "required-pr-worktree-path"),
      codexManagedWorktreePaths: repeated(argv, "codex-managed-worktree-path"),
      result: option(parsed.options, "result") ?? "merged",
      desiredCloseoutStatus:
        option(parsed.options, "desired-closeout-status") ?? "完成",
      pendingUserDecision: booleanOption(argv, "pending-user-decision", false),
      blockingReason: option(parsed.options, "blocking-reason") ?? "",
      remoteBranchStatus:
        option(parsed.options, "remote-branch-status") ?? "未检查",
      remoteSourceRepoUnavailable: booleanOption(
        argv,
        "remote-source-repo-unavailable",
        false,
      ),
      portLeaseStatus: option(parsed.options, "port-lease-status") ?? "未检查",
      portScopeResolved: booleanOption(argv, "port-scope-resolved", true),
    };
    const result = await buildCloseoutContext(args);
    if (parsed.options.has("pretty"))
      console.log(JSON.stringify(result, null, 2));
    else writeJson(result);
    return 0;
  } catch (error) {
    console.error(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
