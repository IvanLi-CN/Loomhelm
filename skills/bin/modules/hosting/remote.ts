import {
  HostingError,
  type ProviderName,
  type RepositoryBinding,
} from "./types";

const HOSTS: Record<string, ProviderName> = {
  "github.com": "github",
  "git.ivanli.cc": "gitea",
};

function parsePath(path: string): [string, string] {
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map(decodeURIComponent);
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[%\/\\?#\0-\x1f\x7f]/.test(part),
    )
  ) {
    throw new HostingError(
      "invalid_repository",
      "remote URL must contain exactly owner/repo",
    );
  }
  const [owner, rawRepo] = parts;
  const repo = rawRepo?.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!owner || !repo)
    throw new HostingError(
      "invalid_repository",
      "remote URL contains an invalid owner/repo",
    );
  return [owner, repo];
}

export function parseGitRemote(raw: string): [string, string, string] {
  const value = raw.trim();
  if (!value)
    throw new HostingError("invalid_remote", "Git remote URL is empty");
  try {
    if (value.includes("://")) {
      const url = new URL(value);
      const allowed: Record<string, string> = {
        http: "80",
        https: "443",
        ssh: "22",
      };
      if (
        !allowed[url.protocol.slice(0, -1)] ||
        (url.port && url.port !== allowed[url.protocol.slice(0, -1)])
      ) {
        throw new HostingError(
          "invalid_remote",
          "Git remote URL has an unsupported scheme or port",
        );
      }
      const [owner, repo] = parsePath(url.pathname);
      return [url.hostname.toLowerCase(), owner, repo];
    }
    const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    if (!match?.[1] || !match[2])
      throw new HostingError(
        "invalid_remote",
        "Git remote URL is not SSH scp-like or URI form",
      );
    const [owner, repo] = parsePath(match[2]);
    return [match[1].toLowerCase(), owner, repo];
  } catch (error) {
    if (error instanceof HostingError) throw error;
    throw new HostingError("invalid_remote", "Git remote URL is malformed");
  }
}

export function bindingFromRemote(
  raw: string,
  remote: string,
): RepositoryBinding {
  const [host, owner, repo] = parseGitRemote(raw);
  const provider = Object.hasOwn(HOSTS, host) ? HOSTS[host] : undefined;
  if (!provider)
    throw new HostingError(
      "unsupported_host",
      `code-hosting host is not allowlisted: ${host}`,
    );
  const webOrigin = `https://${host}`;
  return {
    provider,
    host,
    owner,
    repo,
    remote,
    webOrigin,
    apiOrigin:
      provider === "github" ? "https://api.github.com" : `${webOrigin}/api/v1`,
    fullName: `${owner}/${repo}`,
    webUrl: `${webOrigin}/${owner}/${repo}`,
  };
}

export function assetUrl(
  binding: RepositoryBinding,
  revision: string,
  repoPath: string,
): string {
  if (
    !/^[0-9a-f]{40}$/i.test(revision) ||
    repoPath.startsWith("/") ||
    repoPath
      .split("/")
      .some(
        (part) => part === "." || part === ".." || /[\\\0-\x1f\x7f]/.test(part),
      )
  ) {
    throw new HostingError(
      "invalid_asset",
      "asset revision or path is invalid",
    );
  }
  const path = repoPath.split("/").map(encodeURIComponent).join("/");
  return binding.provider === "github"
    ? `${binding.webUrl}/blob/${revision}/${path}?raw=1`
    : `${binding.webUrl}/raw/${revision}/${path}`;
}
