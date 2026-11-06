import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EQUIVALENT } from "./direct-evidence";
import { entrypointCommand } from "./entrypoint-smoke";
import { selectWitness } from "./domain-witnesses";

type BaselineStatus = "pass" | "skipped" | "failed" | "unavailable" | "timeout";
type BaselineRecord = {
  id: string;
  source: string;
  method: string;
  status: BaselineStatus;
  reason: string;
  command: string;
  log: string;
};
type ScenarioEvidence = {
  kind: "bun-test" | "domain-batch";
  test_file: string;
  test_name: string;
  command: string;
  basis: string;
  batch_id?: string;
  invariant?: string;
  coverage_note?: string;
  baseline_status: BaselineStatus;
  baseline_reason: string;
  baseline_command: string;
};

function evidenceFor(
  id: string,
  source: string,
  baseline: BaselineRecord | undefined,
): ScenarioEvidence | undefined {
  const direct = EQUIVALENT[id];
  const domain = direct ? undefined : selectWitness(id, source);
  const evidence = direct ?? domain;
  if (!evidence || !baseline) return;
  const pattern = evidence.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isDirect = Boolean(direct);
  return {
    kind: isDirect ? "bun-test" : "domain-batch",
    test_file: evidence.test_file,
    test_name: evidence.test_name,
    command: `bun test ${evidence.test_file} --test-name-pattern=${JSON.stringify(pattern)}`,
    basis: direct
      ? "The named Bun test asserts the same observable invariant; verify.ts runs it independently."
      : domain!.coverage_note,
    ...(domain
      ? {
          batch_id: domain.batch_id,
          invariant: domain.invariant,
          coverage_note: domain.coverage_note,
        }
      : {}),
    baseline_status: baseline.status,
    baseline_reason: baseline.reason,
    baseline_command: baseline.command,
  };
}

function scenarioState(status: BaselineStatus, direct: boolean): string {
  if (status === "failed") return "baseline_failed";
  if (status === "unavailable" || status === "timeout")
    return "baseline_unavailable";
  return direct ? "equivalent" : "audited";
}

function rootFromModule(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

export async function materialize(root = rootFromModule()): Promise<void> {
  const path = join(root, "bin/fixtures/python-compatibility/mapping.json");
  const fixture = JSON.parse(await readFile(path, "utf8")) as {
    schema_version: number;
    baseline: Record<string, unknown>;
    entrypoints: Array<Record<string, unknown>>;
    scenarios: Array<Record<string, unknown>>;
  };
  const baseline = JSON.parse(
    await readFile(
      join(root, "bin/fixtures/python-compatibility/baseline-status.json"),
      "utf8",
    ),
  ) as { counts: Record<string, number>; scenarios: BaselineRecord[] };
  const baselineById = new Map(
    baseline.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const entrypoints = fixture.entrypoints.map((entry) => {
    const replacement = String(entry.replacement);
    const exists = existsSync(join(root, replacement));
    return {
      ...entry,
      state: exists ? "pass" : "missing",
      evidence: exists
        ? {
            kind: "entrypoint",
            replacement,
            command: /(^|\/)test_[^/]+\.ts$/.test(replacement)
              ? `bun test ./${replacement}`
              : entrypointCommand(replacement),
            basis:
              "Tracked TypeScript entrypoint; scenario behavior is tracked separately.",
          }
        : { kind: "missing", reason: "replacement entrypoint is absent" },
    };
  });
  const scenarios: Array<Record<string, unknown>> = fixture.scenarios.map(
    (scenario) => {
      const id = String(scenario.id);
      const source = String(scenario.source);
      const baselineRecord = baselineById.get(id);
      const evidence = evidenceFor(id, source, baselineRecord);
      return evidence
        ? {
            ...scenario,
            state: scenarioState(
              evidence.baseline_status,
              Boolean(EQUIVALENT[id]),
            ),
            evidence,
          }
        : {
            ...scenario,
            state: "missing",
            evidence: {
              kind: "missing",
              reason: baselineRecord
                ? "No explicit Bun witness is available for this baseline scenario; the replacement adapter is not treated as proof."
                : "No baseline status record is available for this scenario.",
            },
          };
    },
  );
  const missingScenarios = scenarios
    .filter((scenario) => scenario.state === "missing")
    .map((scenario) => scenario.id)
    .sort();
  const counts = (items: Array<Record<string, unknown>>) =>
    items.reduce<Record<string, number>>((result, item) => {
      const state = String(item.state);
      result[state] = (result[state] ?? 0) + 1;
      return result;
    }, {});
  const output = {
    ...fixture,
    schema_version: 2,
    evidence_contract: {
      states: [
        "pass",
        "equivalent",
        "audited",
        "baseline_failed",
        "baseline_unavailable",
        "missing",
      ],
      scenario_evidence_required: true,
      missing_requires_reason: true,
      baseline_status_required: true,
      baseline_failure_is_explicit: true,
      verifier: "bin/fixtures/python-compatibility/verify.ts",
    },
    baseline_summary: baseline.counts,
    entrypoints,
    scenarios,
    summary: { entrypoints: counts(entrypoints), scenarios: counts(scenarios) },
    missing_scenarios: missingScenarios,
  };
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const scenarioCounts = counts(scenarios);
  console.log(
    `Materialized entrypoints=${entrypoints.length} scenarios=${scenarios.length} states=${JSON.stringify(scenarioCounts)}`,
  );
}

if (import.meta.main) await materialize();
