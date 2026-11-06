import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { FlowError, isRecord, stableHash } from "./common";

const UNAVAILABLE_RE =
  /(?:\b(?:repository|repo|workspace|filesystem|environment|sandbox|git|inspection|review|access)\s+(?:is|was)?\s*unavailable\b|\bunavailable\s+(?:repository|repo|workspace|filesystem|environment|sandbox|git|inspection|review|access)\b|\bno\s+(?:reliable|inspection\s+)?evidence\b(?!-)|(?:unable|cannot|could not|无法|不能).{0,120}(?:inspect|review|access|read|sandbox|environment|repository|filesystem|git|command|审查|读取|沙箱|环境|仓库|命令))/i;
const NO_CONCLUSION_RE =
  /(?:\bno\s+(?:evidence-based\s+)?(?:conclusion|assessment)\b|\b(?:unable|cannot|could not)\s+to\s+(?:reach|make|provide).{0,80}(?:conclusion|assessment)|无法.{0,80}(?:结论|判断)|不能.{0,80}(?:结论|判断))/i;
const EVIDENCE_RE =
  /(?:\b(?:inspect(?:ed|ion)?|review(?:ed)?|analy[sz](?:ed|is|e)?|verify|verified|check(?:ed)?|test(?:ed)?|validat(?:e|ed|ion)|read)\b.{0,160}\b(?:diff|change|patch|code|implementation|test|contract|base|head|repository)\b|\b(?:diff|change|patch|code|implementation|test|contract|base|repository)\b.{0,160}\b(?:inspect(?:ed|ion)?|review(?:ed)?|analy[sz](?:ed|is|e)?|verify|verified|check(?:ed)?|test(?:ed)?|validat(?:e|ed|ion)|read)\b|(?:审查|检查|验证|测试|阅读).{0,160}(?:差异|变更|补丁|代码|实现|合同|仓库)|(?:差异|变更|补丁|代码|实现|合同|仓库).{0,160}(?:审查|检查|验证|测试|阅读))/i;

export interface ParsedReviewResult {
  result: Record<string, unknown>;
  fingerprints: string[];
  resultSha256: string;
}

export function parseReviewResultJson(raw: string): ParsedReviewResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new FlowError("review final message is not valid structured JSON", {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "findings,overall_confidence_score,overall_correctness,overall_explanation"
  )
    throw new FlowError(
      "review final message does not match the required schema",
    );
  if (!Array.isArray(value.findings))
    throw new FlowError("review findings must be an array");
  const findings: Record<string, unknown>[] = [];
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      Object.keys(finding).sort().join(",") !==
        "body,code_location,confidence_score,priority,title"
    )
      throw new FlowError("review finding does not match the required schema");
    const location = finding.code_location;
    const range = isRecord(location) ? location.line_range : undefined;
    if (
      typeof finding.title !== "string" ||
      typeof finding.body !== "string" ||
      !Number.isInteger(finding.priority) ||
      Number(finding.priority) < 0 ||
      Number(finding.priority) > 3 ||
      typeof finding.confidence_score !== "number" ||
      !Number.isFinite(finding.confidence_score) ||
      finding.confidence_score < 0 ||
      finding.confidence_score > 1 ||
      !isRecord(location) ||
      Object.keys(location).sort().join(",") !==
        "absolute_file_path,line_range" ||
      typeof location.absolute_file_path !== "string" ||
      !location.absolute_file_path.trim() ||
      !isAbsolute(location.absolute_file_path) ||
      !isRecord(range) ||
      Object.keys(range).sort().join(",") !== "end,start" ||
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      Number(range.start) < 1 ||
      Number(range.end) < Number(range.start)
    )
      throw new FlowError("review finding contains invalid field values");
    findings.push(finding);
  }
  if (
    !["patch is correct", "patch is incorrect"].includes(
      String(value.overall_correctness),
    ) ||
    typeof value.overall_explanation !== "string" ||
    !value.overall_explanation.trim() ||
    typeof value.overall_confidence_score !== "number" ||
    !Number.isFinite(value.overall_confidence_score) ||
    value.overall_confidence_score < 0 ||
    value.overall_confidence_score > 1
  )
    throw new FlowError("review summary does not match the required schema");
  const blocking = findings.filter((finding) => Number(finding.priority) <= 2);
  const fingerprints = blocking.map(reviewFindingFingerprint).sort();
  if (
    value.overall_correctness === "patch is incorrect" &&
    !fingerprints.length
  )
    throw new FlowError(
      "review rejects the patch without an actionable blocking finding",
    );
  if (UNAVAILABLE_RE.test(value.overall_explanation))
    throw new FlowError("review reports unavailable inspection evidence");
  if (NO_CONCLUSION_RE.test(value.overall_explanation))
    throw new FlowError("review does not contain an evidence-based conclusion");
  if (!EVIDENCE_RE.test(value.overall_explanation))
    throw new FlowError(
      "review summary does not contain evidence of candidate inspection",
    );
  return {
    result: { ...value, findings },
    fingerprints,
    resultSha256: stableHash(value),
  };
}

