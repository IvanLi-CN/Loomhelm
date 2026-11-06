import { execFileSync } from "node:child_process";
import { bindingFromRemote } from "./remote";
import { HostingError, type RepositoryBinding } from "./types";

export interface PullRequestFacts {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
  base_sha: string;
  base_ref: string;
  base_repository: string;
  head_sha: string;
  head_ref: string;
  head_repository: string;
  merge_sha?: string;
  merged_at?: string;
}

export interface BoundPullRequest {
  binding: RepositoryBinding;
  number: number;
  facts: PullRequestFacts;
}

export function readLivePullRequest(
  repo: string,
  prRef: string,
  remote = "origin",
): BoundPullRequest {
  const selectedRemote = readRemote(repo, remote);
  const binding = bindingFromRemote(selectedRemote.url, selectedRemote.name);
  return readLivePullRequestForBinding(repo, binding, prRef);
}

export function readLivePullRequestForBinding(
  repo: string,
  binding: RepositoryBinding,
  prRef: string,
): BoundPullRequest {
  const number = parsePullRequestNumber(prRef, binding);
  const payload = requestPullRequest(repo, binding, number);
  return {
    binding,
    number,
    facts: normalizePullRequestFacts(payload, binding, number),
  };
}

export function pullRequestNumber(payload: unknown): number {
  if (!isRecord(payload)) throw invalidFacts();
  const number = payload.number;
  if (!Number.isSafeInteger(number) || (number as number) < 1)
    throw invalidFacts();
  return number as number;
}

export function normalizePullRequestFacts(
  payload: unknown,
  binding: RepositoryBinding,
  expectedNumber: number,
): PullRequestFacts {
  if (!isRecord(payload)) throw invalidFacts();
  const number = pullRequestNumber(payload);
  if (number !== expectedNumber) throw invalidFacts();
  const base = isRecord(payload.base) ? payload.base : undefined;
  const head = isRecord(payload.head) ? payload.head : undefined;
  const baseSha = sha(base?.sha ?? payload.base_sha);
  const headSha = sha(head?.sha ?? payload.head_sha);
  const baseRef = nonEmptyString(base?.ref ?? payload.base_ref);
  const headRef = nonEmptyString(head?.ref ?? payload.head_ref);
  const baseRepository = repositoryName(
    recordValue(base?.repo, "full_name") ??
      recordValue(base?.repo, "html_url") ??
      recordValue(base?.repo, "url") ??
      payload.base_repository,
    binding,
  );
  const headRepository = repositoryName(
    recordValue(head?.repo, "full_name") ??
      recordValue(head?.repo, "html_url") ??
      recordValue(head?.repo, "url") ??
      payload.head_repository,
    binding,
  );
  const url = canonicalPullRequestUrl(payload.html_url, binding, number);
  if (
    !baseSha ||
    !headSha ||
    !baseRef ||
    !headRef ||
    !baseRepository ||
    !headRepository ||
    baseRepository.toLowerCase() !== binding.fullName.toLowerCase()
  )
    throw invalidFacts();
  const mergedAt =
    typeof payload.merged_at === "string"
      ? payload.merged_at.trim()
      : undefined;
  if (
    mergedAt !== undefined &&
    (!mergedAt ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        mergedAt,
      ) ||
      Number.isNaN(Date.parse(mergedAt)))
  )
    throw invalidFacts();
  const state =
    payload.merged === true || mergedAt
      ? "MERGED"
      : String(payload.state ?? "").toUpperCase() === "OPEN"
        ? "OPEN"
        : String(payload.state ?? "").toUpperCase() === "CLOSED"
          ? "CLOSED"
          : "UNKNOWN";
  const mergeValue = payload.merge_commit_sha ?? payload.merge_sha;
  const merge =
    mergeValue === undefined || mergeValue === null || mergeValue === ""
      ? undefined
      : sha(mergeValue);
  if (
    mergeValue !== undefined &&
    mergeValue !== null &&
    mergeValue !== "" &&
    !merge
  )
    throw invalidFacts();
  return {
    number,
    url,
    state,
    base_sha: baseSha,
    base_ref: baseRef,
    base_repository: baseRepository,
    head_sha: headSha,
    head_ref: headRef,
    head_repository: headRepository,
    ...(merge ? { merge_sha: merge } : {}),
    ...(mergedAt ? { merged_at: mergedAt } : {}),
  };
}

export function assertPullRequestResponse(
  payload: unknown,
  binding: RepositoryBinding,
  expectedNumber: number,
  expectedBody?: string,
  operation = "pr-edit",
): PullRequestFacts {
  const facts = normalizePullRequestFacts(payload, binding, expectedNumber);
  if (
    expectedBody !== undefined &&
    (!isRecord(payload) || payload.body !== expectedBody)
  )
    throw new HostingError(
      "provider_request_failed",
      "provider PR response does not confirm the requested body",
      operation,
    );
  return facts;
}

