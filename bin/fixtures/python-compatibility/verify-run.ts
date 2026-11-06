import { runProcess } from "../../modules/core/process";
import {
  entrypointCommand,
  entrypointSmokeArgs,
  isCompatibilityWrapper,
} from "./entrypoint-smoke";

type RuntimeMapping = {
  entrypoints: Array<{ replacement: string; state?: string }>;
  scenarios: Array<{
    id: string;
    state: string;
    evidence: { test_file?: string; test_name?: string };
  }>;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runEntrypoints(
  mapping: RuntimeMapping,
  root: string,
): Promise<number> {
  let failures = 0;
  for (const entry of mapping.entrypoints) {
    if (entry.state === "retired") continue;
    const replacement = entry.replacement;
    const isTestEntrypoint = /(^|\/)test_[^/]+\.ts$/.test(replacement);
    const smokeArgs = isTestEntrypoint
      ? ["test", `./${replacement}`]
      : entrypointSmokeArgs(replacement);
    const command = isTestEntrypoint
      ? `bun test ./${replacement}`
      : entrypointCommand(replacement);
    const result = await runProcess({
      command: "bun",
      args: isTestEntrypoint ? smokeArgs : [replacement, ...smokeArgs],
      cwd: root,
      timeoutMs: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const fatal =
      /(?:SyntaxError|Cannot find module|Module not found|Unhandled exception|panic:)/i.test(
        output,
      );
    const dispatched =
      !isTestEntrypoint &&
      isCompatibilityWrapper(replacement) &&
      output.includes(
        `SMOKE dispatched=${replacement.replace(/^.*\//, "").replace(/\.ts$/, "")}`,
      );
    if (
      result.timedOut ||
      result.exitCode !== 0 ||
      fatal ||
      (!isTestEntrypoint && isCompatibilityWrapper(replacement) && !dispatched)
    ) {
      failures += 1;
      console.error(`FAIL entrypoint=${replacement} command=${command}`);
      console.error((result.stderr || result.stdout).trim());
    } else console.log(`PASS entrypoint=${replacement} command=${command}`);
  }
  return failures;
}

function witnessOutcome(
  stdout: string,
  testName: string,
): "pass" | "skip" | "missing" {
  const line = stdout
    .split(/\r?\n/)
    .find((item) => item.includes(testName) && /\((?:pass|skip)\)/.test(item));
  if (!line) return "missing";
  return line.includes("(skip)") ? "skip" : "pass";
}

export async function runScenarioWitnesses(
  mapping: RuntimeMapping,
  root: string,
): Promise<number> {
  const runs = new Map<
    string,
    { testFile: string; testName: string; scenarios: string[] }
  >();
  for (const scenario of mapping.scenarios) {
    if (["missing", "retired"].includes(scenario.state)) continue;
    const testFile = scenario.evidence.test_file!;
    const testName = scenario.evidence.test_name!;
    const key = `${testFile}\u0000${testName}`;
    const record = runs.get(key) ?? { testFile, testName, scenarios: [] };
    record.scenarios.push(scenario.id);
    runs.set(key, record);
  }
  let failures = 0;
  for (const record of runs.values()) {
    const result = await runProcess({
      command: "bun",
      args: [
        "test",
        record.testFile,
        "--test-name-pattern",
        escapeRegex(record.testName),
      ],
      cwd: root,
      timeoutMs: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const outcome = witnessOutcome(output, record.testName);
    if (result.exitCode !== 0 || result.timedOut || outcome !== "pass") {
      failures += record.scenarios.length;
      console.error(
        `${outcome === "skip" ? "SKIP" : "FAIL"} evidence=${record.testFile} test=${record.testName}`,
      );
      console.error(output.trim());
      continue;
    }
    for (const scenario of record.scenarios)
      console.log(
        `PASS scenario=${scenario} evidence=${record.testFile}::${record.testName}`,
      );
  }
  return failures;
}
