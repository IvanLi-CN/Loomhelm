import { createHash } from "node:crypto";
import { section, sectionHeadingCount } from "./markdown";

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
const HIGH_RISK = new Set([
  "safety",
  "migration",
  "data-integrity",
  "permission",
]);
const LEGACY_PHASE_AMBIGUITY =
  /(?:post[ _-]*(?:merge|deploy)|after[ _-]*(?:merge|deploy)|merge[ _-]*(?:receipt|sha)|(?:release|publish|deployment|deploy|observation|observe)|合并后|合并[ _-]*(?:receipt|sha)|发布|发版|部署|上线|观察|观测)/i;
const EMPIRICAL_SCENARIO =
  /(?:^|[,:;])[ \t]*(?:scenario|observable[ \t_-]*scenario|场景|可观察场景)[ \t]*[:=][ \t]*(?<value>[^,;]+)/i;
const EMPIRICAL_EXPECTED =
  /(?:^|[,:;])[ \t]*(?:expected|expected[ \t_-]*result|pass[ \t_-]*condition|期望|预期结果|通过条件)[ \t]*[:=][ \t]*(?<value>[^,;]+)/i;
const PYTHON_WHITESPACE_CLASS =
  "\\u0009-\\u000D\\u001C-\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const EMPIRICAL_BOUNDARY = `${PYTHON_WHITESPACE_CLASS},;:()\\[\\]{}.!?/_-`;
