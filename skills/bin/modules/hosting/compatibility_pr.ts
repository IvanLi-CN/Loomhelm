import { assertPullRequestResponse } from "./pull-request";
import { redactProviderValue } from "./redact";
import { HostingError, type RepositoryBinding } from "./types";
import type { HostingBackend } from "./backend";
import {
  providerRecord,
  stringValue,
  unsupportedResponse,
} from "./compatibility_helpers";

function normalizeRelated(
  payload: unknown,
  kind: "reviews" | "comments",
  observedAt: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(payload))
    throw new HostingError(
      "invalid_provider_response",
      `PR ${kind} response is not an array`,
      `pr-${kind}`,
    );
  return payload.flatMap((item): Array<Record<string, unknown>> => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return [];
    const value = item as Record<string, unknown>;
    const user =
      value.user !== null &&
      typeof value.user === "object" &&
      !Array.isArray(value.user)
        ? (value.user as Record<string, unknown>)
        : {};
    if (kind === "reviews")
      return [
        {
          id: value.id,
          state: value.state ?? value.status,
          body: value.body ?? "",
          user: user.login ?? user.username ?? value.reviewer,
          submitted_sha: value.commit_id ?? value.commit_sha,
          url: value.html_url ?? value.url,
          submitted_at: value.submitted_at ?? value.created_at,
          observed_at: observedAt,
          raw: redactProviderValue(value),
        },
      ];
    return [
      {
        id: value.id,
        body: value.body ?? value.content ?? "",
        user: user.login ?? user.username ?? value.author,
        url: value.html_url ?? value.url,
        created_at: value.created_at,
        updated_at: value.updated_at,
        observed_at: observedAt,
        raw: redactProviderValue(value),
      },
    ];
  });
}

export async function detailedPullRequestFacts(
  binding: RepositoryBinding,
  backend: HostingBackend,
  number: number,
): Promise<Record<string, unknown>> {
  const response = await backend.request(
    `repos/${binding.fullName}/pulls/${number}`,
    { operation: "pr-facts" },
  );
  const facts = assertPullRequestResponse(response.payload, binding, number);
  const payload = providerRecord(response.payload, "pr-facts");
  const related: Record<string, Array<Record<string, unknown>>> = {};
  for (const [kind, endpoint] of [
    ["reviews", `repos/${binding.fullName}/pulls/${number}/reviews`],
    ["comments", `repos/${binding.fullName}/issues/${number}/comments`],
  ] as const) {
    const relatedResponse = await backend.request(endpoint, {
      check: false,
      operation: `pr-${kind}`,
    });
    if (unsupportedResponse(relatedResponse))
      throw new HostingError(
        "unsupported_capability",
        `provider does not support PR ${kind}`,
        `pr-${kind}`,
      );
    if (
      relatedResponse.status === null ||
      (relatedResponse.status >= 400 && relatedResponse.status !== 404)
    )
      throw new HostingError(
        "provider_request_failed",
        `PR ${kind} request failed`,
        `pr-${kind}`,
      );
    related[kind] = normalizeRelated(
      relatedResponse.payload,
      kind,
      relatedResponse.observedAt,
    );
  }
  return {
    ...facts,
    body: stringValue(payload.body),
    mergeable:
      typeof payload.mergeable === "boolean" ? payload.mergeable : null,
    merge_state: payload.mergeable_state ?? payload.merge_state_status ?? null,
    draft: Boolean(payload.draft ?? payload.is_draft),
    merged_at: stringValue(payload.merged_at),
    reviews: related.reviews,
    comments: related.comments,
    observed_at: response.observedAt,
    raw: redactProviderValue({ pr: payload, ...related }),
  };
}
