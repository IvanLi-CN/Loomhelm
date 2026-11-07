import { readFileSync } from "node:fs";
import {
  finding,
  isRecord,
  parseJsonArguments,
  result,
  type Finding,
  type JsonRecord,
  type ReplayResult,
} from "./replay";

const trackingMarkers = [
  "release-tracker",
  "release-tracking",
  "release_tracking",
  "ci-tracker",
  "ci-tracking",
  "ci_tracking",
  "release tracking",
  "ci tracking",
  "deployment tracking",
  "pr status tracking",
  "post_merge_release",
  "pr_head_ci",
  "post_merge_target_ci",
];
const anchorMarkers = [
  "chat",
  "release_epoch",
  "target_repo",
  "target_branch",
  "origin_sha",
  "trigger",
  "run_locator",
  "surface_locator",
  "lineage",
  "child_handle",
  "startup_reason",
  "retry_record",
  "recovery_operation",
  "window_start",
  "deadline",
];
const mutatingModes = new Set(["create", "suggested_create", "update"]);

function flatten(value: unknown): string {
  if (isRecord(value))
    return Object.entries(value)
      .map(([key, item]) => `${flatten(key)} ${flatten(item)}`)
      .join(" ");
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  return String(value);
}

function payload(record: JsonRecord): JsonRecord {
  return isRecord(record.payload) ? record.payload : record;
}

function isTracking(record: JsonRecord): boolean {
  const text = flatten(record).toLowerCase();
  return trackingMarkers.some((marker) => text.includes(marker));
}

function fields(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/([a-z_]+)=([^\s]+)/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  ) as Record<string, string>;
}

function iso(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value.replace(/z$/i, "Z"));
  return Number.isNaN(parsed.valueOf()) || !/[zZ]|[+-]\d\d:?\d\d$/.test(value)
    ? undefined
    : parsed;
}

function incompleteAnchor(record: JsonRecord): boolean {
  const text = flatten(record);
  if (
    !text.toLowerCase().includes("$flow-continue") ||
    !text.toLowerCase().includes("recovery anchor")
  )
    return false;
  const values = fields(text);
  if (anchorMarkers.some((marker) => !values[marker])) return true;
  if (!/^[0-9a-f]{40}$/.test(values.origin_sha!)) return true;
  const trigger = iso(values.trigger);
  const start = iso(values.window_start);
  const deadline = iso(values.deadline);
  if (!trigger || !start || !deadline) return true;
  const operation = values.recovery_operation;
  if (operation !== "none" && operation !== "authorized") return true;
  const max = operation === "none" ? 1_800_000 : 3_600_000;
  if (
    start.valueOf() !== trigger.valueOf() ||
    deadline <= start ||
    deadline.valueOf() - start.valueOf() > max
  )
    return true;
  return ["run_locator", "surface_locator", "child_handle"].some((key) =>
    ["none", "unknown", "unavailable"].includes(values[key]!),
  );
}

function unrelated(record: JsonRecord): boolean {
  if (record.type !== "tracking_scope_boundary") return false;
  const raw = payload(record);
  return (
    raw.tracking === false ||
    ["unrelated", "non_tracking"].includes(
      String(raw.tracking_scope ?? "").toLowerCase(),
    )
  );
}

function scheduled(record: JsonRecord): boolean {
  const raw = payload(record);
  const type = String(raw.type ?? "");
  if (!["function_call", "tool_call"].includes(type)) return false;
  const name = String(raw.name ?? raw.tool_name ?? "").toLowerCase();
  if (
    !name.includes("automation_update") &&
    !flatten(raw).toLowerCase().includes("automation_update")
  )
    return false;
  const args = parseJsonArguments(raw.arguments ?? raw.input);
  return mutatingModes.has(String(args.mode ?? "").toLowerCase());
}

export function analyzeReleaseTracking(path: string): ReplayResult {
  const findings: Finding[] = [];
  let trackingContext = false;
  let anchor: Record<string, string> | undefined;
  for (const [index, raw] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      findings.push(finding("REPLAY_JSON_INVALID", index + 1, String(error)));
      continue;
    }
    if (!isRecord(record)) continue;
    if (unrelated(record)) {
      trackingContext = false;
      anchor = undefined;
      continue;
    }
    trackingContext ||= isTracking(record);
    if (trackingContext && incompleteAnchor(record))
      findings.push(
        finding(
          "TRACKING_RECOVERY_ANCHOR_INCOMPLETE",
          index + 1,
          "manual flow-continue recovery anchor is missing required identity or retry fields",
        ),
      );
    const text = flatten(record);
    if (
      trackingContext &&
      text.toLowerCase().includes("$flow-continue") &&
      text.toLowerCase().includes("recovery anchor") &&
      !incompleteAnchor(record)
    ) {
      const current = fields(text);
      const previous = anchor;
      if (
        previous &&
        [
          "chat",
          "target_repo",
          "target_branch",
          "origin_sha",
          "release_epoch",
          "trigger",
          "run_locator",
          "surface_locator",
          "lineage",
          "child_handle",
          "startup_reason",
          "retry_record",
          "window_start",
          "deadline",
        ].some((key) => current[key] !== previous[key])
      )
        findings.push(
          finding(
            "TRACKING_RECOVERY_ANCHOR_MISMATCH",
            index + 1,
            "manual recovery anchor changed identity or time fields",
          ),
        );
      anchor = current;
    }
    if (trackingContext && scheduled(record))
      findings.push(
        finding(
          "TRACKING_SCHEDULED_AUTOMATION_FORBIDDEN",
          index + 1,
          "tracking automation_update attempted to create or update a scheduled task",
        ),
      );
  }
  return result(findings);
}