export function reviewFindingFingerprint(
  finding: Record<string, unknown>,
): string {
  const location = finding.code_location as Record<string, unknown>;
  const title = String(finding.title).trim().replace(/\s+/g, " ").toLowerCase();
  const body = String(finding.body)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\d+\b/g, "<number>");
  return stableHash({
    title,
    absolute_file_path: location.absolute_file_path,
    body,
  });
}

export function validateReviewFindingLocations(
  result: Record<string, unknown>,
  repo: string,
  baseSha: string,
  headSha: string,
): void {
  for (const finding of result.findings as Record<string, unknown>[]) {
    const location = finding.code_location as Record<string, unknown>;
    const range = location.line_range as Record<string, unknown>;
    const path = resolve(String(location.absolute_file_path));
    const root = resolve(repo);
    const relativePath = relative(root, path);
    if (relativePath.startsWith("..") || relativePath.includes("\0"))
      throw new FlowError("review finding is outside the repository");
    const currentExists = existsSync(path);
    let currentLines = 0;
    if (currentExists)
      currentLines = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter(
          (_, index, lines) => index < lines.length - 1 || lines[index] !== "",
        ).length;
    const baseText = gitText(repo, baseSha, relativePath);
    const baseLines =
      baseText === undefined
        ? 0
        : baseText
            .split(/\r?\n/)
            .filter(
              (_, index, lines) =>
                index < lines.length - 1 || lines[index] !== "",
            ).length;
    if (!currentExists && baseText === undefined)
      throw new FlowError("review finding file does not exist");
    if (Number(range.end) > Math.max(1, currentLines, baseLines))
      throw new FlowError("review finding line range exceeds the file");
    const diff = gitDiff(repo, baseSha, headSha, relativePath);
    const changed = [
      ...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
    ].flatMap((match) => {
      const oldStart = Number(match[1]);
      const oldCount = Number(match[2] ?? 1);
      const newStart = Number(match[3]);
      const newCount = Number(match[4] ?? 1);
      return [
        ...(newCount > 0 ? [[newStart, newStart + newCount - 1]] : []),
        ...(oldCount > 0 ? [[oldStart, oldStart + oldCount - 1]] : []),
      ];
    });
    if (
      !changed.some(
        ([start, end]) =>
          Number(range.start) <= (end ?? 0) &&
          Number(range.end) >= (start ?? Number.MAX_SAFE_INTEGER),
      )
    )
      throw new FlowError("review finding does not overlap the candidate diff");
  }
}

function gitText(
  repo: string,
  revision: string,
  path: string,
): string | undefined {
  try {
    return execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function gitDiff(
  repo: string,
  base: string,
  head: string,
  path: string,
): string {
  try {
    return execFileSync(
      "git",
      ["diff", "--unified=0", "--format=", `${base}...${head}`, "--", path],
      {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch (error) {
    throw new FlowError("review finding diff cannot be inspected", {
      cause: error,
    });
  }
}
