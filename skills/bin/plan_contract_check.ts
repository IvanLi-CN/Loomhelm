import { Runtime } from "./modules/core/runtime";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalDiagnostic,
  validateCanonicalRawPlan,
} from "./modules/plan/contract";
import {
  historicalPlans,
  historicalSessionFindings,
  historicalDiagnostic,
} from "./modules/plan/historical_session";

function usage(): string {
  return `Usage:
  bun skills/bin/plan_contract_check.ts --plan <plan.md|->
  bun skills/bin/plan_contract_check.ts <historical-session.jsonl>
  bun skills/bin/plan_contract_check.ts --cases <CASES.txt>
`;
}

async function input(path: string): Promise<string> {
  if (path === "-") return new Response(Runtime.stdin.stream()).text();
  return readFile(resolve(path), "utf8");
}

async function runPlan(path: string, label = path): Promise<number> {
  try {
    const text = await input(path);
    const output = canonicalDiagnostic(text).replaceAll("<stdin>", label);
    process.stdout.write(output);
    return validateCanonicalRawPlan(text).length ? 1 : 0;
  } catch (error) {
    process.stdout.write(
      `FINDING file=${path} idx=raw code=FILE_NOT_FOUND msg=${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runHistorical(path: string): Promise<number> {
  try {
    const text = await input(path);
    if (!historicalPlans(text).length) {
      const findings = historicalSessionFindings(text);
      if (findings.length) {
        process.stdout.write(historicalDiagnostic(path, text));
        return 1;
      }
      process.stdout.write(
        `FINDING file=${path} idx=historical code=HISTORICAL_PLAN_NOT_FOUND msg=session has no proposed_plan message\n`,
      );
      return 1;
    }
    const findings = historicalSessionFindings(text);
    if (!findings.length) {
      process.stdout.write(
        `PASS file=${path} checks=historical-compatibility\n`,
      );
      return 0;
    }
    process.stdout.write(historicalDiagnostic(path, text));
    return 1;
  } catch (error) {
    process.stdout.write(
      `FINDING file=${path} idx=historical code=FILE_NOT_FOUND msg=${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runRawCase(path: string): Promise<number> {
  const source = await input(path);
  const raw = source;
  const output = canonicalDiagnostic(raw).replaceAll("<stdin>", path);
  process.stdout.write(output);
  return validateCanonicalRawPlan(raw).length ? 1 : 0;
}

async function runCases(path: string): Promise<number> {
  const text = await readFile(resolve(path), "utf8");
  let failed = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [expected, casePath, requiredCode, mode] = trimmed.split(/\s+/);
    if (mode && mode !== "raw-plan") {
      process.stdout.write(`CASE_FAIL path=${casePath} invalid_mode=${mode}\n`);
      failed = true;
      continue;
    }
    const absolute = resolve(resolve(path, ".."), casePath!);
    const result =
      mode === "raw-plan"
        ? await runRawCase(absolute)
        : await runHistorical(absolute);
    if (expected === "pass" && result !== 0) {
      process.stdout.write(`CASE_FAIL path=${casePath} expected=pass\n`);
      failed = true;
    }
    if (expected === "fail" && result === 0) {
      process.stdout.write(`CASE_FAIL path=${casePath} expected=fail\n`);
      failed = true;
    }
    if (expected === "fail" && requiredCode && requiredCode !== "-") {
      const source =
        mode === "raw-plan" ? await input(absolute) : await input(absolute);
      const raw = source === undefined ? "" : source;
      const diagnostic =
        mode === "raw-plan"
          ? canonicalDiagnostic(raw).replaceAll("<stdin>", absolute)
          : historicalDiagnostic(absolute, raw);
      if (!diagnostic.includes(`code=${requiredCode}`)) {
        process.stdout.write(
          `CASE_FAIL path=${casePath} missing_code=${requiredCode}\n`,
        );
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}
if (args[0] === "--plan" && args[1])
  process.exit(await runPlan(args[1], args[1] === "-" ? "<stdin>" : args[1]));
if (args[0] === "--cases" && args[1]) process.exit(await runCases(args[1]));
if (args[0] && !args[0].startsWith("-"))
  process.exit(await runHistorical(args[0]));
process.stderr.write(usage());
process.exit(2);
