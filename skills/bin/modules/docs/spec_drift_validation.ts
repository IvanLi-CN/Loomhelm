import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gitFileText, gitRefExists, gitText } from "./git";
import { isTopicSlug } from "./migration_common";
import { file, pathExists } from "./spec_drift_legacy";
import type { DriftPathContext, RelatedAdrResult } from "./spec_drift_types";

export function relatedAdrPaths(
  text: string,
  allowLegacyNone: boolean,
  requireSection: boolean,
): RelatedAdrResult {
  let inSection = false;
  let headingCount = 0;
  let noneCount = 0;
  let sawLink = false;
  let previous = "";
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (line === "## Related ADRs" || /^## Related ADRs\s+$/.test(line)) {
        headingCount += 1;
        inSection = true;
        continue;
      }
      if (inSection) inSection = false;
    }
    if (!inSection || !line.trim()) continue;
    if (line === "None" || (allowLegacyNone && line === "- None")) {
      noneCount += 1;
      continue;
    }
    const match =
      /^-\s+\[[^\]]+\]\(\.\.\/\.\.\/(adr\/[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)\)$/.exec(
        line,
      );
    if (!match?.[1])
      return {
        ok: false,
        paths,
        error: "entries must be None or canonical ADR links",
      };
    const path = `docs/${match[1]}`;
    if (previous && path <= previous)
      return { ok: false, paths, error: "ADR paths must be unique and sorted" };
    previous = path;
    paths.push(path);
    sawLink = true;
  }
  if (headingCount === 0)
    return requireSection
      ? { ok: false, paths, error: "slug-only Specs require the section" }
      : { ok: true, paths };
  if (headingCount !== 1)
    return { ok: false, paths, error: "section must appear exactly once" };
  if ((noneCount > 0 && sawLink) || (noneCount !== 1 && !sawLink))
    return {
      ok: false,
      paths,
      error: "use exactly None or one or more ADR links",
    };
  return { ok: true, paths };
}

export function adrStatus(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return "";
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    const match = /^status:\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return "";
}

export function validateRelatedAdrs(
  context: DriftPathContext,
  spec: string,
  requireSection: boolean,
  allowLegacyNone: boolean,
): RelatedAdrResult {
  if (!spec.startsWith("docs/specs/") || !spec.endsWith("/SPEC.md"))
    return { ok: true, paths: [] };
  const current = resolve(context.repoRoot, spec);
  if (pathExists(current)) {
    if (!file(current))
      return {
        ok: false,
        paths: [],
        error: `candidate Spec must be a regular file`,
      };
    const parsed = relatedAdrPaths(
      readFileSync(current, "utf8"),
      allowLegacyNone,
      requireSection,
    );
    if (!parsed.ok)
      return {
        ok: false,
        paths: parsed.paths,
        error: `entries in candidate ${spec}: ${parsed.error}`,
      };
    const targetError = validateAdrTargets(
      context,
      parsed.paths,
      "candidate",
      false,
    );
    if (targetError)
      return { ok: false, paths: parsed.paths, error: targetError };
  }
  const indexEntry =
    gitText(context.repoRoot, ["ls-files", "-s", "--", spec]) ?? "";
  if (indexEntry) {
    if (!/^(?:100644|100755)\s+[0-9a-f]{40}\s+0\s/.test(indexEntry))
      return { ok: false, paths: [], error: `Spec must be a regular file` };
    const staged = gitFileText(context.repoRoot, ":", spec);
    if (staged === null)
      return { ok: false, paths: [], error: "cannot read staged Spec" };
    const parsed = relatedAdrPaths(staged, allowLegacyNone, requireSection);
    if (!parsed.ok)
      return {
        ok: false,
        paths: parsed.paths,
        error: `entries in index ${spec}: ${parsed.error}`,
      };
    const targetError = validateAdrTargets(
      context,
      parsed.paths,
      "index",
      true,
    );
    if (targetError)
      return { ok: false, paths: parsed.paths, error: targetError };
    return { ok: true, paths: parsed.paths };
  }
  if (
    pathExists(current) &&
    gitRefExists(context.repoRoot, `${context.baseRef}:${spec}`)
  )
    return { ok: false, paths: [], error: "staged candidate removed Spec" };
  return { ok: true, paths: [] };
}

function validateAdrTargets(
  context: DriftPathContext,
  paths: string[],
  label: string,
  index: boolean,
): string | null {
  for (const path of paths) {
    let text: string | null;
    if (index) {
      const entry =
        gitText(context.repoRoot, ["ls-files", "-s", "--", path]) ?? "";
      if (!/^(?:100644|100755)\s+[0-9a-f]{40}\s+0\s/.test(entry))
        return `missing ADR target ${path} (not a regular index file)`;
      text = gitFileText(context.repoRoot, ":", path);
      if (text === null) return `cannot read staged ADR target ${path}`;
    } else {
      const candidate = resolve(context.repoRoot, path);
      if (!file(candidate))
        return `missing ADR target ${path} (not a regular file)`;
      text = readFileSync(candidate, "utf8");
    }
    const status = adrStatus(text);
    if (status === "superseded" || status === "deprecated")
      return `ADR ${path} is ${status}`;
    if (status && status !== "accepted")
      return `ADR ${path} has non-accepted status ${status}`;
  }
  return null;
}

export function isImplementationPath(path: string): boolean {
  if (
    path.startsWith("docs/") ||
    path.startsWith("README") ||
    path.startsWith(".github/")
  )
    return false;
  const base = basename(path);
  if ([".DS_Store"].includes(base) || /\.(log|tmp|swp|bak)$/.test(base))
    return false;
  if (
    /^(src|app|web\/src|server|backend|frontend|cmd|pkg|internal|services|modules|crates|libs)\//.test(
      path,
    )
  )
    return true;
  if (
    /^(Dockerfile|Containerfile|Makefile|GNUmakefile|Procfile|Gemfile|Rakefile|Vagrantfile|Jenkinsfile)$/.test(
      base,
    )
  )
    return true;
  if (
    /\.(c|cc|cpp|h|hpp|rs|go|py|ts|tsx|js|jsx|mjs|cjs|java|kt|swift|rb|php|cs|sh|bash|zsh|toml|json|yaml|yml)$/.test(
      path,
    )
  )
    return true;
  return !base.includes(".");
}

export function parseNameStatus(
  line: string,
): { status: string; path1: string; path2?: string } | null {
  const tab = line.indexOf("\t");
  if (!line || tab < 0) return null;
  const status = line.slice(0, tab);
  const rest = line.slice(tab + 1);
  if (/^[RC]/.test(status)) {
    const split = rest.indexOf("\t");
    if (split < 0) return null;
    return {
      status,
      path1: rest.slice(0, split),
      path2: rest.slice(split + 1),
    };
  }
  return { status, path1: rest };
}

export function pathDeleted(context: DriftPathContext, path: string): boolean {
  return context.deletedFiles.includes(path);
}

export function currentHash(context: DriftPathContext, path: string): string {
  return (
    gitText(context.repoRoot, ["hash-object", path])?.trim() ||
    gitText(context.repoRoot, [
      "rev-parse",
      "--verify",
      `HEAD:${path}`,
    ])?.trim() ||
    "unknown"
  );
}

export function frozenAdrMembership(
  context: DriftPathContext,
  spec: string,
): string[] {
  const text = gitFileText(context.repoRoot, ":", spec);
  return text ? relatedAdrPaths(text, false, false).paths : [];
}

export function slugOnly(value: string): boolean {
  return isTopicSlug(value);
}
