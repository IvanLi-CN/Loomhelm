import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gitText } from "./git";

export const STATUS_READY = "待实现";
export const STATUS_PARTIAL_PREFIX = "部分完成";
export const STATUS_PENDING_DESIGN = "待设计";
export const STATUS_SKIPPED = "跳过";
export const STATUS_DONE = "已完成";
export const STATUS_VOID = "作废";
export const STATUS_REDESIGN_PREFIX = "重新设计";

export type Json = Record<string, unknown>;
export interface Candidate {
  id: string;
  title: string;
  status: string;
  path: string;
  createdAt: string | null;
  rank: number;
}

export function row(line: string): string[] {
  let raw = line.trim();
  if (raw.startsWith("|")) raw = raw.slice(1);
  if (raw.endsWith("|")) raw = raw.slice(0, -1);
  return raw.split("|").map((cell) => cell.trim());
}

export function separator(cells: string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((cell) => {
      const value = cell.replaceAll(":", "").trim();
      return value === "" || [...value].every((char) => char === "-");
    })
  );
}

export function pathCell(value: string): string | null {
  const text = value.trim();
  const link = /^\s*\[[^\]]+\]\(([^)]+)\)\s*$/.exec(text);
  return link?.[1]?.trim() ?? (text || null);
}

export function table(lines: string[]): {
  columns: Record<string, number>;
  start: number;
  pathLabel: string;
  mode: "status" | "lifecycle";
} | null {
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index]?.trimStart().startsWith("|")) continue;
    const headers = row(lines[index] as string);
    if (
      !headers.length ||
      separator(headers) ||
      !separator(row(lines[index + 1] as string))
    )
      continue;
    const map: Record<string, number> = {};
    headers.forEach((header, position) => {
      if (header) map[header.toLowerCase()] = position;
    });
    const pathLabel =
      map.spec !== undefined ? "spec" : map.plan !== undefined ? "plan" : null;
    if (!pathLabel) continue;
    if (
      map.id !== undefined &&
      map.title !== undefined &&
      map.status !== undefined
    )
      return {
        columns: {
          id: map.id,
          title: map.title,
          status: map.status,
          path: map[pathLabel] as number,
        },
        start: index + 2,
        pathLabel,
        mode: "status",
      };
    if (
      map.id !== undefined &&
      map.title !== undefined &&
      map.lifecycle !== undefined
    )
      return {
        columns: {
          id: map.id,
          title: map.title,
          lifecycle: map.lifecycle,
          path: map[pathLabel] as number,
        },
        start: index + 2,
        pathLabel,
        mode: "lifecycle",
      };
    if (map.topic !== undefined && map.lifecycle !== undefined)
      return {
        columns: {
          topic: map.topic,
          lifecycle: map.lifecycle,
          path: map[pathLabel] as number,
        },
        start: index + 2,
        pathLabel,
        mode: "lifecycle",
      };
  }
  return null;
}

export function relOrAbs(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path)).replaceAll(
    "\\",
    "/",
  );
  return relativePath.startsWith("../") ? resolve(path) : relativePath;
}

export function detectRoot(
  root: string,
): { mode: string; primary: string; fallback: string | null } | null {
  const specs = join(root, "docs/specs");
  const plan = join(root, "docs/plan");
  if (existsSync(specs))
    return {
      mode: "specs",
      primary: specs,
      fallback: existsSync(plan) ? plan : null,
    };
  if (existsSync(plan))
    return { mode: "plan_legacy", primary: plan, fallback: null };
  return null;
}

export function findPaths(root: string, id: string): string[] {
  if (!existsSync(root)) return [];
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directoryPattern = new RegExp(`^${escaped}(?:-|:).+`);
  const matches: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !directoryPattern.test(entry.name)) continue;
    for (const file of ["SPEC.md", "PLAN.md"]) {
      const candidate = join(root, entry.name, file);
      if (existsSync(candidate) && statSync(candidate).isFile())
        matches.push(resolve(candidate));
    }
  }
  return [...new Set(matches)];
}

export function resolveCandidate(
  root: string,
  id: string,
  cell: string,
  primary: string,
  fallback: string | null,
): { path: string | null; candidates: string[] } {
  const raw = pathCell(cell);
  if (raw) {
    const direct = resolve(root, raw);
    if (existsSync(direct) && statSync(direct).isFile())
      return {
        path: relOrAbs(root, direct),
        candidates: [relOrAbs(root, direct)],
      };
  }
  const primaryMatches = findPaths(primary, id);
  const specOnly = primaryMatches.filter(
    (path) => basename(path) === "SPEC.md",
  );
  if (primaryMatches.length === 1 || specOnly.length === 1) {
    const selected = (
      primaryMatches.length === 1 ? primaryMatches : specOnly
    )[0] as string;
    return {
      path: relOrAbs(root, selected),
      candidates: [relOrAbs(root, selected)],
    };
  }
  if (primaryMatches.length)
    return {
      path: null,
      candidates: primaryMatches.map((path) => relOrAbs(root, path)),
    };
  const fallbackMatches = fallback ? findPaths(fallback, id) : [];
  const fallbackSpecs = fallbackMatches.filter(
    (path) => basename(path) === "SPEC.md",
  );
  if (fallbackMatches.length === 1 || fallbackSpecs.length === 1) {
    const selected = (
      fallbackMatches.length === 1 ? fallbackMatches : fallbackSpecs
    )[0] as string;
    return {
      path: relOrAbs(root, selected),
      candidates: [relOrAbs(root, selected)],
    };
  }
  return {
    path: null,
    candidates: fallbackMatches.map((path) => relOrAbs(root, path)),
  };
}

export function createdAt(root: string, path: string): string | null {
  const output = gitText(root, [
    "log",
    "--diff-filter=A",
    "--follow",
    "--format=%aI",
    "--",
    path,
  ]);
  if (!output) return null;
  const lines = output.split(/\r?\n/).filter(Boolean);
  return lines[lines.length - 1] ?? null;
}

export function statusRank(status: string): number {
  return status.startsWith(STATUS_PARTIAL_PREFIX)
    ? 0
    : status === STATUS_READY
      ? 1
      : 99;
}
export function noPick(statuses: string[]): string {
  if (statuses.some((status) => status.includes(STATUS_PENDING_DESIGN)))
    return "no_implementable_has_pending_design";
  if (statuses.some((status) => status.includes(STATUS_SKIPPED)))
    return "no_implementable_has_skipped";
  if (
    statuses.length > 0 &&
    statuses.every(
      (status) =>
        status === STATUS_DONE ||
        status === STATUS_VOID ||
        status.startsWith(STATUS_REDESIGN_PREFIX),
    )
  )
    return "no_implementable_all_terminal";
  return "no_implementable";
}
