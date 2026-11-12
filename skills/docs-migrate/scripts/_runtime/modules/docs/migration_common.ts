import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { gitText } from "./git";

export const PREFIXED_NAME = /^(?<legacyId>[a-z0-9]{4,5})[-:](?<topic>.+)$/i;
const TOPIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INLINE_LINK = /\]\(\s*(?:<(?<angle>[^>]+)>|(?<bare>[^\s)]+))/gm;
const REFERENCE_LINK =
  /^\s*\[[^\]]+\]:\s*(?:<(?<angle>[^>]+)>|(?<bare>[^\s]+))/gm;
const CATALOG_LINK =
  /^\s*\[[^\]]*\]\(\s*(?:<(?<angle>[^>]+)>|(?<bare>[^\s)]+))(?:\s+["'][^"']*["'])?\s*\)\s*$/;

export type Json = Record<string, unknown>;

export function relativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path)).replaceAll("\\", "/");
  if (value === "" || value === ".") return ".";
  return value;
}

export function parsePrefixedName(name: string): [string, string] | null {
  const match = PREFIXED_NAME.exec(name);
  return match?.groups?.legacyId && match.groups.topic
    ? [match.groups.legacyId, match.groups.topic]
    : null;
}

export function isTopicSlug(value: string): boolean {
  return TOPIC_SLUG.test(value);
}

export function tableRows(text: string): Json[] {
  const rows: Json[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index + 1 < lines.length;) {
    const header = lines[index] as string;
    const separator = lines[index + 1] as string;
    if (
      !header.trimStart().startsWith("|") ||
      !separator.trimStart().startsWith("|")
    ) {
      index += 1;
      continue;
    }
    const headers = header
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim().toLowerCase());
    const separators = separator
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    if (
      !headers.length ||
      headers.length !== separators.length ||
      separators.some((cell) => !/^:?-{3,}:?$/.test(cell))
    ) {
      index += 1;
      continue;
    }
    index += 2;
    while (
      index < lines.length &&
      (lines[index] as string).trimStart().startsWith("|")
    ) {
      const values = (lines[index] as string)
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
      if (values.length === headers.length) {
        const row: Json = {};
        headers.forEach((key, position) => {
          row[key] = values[position] ?? "";
        });
        rows.push(row);
      }
      index += 1;
    }
  }
  return rows;
}

function unwrapCatalogPath(value: string): string {
  let candidate = value.trim();
  if (candidate.startsWith("`") && candidate.endsWith("`"))
    candidate = candidate.slice(1, -1).trim();
  const match = CATALOG_LINK.exec(candidate);
  return match?.groups?.angle ?? match?.groups?.bare ?? candidate;
}

export function normalizeRepoRelativePath(value: string): string | null {
  const withoutFragment = decodeURIComponent(
    value.split("#", 1)[0]?.split("?", 1)[0] ?? "",
  ).trim();
  if (
    !withoutFragment ||
    withoutFragment.startsWith("/") ||
    withoutFragment.startsWith("#") ||
    withoutFragment.includes("://")
  )
    return null;
  const parts: string[] = [];
  for (const part of withoutFragment.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || null;
}

function catalogPathCandidates(
  value: string,
  catalogRelative: string,
): Set<string> {
  const path = unwrapCatalogPath(value);
  const direct = normalizeRepoRelativePath(path);
  const catalogRoot = normalizeRepoRelativePath(
    dirname(catalogRelative).replaceAll("\\", "/"),
  );
  const relativePathValue = catalogRoot
    ? normalizeRepoRelativePath(`${catalogRoot}/${path}`)
    : null;
  return new Set(
    [direct, relativePathValue].filter(
      (candidate): candidate is string => candidate !== null,
    ),
  );
}

function catalogTexts(repoRoot: string, catalogRelative: string): string[] {
  const texts: string[] = [];
  const path = resolve(repoRoot, catalogRelative);
  if (existsSync(path)) texts.push(readFileSync(path, "utf8"));
  const history = gitText(repoRoot, [
    "log",
    "--format=%H",
    "HEAD",
    "--",
    catalogRelative,
  ]);
  for (const revision of history?.split(/\r?\n/).filter(Boolean) ?? []) {
    const text = gitText(repoRoot, ["show", `${revision}:${catalogRelative}`]);
    if (text !== null && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

export function catalogConfirmsLegacyId(
  repoRoot: string,
  catalogRelative: string,
  sourceRelative: string,
  legacyId: string,
): boolean {
  const expected = normalizeRepoRelativePath(sourceRelative);
  if (!expected) return false;
  return catalogTexts(repoRoot, catalogRelative).some((text) =>
    tableRows(text).some((row) => {
      if (
        String(row.id ?? "")
          .replaceAll("`", "")
          .toLowerCase() !== legacyId.toLowerCase()
      )
        return false;
      return ["spec", "plan", "path"].some((column) =>
        catalogPathCandidates(String(row[column] ?? ""), catalogRelative).has(
          expected,
        ),
      );
    }),
  );
}

export function legacyIdentity(
  repoRoot: string,
  name: string,
  catalogRelative: string,
  sourceRelative: string,
  explicit?: string,
): [string, string, string] | null {
  const parsed = parsePrefixedName(name);
  if (!parsed) return null;
  const [legacyId, topic] = parsed;
  if (explicit !== undefined) {
    if (explicit.toLowerCase() !== legacyId.toLowerCase())
      throw new Error(
        `--legacy-id '${explicit}' does not match source prefix '${legacyId}'`,
      );
    return [legacyId, topic, "explicit"];
  }
  return catalogConfirmsLegacyId(
    repoRoot,
    catalogRelative,
    sourceRelative,
    legacyId,
  )
    ? [legacyId, topic, "catalog"]
    : null;
}

function targetIsSource(
  target: string,
  markdownPath: string,
  source: string,
): boolean {
  const cleaned = decodeURIComponent(
    target.split("#", 1)[0]?.split("?", 1)[0] ?? "",
  ).trim();
  if (!cleaned || cleaned.includes("://") || cleaned.startsWith("#"))
    return false;
  const resolvedTarget = resolve(dirname(markdownPath), cleaned);
  const sourcePath = resolve(source);
  if (existsSync(sourcePath) && statSafe(sourcePath)?.isFile())
    return resolvedTarget === sourcePath;
  return (
    resolvedTarget === sourcePath || resolvedTarget.startsWith(`${sourcePath}/`)
  );
}

function links(text: string): string[] {
  const result: string[] = [];
  for (const pattern of [INLINE_LINK, REFERENCE_LINK]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern))
      result.push(match.groups?.angle ?? match.groups?.bare ?? "");
  }
  return result;
}

function statSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function inboundLinks(
  repoRoot: string,
  source: string,
  sourceRelative: string,
): string[] {
  const matches: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) visit(path);
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        resolve(path) === resolve(source)
      )
        continue;
      const sourceStat = statSafe(source);
      if (
        sourceStat?.isDirectory() &&
        resolve(path).startsWith(`${resolve(source)}/`)
      )
        continue;
      const text = readFileSync(path, "utf8");
      if (
        text.includes(sourceRelative) ||
        links(text).some((target) => targetIsSource(target, path, source))
      )
        matches.push(relativePath(repoRoot, path));
    }
  }
  visit(resolve(repoRoot));
  return matches.sort();
}

export function isProtectedBranch(branch: string): boolean {
  return (
    new Set(["main", "master", "trunk"]).has(branch) ||
    /^(release|hotfix|support)\//.test(branch)
  );
}

export function currentBranch(repoRoot: string): string {
  return (
    gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ||
    "unknown"
  );
}
