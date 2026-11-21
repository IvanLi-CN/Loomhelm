import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, unknown>;

export interface Finding {
  code: string;
  line: number;
  message: string;
}

export interface ReplayResult {
  findings: Finding[];
}

export interface ReplayCase {
  path: string;
  expectFail: boolean;
  expectedCodes: string[];
  line: number;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

const trackerCardFields = new Set([
  "phase",
  "tracking_phase",
  "追踪阶段",
  "tracking_target",
  "追踪目标",
  "bound_sha",
  "checked_sha",
  "追踪绑定sha",
  "绑定sha",
  "terminal_state",
  "追踪终态",
  "result",
  "追踪结果",
  "external_locator",
  "外部定位",
]);
const routeResolutionFields = new Set([
  "pre_merge_release_route",
  "release_disposition",
  "release_route",
  "release_route_resolved",
  "current_repository_facts",
  "repository_facts",
  "current_pr_facts",
  "pr_facts",
]);

function pythonText(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

export function collectTrackerCardStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTrackerCardStrings);
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (
      trackerCardFields.has(key) &&
      (typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean")
    ) {
      texts.push(`${key}=${pythonText(item)}`);
    } else if (routeResolutionFields.has(key)) {
      if (Array.isArray(item) || isRecord(item)) {
        texts.push(key);
        texts.push(...collectTrackerCardStrings(item));
      } else {
        texts.push(`${key}=${pythonText(item)}`);
      }
    } else if (Array.isArray(item) || isRecord(item)) {
      texts.push(...collectTrackerCardStrings(item));
    }
  }
  return texts;
}

type JsonScanResult = number | "duplicate" | undefined;

function skipJsonWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}

function scanJsonString(
  text: string,
  start: number,
): { end: number; value: string } | undefined {
  if (text[start] !== '"') return undefined;
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      const raw = text.slice(start, index + 1);
      try {
        const value: unknown = JSON.parse(raw);
        return typeof value === "string"
          ? { end: index + 1, value }
          : undefined;
      } catch {
        return undefined;
      }
    }
    index += 1;
  }
  return undefined;
}

function scanJsonValue(text: string, start: number): JsonScanResult {
  const index = skipJsonWhitespace(text, start);
  if (text[index] === '"') return scanJsonString(text, index)?.end;
  if (text[index] === "{") {
    const keys = new Set<string>();
    let cursor = skipJsonWhitespace(text, index + 1);
    if (text[cursor] === "}") return cursor + 1;
    while (cursor < text.length) {
      const key = scanJsonString(text, cursor);
      if (!key) return undefined;
      if (keys.has(key.value)) return "duplicate";
      keys.add(key.value);
      cursor = skipJsonWhitespace(text, key.end);
      if (text[cursor] !== ":") return undefined;
      const value = scanJsonValue(text, cursor + 1);
      if (value === "duplicate" || value === undefined) return value;
      cursor = skipJsonWhitespace(text, value);
      if (text[cursor] === "}") return cursor + 1;
      if (text[cursor] !== ",") return undefined;
      cursor = skipJsonWhitespace(text, cursor + 1);
    }
    return undefined;
  }
  if (text[index] === "[") {
    let cursor = skipJsonWhitespace(text, index + 1);
    if (text[cursor] === "]") return cursor + 1;
    while (cursor < text.length) {
      const value = scanJsonValue(text, cursor);
      if (value === "duplicate" || value === undefined) return value;
      cursor = skipJsonWhitespace(text, value);
      if (text[cursor] === "]") return cursor + 1;
      if (text[cursor] !== ",") return undefined;
      cursor = skipJsonWhitespace(text, cursor + 1);
    }
    return undefined;
  }
  let cursor = index;
  while (cursor < text.length && !/[\s,\]}]/.test(text[cursor]!)) cursor += 1;
  return cursor > index ? cursor : undefined;
}

function hasDuplicateJsonKeys(text: string): boolean {
  return scanJsonValue(text, 0) === "duplicate";
}

export function parseJsonArguments(raw: unknown): JsonRecord {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};
  const parsed = parseJsonValue(raw);
  return isRecord(parsed) ? parsed : {};
}

