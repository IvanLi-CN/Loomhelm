export type ProviderName = "github" | "gitea";

export interface RepositoryBinding {
  provider: ProviderName;
  host: string;
  owner: string;
  repo: string;
  remote: string;
  webOrigin: string;
  apiOrigin: string;
  fullName: string;
  webUrl: string;
}

export interface PullRequestFacts {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  baseRef: string;
  baseSha: string | null;
  headRef: string;
  headSha: string | null;
  draft: boolean;
  mergeable: boolean | null;
  raw: unknown;
}

export class HostingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operation = "unknown",
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "HostingError";
  }
}
