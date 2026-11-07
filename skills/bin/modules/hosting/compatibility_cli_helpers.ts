import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { bindingFromRemote } from "./remote";
import type { PullRequestFacts } from "./pull-request";
import { HostingError, type RepositoryBinding } from "./types";
import { option } from "../../compatibility_shared";
import { requiredShaValue } from "./compatibility_helpers";

export function requiredOption(
  argv: string[],
  name: string,
  operation: string,
): string {
  const value = option(argv, name);
  if (!value?.trim())
    throw new HostingError(
      "invalid_arguments",
      `--${name} is required`,
      operation,
    );
  return value.trim();
}

export function requiredSha(
  argv: string[],
  name: string,
  operation: string,
): string {
  return requiredShaValue(
    requiredOption(argv, name, operation),
    name,
    operation,
  );
}

export function positiveNumber(
  argv: string[],
  name: string,
  operation: string,
): number {
  const value = Number(requiredOption(argv, name, operation));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HostingError(
      "invalid_arguments",
      `--${name} must be a positive integer`,
      operation,
    );
  return value;
}

export function readTextFile(
  argv: string[],
  name: "body-file" | "text-file" | "note-file",
  operation: string,
): string {
  const path = requiredOption(argv, name, operation);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new HostingError(
      "input_unavailable",
      "body file could not be read",
      operation,
    );
  }
}

export function readBody(argv: string[], operation: string): string {
  return readTextFile(argv, "body-file", operation);
}

export function bindingForRemote(root: string, remote: string) {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["-C", root, "config", "--get", `remote.${remote}.url`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    throw new HostingError(
      "invalid_remote",
      "selected Git remote is unavailable",
      "resolve",
      { remote },
    );
  }
  if (!raw)
    throw new HostingError(
      "invalid_remote",
      "selected Git remote is empty",
      "resolve",
      { remote },
    );
  return bindingFromRemote(raw, remote);
}

export function operationError(error: unknown): void {
  if (error instanceof HostingError) {
    console.error(
      JSON.stringify({
        schema_version: 1,
        operation: error.operation,
        outcome: error.code,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      }),
    );
    return;
  }
  console.error(
    JSON.stringify({
      schema_version: 1,
      operation: "unknown",
      outcome: "error",
      error: {
        code: "unexpected_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
}

export function missingOperation(): number {
  operationError(
    new HostingError("invalid_arguments", "an operation is required"),
  );
  return 2;
}

export function mergeRequestFor(
  provider: "github" | "gitea",
  expectedHead: string,
  method: string,
): { method: "PUT" | "POST"; data: Record<string, string> } {
  return provider === "gitea"
    ? { method: "POST", data: { head_commit_id: expectedHead, do: method } }
    : { method: "PUT", data: { sha: expectedHead, merge_method: method } };
}

export function mergeConfirmationMatches(
  before: PullRequestFacts,
  after: PullRequestFacts,
  expectedHead: string,
): boolean {
  return (
    after.state === "MERGED" &&
    after.base_ref === before.base_ref &&
    after.head_sha === expectedHead &&
    Boolean(after.merge_sha)
  );
}

export function branchEndpointFor(
  binding: { provider: "github" | "gitea"; fullName: string },
  branch: string,
): string {
  const path = binding.provider === "github" ? "git/refs/heads" : "branches";
  return `repos/${binding.fullName}/${path}/${encodeURIComponent(branch)}`;
}

export function requiredProviderObject(
  payload: unknown,
  operation: string,
): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new HostingError(
      "invalid_provider_response",
      "provider response is not an object",
      operation,
    );
  const result = payload as Record<string, unknown>;
  const identities = ["login", "login_name", "username"]
    .map((key) => result[key])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!identities.length || new Set(identities).size !== 1)
    throw new HostingError(
      "invalid_provider_response",
      "provider identity response does not contain one stable login",
      operation,
    );
  return result;
}
