import { parseArguments, writeJson } from "../core/cli";
import {
  buildLocalMergeCloseoutContext,
  type LocalMergeCloseoutArgs,
} from "./local_merge_closeout_context";

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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    const args: LocalMergeCloseoutArgs = {
      repoRoot: required(parsed.options, "repo-root"),
      baseBranch: required(parsed.options, "base-branch"),
      topicBranch: option(parsed.options, "topic-branch") ?? "",
      mergeWorktreePath: option(parsed.options, "merge-worktree-path") ?? "",
      desiredCloseoutStatus:
        option(parsed.options, "desired-closeout-status") ?? "完成",
      pendingCleanupAction:
        option(parsed.options, "pending-cleanup-action") ?? "none",
      dirtyWorktreePolicy:
        option(parsed.options, "dirty-worktree-policy") ?? "clean",
      topicBranchAction:
        option(parsed.options, "topic-branch-action") ?? "not_needed",
      blockingReason: option(parsed.options, "blocking-reason") ?? "",
      optionalPushStatus:
        option(parsed.options, "optional-push-status") ?? "未请求",
    };
    const result = await buildLocalMergeCloseoutContext(args);
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
