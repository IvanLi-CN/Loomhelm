import { redactProviderValue } from "./redact";
import { HostingError, type RepositoryBinding } from "./types";
import type { HostingBackend } from "./backend";
import {
  providerRecord,
  providerSha,
  requiredShaValue,
  stringValue,
} from "./compatibility_helpers";

export async function treeFacts(
  binding: RepositoryBinding,
  backend: HostingBackend,
  rawSha: string,
  rawPath: string,
): Promise<Record<string, unknown>> {
  const sha = requiredShaValue(rawSha, "sha", "tree-has");
  const path = rawPath.trim().replace(/^\/+|\/+$/g, "");
  if (
    !path ||
    path
      .split("/")
      .some(
        (part) => part === "." || part === ".." || /[\\\0-\x1f\x7f]/.test(part),
      )
  )
    throw new HostingError(
      "invalid_asset",
      "asset path is invalid",
      "tree-has",
    );
  const initial = await backend.request(
    `repos/${binding.fullName}/git/trees/${sha}?recursive=true`,
    { operation: "tree" },
  );
  const entries =
    initial.payload !== null &&
    typeof initial.payload === "object" &&
    Array.isArray((initial.payload as Record<string, unknown>).tree)
      ? ((initial.payload as Record<string, unknown>).tree as unknown[])
      : undefined;
  if (!entries)
    throw new HostingError(
      "invalid_provider_response",
      "tree response has no tree entries",
      "tree",
    );
  if (!(initial.payload as Record<string, unknown>).truncated) {
    return {
      exists: entries.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).path === path &&
          ["blob", "file"].includes(
            stringValue((entry as Record<string, unknown>).type),
          ),
      ),
      sha,
      path,
      observed_at: initial.observedAt,
      raw: [redactProviderValue(initial.payload)],
    };
  }
  let treeSha = sha;
  const rawPayloads: unknown[] = [redactProviderValue(initial.payload)];
  const components = path.split("/");
  for (const [index, component] of components.entries()) {
    const response = await backend.request(
      `repos/${binding.fullName}/git/trees/${treeSha}`,
      { operation: "tree" },
    );
    rawPayloads.push(redactProviderValue(response.payload));
    const payload = providerRecord(response.payload, "tree");
    const current = Array.isArray(payload.tree) ? payload.tree : [];
    const entry = current.find(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).path === component,
    );
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return {
        exists: false,
        sha,
        path,
        observed_at: response.observedAt,
        raw: rawPayloads,
      };
    const typed = entry as Record<string, unknown>;
    if (index === components.length - 1)
      return {
        exists: ["blob", "file"].includes(stringValue(typed.type)),
        sha,
        path,
        observed_at: response.observedAt,
        raw: rawPayloads,
      };
    if (
      !["tree", "directory"].includes(stringValue(typed.type)) ||
      !providerSha(typed.sha)
    )
      return {
        exists: false,
        sha,
        path,
        observed_at: response.observedAt,
        raw: rawPayloads,
      };
    treeSha = providerSha(typed.sha);
  }
  return {
    exists: false,
    sha,
    path,
    observed_at: initial.observedAt,
    raw: rawPayloads,
  };
}

export async function renderMarkdownFact(
  binding: RepositoryBinding,
  backend: HostingBackend,
  text: string,
  context?: string,
): Promise<Record<string, unknown>> {
  const data =
    binding.provider === "github"
      ? { text, mode: "gfm", context: context?.trim() || binding.fullName }
      : {
          Text: text,
          Mode: "gfm",
          Context: context?.trim() || binding.fullName,
        };
  const response = await backend.request("markdown", {
    method: "POST",
    data,
    operation: "markdown",
  });
  const payload = response.payload;
  const html =
    typeof payload === "string"
      ? payload
      : payload !== null && typeof payload === "object"
        ? stringValue((payload as Record<string, unknown>).html)
        : "";
  if (!html)
    throw new HostingError(
      "invalid_provider_response",
      "Markdown response is not rendered text",
      "markdown",
    );
  return {
    html,
    observed_at: response.observedAt,
    raw: redactProviderValue(payload),
  };
}

