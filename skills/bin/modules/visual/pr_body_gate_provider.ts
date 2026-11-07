import { backendFor } from "../hosting/backend";
import {
  normalizePullRequestFacts,
  type PullRequestFacts,
} from "../hosting/pull-request";
import { HostingError, type RepositoryBinding } from "../hosting/types";

export type PullRequest = {
  number: number;
  state: string;
  body: string;
  url: string;
  base_sha: string;
  base_ref: string;
  base_repository: string;
  head_sha: string;
  head_ref: string;
  merge_sha: string;
  head_repository: string;
  etag?: string;
  content_version?: number;
};

export function samePullRequestIdentity(
  left: PullRequest,
  right: PullRequest,
  includeBody = false,
): boolean {
  const same =
    left.number === right.number &&
    left.state === right.state &&
    left.url === right.url &&
    left.base_repository === right.base_repository &&
    left.base_ref === right.base_ref &&
    left.base_sha === right.base_sha &&
    left.head_repository === right.head_repository &&
    left.head_ref === right.head_ref &&
    left.head_sha === right.head_sha;
  return same && (!includeBody || left.body === right.body);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function readPullRequest(
  root: string,
  binding: RepositoryBinding,
  number: number,
): Promise<PullRequest> {
  const response = await backendFor(binding, { cwd: root }).request(
    `repos/${binding.fullName}/pulls/${number}`,
    { include: true, operation: "pr-facts" },
  );
  const payload = record(response.payload);
  if (!payload)
    throw new HostingError(
      "provider_request_failed",
      "PR response is not an object",
      "pr-facts",
    );
  const normalized: PullRequestFacts = normalizePullRequestFacts(
    payload,
    binding,
    number,
  );
  if (typeof payload.body !== "string")
    throw new HostingError(
      "provider_request_failed",
      "PR response body is missing or not a string",
      "pr-facts",
    );
  const facts: PullRequest = {
    number: normalized.number,
    state: normalized.state,
    body: payload.body,
    url: normalized.url,
    base_sha: normalized.base_sha,
    base_ref: normalized.base_ref,
    base_repository: normalized.base_repository,
    head_sha: normalized.head_sha,
    head_ref: normalized.head_ref,
    merge_sha: normalized.merge_sha ?? "",
    head_repository: normalized.head_repository,
    ...(response.etag ? { etag: response.etag } : {}),
    ...(Number.isSafeInteger(payload.content_version) &&
    (payload.content_version as number) >= 0
      ? { content_version: payload.content_version as number }
      : {}),
  };
  return facts;
}

export async function renderAndCheck(
  root: string,
  binding: RepositoryBinding,
  body: string,
  expectedUrls: string[],
): Promise<string[]> {
  const response = await backendFor(binding, { cwd: root }).request(
    "markdown",
    {
      method: "POST",
      data: { text: body, mode: "gfm", context: binding.fullName },
      operation: "markdown",
    },
  );
  const payload = response.payload;
  const html =
    typeof payload === "string" ? payload : stringValue(record(payload)?.html);
  if (!html) return ["missing_rendered_markdown"];
  const sections = [...html.matchAll(/<h2[^>]*>\s*Visual Evidence\s*<\/h2>/gi)];
  const start = sections[0]?.index;
  const end = start === undefined ? undefined : html.indexOf("<h2", start + 4);
  const managed =
    start === undefined
      ? ""
      : html.slice(start, end === undefined || end < 0 ? undefined : end);
  const urls = [...managed.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(
    (match) => match[1]!,
  );
  const reasons: string[] = [];
  if (sections.length !== 1)
    reasons.push("ambiguous_visual_evidence_html_section");
  if (JSON.stringify(urls) !== JSON.stringify(expectedUrls))
    reasons.push("html_image_url_mismatch");
  return reasons;
}
