import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseReplayCases,
  resolveCasePath,
  runReplayCases,
} from "./modules/checks/replay";

export type Analyzer = (path: string) => {
  findings: Array<{ code: string; line: number; message: string }>;
};

export function option(
  argv: string[],
  name: string,
  fallback?: string,
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === `--${name}`) return argv[index + 1] ?? fallback;
    if (token?.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return fallback;
}

export function values(argv: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === `--${name}` && argv[index + 1]) result.push(argv[++index]!);
    else if (token?.startsWith(`--${name}=`))
      result.push(token.slice(name.length + 3));
  }
  return result;
}

export function groups(argv: string[], name: string, size: number): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== `--${name}`) continue;
    const group = argv.slice(index + 1, index + 1 + size);
    if (group.length === size) result.push(group);
    index += size;
  }
  return result;
}

export function positional(argv: string[]): string[] {
  const skip = new Set([
    "--repo-root",
    "--cases",
    "--path",
    "--base-sha",
    "--output-dir",
    "--repo",
    "--remote",
    "--number",
    "--sha",
    "--method",
    "--expected-base",
    "--expected-head",
    "--branch",
    "--title",
    "--body-file",
    "--head",
    "--base",
    "--run-id",
    "--expected-sha",
    "--tag",
    "--note-file",
    "--target",
    "--event",
    "--text-file",
    "--context",
  ]);
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (skip.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("--")) result.push(token);
  }
  return result;
}

export function replay(
  argv: string[],
  analyzer: Analyzer,
  expectation: "required" | "exact" = "required",
): number {
  const casePaths = values(argv, "cases");
  const paths = positional(argv);
  if (!casePaths.length && !paths.length) {
    console.error("at least one replay path is required");
    return 2;
  }
  let exitCode = 0;
  const summary = argv.includes("--summary");
  for (const casesPath of casePaths) {
    const failures = replayCases(casesPath, analyzer, expectation, summary);
    if (failures.length) {
      exitCode = 1;
      for (const failure of failures)
        console.error(formatCaseMismatch(failure, summary));
    }
  }
  for (const path of paths) {
    try {
      const caseFailures = path.endsWith(".txt")
        ? replayCases(path, analyzer, expectation, summary)
        : undefined;
      if (caseFailures !== undefined) {
        if (caseFailures.length) {
          exitCode = 1;
          for (const failure of caseFailures)
            console.error(formatCaseMismatch(failure, summary));
        }
        continue;
      }
      const findings = analyzer(path).findings;
      if (findings.length) {
        exitCode = 1;
        if (summary)
          console.log(`SUMMARY file=${path} ${replaySummary(findings)}`);
        else
          findings.forEach((finding) =>
            console.log(
              `FINDING file=${path} code=${finding.code} line=${finding.line} msg=${finding.message}`,
            ),
          );
      } else {
        console.log(
          summary
            ? `SUMMARY file=${path} status=PASS total=0`
            : `PASS file=${path}`,
        );
      }
    } catch (error) {
      exitCode = 1;
      console.error(
        `FAIL file=${path} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return exitCode;
}

function formatCaseMismatch(
  failure: ReturnType<typeof runReplayCases>[number],
  summary: boolean,
): string {
  const actual = failure.actualCodes.join(",") || "PASS";
  if (summary) {
    return failure.case.expectFail
      ? `ERROR file=${failure.path} expected finding ${failure.case.expectedCodes.join(",") || "any"} but saw ${actual}`
      : `ERROR file=${failure.path} expected PASS but saw findings ${actual}`;
  }
  return `CASE_MISMATCH file=${failure.path} line=${failure.case.line} expected=${failure.case.expectedCodes.join(",") || (failure.case.expectFail ? "finding" : "pass")} actual=${failure.actualCodes.join(",") || "pass"}`;
}

function replayCases(
  casesPath: string,
  analyzer: Analyzer,
  expectation: "required" | "exact",
  summary: boolean,
): ReturnType<typeof runReplayCases> {
  const failures: ReturnType<typeof runReplayCases> = [];
  for (const item of parseReplayCases(casesPath)) {
    const localPath = resolveCasePath(dirname(casesPath), item.path);
    const path = existsSync(localPath)
      ? localPath
      : resolveCasePath(process.cwd(), item.path);
    const actual = analyzer(path).findings;
    const actualCodes = actual.map((finding) => finding.code).sort();
    const actualCodeSet = [...new Set(actualCodes)];
    const expectedCodes = [...new Set(item.expectedCodes)].sort();
    const matches = item.expectFail
      ? expectation === "exact"
        ? actualCodes.length === expectedCodes.length &&
          actualCodes.every((code, index) => code === expectedCodes[index])
        : expectedCodes.every((code) => actualCodeSet.includes(code))
      : actualCodes.length === 0;
    if (summary) console.log(`SUMMARY file=${path} ${replaySummary(actual)}`);
    else if (actual.length) {
      for (const finding of actual)
        console.log(
          `FINDING file=${path} code=${finding.code} line=${finding.line} msg=${finding.message}`,
        );
    } else console.log(`PASS file=${path}`);
    if (!matches) failures.push({ case: item, actualCodes, path });
  }
  return failures;
}

function replaySummary(
  findings: Array<{ code: string; line: number }>,
): string {
  if (!findings.length) return "status=PASS total=0";
  const counts = new Map<string, { count: number; line: number }>();
  for (const finding of findings) {
    const previous = counts.get(finding.code);
    counts.set(finding.code, {
      count: (previous?.count ?? 0) + 1,
      line: previous?.line ?? finding.line,
    });
  }
  const details = [...counts.entries()]
    .sort(
      (left, right) =>
        left[1].line - right[1].line || left[0].localeCompare(right[0]),
    )
    .map(([code, detail]) => `${code}:${detail.count}@${detail.line}`)
    .join(",");
  return `status=FINDINGS total=${findings.length} codes=${details}`;
}

export function rootFor(argv: string[]): string {
  return resolve(option(argv, "repo-root", process.cwd())!);
}

export function printList(valuesToPrint: string[], prefix = "FINDING"): number {
  valuesToPrint.forEach((value) => console.log(`${prefix} ${value}`));
  return valuesToPrint.length ? 1 : 0;
}

export function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
