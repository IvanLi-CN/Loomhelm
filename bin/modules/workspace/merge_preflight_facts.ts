import { record, sha, text } from "./merge_preflight_model";

export function recordPrFacts(
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
  expectedRepository?: string,
): string[] {
  const base = record(raw.base);
  const head = record(raw.head);
  const repositoryValue = raw.headRepository ?? head.repository;
  const repository =
    typeof repositoryValue === "object"
      ? text(record(repositoryValue).nameWithOwner) ||
        text(record(repositoryValue).url)
      : text(repositoryValue);
  const baseRepositoryValue = raw.baseRepository ?? base.repository;
  const baseRepository =
    typeof baseRepositoryValue === "object"
      ? text(record(baseRepositoryValue).nameWithOwner) ||
        text(record(baseRepositoryValue).full_name) ||
        text(record(baseRepositoryValue).url)
      : text(baseRepositoryValue);
  const baseRef = text(raw.baseRefName ?? base.ref);
  const baseOid = sha(raw.baseRefOid ?? base.oid ?? base.sha);
  const headRef = text(raw.headRefName ?? head.ref);
  const headOid = sha(raw.headRefOid ?? head.oid ?? head.sha);
  const state = text(raw.state).toUpperCase();
  const responseNumber = raw.number;
  const expectedNumber =
    payload.pr && typeof payload.pr === "object"
      ? (payload.pr as Record<string, unknown>).number
      : undefined;
  const provider = text(raw.provider).toLowerCase();
  const expectedHost =
    provider === "github"
      ? "github.com"
      : provider === "gitea"
        ? "git.ivanli.cc"
        : "";
  const url = text(raw.url);
  const pr = payload.pr as Record<string, unknown>;
  Object.assign(pr, {
    state: state || null,
    url: url || null,
    base_ref: baseRef || null,
    base_oid: baseOid || null,
    base_repository: baseRepository || null,
    head_ref: headRef || null,
    head_oid: headOid || null,
    source_branch: headRef || null,
    source_repository: repository || null,
    is_cross_repository:
      typeof raw.isCrossRepository === "boolean" ? raw.isCrossRepository : null,
    base: { ref: baseRef || null, oid: baseOid || null },
    head: {
      ref: headRef || null,
      oid: headOid || null,
      repository: repository || null,
    },
  });
  const missing = [
    ["state", state],
    ["base_ref", baseRef],
    ["base_oid", baseOid],
    ["head_ref", headRef],
    ["head_oid", headOid],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name!);
  const invalid: string[] = [];
  if (provider !== "github" && provider !== "gitea") invalid.push("provider");
  if (
    !Number.isSafeInteger(responseNumber) ||
    responseNumber !== expectedNumber
  )
    invalid.push("number");
  if (
    !baseRepository ||
    !/^[^/\s]+\/[^/\s]+$/.test(baseRepository) ||
    (expectedRepository &&
      baseRepository.toLowerCase() !== expectedRepository.toLowerCase())
  )
    invalid.push("base_repository");
  if (
    !repository ||
    !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
    /[\\\0-\x1f\x7f]/.test(repository)
  )
    invalid.push("head_repository");
  if (expectedHost) {
    let validUrl = false;
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      validUrl =
        parsed.protocol === "https:" &&
        parsed.hostname.toLowerCase() === expectedHost &&
        !parsed.port &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        parts.length === 4 &&
        (parts[2]!.toLowerCase() === "pulls" ||
          parts[2]!.toLowerCase() === "pull");
      if (validUrl && expectedRepository) {
        const [owner, repositoryNamePart] = expectedRepository.split("/");
        validUrl =
          parts[0]!.toLowerCase() === owner!.toLowerCase() &&
          parts[1]!.toLowerCase() === repositoryNamePart!.toLowerCase() &&
          parts[3] === String(expectedNumber);
      }
    } catch {
      validUrl = false;
    }
    if (!validUrl) invalid.push("url");
  }
  if (!/^[0-9a-f]{40}$/.test(baseOid) || !/^[0-9a-f]{40}$/.test(headOid))
    invalid.push("sha");
  if (!/^(OPEN|CLOSED|MERGED)$/.test(state)) invalid.push("state");
  if (!/^[^\0-\x1f\x7f]+$/.test(baseRef) || !/^[^\0-\x1f\x7f]+$/.test(headRef))
    invalid.push("ref");
  return [...missing, ...invalid.map((name) => `invalid_${name}`)];
}
