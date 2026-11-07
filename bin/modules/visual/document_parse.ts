import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readRegularNoFollow } from "./secure_io";

export const CANONICAL_HEADING = "## Visual Evidence";
export const TARGET_RE =
  /^docs\/(?:specs\/.+\/(?:SPEC|PLAN)\.md|plan\/.+\/PLAN\.md)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const IMAGE_RE = /!\[[^\]]*\]\((?:<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/;
const SELECTOR_RE = /^PR:\s*(?:include|none)\s*$/i;

export class DocumentError extends Error {}

export type DocumentSnapshot = {
  text: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

export type Section = {
  kind: "canonical" | "legacy";
  level: number;
  headingIndex: number;
  endIndex: number;
  hasImages: boolean;
};

function fenceMatch(line: string): RegExpExecArray | null {
  return /^(\`{3,}|~{3,})(.*)$/.exec(line.trim());
}

export function isTargetPath(path: string): boolean {
  return TARGET_RE.test(path);
}

export function isIndentedCodeLine(line: string): boolean {
  return line.startsWith("    ") || line.startsWith("\t");
}

export function normalizeRelativePath(rawPath: string): string {
  return rawPath
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function normalizeHeadingTitle(title: string): string {
  return title.replace(/\s+#+\s*$/, "").trim();
}

export function relativePath(rawPath: string, root: string): string {
  const candidate = rawPath.trim();
  if (isAbsolute(candidate) || candidate.split(/[\\/]/).includes(".."))
    throw new DocumentError(`target path is not repo-relative: ${rawPath}`);
  const normalized = normalizeRelativePath(candidate);
  if (!isTargetPath(normalized))
    throw new DocumentError(
      `unsupported visual-evidence document: ${normalized}`,
    );
  const absolute = resolve(root, normalized);
  const rootPath = resolve(root);
  if (!(
    relative(rootPath, absolute) === "" ||
    !relative(rootPath, absolute).startsWith("..")
  ))
    throw new DocumentError(`target path escapes repository: ${rawPath}`);
  let current = rootPath;
  for (const component of normalized.split("/")) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new DocumentError(
          `target path contains a symlinked component: ${normalized}`,
        );
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new DocumentError(`target path is unreadable: ${normalized}`);
    }
  }
  return normalized;
}

export function readDocumentSnapshot(path: string): DocumentSnapshot {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink())
      throw new DocumentError(`target document is a symlink: ${path}`);
    if (!metadata.isFile())
      throw new DocumentError(`target document is missing: ${path}`);
    if (metadata.nlink !== 1)
      throw new DocumentError(
        `target document is a hard-linked alias: ${path}`,
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      readRegularNoFollow(path),
    );
    const current = lstatSync(path);
    if (
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      current.size !== metadata.size ||
      current.mtimeMs !== metadata.mtimeMs
    )
      throw new DocumentError(`target document changed while reading: ${path}`);
    return {
      text,
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(`target document is unreadable: ${path}`);
  }
}

export function readDocument(path: string): string {
  return readDocumentSnapshot(path).text;
}

export function sameDocumentSnapshot(
  left: DocumentSnapshot,
  right: DocumentSnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.text === right.text
  );
}

function activeLines(
  lines: string[],
  predicate: (line: string) => boolean,
): boolean {
  let activeChar: string | undefined;
  let activeLength = 0;
  for (const line of lines) {
    if (isIndentedCodeLine(line)) continue;
    const stripped = line.trim();
    const match = fenceMatch(stripped);
    if (activeChar) {
      if (
        match?.[1]?.[0] === activeChar &&
        (match[1]?.length ?? 0) >= activeLength &&
        !match[2]?.trim()
      ) {
        activeChar = undefined;
        activeLength = 0;
      }
      continue;
    }
    if (match) {
      activeChar = match[1]?.[0];
      activeLength = match[1]?.length ?? 0;
      continue;
    }
    if (predicate(stripped)) return true;
  }
  return false;
}

export function sections(lines: string[]): Section[] {
  const headings: Array<[number, number, string]> = [];
  let activeChar: string | undefined;
  let activeLength = 0;
  for (const [index, line] of lines.entries()) {
    if (isIndentedCodeLine(line)) continue;
    const match = fenceMatch(line);
    if (activeChar) {
      if (
        match?.[1]?.[0] === activeChar &&
        (match[1]?.length ?? 0) >= activeLength &&
        !match[2]?.trim()
      ) {
        activeChar = undefined;
        activeLength = 0;
      }
      continue;
    }
    if (match) {
      activeChar = match[1]?.[0];
      activeLength = match[1]?.length ?? 0;
      continue;
    }
    const heading = HEADING_RE.exec(line.trim());
    if (heading)
      headings.push([
        index,
        heading[1]?.length ?? 0,
        normalizeHeadingTitle(heading[2] ?? ""),
      ]);
  }
  const found: Section[] = [];
  for (const [headingPosition, [index, level, title]] of headings.entries()) {
    const kind =
      title === "Visual Evidence"
        ? "canonical"
        : title === "Visual Evidence (PR)"
          ? "legacy"
          : undefined;
    if (!kind) continue;
    const next = headings
      .slice(headingPosition + 1)
      .find(([_, nextLevel]) => nextLevel <= level);
    const endIndex = next?.[0] ?? lines.length;
    found.push({
      kind,
      level,
      headingIndex: index,
      endIndex,
      hasImages: hasActiveImages(lines.slice(index + 1, endIndex)),
    });
  }
  return found;
}

export function activeSelectorLines(lines: string[]): number[] {
  const indexes: number[] = [];
  let activeChar: string | undefined;
  let activeLength = 0;
  for (const [index, line] of lines.entries()) {
    if (isIndentedCodeLine(line)) continue;
    const match = fenceMatch(line);
    if (activeChar) {
      if (
        match?.[1]?.[0] === activeChar &&
        (match[1]?.length ?? 0) >= activeLength &&
        !match[2]?.trim()
      ) {
        activeChar = undefined;
        activeLength = 0;
      }
      continue;
    }
    if (match) {
      activeChar = match[1]?.[0];
      activeLength = match[1]?.length ?? 0;
      continue;
    }
    if (SELECTOR_RE.test(line.trim())) indexes.push(index);
  }
  return indexes;
}

export function hasActiveImages(lines: string[]): boolean {
  return activeLines(lines, (line) => IMAGE_RE.test(line));
}

export function hasUnterminatedFence(lines: string[]): boolean {
  let activeChar: string | undefined;
  let activeLength = 0;
  for (const line of lines) {
    if (isIndentedCodeLine(line)) continue;
    const match = fenceMatch(line);
    if (activeChar) {
      if (
        match?.[1]?.[0] === activeChar &&
        (match[1]?.length ?? 0) >= activeLength &&
        !match[2]?.trim()
      ) {
        activeChar = undefined;
        activeLength = 0;
      }
    } else if (match) {
      activeChar = match[1]?.[0];
      activeLength = match[1]?.length ?? 0;
    }
  }
  return Boolean(activeChar);
}

function migrationConflict(found: Section[]): string | undefined {
  const canonical = found.filter((section) => section.kind === "canonical");
  const legacy = found.filter((section) => section.kind === "legacy");
  if ([...canonical, ...legacy].some((section) => section.level !== 2))
    return "visual_evidence_heading_level_ambiguous";
  if (canonical.length > 1)
    return "duplicate_canonical_visual_evidence_sections";
  if (legacy.length > 1) return "duplicate_legacy_visual_evidence_sections";
  if (canonical[0]?.hasImages && legacy[0]?.hasImages)
    return "canonical_and_legacy_sections_both_have_images";
  return undefined;
}

function mergeLegacy(
  lines: string[],
  canonical: Section,
  legacy: Section,
): string[] {
  const body = lines.slice(legacy.headingIndex + 1, legacy.endIndex);
  const legacyLength = legacy.endIndex - legacy.headingIndex;
  const result = [
    ...lines.slice(0, legacy.headingIndex),
    ...lines.slice(legacy.endIndex),
  ];
  let canonicalEnd = canonical.endIndex;
  if (legacy.headingIndex < canonical.headingIndex)
    canonicalEnd -= legacyLength;
  result.splice(canonicalEnd, 0, ...body);
  return result;
}

export function migrateText(text: string): { text: string; changes: string[] } {
  const hadFinalNewline = text.endsWith("\n");
  let lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines = lines.slice(0, -1);
  if (hasUnterminatedFence(lines))
    throw new DocumentError("unterminated_code_fence");
  let found = sections(lines);
  const conflict = migrationConflict(found);
  if (conflict) throw new DocumentError(conflict);
  const changes: string[] = [];
  const selectors = activeSelectorLines(lines);
  if (selectors.length) {
    changes.push("retired_selector_lines_removed");
    const removed = new Set(selectors);
    lines = lines.filter((_, index) => !removed.has(index));
    found = sections(lines);
  }
  const canonical = found.filter((section) => section.kind === "canonical");
  const legacy = found.filter((section) => section.kind === "legacy");
  if (legacy[0]) {
    if (!canonical[0]) {
      lines[legacy[0].headingIndex] = CANONICAL_HEADING;
      changes.push("legacy_heading_normalized");
    } else {
      lines = mergeLegacy(lines, canonical[0], legacy[0]);
      changes.push("legacy_heading_merged_into_canonical");
    }
  }
  return { text: lines.join("\n") + (hadFinalNewline ? "\n" : ""), changes };
}
