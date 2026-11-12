import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { gitRefExists } from "./git";
import { catalogConfirmsLegacyId } from "./migration_common";
import type { DriftPathContext } from "./spec_drift_types";

export function pathCountsAsSpecSync(
  path: string,
  root: string,
  associatedSpec: string,
): boolean {
  if (!root || !path.startsWith(`${root}/`)) return false;
  const relativePathValue = path.slice(root.length + 1);
  if (
    ["SPEC.md", "IMPLEMENTATION.md", "HISTORY.md"].includes(relativePathValue)
  )
    return true;
  if (relativePathValue === "PLAN.md")
    return /^(docs\/plan|docs\/specs)\/.+\/PLAN\.md$/.test(associatedSpec);
  return relativePathValue.startsWith("contracts/");
}

export function specTargetFromChangedPath(path: string): string | null {
  if (path.startsWith("docs/plan/")) {
    const relativePathValue = path.slice("docs/plan/".length);
    const root = relativePathValue.split("/")[0];
    return root ? `docs/plan/${root}/PLAN.md` : null;
  }
  if (/^docs\/specs\/[^/]+\/PLAN\.md$/.test(path)) return path;
  if (path.startsWith("docs/specs/")) {
    const root = path.slice("docs/specs/".length).split("/")[0];
    return root ? `docs/specs/${root}/SPEC.md` : null;
  }
  return null;
}

export function isLegacySpecDirName(name: string): boolean {
  return /^\d{4}(?:$|[-:])/.test(name) || /^[a-z0-9]{5}[-:]/i.test(name);
}

export function extractSpecId(path: string): string {
  const match = /^(?:docs\/specs|docs\/plan)\/([^/]+)\//.exec(path);
  if (!match?.[1]) return "";
  return match[1].split(/[-:]/, 1)[0] ?? "";
}