const EMPIRICAL_PLACEHOLDER = new RegExp(
  `(?:^|[${EMPIRICAL_BOUNDARY}])(?:placeholder|tbd|tba|tbc|todo|later|pending|待定|待确认|占位|后续验证)(?:$|[${EMPIRICAL_BOUNDARY}])`,
  "i",
);
const ENTRY =
  /^-[ \t]+(?<id>[A-Z][A-Z0-9_-]*)[ \t]+\[(?<category>[a-z-]+)\/(?<mode>[a-z]+)\][ \t]+(?<target>[^|]+?)[ \t]*\|[ \t]*(?:(?:scope=`(?<scope>[^`]+)`[ \t]*\|[ \t]*)?(?:phase=`(?<phase>[^`]+)`[ \t]*\|[ \t]*)?)?evidence=`(?<evidence>[^`]+)`[ \t]*\|[ \t]*assertions=`(?<assertions>[^`]+)`(?:[ \t]*\|[ \t]*gate=`(?<gate>[^`]+)`)?[ \t]*$/;

function compareStrings(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index]! !== rightPoints[index]!)
      return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function isPythonWhitespace(value: string): boolean {
  const codePoint = value.codePointAt(0)!;
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

function pythonStrip(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && isPythonWhitespace(characters[start]!)) start += 1;
  while (end > start && isPythonWhitespace(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end).join("");
}

function pythonRstrip(value: string): string {
  const characters = Array.from(value);
  let end = characters.length;
  while (end > 0 && isPythonWhitespace(characters[end - 1]!)) end -= 1;
  return characters.slice(0, end).join("");
}

export interface AcceptanceItem {
  id: string;
  category: string;
  mode: string;
  gate: string;
  scope: string;
  phase: string;
  target: string;
  evidence: string[];
  assertions: string[];
}

export interface AcceptanceManifest {
  plan_digest: string;
  items: AcceptanceItem[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => compareStrings(a, b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateEmpiricalAssertions(items: AcceptanceItem[]): void {
  for (const item of items) {
    const assertions = item.assertions.join(",");
    const scenario = pythonStrip(
      assertions.match(EMPIRICAL_SCENARIO)?.groups?.value ?? "",
    );
    const expected = pythonStrip(
      assertions.match(EMPIRICAL_EXPECTED)?.groups?.value ?? "",
    );
    if (!assertions.match(EMPIRICAL_SCENARIO)) {
      throw new Error(
        `empirical acceptance requires scenario=<concrete-observation>: ${item.id}`,
      );
    }
    if (!assertions.match(EMPIRICAL_EXPECTED)) {
      throw new Error(
        `empirical acceptance requires expected=<concrete-result>: ${item.id}`,
      );
    }
    if (!scenario || EMPIRICAL_PLACEHOLDER.test(scenario)) {
      throw new Error(`empirical scenario must be concrete: ${item.id}`);
    }
    if (!expected || EMPIRICAL_PLACEHOLDER.test(expected)) {
      throw new Error(`empirical expected result must be concrete: ${item.id}`);
    }
  }
}

export interface ParseAcceptanceOptions {
  requireEmpirical?: boolean;
  requireScopedAcceptance?: boolean;
  requirePhase?: boolean;
  scopeLabel?: string;
}

export function parseAcceptance(
  planText: string,
  options: ParseAcceptanceOptions = {},
): AcceptanceManifest {
  const {
    requireEmpirical = false,
    requireScopedAcceptance = false,
    requirePhase = false,
    scopeLabel,
  } = options;
  const headingCount = sectionHeadingCount(planText, "Acceptance & Validation");
  if (headingCount > 1)
    throw new Error("Acceptance & Validation section must appear exactly once");
  if (headingCount === 0)
    throw new Error("Acceptance & Validation section is missing");
  const entries = section(planText, "Acceptance & Validation")
    .split("\n")
    .map(pythonStrip)
    .filter(Boolean);
  if (!entries.length)
    throw new Error("Acceptance & Validation must contain at least one entry");
  const items: AcceptanceItem[] = [];
  const seen = new Set<string>();
  for (const line of entries) {
    const match = line.match(ENTRY);
    if (!match?.groups)
      throw new Error(
        "acceptance entry does not match strict ID/class/mode/evidence/assertions format",
      );
    const values = match.groups;
    const id = values.id;
    const category = values.category;
    const mode = values.mode;
    const gate = values.gate ?? "validation";
    if (requirePhase && (!values.scope || !values.phase)) {
      throw new Error(
        `DIRECT_V1_ACCEPTANCE_PHASE_REQUIRED: acceptance must declare scope=plan and phase explicitly: ${id}`,
      );
    }
    if (requirePhase && values.scope !== "plan") {
      throw new Error(
        `DIRECT_V1_ACCEPTANCE_SCOPE_INVALID: direct/v1 acceptance requires scope=plan: ${id}`,
      );
    }
    if (requireScopedAcceptance && (!values.scope || !values.phase)) {
      throw new Error(
        `${scopeLabel ?? "multi-task-flow"} acceptance requires explicit scope and phase: ${id}`,
      );
    }
    const scope = values.scope ?? "plan";
    const phase = values.phase ?? "pre_merge";
    if (!values.scope || !values.phase) {
      const legacyText = `${values.target ?? ""} ${values.evidence ?? ""} ${values.assertions ?? ""}`;
      if (LEGACY_PHASE_AMBIGUITY.test(legacyText)) {
        throw new Error(
          `LEGACY_ACCEPTANCE_PHASE_AMBIGUOUS: legacy acceptance requires explicit phase before continuing: ${id}`,
        );
      }
    }
    const evidence = (values.evidence ?? "")
      .split(",")
      .map(pythonStrip)
      .filter(Boolean);
    const assertions = (values.assertions ?? "")
      .split(",")
      .map(pythonStrip)
      .filter(Boolean);
    if (!id || !category || !mode)
      throw new Error(
        "acceptance entry does not match strict ID/class/mode/evidence/assertions format",
      );
    if (seen.has(id)) throw new Error(`duplicate acceptance ID: ${id}`);
    if (!ACCEPTANCE_CLASSES.has(category))
      throw new Error(`invalid acceptance category: ${category}`);
    if (!ACCEPTANCE_MODES.has(mode))
      throw new Error(`invalid acceptance evidence mode: ${mode}`);
    if (!ACCEPTANCE_GATES.has(gate))
      throw new Error(`invalid acceptance gate: ${gate}`);
    if (!ACCEPTANCE_PHASES.has(phase))
      throw new Error(`invalid acceptance phase: ${phase}`);
    if (
      requireScopedAcceptance &&
      !/^(?:task|batch):[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(scope)
    ) {
      throw new Error(
        `${scopeLabel ?? "multi-task-flow"} acceptance requires scope=task:<id> or batch:<id>: ${id}`,
      );
    }
    if (HIGH_RISK.has(category) && mode !== "direct") {
      throw new Error(`high-risk acceptance requires direct evidence: ${id}`);
    }
    if (
      !pythonStrip(values.target ?? "") ||
      !evidence.length ||
      !assertions.length
    ) {
      throw new Error(`acceptance entry is incomplete: ${id}`);
    }
    if (
      new Set(evidence).size !== evidence.length ||
      new Set(assertions).size !== assertions.length
    ) {
      throw new Error(
        `acceptance entry contains duplicate evidence/assertions: ${id}`,
      );
    }
    seen.add(id);
    items.push({
      id,
      category,
      mode,
      gate,
      scope,
      phase,
      target: pythonStrip(values.target ?? ""),
      evidence: [...evidence].sort(compareStrings),
      assertions: [...assertions].sort(compareStrings),
    });
  }
  items.sort((left, right) => compareStrings(left.id, right.id));
  if (requireEmpirical) validateEmpiricalAssertions(items);
  const normalizedPlan = pythonStrip(planText)
    .split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)
    .map(pythonRstrip)
    .join("\n");
  return {
    plan_digest: createHash("sha256").update(normalizedPlan).digest("hex"),
    items,
  };
}
