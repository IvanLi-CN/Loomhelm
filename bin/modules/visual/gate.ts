import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  defaultSnapshotRoot,
  isReadableRegularFile,
  pathWithin,
} from "./paths";
import { casefold } from "./casefold";

export type ImageViolation = {
  syntax: string;
  source: string;
  reason: string;
  position: number;
};

const MARKDOWN_IMAGE_START = /(?<!\\)!\[/g;
const REFERENCE_DEFINITION =
  /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]+>|[^\s]+)/gm;
const HTML_IMAGE_TAG = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const FENCE_START = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE = /(`+)([^\n]*?)\1/g;

function maskSpans(text: string, spans: Array<[number, number]>): string {
  const masked = text.split("");
  for (const [start, end] of spans) {
    for (
      let index = Math.max(0, start);
      index < Math.min(end, masked.length);
      index += 1
    )
      masked[index] = " ";
  }
  return masked.join("");
}

function linesWithOffsets(
  text: string,
): Array<{ start: number; end: number; content: string }> {
  const lines: Array<{ start: number; end: number; content: string }> = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r")
      end += 1;
    if (end < text.length && text[end] === "\r" && text[end + 1] === "\n")
      end += 2;
    else if (end < text.length) end += 1;
    lines.push({
      start,
      end,
      content: text.slice(start, end).replace(/[\r\n]+$/, ""),
    });
    start = end;
  }
  if (text.length === 0) return [];
  return lines;
}

function fencedCodeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let activeChar: string | undefined;
  let activeLength = 0;
  for (const line of linesWithOffsets(text)) {
    const match = FENCE_START.exec(line.content);
    if (activeChar) {
      spans.push([line.start, line.end]);
      if (
        match?.[1]?.[0] === activeChar &&
        (match[1]?.length ?? 0) >= activeLength &&
        !match[2]?.trim()
      ) {
        activeChar = undefined;
        activeLength = 0;
      }
    } else if (match) {
      spans.push([line.start, line.end]);
      activeChar = match[1]?.[0];
      activeLength = match[1]?.length ?? 0;
    }
  }
  return spans;
}

function maskCodeRegions(text: string): string {
  const fenced = fencedCodeSpans(text);
  const masked = maskSpans(text, fenced);
  const inline: Array<[number, number]> = [];
  for (const match of masked.matchAll(INLINE_CODE)) {
    if (match.index !== undefined)
      inline.push([match.index, match.index + match[0].length]);
  }
  return maskSpans(text, [...fenced, ...inline]);
}

function normalizeReferenceLabel(label: string): string {
  return casefold(label.trim()).split(/\s+/).join(" ");
}

function markdownDestination(raw: string): string {
  const candidate = raw.trim();
  if (candidate.startsWith("<")) {
    const closing = candidate.indexOf(">");
    if (closing >= 0)
      return candidate
        .slice(1, closing)
        .trim()
        .replace(/\\([\\()<>])/g, "$1");
  }
  return (candidate.split(/\s+/, 1)[0] ?? "").replace(/\\([\\()<>])/g, "$1");
}

function scanBracketed(
  text: string,
  opening: number,
): [number, string] | undefined {
  if (text[opening] !== "[") return undefined;
  let depth = 1;
  let escaped = false;
  for (let index = opening + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0)
      return [index, text.slice(opening + 1, index)];
  }
  return undefined;
}

function scanParenthesized(
  text: string,
  opening: number,
): [number, string] | undefined {
  let depth = 1;
  let escaped = false;
  let angleDestination = false;
  for (let index = opening + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (angleDestination) {
      if (char === ">") angleDestination = false;
    } else if (char === "<" && !text.slice(opening + 1, index).trim())
      angleDestination = true;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0)
      return [index, text.slice(opening + 1, index)];
  }
  return undefined;
}

function markdownImages(
  text: string,
): Array<[number, "markdown" | "markdown-reference", string]> {
  const images: Array<[number, "markdown" | "markdown-reference", string]> = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_START)) {
    const position = match.index ?? 0;
    const label = scanBracketed(text, position + match[0].length - 1);
    if (!label) continue;
    let index = label[0] + 1;
    if (text[index] === "(") {
      const destination = scanParenthesized(text, index);
      if (destination) images.push([position, "markdown", destination[1]]);
      continue;
    }
    while (text[index] === " " || text[index] === "\t") index += 1;
    if (text[index] === "[") {
      const reference = scanBracketed(text, index);
      if (reference)
        images.push([position, "markdown-reference", reference[1] || label[1]]);
    } else images.push([position, "markdown-reference", label[1]]);
  }
  return images;
}

function referenceDefinitions(text: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(REFERENCE_DEFINITION)) {
    const label = normalizeReferenceLabel(match[1] ?? "");
    if (!definitions.has(label))
      definitions.set(label, markdownDestination(match[2] ?? ""));
  }
  return definitions;
}

function srcsetSources(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter((source): source is string => Boolean(source));
}

function htmlImageSources(
  tag: string,
): Array<[number, "html" | "html-srcset", string]> {
  const sources: Array<[number, "html" | "html-srcset", string]> = [];
  let index = 4;
  const limit = Math.max(index, tag.length - 1);
  while (index < limit) {
    while (index < limit && (/\s/.test(tag[index] ?? "") || tag[index] === "/"))
      index += 1;
    const nameStart = index;
    while (index < limit && !/[\s=/>]/.test(tag[index] ?? "")) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = tag.slice(nameStart, index).toLocaleLowerCase();
    while (index < limit && /\s/.test(tag[index] ?? "")) index += 1;
    if (tag[index] !== "=") continue;
    index += 1;
    while (index < limit && /\s/.test(tag[index] ?? "")) index += 1;
    if (index >= limit) break;
    let value = "";
    if (tag[index] === '"' || tag[index] === "'") {
      const quote = tag[index];
      index += 1;
      const valueStart = index;
      while (index < limit && tag[index] !== quote) index += 1;
      value = tag.slice(valueStart, index);
      index += 1;
    } else {
      const valueStart = index;
      while (index < limit && !/[\s>]/.test(tag[index] ?? "")) index += 1;
      value = tag.slice(valueStart, index);
    }
    if (name === "src") sources.push([nameStart, "html", value]);
    if (name === "srcset")
      for (const source of srcsetSources(value))
        sources.push([nameStart, "html-srcset", source]);
  }
  return sources;
}

export function extractAssistantText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message))
    return message.map(extractAssistantText).filter(Boolean).join("\n");
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const type = String(record.type ?? "").toLocaleLowerCase();
  if (["image", "image_url", "input_image", "native_image"].includes(type))
    return "";
  const parts: string[] = [];
  if (typeof record.text === "string") parts.push(record.text);
  if (record.content !== undefined)
    parts.push(extractAssistantText(record.content));
  return parts.filter(Boolean).join("\n");
}

function validateSnapshotSource(
  source: string,
  root: string,
): string | undefined {
  if (!source) return "empty_image_source";
  if (!isAbsolute(source)) return "non_snapshot_path";
  try {
    const resolvedRoot = canonicalPath(root);
    const candidate = resolve(source);
    const realCandidate = resolve(realpathSafe(candidate));
    if (!pathWithin(resolvedRoot, realCandidate))
      return "outside_snapshot_root";
    return isReadableRegularFile(realCandidate) ?? undefined;
  } catch {
    return "outside_snapshot_root";
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function violation(
  syntax: string,
  source: string,
  position: number,
  root: string,
): ImageViolation | undefined {
  const reason = validateSnapshotSource(source, root);
  return reason ? { syntax, source, reason, position } : undefined;
}

export function checkText(
  text: string,
  snapshotRoot = defaultSnapshotRoot(),
): ImageViolation[] {
  if (!text) return [];
  const root = canonicalPath(snapshotRoot);
  const masked = maskCodeRegions(text);
  const definitions = referenceDefinitions(masked);
  const violations: ImageViolation[] = [];
  for (const [position, syntax, raw] of markdownImages(masked)) {
    const source =
      syntax === "markdown"
        ? markdownDestination(raw)
        : definitions.get(normalizeReferenceLabel(raw));
    if (source !== undefined) {
      const item = violation(syntax, source, position, root);
      if (item) violations.push(item);
    }
  }
  for (const match of masked.matchAll(HTML_IMAGE_TAG)) {
    const start = match.index ?? 0;
    for (const [relativePosition, syntax, source] of htmlImageSources(
      match[0],
    )) {
      const item = violation(syntax, source, start + relativePosition, root);
      if (item) violations.push(item);
    }
  }
  return violations.sort((left, right) => left.position - right.position);
}

export function checkMessage(
  message: unknown,
  snapshotRoot = defaultSnapshotRoot(),
): ImageViolation[] {
  return checkText(extractAssistantText(message), snapshotRoot);
}

function formatViolation(item: ImageViolation, root: string): string {
  return `${item.syntax} image source ${JSON.stringify(item.source)} is invalid (${item.reason}); use an absolute readable snapshot under ${root}`;
}

export function evaluatePayload(
  payload: Record<string, unknown>,
  snapshotRoot = defaultSnapshotRoot(),
): Record<string, unknown> {
  const violations = checkMessage(payload.last_assistant_message, snapshotRoot);
  if (violations.length === 0) return { continue: true };
  const details = violations
    .map((item) => formatViolation(item, snapshotRoot))
    .join("; ");
  return payload.stop_hook_active
    ? {
        continue: false,
        stopReason: `Owner-facing image delivery is blocked after one repair attempt. The response still contains a non-compliant image source; do not fall back to a remote image. ${details}`,
      }
    : {
        decision: "block",
        reason: `Owner-facing Markdown/HTML images must use immutable snapshots. Run snapshot_local_image.ts and replace the image source with its snapshot_path; do not fall back to a remote image. ${details}`,
      };
}

export function gateMain(input: string): number {
  if (!input.trim()) {
    process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
    return 0;
  }
  try {
    const payload: unknown = JSON.parse(input);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      process.stdout.write(
        `${JSON.stringify({ decision: "block", reason: "Owner-facing image gate requires a JSON object from the Stop hook." })}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `${JSON.stringify(evaluatePayload(payload as Record<string, unknown>))}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ decision: "block", reason: `Owner-facing image gate could not parse Stop hook input: ${error instanceof Error ? error.message : String(error)}` })}\n`,
    );
  }
  return 0;
}