export function legacyTopicFromDir(directory: string): string {
  if (/^\d{4}[-:]/.test(directory)) return directory.slice(5);
  if (/^[a-z0-9]{5}[-:]/i.test(directory)) return directory.slice(6);
  return directory;
}

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function file(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function catalogProves(repoRoot: string, sourcePath: string): boolean {
  const match = /^(docs\/(?:plan|specs)\/[^/]+\/(?:PLAN|SPEC)\.md)$/.exec(
    sourcePath,
  );
  if (!match) return false;
  const root = dirname(sourcePath);
  const name = basename(root);
  if (!isLegacySpecDirName(name)) return false;
  const id = extractSpecId(sourcePath);
  const catalog = sourcePath.startsWith("docs/plan/")
    ? "docs/plan/README.md"
    : "docs/specs/README.md";
  const relativeToCatalog = sourcePath.slice(dirname(catalog).length + 1);
  return Boolean(
    (id && catalogConfirmsLegacyId(repoRoot, catalog, sourcePath, id)) ||
    (id && catalogConfirmsLegacyId(repoRoot, catalog, relativeToCatalog, id)),
  );
}

function historyProves(repoRoot: string, sourcePath: string): boolean {
  if (!sourcePath.startsWith("docs/specs/") || !sourcePath.endsWith("/SPEC.md"))
    return false;
  const directoryName = basename(dirname(sourcePath));
  if (!isLegacySpecDirName(directoryName)) return false;
  const id = extractSpecId(sourcePath);
  const topic = legacyTopicFromDir(directoryName);
  const history = resolve(repoRoot, `docs/specs/${topic}/HISTORY.md`);
  if (!id || !file(history)) return false;
  return new RegExp(
    `^\\s*-\\s*Legacy compatibility identity:\\s*\`#?${id}\`(?:\\s|\\.|$)`,
    "m",
  ).test(readFileSync(history, "utf8"));
}

function legacyProof(repoRoot: string, sourcePath: string): boolean {
  return (
    catalogProves(repoRoot, sourcePath) || historyProves(repoRoot, sourcePath)
  );
}

function renameMatches(
  context: DriftPathContext,
  oldPath: string,
  newPath: string,
): boolean {
  if (
    !oldPath.startsWith("docs/specs/") ||
    !oldPath.endsWith("/SPEC.md") ||
    !newPath.startsWith("docs/specs/") ||
    !newPath.endsWith("/SPEC.md")
  )
    return false;
  const oldDirectory = basename(dirname(oldPath));
  const newDirectory = basename(dirname(newPath));
  if (
    !isLegacySpecDirName(oldDirectory) ||
    !legacyProof(context.repoRoot, oldPath)
  )
    return false;
  const oldId = extractSpecId(oldPath);
  if (isLegacySpecDirName(newDirectory))
    return oldId !== "" && oldId === extractSpecId(newPath);
  return newDirectory === legacyTopicFromDir(oldDirectory);
}

function movedTarget(
  context: DriftPathContext,
  oldPath: string,
): string | null | "ambiguous" {
  const direct = context.renamePairs.find(
    (pair) =>
      pair.oldPath === oldPath &&
      pair.newPath.startsWith("docs/specs/") &&
      pair.newPath.endsWith("/SPEC.md") &&
      renameMatches(context, pair.oldPath, pair.newPath),
  );
  if (direct) return direct.newPath;
  if (!legacyProof(context.repoRoot, oldPath)) return null;
  const id = extractSpecId(oldPath);
  const candidates = new Set<string>();
  for (const path of context.changedFiles)
    if (
      path.startsWith(`docs/specs/${id}-`) ||
      path.startsWith(`docs/specs/${id}:`)
    )
      if (
        path.endsWith("/SPEC.md") &&
        pathExists(resolve(context.repoRoot, path)) &&
        renameMatches(context, oldPath, path)
      )
        candidates.add(path);
  const specsRoot = resolve(context.repoRoot, "docs/specs");
  if (directory(specsRoot))
    for (const entry of readdirSync(specsRoot, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        (entry.name.startsWith(`${id}-`) || entry.name.startsWith(`${id}:`))
      ) {
        const path = `docs/specs/${entry.name}/SPEC.md`;
        if (
          file(resolve(context.repoRoot, path)) &&
          renameMatches(context, oldPath, path)
        )
          candidates.add(path);
      }
  if (candidates.size === 1) return [...candidates][0] as string;
  return candidates.size > 1 ? "ambiguous" : null;
}

function resolveLegacyPlan(
  context: DriftPathContext,
  path: string,
): string | null | "ambiguous" {
  const match = /^(?:docs\/plan|docs\/specs)\/([^/]+)\/PLAN\.md$/.exec(path);
  if (!match?.[1]) return null;
  const relativeDirectory = match[1];
  const candidates = new Set<string>();
  const direct = `docs/specs/${relativeDirectory}/SPEC.md`;
  if (pathExists(resolve(context.repoRoot, direct))) candidates.add(direct);
  if (legacyProof(context.repoRoot, path)) {
    const topic = legacyTopicFromDir(relativeDirectory);
    const slug = `docs/specs/${topic}/SPEC.md`;
    if (file(resolve(context.repoRoot, slug))) candidates.add(slug);
    const id = extractSpecId(path);
    const root = resolve(context.repoRoot, "docs/specs");
    if (directory(root))
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          (entry.name.startsWith(`${id}-`) || entry.name.startsWith(`${id}:`))
        ) {
          const candidate = `docs/specs/${entry.name}/SPEC.md`;
          if (file(resolve(context.repoRoot, candidate)))
            candidates.add(candidate);
        }
  }
  if (candidates.size === 1) return [...candidates][0] as string;
  return candidates.size > 1 ? "ambiguous" : null;
}

function resolveLegacySpec(
  context: DriftPathContext,
  path: string,
): string | null | "ambiguous" {
  if (!/^docs\/specs\/[^/]+\/SPEC\.md$/.test(path)) return null;
  const directoryName = basename(dirname(path));
  if (
    pathExists(resolve(context.repoRoot, path)) &&
    isLegacySpecDirName(directoryName) &&
    legacyProof(context.repoRoot, path)
  ) {
    const slug = `docs/specs/${legacyTopicFromDir(directoryName)}/SPEC.md`;
    if (file(resolve(context.repoRoot, slug)) && slug !== path) return slug;
  }
  if (pathExists(resolve(context.repoRoot, path))) return path;
  const moved = movedTarget(context, path);
  if (moved) return moved;
  if (moved === "ambiguous") return "ambiguous";
  if (!legacyProof(context.repoRoot, path)) return path;
  const id = extractSpecId(path);
  const topic = legacyTopicFromDir(directoryName);
  const candidates = [`docs/specs/${topic}/SPEC.md`];
  const root = resolve(context.repoRoot, "docs/specs");
  if (directory(root))
    for (const entry of readdirSync(root, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        (entry.name.startsWith(`${id}-`) || entry.name.startsWith(`${id}:`))
      )
        candidates.push(`docs/specs/${entry.name}/SPEC.md`);
  const existing = [
    ...new Set(
      candidates.filter((candidate) =>
        file(resolve(context.repoRoot, candidate)),
      ),
    ),
  ];
  return existing.length === 1
    ? (existing[0] as string)
    : existing.length > 1
      ? "ambiguous"
      : path;
}

export function resolveAssociatedSpecPath(
  context: DriftPathContext,
  path: string,
): string | null | "ambiguous" {
  if (/^(?:docs\/plan|docs\/specs)\/[^/]+\/PLAN\.md$/.test(path))
    return resolveLegacyPlan(context, path) ?? path;
  if (/^docs\/specs\/[^/]+\/SPEC\.md$/.test(path))
    return resolveLegacySpec(context, path) ?? path;
  if (legacyProof(context.repoRoot, path)) {
    const id = extractSpecId(path);
    const root = resolve(context.repoRoot, "docs/specs");
    if (directory(root))
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          (entry.name.startsWith(`${id}-`) || entry.name.startsWith(`${id}:`))
        )
          return `docs/specs/${entry.name}/SPEC.md`;
  }
  return path;
}

function compareRefHas(context: DriftPathContext, path: string): boolean {
  return gitRefExists(context.repoRoot, `${context.baseRef}:${path}`);
}

export function grandfatheredLegacyRename(
  context: DriftPathContext,
  newPath: string,
): boolean {
  const oldPaths = context.renamePairs
    .filter((pair) => pair.newPath === newPath)
    .map((pair) => pair.oldPath)
    .concat(context.deletedFiles);
  return oldPaths.some(
    (oldPath) =>
      oldPath !== newPath &&
      renameMatches(context, oldPath, newPath) &&
      compareRefHas(context, oldPath) &&
      !compareRefHas(context, `${dirname(oldPath)}/IMPLEMENTATION.md`) &&
      !compareRefHas(context, `${dirname(oldPath)}/HISTORY.md`),
  );
}

export function requiredSpecFiles(
  context: DriftPathContext,
  specPath: string,
): string[] {
  if (/^(?:docs\/plan|docs\/specs)\/[^/]+\/PLAN\.md$/.test(specPath)) {
    if (compareRefHas(context, specPath)) return [specPath];
    const topic = legacyTopicFromDir(basename(dirname(specPath)));
    const canonicalRoot = `docs/specs/${topic}`;
    return [
      `${canonicalRoot}/SPEC.md`,
      `${canonicalRoot}/IMPLEMENTATION.md`,
      `${canonicalRoot}/HISTORY.md`,
    ];
  }
  const root = dirname(specPath);
  const implementation = `${root}/IMPLEMENTATION.md`;
  const history = `${root}/HISTORY.md`;
  const isNew =
    !compareRefHas(context, specPath) &&
    !grandfatheredLegacyRename(context, specPath);
  const needsCompanions =
    isNew ||
    compareRefHas(context, implementation) ||
    compareRefHas(context, history) ||
    pathExists(resolve(context.repoRoot, implementation)) ||
    pathExists(resolve(context.repoRoot, history)) ||
    context.deletedFiles.includes(implementation) ||
    context.deletedFiles.includes(history);
  return [
    `${root}/SPEC.md`,
    ...(needsCompanions ? [implementation, history] : []),
  ];
}

export function sourceRequiresRelatedAdrs(
  context: DriftPathContext,
  source: string,
  target: string,
): boolean {
  if (
    !/^docs\/specs\/[^/]+\/SPEC\.md$/.test(target) ||
    source !== target ||
    !context.changedFiles.includes(target)
  )
    return false;
  if (
    legacyProof(context.repoRoot, target) ||
    grandfatheredLegacyRename(context, target)
  )
    return false;
  return !context.renamePairs.some(
    (pair) =>
      pair.newPath === target && renameMatches(context, pair.oldPath, target),
  );
}

export function specAllowsLegacyRelatedAdrsNone(
  context: DriftPathContext,
  spec: string,
): boolean {
  return (
    legacyProof(context.repoRoot, spec) ||
    grandfatheredLegacyRename(context, spec)
  );
}
