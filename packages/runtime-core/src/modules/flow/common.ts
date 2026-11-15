import { createHash } from "node:crypto";

export class FlowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FlowError";
  }
}

export const FLOW_SCHEMA_VERSION = 7;
export const REVIEW_RECEIPT_SCHEMA_VERSION = 6;
export const DEFAULT_COMMAND_BUDGET_SECONDS = 1800;
export const MAX_CONVERGENCE_ROUNDS = 3;
export const TRANSIENT_VALIDATION_EXIT_CODES = new Set([75, 124]);
export const TERMINAL_STATES = new Set([
  "complete",
  "failed",
  "cancelled",
  "NON_CONVERGENT",
]);
export const REVIEW_NECESSITY_TIERS = new Set([1, 2, 3, 4]);
export const DIRECT_REVIEW_FLOW_TYPES = new Set([
  "fast-track",
  "normal",
  "local-merge",
]);
export const PR_BOUND_FLOW_TYPES = new Set(["fast-track", "normal"]);
export const FIXED_REVIEW_LANES = new Set([
  "contract",
  "state-concurrency",
  "failure-data-safety",
  "test-platform",
]);
export const DYNAMIC_REVIEW_LANES = new Set([
  "ui-accessibility",
  "security",
  "database-migration",
  "release-infra",
]);
export const MAX_DYNAMIC_REVIEW_LANES = 2;
export const REVIEW_SCOPE_CLASSES = new Set(["code", "document", "mechanical"]);
export const ACCEPTANCE_CLASSES = new Set([
  "behavior",
  "contract",
  "safety",
  "migration",
  "data-integrity",
  "permission",
  "mechanical",
]);
export const ACCEPTANCE_MODES = new Set(["direct", "composed"]);
export const ACCEPTANCE_GATES = new Set(["validation", "delivery"]);
export const ACCEPTANCE_PHASES = new Set([
  "pre_merge",
  "post_merge",
  "post_deploy",
]);
export const HIGH_RISK_ACCEPTANCE_CLASSES = new Set([
  "safety",
  "migration",
  "data-integrity",
  "permission",
]);

export type JsonObject = { [key: string]: unknown };

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result || undefined;
}

function escapeAscii(value: string): string {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapeAscii(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new FlowError("cannot encode non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${escapeAscii(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new FlowError("cannot encode unsupported JSON value");
}

export function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function normalizeSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new FlowError(`${label} is invalid`);
  }
  return value.toLowerCase();
}

export function assertRecord(
  value: unknown,
  message: string,
): asserts value is JsonObject {
  if (!isRecord(value)) throw new FlowError(message);
}
