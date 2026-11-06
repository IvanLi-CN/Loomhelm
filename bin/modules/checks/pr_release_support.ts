import { isRecord, type JsonValue } from "./replay";

export type ReleaseExpected = true | false | "unknown" | undefined;

export interface ReleaseCard {
  value: Record<string, unknown>;
  line: number;
}

export interface PublicationFact {
  line: number;
  surface: string;
  tags: Set<string>;
  shas: Set<string>;
  repos: Set<string>;
  urls: Set<string>;
  times: Set<string>;
}

export const releaseStatus =
  /发布状态\s*[:=]\s*(不适用|未触发|运行中|已发布|失败|未终态|未检查)/i;
export const releaseExpectedTrue =
  /["']?release_expected["']?\s*[:=]\s*true|["']?release_enabled["']?\s*[:=]\s*true/i;
export const releaseExpectedFalse =
  /["']?release_expected["']?\s*[:=]\s*false|["']?release_enabled["']?\s*[:=]\s*false/i;
export const releaseExpectedUnknown =
  /["']?release_expected["']?\s*[:=]\s*["']unknown["']/i;
export const releaseIntent =
  /Release Snapshot|release[-_ ]intent|release_enabled\s*[:=]\s*True|release_disposition/i;
export const releaseEpoch =
  /["']?release_epoch["']?\s*[:=]\s*["']?([^\s"'`,;；}]+)/i;
export const targetRepo =
  /["']?target_repo["']?\s*[:=]\s*["']?([\w.-]+\/[\w.-]+)/i;
export const targetBranch = /["']?target_branch["']?\s*[:=]\s*["']?([\w./-]+)/i;
export const targetSha = /["']?target_sha["']?\s*[:=]\s*["']?([0-9a-f]{7,40})/i;
export const mergeSha = /["']?merge_sha["']?\s*[:=]\s*["']?([0-9a-f]{7,40})/i;
export const candidateTag =
  /["']?release_tag["']?\s*[:=]\s*["']?([^\s"'`,;；}]+)/i;
export const boundSha = /发布绑定sha\s*[:=]\s*([0-9a-f]{7,40})/i;
export const reportedTag = /发布tag\s*[:=]\s*([^\s`，。；;,]+)/i;
export const reportedVersion =
  /发布版本\s*[:=]\s*(?!none|未检查)([^\s`，。；;,]+)/i;
export const reportedUrl = /发布URL\s*[:=]\s*(https?:\/\/[^\s，。；;,]+)/i;
export const reportedWorkflow =
  /发布workflow\s*[:=]\s*(https?:\/\/[^\s，。；;,]+)/i;
export const reportedTime =
  /发布时间\s*[:=]\s*(?!none|未检查)([^\s，。；;,]+)/i;
export const reportedArtifacts = /发布产物\s*[:=\s]*(?!none|未检查)\S+/i;
export const expectedSurfaces = new Set([
  "github_release",
  "package",
  "container",
  "deployment",
]);

export function jsonObjects(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return jsonObjects(JSON.parse(value) as JsonValue);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(jsonObjects);
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap(jsonObjects)];
}

export function scalarCards(value: unknown): Record<string, unknown>[] {
  return jsonObjects(value).map((item) =>
    Object.fromEntries(
      Object.entries(item).filter(
        ([, child]) => !isRecord(child) && !Array.isArray(child),
      ),
    ),
  );
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asSha(value: unknown): string | undefined {
  const text = stringValue(value)?.toLowerCase();
  return text && /^[0-9a-f]{7,40}$/.test(text) ? text : undefined;
}

export function identifiersMatch(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value
      .replace(/^refs\/tags\//i, "")
      .replace(/^v/i, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

export function shaMatches(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return Boolean(
    left && right && (left.startsWith(right) || right.startsWith(left)),
  );
}

export function iso8601(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
    value,
  );
}

export function surfaceFor(text: string): string {
  if (/\/releases\/tag\//i.test(text)) return "github_release";
  if (/deployment_url/i.test(text)) return "deployment";
  if (/ghcr\.io|container_url|registry_url|\bdigest\b/i.test(text))
    return "container";
  return "package";
}

export function publicationFact(
  line: number,
  output: unknown,
): PublicationFact[] {
  const facts: PublicationFact[] = [];
  const cards = scalarCards(output);
  const inheritedShas = new Set<string>();
  const inheritedWorkflowUrls = new Set<string>();
  for (const card of cards) {
    for (const [key, value] of Object.entries(card))
      if (
        /^(headSha|head_sha|targetCommitish|target_commitish|source_sha|revision|org\.opencontainers\.image\.revision)$/i.test(
          key,
        )
      ) {
        const sha = asSha(value);
        if (sha) inheritedShas.add(sha);
      }
    for (const [key, value] of Object.entries(card))
      if (
        /^(workflow_url|url)$/i.test(key) &&
        typeof value === "string" &&
        /\/actions\/runs\//i.test(value)
      )
        inheritedWorkflowUrls.add(value);
  }
  for (const card of cards) {
    const text = JSON.stringify(card);
    const githubUrl = text.match(
      /https?:\/\/[^"\s]+\/[^"\s]+\/releases\/tag\/[^"\s]+/i,
    )?.[0];
    const publishedAt = Object.entries(card).find(
      ([key, value]) =>
        /^(publishedAt|published_at|createdAt|created_at|deployed_at)$/i.test(
          key,
        ) && typeof value === "string",
    )?.[1] as string | undefined;
    const hasPublishedState =
      /"(?:published|available|uploaded)"\s*:\s*true|"(?:status|state)"\s*:\s*"(?:published|available)"/i.test(
        text,
      );
    const isGithub = Boolean(githubUrl && publishedAt);
    const isPackage = Boolean(
      publishedAt &&
      hasPublishedState &&
      /package_url|container_url|registry_url|digest/i.test(text),
    );
    const isDeployment =
      /deployment_url/i.test(text) &&
      /"status"\s*:\s*"(?:success|succeeded|active)"/i.test(text) &&
      Boolean(publishedAt);
    if (!isGithub && !isPackage && !isDeployment) continue;
    const tags = new Set<string>();
    const tagFromUrl = githubUrl?.match(/\/releases\/tag\/([^/?#"\s]+)/i)?.[1];
    if (tagFromUrl) tags.add(tagFromUrl);
    for (const [key, value] of Object.entries(card))
      if (
        /^(tagName|tag_name|tag|version)$/i.test(key) &&
        typeof value === "string"
      )
        tags.add(value);
    const containerTag = text.match(
      /(?:package_url|container_url|registry_url)["']?\s*[:=]\s*["']?https?:\/\/[^"\s]+:([^"/@:]+)/i,
    )?.[1];
    if (containerTag) tags.add(containerTag);
    const shas = new Set<string>();
    for (const [key, value] of Object.entries(card))
      if (
        /^(headSha|head_sha|targetCommitish|target_commitish|source_sha|revision|org\.opencontainers\.image\.revision)$/i.test(
          key,
        )
      ) {
        const sha = asSha(value);
        if (sha) shas.add(sha);
      }
    const urls = new Set<string>();
    for (const [key, value] of Object.entries(card))
      if (
        /^(url|html_url|workflow_url|package_url|container_url|registry_url|deployment_url)$/i.test(
          key,
        ) &&
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
      )
        urls.add(value);
    const repos = new Set<string>();
    for (const url of urls) {
      const githubRepo = url.match(
        /https?:\/\/[^/]+\/([^/]+\/[^/]+)(?:\/releases\/tag|\/actions\/runs)/i,
      )?.[1];
      const packageRepo = url.match(
        /https?:\/\/[^/]+\/([^/:]+\/[^/:]+)(?::|\/|$)/i,
      )?.[1];
      if (githubRepo) repos.add(githubRepo.toLowerCase());
      else if (packageRepo) repos.add(packageRepo.toLowerCase());
    }
    const times = new Set<string>(publishedAt ? [publishedAt] : []);
    if (!shas.size) for (const sha of inheritedShas) shas.add(sha);
    if (isGithub) for (const url of inheritedWorkflowUrls) urls.add(url);
    facts.push({
      line,
      surface: isGithub
        ? "github_release"
        : isDeployment
          ? "deployment"
          : surfaceFor(text),
      tags,
      shas,
      repos,
      urls,
      times,
    });
  }
  return facts;
}

export function findCard(
  output: unknown,
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return jsonObjects(output).find(predicate);
}

export function reportFieldMissing(text: string): string[] {
  const fields: Array<[string, RegExp]> = [
    [
      "release_expected",
      /\brelease_expected\s*[:=]\s*(?:true|false|unknown)\b/i,
    ],
    ["发布版本", /发布版本\s*[:=]\s*\S+/i],
    ["发布tag", /发布tag\s*[:=]\s*\S+/i],
    ["发布channel", /发布channel\s*[:=]\s*\S+/i],
    ["发布绑定sha", /发布绑定sha\s*[:=]\s*\S+/i],
    ["发布workflow", /发布workflow\s*[:=]\s*\S+/i],
    ["发布URL", /发布URL\s*[:=]\s*\S+/i],
    ["发布时间", /发布时间\s*[:=]\s*\S+/i],
    ["发布产物", /发布产物\s*[:=]\s*\S+/i],
    ["发布处置", /发布处置\s*[:=]\s*\S+/i],
  ];
  return fields
    .filter(([, pattern]) => !pattern.test(text))
    .map(([name]) => name);
}
