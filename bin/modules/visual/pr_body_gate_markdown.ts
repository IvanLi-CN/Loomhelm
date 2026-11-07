import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { assetUrl } from "../hosting/remote";
import type { RepositoryBinding } from "../hosting/types";

export const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
];
const PRIMARY_HEADING = "Visual Evidence";
const LEGACY_HEADING = "Visual Evidence (PR)";

export type Image = { path: string; alt: string };

export function repoPath(raw: string, root: string): string | undefined {
  const candidate = raw.trim();
  if (!candidate || isAbsolute(candidate)) return;
  const normalized = candidate.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return;
  const absolute = resolve(root, normalized);
  if (relative(root, absolute).startsWith("..")) return;
  if (
    !IMAGE_EXTENSIONS.some((suffix) =>
      normalized.toLowerCase().endsWith(suffix),
    )
  )
    return;
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return;
  return normalized;
}

export function defaultAlt(path: string): string {
  return path
    .split("/")
    .at(-1)!
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ");
}

function activeHeadings(
  lines: string[],
): Array<{ index: number; level: number; title: string }> {
  const result: Array<{ index: number; level: number; title: string }> = [];
  let fence: string | undefined;
  let fenceLength = 0;
  lines.forEach((line, index) => {
    const marker = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence &&
        marker[1]!.length >= fenceLength &&
        !marker[2]!.trim()
      ) {
        fence = undefined;
        fenceLength = 0;
      }
      return;
    }
    if (marker) {
      fence = marker[1]![0];
      fenceLength = marker[1]!.length;
      return;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*$/);
    if (heading)
      result.push({
        index,
        level: heading[1]!.length,
        title: heading[2]!.replace(/\s+#+\s*$/, "").trim(),
      });
  });
  return result;
}

function section(
  markdown: string,
  title: string,
): { start: number; end: number; body: string[] } | undefined {
  const lines = markdown.split(/\r?\n/);
  const headings = activeHeadings(lines);
  const matchIndex = headings.findIndex(
    (heading) => heading.level === 2 && heading.title === title,
  );
  if (matchIndex < 0) return;
  const heading = headings[matchIndex]!;
  const next = headings
    .slice(matchIndex + 1)
    .find((candidate) => candidate.level <= 2);
  return {
    start: heading.index,
    end: next?.index ?? lines.length,
    body: lines.slice(heading.index + 1, next?.index ?? lines.length),
  };
}

function removeManaged(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const headings = activeHeadings(lines);
  const remove = new Set<number>();
  for (const heading of headings) {
    if (
      heading.level !== 2 ||
      ![PRIMARY_HEADING, LEGACY_HEADING].includes(heading.title)
    )
      continue;
    const next = headings.find(
      (candidate) => candidate.index > heading.index && candidate.level <= 2,
    );
    for (
      let index = heading.index;
      index < (next?.index ?? lines.length);
      index += 1
    )
      remove.add(index);
  }
  return lines
    .filter((_, index) => !remove.has(index))
    .join("\n")
    .trim();
}

export function replaceManaged(
  markdown: string,
  sectionMarkdown: string,
): string {
  const base = removeManaged(markdown);
  const sectionText = sectionMarkdown.trim();
  return base ? `${base}\n\n${sectionText}\n` : `${sectionText}\n`;
}

export function imageUrl(
  binding: RepositoryBinding,
  reference: string,
  path: string,
): string {
  if (/^[0-9a-f]{40}$/i.test(reference))
    return assetUrl(binding, reference, path);
  const encodedReference = encodeURIComponent(reference).replaceAll("%2F", "/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  if (binding.provider === "gitea")
    return `https://${binding.host}/${binding.fullName}/raw/${encodedReference}/${encodedPath}`;
  return `https://${binding.host}/${binding.fullName}/blob/${encodedReference}/${encodedPath}?raw=1`;
}

export function renderSection(
  images: Image[],
  binding: RepositoryBinding,
  reference: string,
): string {
  if (!images.length) return `## ${PRIMARY_HEADING}\n\nNone`;
  return [
    `## ${PRIMARY_HEADING}`,
    "",
    ...images.flatMap((image) => [
      `![${image.alt}](${imageUrl(binding, reference, image.path)})`,
      "",
    ]),
  ]
    .join("\n")
    .trim();
}

export function parseManaged(
  markdown: string,
  binding: RepositoryBinding,
  reference: string,
): {
  state: "selected" | "explicit_no_image" | "blocked";
  images: Image[];
  reasons: string[];
} {
  if (section(markdown, LEGACY_HEADING))
    return {
      state: "blocked",
      images: [],
      reasons: ["legacy_visual_evidence_section_present"],
    };
  const managed = section(markdown, PRIMARY_HEADING);
  if (!managed)
    return {
      state: "blocked",
      images: [],
      reasons: ["missing_visual_evidence_section"],
    };
  const images: Image[] = [];
  const reasons: string[] = [];
  let none = 0;
  const prefix = `https://${binding.host}/${binding.fullName}/`;
  for (const rawLine of managed.body) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "None") {
      none += 1;
      continue;
    }
    const match = line.match(
      /^!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)$/,
    );
    if (!match) {
      reasons.push("managed_section_contains_non_image_content");
      continue;
    }
    const rawUrl = match[2]!.replace(/^<|>$/g, "");
    const referencePath = encodeURIComponent(reference).replaceAll("%2F", "/");
    const expected = `${prefix}blob/${referencePath}/`;
    const expectedRaw = `${prefix}raw/${referencePath}/`;
    let path: string | undefined;
    if (rawUrl.startsWith(expected) && new URL(rawUrl).search === "?raw=1")
      path = decodeURIComponent(
        rawUrl.slice(expected.length).split("?", 1)[0]!,
      );
    if (rawUrl.startsWith(expectedRaw))
      path = decodeURIComponent(
        rawUrl.slice(expectedRaw.length).split("?", 1)[0]!,
      );
    if (
      !path ||
      !IMAGE_EXTENSIONS.some((suffix) => path!.toLowerCase().endsWith(suffix))
    ) {
      reasons.push("managed_section_image_target_ref_mismatch");
      continue;
    }
    images.push({ path, alt: match[1]!.trim() || defaultAlt(path) });
  }
  if (none && images.length)
    reasons.push("managed_section_mixes_none_and_images");
  if (none > 1) reasons.push("duplicate_managed_none_declaration");
  if (new Set(images.map((image) => image.path)).size !== images.length)
    reasons.push("duplicate_managed_image_path");
  if (reasons.length)
    return {
      state: "blocked",
      images: [],
      reasons: [...new Set(reasons)].sort(),
    };
  if (none) return { state: "explicit_no_image", images: [], reasons: [] };
  if (images.length) return { state: "selected", images, reasons: [] };
  return {
    state: "blocked",
    images: [],
    reasons: ["managed_section_missing_image_declaration"],
  };
}
