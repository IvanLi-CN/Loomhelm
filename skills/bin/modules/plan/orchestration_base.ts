import {
  linesOf,
  section,
  sectionHeadingCount,
  unfencedMarkerLines,
  validateFencedBlocks,
} from "./markdown";
import { posix as posixPath } from "node:path";

export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const LEGACY_BATCH_FIELDS = [
  "mode",
  "target",
  "depends_on",
  "condition",
  "acceptance",
  "observation_window",
] as const;
export const REQUIRED_BATCH_FIELDS = [
  ...LEGACY_BATCH_FIELDS,
  "parent_branch",
  "child_pr",
  "topology",
  "event_protocol",
  "release_policy",
] as const;
export const LEGACY_TASK_FIELDS = [
  "owned_surfaces",
  "depends_on",
  "condition",
  "acceptance",
  "skill",
] as const;
export const DISPLAY_TASK_FIELDS = ["title", "purpose", "outputs"] as const;
export const REQUIRED_TASK_FIELDS = [
  ...DISPLAY_TASK_FIELDS,
  ...LEGACY_TASK_FIELDS,
] as const;
export const V2_TASK_DISPLAY_FIELDS = DISPLAY_TASK_FIELDS;
export const V2_TASK_FIELDS = REQUIRED_TASK_FIELDS;
export const TASK_DEPENDENCY_MILESTONES = new Set(["integrated"]);
export const BATCH_DEPENDENCY_MILESTONES = new Set([
  "merged",
  "published",
  "deployed",
  "observed",
]);
export const MULTI_TASK_FLOW_TASK_SKILL = "$multi-task-flow";
export const MULTI_TASK_FLOW_EVENT_PROTOCOL = "multi-task-flow/v1";
export type TaskProfile = {
  model: string;
  thinking: string;
};

const TASK_PROFILE_EFFORTS = {
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6.1-terra": ["xhigh"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
} as const;

export const TASK_PROFILES: readonly TaskProfile[] = Object.entries(
  TASK_PROFILE_EFFORTS,
).flatMap(([model, efforts]) =>
  efforts.map((thinking) => ({ model, thinking })),
);

export type FieldMap = Record<string, string>;
export interface TaskRecord {
  id: string;
  batch_id: string;
  wave: number;
  fields: FieldMap;
  profile?: TaskProfile;
}
export interface WaveRecord {
  wave: number;
  indent: number;
  tasks: TaskRecord[];
}
export interface BatchRecord {
  id: string;
  indent: number;
  fields: FieldMap;
  waves: WaveRecord[];
}
export type BatchMap = Record<string, BatchRecord>;
export type TaskMap = Record<string, TaskRecord>;
export function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
export function hasKey<T>(map: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}
export function field(fields: FieldMap, key: string): string {
  return fields[key] ?? "";
}

function isPythonWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    (codePoint >= 0x1c && codePoint <= 0x20) ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

export const PYTHON_WHITESPACE_CLASS =
  "\\u0009-\\u000D\\u001C-\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";

export function pythonLstrip(value: string): string {
  let start = 0;
  while (start < value.length) {
    const codePoint = value.codePointAt(start)!;
    if (!isPythonWhitespace(codePoint)) break;
    start += codePoint > 0xffff ? 2 : 1;
  }
  return value.slice(start);
}

export function pythonRstrip(value: string): string {
  let end = value.length;
  while (end > 0) {
    const codePoint = value.codePointAt(end - 1)!;
    if (!isPythonWhitespace(codePoint)) break;
    end -= 1;
  }
  return value.slice(0, end);
}

export function pythonStrip(value: string): string {
  return pythonRstrip(pythonLstrip(value));
}

export function pythonRemoveWhitespace(value: string): string {
  return Array.from(value)
    .filter((character) => !isPythonWhitespace(character.codePointAt(0)!))
    .join("");
}

const PYTHON_WHITESPACE = `[${PYTHON_WHITESPACE_CLASS}]`;
export const batchPattern = new RegExp(
  `^-${PYTHON_WHITESPACE}+batch:(?<id>[A-Za-z0-9][A-Za-z0-9_.-]*)(?:${PYTHON_WHITESPACE}+\\[(?<mode>[^\\]]+)\\])?(?:${PYTHON_WHITESPACE}*=>${PYTHON_WHITESPACE}*(?<body>.*))?$`,
);
export const wavePattern = new RegExp(
  `^-${PYTHON_WHITESPACE}+wave:${PYTHON_WHITESPACE}*(?<wave>[0-9]+)${PYTHON_WHITESPACE}*$`,
);
export const taskPattern = new RegExp(
  `^-${PYTHON_WHITESPACE}+task:(?<id>[A-Za-z0-9][A-Za-z0-9_.-]*)(?:${PYTHON_WHITESPACE}+\\[(?<profile>[^\\]]+)\\])?${PYTHON_WHITESPACE}*=>${PYTHON_WHITESPACE}*(?<body>.*)$`,
);
export const contractPattern = new RegExp(
  `^-${PYTHON_WHITESPACE}+(?<kind>batch|task):(?<id>[A-Za-z0-9][A-Za-z0-9_.-]*)${PYTHON_WHITESPACE}*=>${PYTHON_WHITESPACE}*(?<body>.*)$`,
);

