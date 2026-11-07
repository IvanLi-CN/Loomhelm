import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cloneReportFile } from "./isolation";
import type { CloneFile } from "./report_runtime";
import {
  SNAPSHOT_SCOPE,
  snapshotPath,
  validReportFilename,
  type ItemLists,
  type ManifestPair,
} from "./report_validate";
import { sha256FileSync } from "./paths";

function strictUtcDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const offsetHour = Number(match[8]?.slice(1, 3));
  const offsetMinute = Number(match[8]?.slice(4, 6));
  if (year < 1 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const milliseconds = (match[7] ?? "").padEnd(3, "0").slice(0, 3) || "000";
  const local = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`,
  );
  if (
    Number.isNaN(local.valueOf()) ||
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() + 1 !== Number(match[2]) ||
    local.getUTCDate() !== Number(match[3]) ||
    local.getUTCHours() !== Number(match[4]) ||
    local.getUTCMinutes() !== Number(match[5]) ||
    local.getUTCSeconds() !== Number(match[6]) ||
    local.getUTCMilliseconds() !== Number(milliseconds)
  )
    return undefined;
  const date = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}${match[8]}`,
  );
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

export function reportLayoutIssue(
  reportDir: string,
  root: string,
  manifest: Record<string, unknown>,
): string | undefined {
  const parts = relative(resolve(root), resolve(reportDir)).split(/[\\/]/);
  if (
    parts.length !== 6 ||
    !SNAPSHOT_SCOPE.test(parts[0] ?? "") ||
    !/^\d{4}$/.test(parts[1] ?? "") ||
    !/^(0[1-9]|1[0-2])$/.test(parts[2] ?? "") ||
    !/^(0[1-9]|[12]\d|3[01])$/.test(parts[3] ?? "") ||
    parts[4] !== "reg-cli-reports"
  )
    return "report directory does not match the snapshot store layout";
  const match = /^(\d{8}T\d{6}Z)-([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(
    parts[5] ?? "",
  );
  const created = strictUtcDate(manifest.created_at_utc);
  if (
    !match ||
    manifest.repo_scope !== parts[0] ||
    !created ||
    Number.isNaN(created.valueOf())
  )
    return "report directory does not match its manifest";
  const iso = created.toISOString();
  const expected = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  if (
    `${parts[1]}${parts[2]}${parts[3]}` !== expected.slice(0, 8) ||
    parts[5] !== `${expected}-${match[2]}`
  )
    return "report directory does not match its manifest";
  return undefined;
}

function parseAssignedJson(
  script: string,
): Record<string, unknown> | undefined {
  const assignment = /window\s*\[\s*["']__reg__["']\s*\]\s*=\s*/.exec(script);
  if (!assignment) return undefined;
  const source = script
    .slice(assignment.index + assignment[0].length)
    .trim()
    .replace(/;\s*$/, "");
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function withoutHtmlComments(content: string): string {
  let result = "";
  let cursor = 0;
  let inScript = false;
  let inComment = false;
  for (const match of content.matchAll(/<\/?script\b[^>]*>|<!--|-->/gi)) {
    const token = match[0] ?? "";
    const index = match.index ?? 0;
    if (!inComment) result += content.slice(cursor, index);
    if (inComment) {
      result += " ".repeat(token.length);
      if (token === "-->") inComment = false;
    } else if (!inScript && token === "<!--") {
      result += " ".repeat(token.length);
      inComment = true;
    } else {
      result += token;
      if (/^<script(?=\s|>)/i.test(token)) inScript = true;
      else if (/^<\/script(?=\s|>)/i.test(token)) inScript = false;
    }
    cursor = index + token.length;
  }
  return inComment ? result : result + content.slice(cursor);
}

function hasAppId(token: string): boolean {
  let index = 4;
  while (index < token.length - 1) {
    while (/\s|\//.test(token[index] ?? "")) index += 1;
    if (token[index] === ">") break;
    const start = index;
    while (!/[\s=/>]/.test(token[index] ?? "")) index += 1;
    const name = token.slice(start, index).toLowerCase();
    while (/\s/.test(token[index] ?? "")) index += 1;
    let value = "";
    if (token[index] === "=") {
      index += 1;
      while (/\s/.test(token[index] ?? "")) index += 1;
      const quote = token[index];
      if (quote === "'" || quote === '"') {
        index += 1;
        const end = token.indexOf(quote, index);
        value = token.slice(index, end < 0 ? token.length - 1 : end);
        index = end < 0 ? token.length : end + 1;
      } else {
        const end = index;
        while (!/[\s>]/.test(token[index] ?? "")) index += 1;
        value = token.slice(end, index);
      }
    }
    if (name === "id" && value === "app") return true;
  }
  return false;
}

function hasAppMount(content: string): boolean {
  let inScript = false;
  for (const match of content.matchAll(
    /<\/?script\b(?:[^"'<>]|"[^"]*"|'[^']*")*>|<div\b(?:[^"'<>]|"[^"]*"|'[^']*")*>/gi,
  )) {
    const token = match[0] ?? "";
    if (/^<script(?=\s|>)/i.test(token)) {
      inScript = true;
      continue;
    }
    if (/^<\/script(?=\s|>)/i.test(token)) {
      inScript = false;
      continue;
    }
    if (!inScript && !/^<div(?=\s|\/?>)/i.test(token)) continue;
    if (!inScript && hasAppId(token)) return true;
  }
  return false;
}

export function htmlReportIssue(
  path: string,
  itemLists: ItemLists,
): string | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return "cannot read HTML report";
  }
  content = withoutHtmlComments(content);
  if (!hasAppMount(content))
    return "HTML report is missing the rendered reg-cli application or report data";
  const scripts = [
    ...content.matchAll(/<script(?=\s|>)[^>]*>([\s\S]*?)<\/script\s*>/gi),
  ].map((match) => match[1] ?? "");
  const config = scripts.map(parseAssignedJson).find((value) => value);
  if (
    !config ||
    !scripts.some(
      (script) => script.trim().length > 32 && !parseAssignedJson(script),
    )
  )
    return "HTML report is missing the rendered reg-cli application";
  if (
    config.actualDir !== "./actual" ||
    config.expectedDir !== "./expected" ||
    config.diffDir !== "./diff"
  )
    return "HTML report does not reference the report input directories";
  for (const key of ["failedItems", "passedItems"] as const) {
    const entries = config[key];
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          !validReportFilename((entry as Record<string, unknown>).raw) ||
          (entry as Record<string, unknown>).encoded !==
            (entry as Record<string, unknown>).raw,
      )
    )
      return "HTML report contains invalid comparison entries";
    const names = entries.map(
      (entry) => (entry as Record<string, unknown>).raw as string,
    );
    const expectedNames = new Set(itemLists[key]);
    const actualNames = new Set(names);
    if (
      actualNames.size !== names.length ||
      actualNames.size !== expectedNames.size ||
      [...expectedNames].some((name) => !actualNames.has(name))
    )
      return `HTML report comparison entries do not exactly match ${key}`;
    if (
      config[key === "failedItems" ? "hasFailed" : "hasPassed"] !==
      names.length > 0
    )
      return "HTML report result flags do not match its comparison entries";
  }
  if (
    JSON.stringify(config.newItems) !== "[]" ||
    JSON.stringify(config.deletedItems) !== "[]" ||
    config.hasNew !== false ||
    config.hasDeleted !== false
  )
    return "HTML report contains unrequested new or deleted items";
  return undefined;
}

export function snapshotIntegrityIssue(
  pairs: ManifestPair[],
  root: string,
): string | undefined {
  for (const pair of pairs)
    for (const [pathKey, hashKey] of [
      ["actual_snapshot", "actual_sha256"],
      ["expected_snapshot", "expected_sha256"],
    ] as const) {
      try {
        const source = snapshotPath(pair[pathKey], root);
        if (sha256FileSync(source) !== pair[hashKey])
          return "snapshot input changed during report generation";
      } catch {
        return "snapshot input disappeared or escaped the asset root";
      }
    }
  return undefined;
}

export function cloneReportOutputs(
  source: string,
  publication: string,
  itemLists: ItemLists,
  clone: CloneFile = cloneReportFile,
): void {
  clone(join(source, "report.html"), join(publication, "report.html"));
  clone(join(source, "reg.json"), join(publication, "reg.json"));
  for (const filename of itemLists.diffItems)
    clone(join(source, "diff", filename), join(publication, "diff", filename));
}