export function bindingForLedger(
  binding: RepositoryBinding,
): Record<string, string> {
  return {
    provider: binding.provider,
    host: binding.host,
    owner: binding.owner,
    repo: binding.repo,
    full_name: binding.fullName,
    remote: binding.remote,
    web_origin: binding.webOrigin,
    api_origin: binding.apiOrigin,
    web_url: binding.webUrl,
  };
}

function readRemote(
  repo: string,
  remote: string,
): { name: string; url: string } {
  try {
    const url = execFileSync(
      "git",
      ["config", "--get", `remote.${remote}.url`],
      {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!url) throw new Error("empty remote");
    return { name: remote, url };
  } catch (error) {
    throw new HostingError(
      "invalid_remote",
      "selected Git remote is unavailable",
      "bind_pr",
      {
        cause: error instanceof Error ? error.name : "unknown",
      },
    );
  }
}

function parsePullRequestNumber(
  raw: string,
  binding: RepositoryBinding,
): number {
  const value = raw.trim();
  let numberText: string | undefined;
  const short = /^PR#(\d+)$/.exec(value);
  if (short) numberText = short[1];
  const qualified = /^([^/]+\/[^#]+)#(\d+)$/.exec(value);
  if (qualified) {
    if (qualified[1] !== binding.fullName)
      throw new HostingError(
        "invalid_pr",
        "PR ref is outside the bound repository",
        "bind_pr",
      );
    numberText = qualified[2];
  }
  if (/^https?:\/\//.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HostingError("invalid_pr", "PR ref is malformed", "bind_pr");
    }
    const match = new RegExp(
      `^/${escapeRegExp(binding.owner)}/${escapeRegExp(binding.repo)}/pulls?/(\\d+)/?$`,
      "i",
    ).exec(url.pathname);
    if (url.hostname.toLowerCase() !== binding.host || !match?.[1])
      throw new HostingError(
        "invalid_pr",
        "PR ref is outside the bound repository",
        "bind_pr",
      );
    numberText = match[1];
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new HostingError("invalid_pr", "PR ref is invalid", "bind_pr");
  return number;
}

function requestPullRequest(
  repo: string,
  binding: RepositoryBinding,
  number: number,
): unknown {
  const endpoint = `repos/${binding.fullName}/pulls/${number}`;
  const command = binding.provider === "github" ? "gh" : "tea";
  const args =
    binding.provider === "github"
      ? ["api", endpoint, "--method", "GET"]
      : ["api", "--remote", binding.remote, "--method", "GET", endpoint];
  try {
    const stdout = execFileSync(command, args, {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new HostingError(
      "provider_request_failed",
      "live PR facts are unavailable",
      "bind_pr",
      {
        provider: binding.provider,
        cause: error instanceof Error ? error.name : "unknown",
      },
    );
  }
}

function sha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function repositoryName(
  value: unknown,
  binding: RepositoryBinding,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const normalized = value.trim();
  const parts = normalized.split("/");
  if (
    parts.length === 2 &&
    parts.every((part) => part && !/[%\\?#\0-\x1f\x7f]/.test(part))
  )
    return normalized;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== binding.host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return;
  const urlParts = url.pathname.split("/").filter(Boolean);
  const reposIndex = urlParts.indexOf("repos");
  const repositoryParts =
    reposIndex >= 0 && urlParts.length === reposIndex + 3
      ? urlParts.slice(reposIndex + 1)
      : urlParts.length === 2
        ? urlParts
        : undefined;
  if (
    !repositoryParts ||
    repositoryParts.length !== 2 ||
    repositoryParts[1]?.endsWith("/") ||
    repositoryParts.some((part) => !part || /[%\\?#\0-\x1f\x7f]/.test(part))
  )
    return;
  return repositoryParts.map((part) => part.replace(/\.git$/, "")).join("/");
}

function canonicalPullRequestUrl(
  value: unknown,
  binding: RepositoryBinding,
  number: number,
): string {
  if (typeof value !== "string" || !value.trim()) throw invalidFacts();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidFacts();
  }
  const expected = new RegExp(
    `^/${escapeRegExp(binding.owner)}/${escapeRegExp(binding.repo)}/pulls?/${number}$`,
    "i",
  );
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== binding.host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !expected.test(url.pathname)
  )
    throw invalidFacts();
  return url.toString();
}

function invalidFacts(): HostingError {
  return new HostingError(
    "provider_request_failed",
    "live PR facts are invalid",
    "bind_pr",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