export function normalizeOwnedSurface(value: string): string {
  const stripped = pythonStrip(value).replaceAll("\\", "/");
  if (!stripped) throw new Error("owned surface must be repository-relative");
  const normalized = posixPath.normalize(stripped);
  const canonical =
    normalized === "/" ? normalized : normalized.replace(/\/+$/, "") || ".";
  if (
    canonical.startsWith("/") ||
    canonical === ".." ||
    canonical.startsWith("../") ||
    /^[A-Za-z]:\/.*$/.test(canonical)
  ) {
    throw new Error("owned surface must be repository-relative");
  }
  return canonical;
}

function parseIsoTimestamp(value: string, label: string): void {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match)
    throw new Error(
      `${label} observation_window must be an absolute ISO-8601 timestamp without fractional seconds`,
    );
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month - 1
    ] ?? 0;
  const offsetText = value.endsWith("Z") ? "0" : value.slice(-6);
  const offsetMinutes =
    offsetText === "0"
      ? 0
      : (offsetText.startsWith("-") ? -1 : 1) *
        (Number(offsetText.slice(1, 3)) * 60 + Number(offsetText.slice(4, 6)));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    Math.abs(offsetMinutes) >= 24 * 60
  ) {
    throw new Error(
      `${label} observation_window must be a valid absolute timestamp`,
    );
  }
}

export function parseFields(
  body: string,
  required: readonly string[],
  label: string,
  allowed: readonly string[] = required,
  expectedSkill = MULTI_TASK_FLOW_TASK_SKILL,
): FieldMap {
  const fields: FieldMap = dictionary<string>();
  for (const part of body.split(";")) {
    const item = pythonStrip(part);
    if (!item) continue;
    const separator = item.indexOf("=");
    if (separator < 0) throw new Error(`${label} contains a field without '='`);
    const key = pythonStrip(item.slice(0, separator));
    const value = pythonStrip(item.slice(separator + 1));
    if (key in fields) throw new Error(`${label} repeats field ${key}`);
    fields[key] = value;
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(fields)
    .filter((key) => !allowedSet.has(key))
    .sort();
  if (unknown.length)
    throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  const missing = required.filter((key) => !fields[key]);
  if (missing.length)
    throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
  if (required.includes("observation_window"))
    parseIsoTimestamp(field(fields, "observation_window"), label);
  if (required.includes("skill") && field(fields, "skill") !== expectedSkill)
    throw new Error(`${label} skill must be ${expectedSkill}`);
  if (
    required.includes("condition") &&
    !new Set(["pending", "true", "false", "unknown"]).has(
      field(fields, "condition"),
    )
  )
    throw new Error(
      `${label} condition must be pending, true, false, or unknown`,
    );
  if (required.includes("owned_surfaces")) {
    const surfaces = field(fields, "owned_surfaces")
      .split(",")
      .map(pythonStrip);
    if (!surfaces.length || surfaces.some((item) => !item))
      throw new Error(`${label} owned_surfaces must contain non-empty paths`);
    const normalized = surfaces.map(normalizeOwnedSurface);
    if (new Set(normalized).size !== normalized.length)
      throw new Error(`${label} owned_surfaces must not repeat a path`);
  }
  return fields;
}

export function normalized(value: string): string {
  return pythonRemoveWhitespace(value).toLowerCase();
}
export function normalizedTopology(value: string): string {
  return pythonStrip(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function normalizedField(key: string, value: string): string {
  if (key === "owned_surfaces")
    return value.split(",").map(normalizeOwnedSurface).join(",");
  if (key === "depends_on" || key === "target")
    return pythonRemoveWhitespace(value);
  return normalized(value);
}
export function ownedSurfacesOverlap(left: string, right: string): boolean {
  const a = normalizeOwnedSurface(left);
  const b = normalizeOwnedSurface(right);
  return (
    a === b ||
    a === "." ||
    b === "." ||
    a.startsWith(`${b.replace(/\/$/, "")}/`) ||
    b.startsWith(`${a.replace(/\/$/, "")}/`)
  );
}

export interface ParseOrchestrationOptions {
  requiredBatchFields?: readonly string[];
  requiredTaskFields?: readonly string[];
  expectedTaskSkill?: string;
  taskProfileLabel?: string;
  taskProfileAllowlist?: readonly TaskProfile[];
  expectedEventProtocol?: string;
  requireEarlierWave?: boolean;
  requireMultipleTasks?: boolean;
  requireExplicitDependency?: boolean;
  requireDisjointOwnedSurfaces?: boolean;
  acceptanceLabel?: string;
}

export const MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS: ParseOrchestrationOptions =
  {
    expectedTaskSkill: MULTI_TASK_FLOW_TASK_SKILL,
    taskProfileLabel: "multi-task-flow",
    taskProfileAllowlist: TASK_PROFILES,
    expectedEventProtocol: MULTI_TASK_FLOW_EVENT_PROTOCOL,
    requireEarlierWave: false,
    requireMultipleTasks: true,
    requireExplicitDependency: true,
    requireDisjointOwnedSurfaces: true,
    acceptanceLabel: "multi-task-flow",
  };