export function parseJsonValue(raw: string): unknown | undefined {
  if (hasDuplicateJsonKeys(raw)) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function eventTexts(record: JsonRecord): {
  kind: string | undefined;
  role: string | undefined;
  texts: string[];
} {
  const recordType = typeof record.type === "string" ? record.type : undefined;
  const payload = isRecord(record.payload) ? record.payload : {};
  if (recordType !== "response_item")
    return {
      kind: recordType,
      role: undefined,
      texts: collectStrings(payload),
    };

  const payloadType =
    typeof payload.type === "string" ? payload.type : undefined;
  if (payloadType === "message") {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const texts = content.flatMap((item) => {
      if (!isRecord(item) || typeof item.text !== "string") return [];
      return [item.text];
    });
    return {
      kind: "message",
      role: typeof payload.role === "string" ? payload.role : undefined,
      texts,
    };
  }
  if (payloadType === "function_call") {
    const texts = [payload.name, payload.arguments].filter(
      (item): item is string => typeof item === "string",
    );
    return { kind: "function_call", role: undefined, texts };
  }
  if (payloadType === "function_call_output")
    return {
      kind: "function_call_output",
      role: undefined,
      texts: [
        ...collectStrings(payload.output),
        ...(typeof payload.output === "object" && payload.output !== null
          ? [JSON.stringify(payload.output)]
          : []),
      ],
    };
  return { kind: payloadType, role: undefined, texts: collectStrings(payload) };
}

export function eventText(record: JsonRecord): string {
  return eventTexts(record).texts.join("\n");
}

export function readJsonLines(
  path: string,
): Array<{ line: number; value: JsonRecord }> {
  const records: Array<{ line: number; value: JsonRecord }> = [];
  for (const [index, raw] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    if (!raw.trim()) continue;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed))
      throw new Error(`replay record at line ${index + 1} must be an object`);
    records.push({ line: index + 1, value: parsed });
  }
  return records;
}

export function parseReplayCases(path: string): ReplayCase[] {
  const cases: ReplayCase[] = [];
  for (const [index, raw] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) throw new Error(`invalid cases line ${index + 1}`);
    if (fields[0] === "pass" || fields[0] === "fail") {
      if (fields.length < 3)
        throw new Error(`missing expectation at line ${index + 1}`);
      cases.push({
        path: fields[1]!,
        expectFail: fields[0] === "fail",
        expectedCodes: fields[2] === "-" ? [] : fields[2]!.split(","),
        line: index + 1,
      });
      continue;
    }
    cases.push({
      path: fields[0]!,
      expectFail: fields[1] !== "pass",
      expectedCodes: fields[1] === "pass" ? [] : fields[1]!.split(","),
      line: index + 1,
    });
  }
  return cases;
}

export function resolveCasePath(baseDir: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

export type ReplayAnalyzer = (path: string) => ReplayResult;

export interface ReplayCaseFailure {
  case: ReplayCase;
  actualCodes: string[];
  path: string;
}

export type ReplayExpectation = "required" | "exact";

export function runReplayCases(
  casesPath: string,
  analyzer: ReplayAnalyzer,
  expectation: ReplayExpectation = "required",
): ReplayCaseFailure[] {
  const failures: ReplayCaseFailure[] = [];
  for (const item of parseReplayCases(casesPath)) {
    const localPath = resolveCasePath(dirname(casesPath), item.path);
    const path = existsSync(localPath)
      ? localPath
      : resolveCasePath(process.cwd(), item.path);
    const actualCodes = analyzer(path)
      .findings.map((finding) => finding.code)
      .sort();
    const actualCodeSet = [...new Set(actualCodes)];
    const expectedCodes = [...new Set(item.expectedCodes)].sort();
    const equal = item.expectFail
      ? expectation === "exact"
        ? actualCodes.length === expectedCodes.length &&
          actualCodes.every((code, index) => code === expectedCodes[index])
        : expectedCodes.every((code) => actualCodeSet.includes(code))
      : actualCodes.length === 0;
    if (!equal) failures.push({ case: item, actualCodes, path });
  }
  return failures;
}

export function result(findings: Finding[]): ReplayResult {
  return { findings };
}

export function finding(code: string, line: number, message: string): Finding {
  return { code, line, message };
}