export async function issueFacts(
  binding: RepositoryBinding,
  backend: HostingBackend,
  number: number,
): Promise<Record<string, unknown>> {
  const response = await backend.request(
    `repos/${binding.fullName}/issues/${number}`,
    { operation: "issue-facts" },
  );
  const payload = providerRecord(response.payload, "issue-facts");
  return {
    number: Number(payload.number ?? number),
    url: payload.html_url ?? payload.url,
    state: stringValue(payload.state).toUpperCase(),
    title: payload.title ?? "",
    body: payload.body ?? "",
    observed_at: response.observedAt,
    raw: redactProviderValue(payload),
  };
}

export async function issueCreate(
  binding: RepositoryBinding,
  backend: HostingBackend,
  title: string,
  body: string,
): Promise<Record<string, unknown>> {
  const response = await backend.request(`repos/${binding.fullName}/issues`, {
    method: "POST",
    data: { title, body },
    operation: "issue-create",
  });
  const payload = providerRecord(response.payload, "issue-create");
  return {
    number: Number(payload.number ?? 0),
    url: payload.html_url ?? payload.url,
    state: stringValue(payload.state || "OPEN").toUpperCase(),
    title: payload.title ?? title,
    body: payload.body ?? body,
    observed_at: response.observedAt,
    raw: redactProviderValue(payload),
  };
}

export async function submitReview(
  binding: RepositoryBinding,
  backend: HostingBackend,
  number: number,
  rawEvent: string,
  body: string,
): Promise<Record<string, unknown>> {
  const event = rawEvent.trim().toUpperCase();
  if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event))
    throw new HostingError(
      "invalid_review_event",
      "review event is invalid",
      "review-submit",
    );
  const response = await backend.request(
    `repos/${binding.fullName}/pulls/${number}/reviews`,
    { method: "POST", data: { event, body }, operation: "review-submit" },
  );
  const payload = providerRecord(response.payload, "review-submit");
  return {
    id: payload.id,
    state: payload.state ?? event,
    url: payload.html_url ?? payload.url,
    submitted_sha: payload.commit_id ?? payload.commit_sha,
    observed_at: response.observedAt,
    raw: redactProviderValue(payload),
  };
}

export async function releaseList(
  binding: RepositoryBinding,
  backend: HostingBackend,
): Promise<Array<Record<string, unknown>>> {
  const response = await backend.request(`repos/${binding.fullName}/releases`, {
    operation: "release-list",
  });
  if (!Array.isArray(response.payload))
    throw new HostingError(
      "invalid_provider_response",
      "release response is not an array",
      "release-list",
    );
  return response.payload.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return [];
    const payload = item as Record<string, unknown>;
    return [
      {
        id: payload.id,
        tag: payload.tag_name,
        url: payload.html_url ?? payload.url,
        draft: Boolean(payload.draft),
        prerelease: Boolean(payload.prerelease),
        observed_at: response.observedAt,
        raw: redactProviderValue(payload),
      },
    ];
  });
}

export async function releaseCreate(
  binding: RepositoryBinding,
  backend: HostingBackend,
  tag: string,
  title: string,
  note: string,
  target: string | undefined,
  draft: boolean,
  prerelease: boolean,
): Promise<Record<string, unknown>> {
  const response = await backend.request(`repos/${binding.fullName}/releases`, {
    method: "POST",
    data: {
      tag_name: tag,
      name: title,
      body: note,
      target_commitish: target ?? "",
      draft,
      prerelease,
    },
    operation: "release-create",
  });
  const payload = providerRecord(response.payload, "release-create");
  return {
    id: payload.id,
    tag: payload.tag_name ?? tag,
    url: payload.html_url ?? payload.url,
    draft: Boolean(payload.draft),
    prerelease: Boolean(payload.prerelease),
    observed_at: response.observedAt,
    raw: redactProviderValue(payload),
  };
}
