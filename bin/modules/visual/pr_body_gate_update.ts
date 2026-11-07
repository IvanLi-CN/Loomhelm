import { backendFor } from "../hosting/backend";
import { type RepositoryBinding } from "../hosting/types";
import {
  readPullRequest,
  samePullRequestIdentity,
  type PullRequest,
} from "./pr_body_gate_provider";

export class PullRequestUpdateError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "PullRequestUpdateError";
  }
}

export function bodyUpdateRequest(
  base: RepositoryBinding,
  current: PullRequest,
  rewritten: string,
): {
  data: { body: string; content_version?: number };
  headers?: Record<string, string>;
} {
  if (base.provider === "github") {
    // GitHub's pull-request PATCH endpoint rejects conditional request
    // headers (including If-Match). The caller performs an identity/body
    // refresh before and after this update as the provider-compatible
    // conflict boundary; this is not an atomic compare-and-swap.
    return { data: { body: rewritten } };
  }
  if (
    current.content_version === undefined ||
    !Number.isSafeInteger(current.content_version) ||
    current.content_version < 0
  )
    throw new PullRequestUpdateError(
      "pr_body_update_requires_provider_content_version",
    );
  return {
    data: { body: rewritten, content_version: current.content_version },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function updatePullRequestBody(
  root: string,
  base: RepositoryBinding,
  pr: PullRequest,
  rewritten: string,
): Promise<void> {
  let current: PullRequest;
  try {
    current = await readPullRequest(root, base, pr.number);
  } catch (error) {
    throw new PullRequestUpdateError(
      `pr_identity_refresh_failed:${errorMessage(error)}`,
    );
  }
  if (!samePullRequestIdentity(pr, current, true))
    throw new PullRequestUpdateError("pr_identity_changed_before_update");
  const request = bodyUpdateRequest(base, current, rewritten);
  try {
    await backendFor(base, { cwd: root }).request(
      `repos/${base.fullName}/pulls/${pr.number}`,
      {
        method: "PATCH",
        data: request.data,
        ...(request.headers ? { headers: request.headers } : {}),
        include: true,
        operation: "pr-edit",
      },
    );
  } catch (error) {
    throw new PullRequestUpdateError(
      `pr_body_update_failed:${errorMessage(error)}`,
    );
  }
  let verified: PullRequest;
  try {
    verified = await readPullRequest(root, base, pr.number);
  } catch (error) {
    throw new PullRequestUpdateError(
      `pr_body_update_verification_failed:${errorMessage(error)}`,
    );
  }
  if (!samePullRequestIdentity(pr, verified, false))
    throw new PullRequestUpdateError("pr_identity_changed_after_update");
  if (verified.body !== rewritten)
    throw new PullRequestUpdateError("pr_body_changed_during_update");
}
