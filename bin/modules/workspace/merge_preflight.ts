import { existsSync, statSync } from "node:fs";
import { parseArguments, writeJson } from "../core/cli";
import { runProcess } from "../core/process";
import { normalizePath } from "./worktree";
import {
  basePayload,
  command,
  CommandError,
  dedupe,
  defaultPrFacts,
  parsePorcelainV2,
  readUpstream,
  sha,
  shell,
  text,
} from "./merge_preflight_model";
import { recordPrFacts } from "./merge_preflight_facts";
import type {
  MergePreflightArgs,
  MergePreflightDeps,
  MergeRunner,
} from "./merge_preflight_model";

export const EXIT_ELIGIBLE = 0;
export const EXIT_BLOCKED = 2;
export const EXIT_INPUT_STALE = 3;
export const EXIT_INDETERMINATE = 4;
export const EXIT_USAGE = 64;

export type {
  MergePreflightArgs,
  MergePreflightDeps,
  MergeRunner,
} from "./merge_preflight_model";
export { CommandError, parsePorcelainV2 } from "./merge_preflight_model";

export async function evaluate(
  args: MergePreflightArgs,
  deps: MergePreflightDeps = {},
): Promise<[Record<string, unknown>, number]> {
  const runner = deps.runner ?? runProcess;
  const candidateInput = normalizePath(args.candidateRoot);
  const payload = basePayload(args, candidateInput);
  const reasons: string[] = [];
  if (!existsSync(candidateInput) || !statSync(candidateInput).isDirectory()) {
    (payload.errors as Record<string, unknown>[]).push({
      scope: "candidate",
      operation: "resolve_root",
      command: null,
      returncode: null,
      detail: "candidate-root is not an existing directory",
    });
    payload.reason_codes = ["candidate_unavailable"];
    return [payload, EXIT_INDETERMINATE];
  }
  let root: string;
  try {
    const rootResult = await command(
      ["git", "rev-parse", "--show-toplevel"],
      candidateInput,
      runner,
    );
    const rootText = rootResult.stdout.trim();
    if (!rootText)
      throw new CommandError(
        ["git", "rev-parse", "--show-toplevel"],
        candidateInput,
        0,
        "empty repository root",
      );
    root = normalizePath(rootText);
    const inside = await command(
      ["git", "rev-parse", "--is-inside-work-tree"],
      root,
      runner,
    );
    if (text(inside.stdout).toLowerCase() !== "true")
      throw new CommandError(
        ["git", "rev-parse", "--is-inside-work-tree"],
        root,
        0,
        "candidate is not a worktree",
      );
    (payload.candidate as Record<string, unknown>).root = root;
    (payload.worktree as Record<string, unknown>).root = root;
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? error
        : new CommandError(["git"], candidateInput, null, String(error));
    (payload.errors as Record<string, unknown>[]).push({
      scope: "git",
      operation: "resolve_worktree",
      command: shell(failure.argv),
      returncode: failure.returncode,
      detail: failure.detail.slice(0, 400),
    });
    payload.reason_codes = ["candidate_unavailable"];
    return [payload, EXIT_INDETERMINATE];
  }
  try {
    const raw = await (
      deps.getPrFacts ??
      ((repo, pr, cwd) => defaultPrFacts(repo, pr, cwd, runner))
    )(args.repo, args.pr, root);
    (payload.merge_guard as Record<string, unknown>).provider =
      raw.provider ?? null;
    reasons.push(
      ...recordPrFacts(payload, raw, args.repo).map(
        (reason) => "pr_facts_incomplete",
      ),
    );
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? error
        : new CommandError(["provider", "pr-facts"], root, null, String(error));
    (payload.errors as Record<string, unknown>[]).push({
      scope: "platform",
      operation: "pr_facts",
      command: shell(failure.argv),
      returncode: failure.returncode,
      detail: failure.detail.slice(0, 400),
    });
    payload.reason_codes = ["pr_facts_unavailable"];
    return [payload, EXIT_INDETERMINATE];
  }
  const candidate = payload.candidate as Record<string, unknown>;
  let localOid = "";
  try {
    const local = await command(
      [
        "git",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${candidate.local_ref}^{commit}`,
      ],
      root,
      runner,
      process.env,
      false,
    );
    localOid = sha(local.stdout);
    candidate.local_oid = localOid || null;
    if (local.exitCode !== 0 || !localOid)
      reasons.push("local_ref_unavailable");
    else await readUpstream(payload, root, runner);
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? error
        : new CommandError(["git", "rev-parse"], root, null, String(error));
    (payload.errors as Record<string, unknown>[]).push({
      scope: "git",
      operation: "local_ref",
      command: shell(failure.argv),
      returncode: failure.returncode,
      detail: failure.detail.slice(0, 400),
    });
    candidate.local_oid = localOid || null;
    reasons.push("local_ref_unavailable");
  }
  try {
    const status = await command(
      [
        "git",
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      root,
      runner,
    );
    const changed = parsePorcelainV2(status.stdout);
    const worktree = payload.worktree as Record<string, unknown>;
    worktree.changed = changed;
    worktree.clean = changed.length === 0;
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? error
        : new CommandError(["git", "status"], root, null, String(error));
    (payload.errors as Record<string, unknown>[]).push({
      scope: "git",
      operation: "status",
      command: shell(failure.argv),
      returncode: failure.returncode,
      detail: failure.detail.slice(0, 400),
    });
    reasons.push("worktree_unavailable");
  }
  const pr = payload.pr as Record<string, unknown>;
  const snapshot = payload.snapshot as Record<string, unknown>;
  const liveHead = sha(pr.head_oid);
  const liveBase = sha(pr.base_oid);
  snapshot.live_head = liveHead || null;
  snapshot.live_base = liveBase || null;
  (payload.merge_guard as Record<string, unknown>).locked_head =
    liveHead || null;
  if (snapshot.expected_head) {
    snapshot.head_matches = Boolean(
      liveHead && liveHead === snapshot.expected_head,
    );
    if (!snapshot.head_matches) reasons.push("expected_head_mismatch");
  }
  if (snapshot.expected_base) {
    snapshot.base_matches = Boolean(
      liveBase && liveBase === snapshot.expected_base,
    );
    if (!snapshot.base_matches) reasons.push("expected_base_mismatch");
  }
  const upstream = candidate.upstream as Record<string, unknown>;
  if (upstream.oid) {
    upstream.matches_local = localOid ? upstream.oid === localOid : null;
    upstream.matches_live_head = liveHead ? upstream.oid === liveHead : null;
  }
  if (localOid && liveHead && localOid !== liveHead)
    reasons.push("local_head_mismatch");
  if (
    reasons.some((reason) =>
      [
        "pr_facts_incomplete",
        "local_ref_unavailable",
        "worktree_unavailable",
      ].includes(reason),
    )
  ) {
    payload.outcome = "indeterminate";
    payload.reason_codes = dedupe(reasons);
    return [payload, EXIT_INDETERMINATE];
  }
  if (pr.state !== "OPEN") reasons.push("pr_not_open");
  if ((payload.worktree as Record<string, unknown>).clean === false)
    reasons.push("worktree_dirty");
  payload.reason_codes = dedupe(reasons);
  if (
    reasons.some((reason) => ["pr_not_open", "worktree_dirty"].includes(reason))
  ) {
    payload.outcome = "blocked";
    return [payload, EXIT_BLOCKED];
  }
  if (
    reasons.some((reason) =>
      [
        "expected_head_mismatch",
        "expected_base_mismatch",
        "local_head_mismatch",
      ].includes(reason),
    )
  ) {
    payload.outcome = "input_stale";
    return [payload, EXIT_INPUT_STALE];
  }
  if (reasons.length) {
    payload.outcome = "indeterminate";
    return [payload, EXIT_INDETERMINATE];
  }
  payload.outcome = "eligible";
  return [payload, EXIT_ELIGIBLE];
}

function option(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  const repo = option(parsed.options, "repo");
  const prText = option(parsed.options, "pr");
  const candidateRoot = option(parsed.options, "candidate-root");
  const pr = prText ? Number(prText) : NaN;
  if (!repo || !candidateRoot || !Number.isInteger(pr) || pr <= 0) {
    console.error("usage: --repo OWNER/REPO --pr NUMBER --candidate-root PATH");
    return EXIT_USAGE;
  }
  const args: MergePreflightArgs = {
    repo,
    pr,
    candidateRoot,
    localRef: option(parsed.options, "local-ref") ?? "HEAD",
  };
  const expectedHead = option(parsed.options, "expected-head");
  const expectedBase = option(parsed.options, "expected-base");
  if (expectedHead !== undefined) args.expectedHead = expectedHead;
  if (expectedBase !== undefined) args.expectedBase = expectedBase;
  try {
    const [payload, code] = await evaluate(args);
    if (parsed.options.has("pretty"))
      console.log(JSON.stringify(payload, null, 2));
    else writeJson(payload);
    return code;
  } catch (error) {
    const payload = basePayload(args, normalizePath(candidateRoot));
    payload.reason_codes = ["preflight_error"];
    payload.errors = [
      {
        scope: "preflight",
        operation: "evaluate",
        command: null,
        returncode: null,
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          400,
        ),
      },
    ];
    console.log(JSON.stringify(payload));
    return EXIT_INDETERMINATE;
  }
}

if (import.meta.main) process.exitCode = await main();
