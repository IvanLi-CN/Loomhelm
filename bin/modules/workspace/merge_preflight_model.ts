import { backendFor } from "../hosting/backend";
import { bindingFromRemote } from "../hosting/remote";
import type { ProcessRequest, ProcessResult } from "../core/process";

export interface MergePreflightArgs {
  repo: string;
  pr: number;
  candidateRoot: string;
  localRef?: string;
  expectedHead?: string;
  expectedBase?: string;
}

export type MergeRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface MergePreflightDeps {
  runner?: MergeRunner;
  getPrFacts?: (
    repo: string,
    pr: number,
    cwd: string,
  ) => Promise<Record<string, unknown>>;
}

export class CommandError extends Error {
  constructor(
    readonly argv: string[],
    readonly cwd: string | undefined,
    readonly returncode: number | null,
    readonly detail: string,
  ) {
    super(detail || `command exited with ${returncode}`);
    this.name = "CommandError";
  }
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sha(value: unknown): string {
  return text(value).toLowerCase();
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function shell(argv: string[]): string {
  return argv
    .map((value) =>
      /^[A-Za-z0-9_./:=@-]+$/.test(value)
        ? value
        : `'${value.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function command(
  argv: string[],
  cwd: string | undefined,
  runner: MergeRunner,
  env = process.env,
  check = true,
): Promise<ProcessResult> {
  let result: ProcessResult;
  try {
    result = await runner({
      command: argv[0]!,
      args: argv.slice(1),
      ...(cwd ? { cwd } : {}),
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (error) {
    throw new CommandError(
      argv,
      cwd,
      null,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (check && (result.exitCode !== 0 || result.timedOut))
    throw new CommandError(
      argv,
      cwd,
      result.timedOut ? null : result.exitCode,
      (result.stderr || result.stdout).trim(),
    );
  return result;
}

export async function defaultPrFacts(
  repo: string,
  pr: number,
  cwd: string,
  runner: MergeRunner,
): Promise<Record<string, unknown>> {
  const remote = await command(
    ["git", "remote", "get-url", "origin"],
    cwd,
    runner,
  );
  const binding = bindingFromRemote(remote.stdout.trim(), "origin");
  if (binding.fullName.toLowerCase() !== repo.toLowerCase())
    throw new CommandError(
      ["git", "remote", "get-url", "origin"],
      cwd,
      0,
      "origin remote does not match requested repository",
    );
  const response = await backendFor(binding, {
    cwd,
    runner: async (request) =>
      command(
        [request.command, ...request.args],
        request.cwd,
        runner,
        process.env,
        true,
      ),
  }).request(`repos/${binding.fullName}/pulls/${pr}`, {
    operation: "pr_facts",
  });
  const payload = record(response.payload);
  const base = record(payload.base);
  const head = record(payload.head);
  const headRepo = record(head.repo);
  const baseRepo = record(base.repo);
  const repositoryName = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    const candidate = record(value);
    const named =
      text(candidate.full_name) ||
      text(candidate.nameWithOwner) ||
      text(candidate.name_with_owner);
    if (named) return named;
    const url = text(candidate.html_url) || text(candidate.url);
    if (!url) return "";
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      return parts.length >= 2
        ? `${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`
        : "";
    } catch {
      return "";
    }
  };
  return {
    provider: binding.provider,
    number: payload.number,
    state: payload.state,
    baseRefName: payload.baseRefName ?? base.ref,
    baseRefOid: payload.baseRefOid ?? base.sha,
    baseRepository:
      typeof payload.baseRepository === "string"
        ? payload.baseRepository
        : repositoryName(baseRepo),
    headRefName: payload.headRefName ?? head.ref,
    headRefOid: payload.headRefOid ?? head.sha,
    headRepository:
      repositoryName(payload.headRepository) ||
      repositoryName(headRepo) ||
      undefined,
    isCrossRepository: payload.isCrossRepository,
    url: payload.html_url ?? payload.url,
  };
}

export function parsePorcelainV2(raw: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("? ")) {
      records.push({ kind: "untracked", path: line.slice(2), record: "?" });
      continue;
    }
    if (line.startsWith("u ")) {
      const parts = line.split(" ", 10);
      records.push({
        kind: "unmerged",
        path: parts[10] ?? parts.at(-1) ?? "",
        record: "u",
        xy: parts[1] ?? "",
      });
      continue;
    }
    if (line.startsWith("1 ")) {
      const parts = line.split(" ", 8);
      const submodule = parts[2]?.startsWith("S") ?? false;
      records.push({
        kind: submodule ? "submodule" : "tracked",
        path: parts[8] ?? parts.at(-1) ?? "",
        record: "1",
        xy: parts[1] ?? "",
        submodule,
      });
      continue;
    }
    if (line.startsWith("2 ")) {
      const [metadata, ...paths] = line.split("\t");
      const parts = metadata?.split(" ") ?? [];
      records.push({
        kind: "tracked_rename",
        path: paths[0] ?? parts.at(-1) ?? "",
        original_path: paths[1],
        record: "2",
        xy: parts[1] ?? "",
        submodule: parts[2]?.startsWith("S") ?? false,
      });
      continue;
    }
    records.push({ kind: "unknown", path: line, record: line[0] ?? "" });
  }
  return records;
}

export function basePayload(
  args: MergePreflightArgs,
  candidateInput: string,
): Record<string, unknown> {
  return {
    schema_version: 1,
    outcome: "indeterminate",
    reason_codes: [],
    errors: [],
    pr: {
      number: args.pr,
      state: null,
      url: null,
      base_ref: null,
      base_oid: null,
      head_ref: null,
      head_oid: null,
      source_branch: null,
      source_repository: null,
      is_cross_repository: null,
      base: { ref: null, oid: null },
      head: { ref: null, oid: null, repository: null },
    },
    candidate: {
      input_root: candidateInput,
      root: null,
      local_ref: args.localRef ?? "HEAD",
      local_oid: null,
      upstream: {
        ref: null,
        oid: null,
        available: false,
        reason: "not_configured",
        matches_local: null,
        matches_live_head: null,
      },
    },
    worktree: {
      root: null,
      clean: null,
      status_format: "porcelain-v2",
      untracked_mode: "all",
      ignored_changes_excluded: true,
      submodule_changes_included: true,
      changed: [],
    },
    snapshot: {
      expected_head: sha(args.expectedHead) || null,
      expected_base: sha(args.expectedBase) || null,
      live_head: null,
      live_base: null,
      head_matches: null,
      base_matches: null,
    },
    merge_guard: { kind: "expected_head", provider: null, locked_head: null },
    validation: "not_evaluated",
  };
}

export async function readUpstream(
  payload: Record<string, unknown>,
  root: string,
  runner: MergeRunner,
): Promise<void> {
  const candidate = payload.candidate as Record<string, unknown>;
  const upstream = candidate.upstream as Record<string, unknown>;
  const ref = String(candidate.local_ref);
  const refResult = await command(
    [
      "git",
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "--verify",
      "--end-of-options",
      `${ref}@{upstream}`,
    ],
    root,
    runner,
    process.env,
    false,
  );
  if (refResult.exitCode !== 0 || !text(refResult.stdout)) return;
  const upstreamRef = text(refResult.stdout);
  upstream.ref = upstreamRef;
  const oidResult = await command(
    [
      "git",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${upstreamRef}^{commit}`,
    ],
    root,
    runner,
    process.env,
    false,
  );
  const upstreamOid = sha(oidResult.stdout);
  upstream.oid = upstreamOid || null;
  upstream.available = Boolean(upstreamOid);
  upstream.reason = upstreamOid ? "available" : "ref_unavailable";
}
