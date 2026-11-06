import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EQUIVALENT } from "./direct-evidence";
import {
  SCENARIO_WITNESSES,
  SCENARIO_WITNESS_COUNT,
} from "./scenario-witnesses";
import { runEntrypoints, runScenarioWitnesses } from "./verify-run";
import {
  baselineFixtureDigest,
  baselineFixtureLogSummaryDigests,
  baselineRecordDigest,
  type BaselineRecord,
} from "./baseline_contract";

type Evidence = {
  kind: string;
  test_file?: string;
  test_name?: string;
  reason?: string;
  basis?: string;
  batch_id?: string;
  invariant?: string;
  coverage_note?: string;
  baseline_status?: string;
  baseline_reason?: string;
  baseline_command?: string;
};
type Mapping = {
  baseline: {
    parent_sha: string;
    python_file_count: number;
    scenario_count: number;
  };
  entrypoints: Array<{
    source: string;
    replacement: string;
    state: string;
    evidence: Evidence;
  }>;
  scenarios: Array<{
    id: string;
    source: string;
    replacement: string;
    state: string;
    evidence: Evidence;
  }>;
  missing_scenarios: string[];
};

function recordsEqual(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const keys = [
    ...new Set([...Object.keys(left), ...Object.keys(right)]),
  ].sort();
  return keys.every((key) => left[key] === right[key]);
}

export function validateMapping(mapping: Mapping, root: string): string[] {
  const errors: string[] = [];
  let baselineRecords: Array<BaselineRecord & { evidence_digest?: string }> =
    [];
  try {
    const baseline = JSON.parse(
      readFileSync(
        join(root, "bin/fixtures/python-compatibility/baseline-status.json"),
        "utf8",
      ),
    ) as {
      schema_version?: number;
      evidence_kind?: string;
      run_id?: string;
      fixture_digest?: string;
      source_revision?: string;
      log_summary_digests?: Record<string, string>;
      counts?: Record<string, number>;
      scenarios?: Array<BaselineRecord & { evidence_digest?: string }>;
    };
    if (baseline.schema_version !== 2)
      errors.push("baseline status schema version changed");
    if (baseline.evidence_kind !== "historical-structured-status")
      errors.push(
        "baseline status evidence kind is not historical structured status",
      );
    if (!baseline.run_id?.trim()) errors.push("baseline run id is missing");
    if (baseline.source_revision !== mapping.baseline.parent_sha)
      errors.push("baseline status source revision is not the recorded parent");
    baselineRecords = baseline.scenarios ?? [];
    if (baselineRecords.length !== 986)
      errors.push("baseline status scenario count changed");
    const counts = baselineRecords.reduce<Record<string, number>>(
      (result, record) => {
        result[record.status] = (result[record.status] ?? 0) + 1;
        return result;
      },
      {},
    );
    if (!recordsEqual(counts, baseline.counts ?? {}))
      errors.push("baseline status counts are inconsistent");
    if (
      !baseline.fixture_digest ||
      !baseline.run_id ||
      !baseline.source_revision ||
      !baseline.log_summary_digests ||
      JSON.stringify(Object.keys(baseline.log_summary_digests).sort()) !==
        JSON.stringify(
          [...new Set(baselineRecords.map((record) => record.log))].sort(),
        ) ||
      !Object.values(baseline.log_summary_digests ?? {}).every((digest) =>
        /^[0-9a-f]{64}$/i.test(digest),
      ) ||
      JSON.stringify(baseline.log_summary_digests) !==
        JSON.stringify(baselineFixtureLogSummaryDigests(baselineRecords)) ||
      baseline.fixture_digest !==
        baselineFixtureDigest({
          evidence_kind: "historical-structured-status",
          run_id: baseline.run_id,
          source_revision: baseline.source_revision,
          scenario_ids: baselineRecords.map((record) => record.id),
          log_files: baselineRecords.map((record) => record.log),
          log_summary_digests: baseline.log_summary_digests ?? {},
        })
    )
      errors.push("baseline fixture digest is inconsistent");
    for (const record of baselineRecords) {
      if (
        !record.evidence_digest ||
        record.evidence_digest !== baselineRecordDigest(record)
      )
        errors.push(`baseline evidence digest is inconsistent: ${record.id}`);
    }
  } catch {
    errors.push("baseline status fixture is unavailable");
  }
  const baselineById = new Map(
    baselineRecords.map((record) => [record.id, record]),
  );
  const mappedIds = new Set(mapping.scenarios.map((scenario) => scenario.id));
  for (const record of baselineRecords)
    if (!mappedIds.has(record.id))
      errors.push(`baseline scenario is unmapped: ${record.id}`);
  for (const id of mappedIds)
    if (!baselineById.has(id))
      errors.push(`mapping scenario is absent from baseline: ${id}`);
  if (!/^[0-9a-f]{40}$/i.test(mapping.baseline.parent_sha))
    errors.push("baseline parent_sha is invalid");
  if (mapping.baseline.python_file_count !== 82)
    errors.push("baseline python_file_count changed");
  if (mapping.baseline.scenario_count !== 986)
    errors.push("baseline scenario_count changed");
  if (mapping.entrypoints.length !== 82)
    errors.push("entrypoint count changed");
  if (mapping.scenarios.length !== 986) errors.push("scenario count changed");
  if (Object.keys(SCENARIO_WITNESSES).length !== SCENARIO_WITNESS_COUNT)
    errors.push("scenario witness index count changed");
  const retirementSources = new Set([
    "bin/test_wave_thread_plan_contract.py",
    "bin/wave_thread_plan_contract.py",
    "bin/wave_thread_route_audit.py",
    "skills/wave-thread-flow/scripts/test_wave_thread_flow.py",
    "skills/wave-thread-flow/scripts/test_wave_thread_v2.py",
    "skills/wave-thread-flow/scripts/wave_thread_flow.py",
    "skills/wave-thread-flow/scripts/wave_thread_replay_check.py",
    "skills/wave-thread-flow/scripts/wave_thread_roundtrip.py",
  ]);
  const checkRetirement = (row: { source: string; evidence: Evidence }) => {
    if (
      !retirementSources.has(row.source) ||
      row.evidence.kind !== "retired" ||
      !row.evidence.reason?.trim()
    )
      errors.push(`invalid capability retirement: ${row.source}`);
  };
  const scenarioIds = new Set<string>();
  for (const entry of mapping.entrypoints) {
    if (entry.state === "retired") {
      checkRetirement(entry);
      if (entry.replacement !== entry.source.replace(/\.py$/, ".ts"))
        errors.push(`retired entrypoint identity differs: ${entry.source}`);
    }
    if (entry.state === "planned")
      errors.push(`planned entrypoint: ${entry.source}`);
    if (!entry.replacement.endsWith(".ts"))
      errors.push(`non-TS replacement: ${entry.replacement}`);
    if (entry.state === "pass" && !existsSync(join(root, entry.replacement)))
      errors.push(`missing entrypoint: ${entry.replacement}`);
    if (!entry.evidence?.kind)
      errors.push(`missing entrypoint evidence: ${entry.source}`);
  }
  for (const scenario of mapping.scenarios) {
    if (scenarioIds.has(scenario.id))
      errors.push(`duplicate scenario: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (scenario.source !== baselineById.get(scenario.id)?.source)
      errors.push(
        `scenario source differs from baseline identity: ${scenario.id}`,
      );
    if (scenario.state === "retired") {
      checkRetirement(scenario);
      continue;
    }
    if (scenario.state === "planned")
      errors.push(`planned scenario: ${scenario.id}`);
    if (
      scenario.state === "equivalent" ||
      scenario.state === "audited" ||
      scenario.state === "baseline_failed" ||
      scenario.state === "baseline_unavailable"
    ) {
      const evidence = scenario.evidence;
      if (
        !["bun-test", "domain-batch"].includes(evidence.kind) ||
        !evidence.test_file ||
        !evidence.test_name ||
        !evidence.baseline_status ||
        !evidence.baseline_reason?.trim() ||
        !evidence.baseline_command?.trim()
      )
        errors.push(`incomplete equivalent evidence: ${scenario.id}`);
      if (scenario.state === "equivalent" && evidence.kind !== "bun-test")
        errors.push(
          `equivalent scenario is not direct evidence: ${scenario.id}`,
        );
      if (scenario.state === "equivalent" && !EQUIVALENT[scenario.id])
        errors.push(
          `equivalent scenario is absent from direct index: ${scenario.id}`,
        );
      if (scenario.state === "audited") {
        if (
          evidence.kind !== "domain-batch" ||
          !evidence.batch_id?.trim() ||
          !evidence.invariant?.trim() ||
          !evidence.coverage_note?.trim()
        )
          errors.push(`incomplete domain-batch evidence: ${scenario.id}`);
      }
      const indexed = SCENARIO_WITNESSES[scenario.id];
      if (evidence.kind === "domain-batch") {
        if (!indexed)
          errors.push(
            `domain-batch witness is absent from index: ${scenario.id}`,
          );
        else if (
          evidence.test_file !== indexed.test_file ||
          evidence.test_name !== indexed.test_name ||
          evidence.batch_id !== indexed.batch_id ||
          evidence.invariant !== indexed.invariant ||
          evidence.coverage_note !== indexed.coverage_note
        )
          errors.push(
            `domain-batch evidence disagrees with index: ${scenario.id}`,
          );
      } else {
        const direct = EQUIVALENT[scenario.id];
        if (!direct) {
          errors.push(`direct evidence is absent from index: ${scenario.id}`);
        } else if (
          evidence.test_file !== direct.test_file ||
          evidence.test_name !== direct.test_name
        )
          errors.push(`direct evidence disagrees with index: ${scenario.id}`);
      }
      if (evidence.test_file && !existsSync(join(root, evidence.test_file)))
        errors.push(`missing evidence test file: ${scenario.id}`);
      const expectedStatuses =
        scenario.state === "equivalent"
          ? ["pass", "skipped"]
          : scenario.state === "audited"
            ? ["pass", "skipped"]
            : scenario.state === "baseline_failed"
              ? ["failed"]
              : ["unavailable", "timeout"];
      if (
        evidence.baseline_status &&
        !expectedStatuses.includes(evidence.baseline_status)
      )
        errors.push(
          `baseline status does not explain ${scenario.id}: ${scenario.state}=${evidence.baseline_status}`,
        );
      const baseline = baselineById.get(scenario.id);
      if (!baseline) errors.push(`baseline status is absent: ${scenario.id}`);
      else if (
        evidence.baseline_status !== baseline.status ||
        evidence.baseline_reason !== baseline.reason ||
        evidence.baseline_command !== baseline.command
      )
        errors.push(
          `mapping baseline evidence disagrees with fixture: ${scenario.id}`,
        );
    } else if (scenario.state === "missing") {
      if (
        scenario.evidence.kind !== "missing" ||
        !scenario.evidence.reason?.trim()
      )
        errors.push(`missing scenario lacks a reason: ${scenario.id}`);
    } else
      errors.push(`invalid scenario state: ${scenario.id}=${scenario.state}`);
  }
  const missing = mapping.scenarios
    .filter((scenario) => scenario.state === "missing")
    .map((scenario) => scenario.id)
    .sort();
  if (
    JSON.stringify(missing) !==
    JSON.stringify([...mapping.missing_scenarios].sort())
  )
    errors.push("missing_scenarios does not match scenario records");
  const retiredIds = new Set(
    mapping.scenarios
      .filter((item) => item.state === "retired")
      .map((item) => item.id),
  );
  const indexedIds = Object.keys(SCENARIO_WITNESSES)
    .filter((id) => !retiredIds.has(id))
    .sort();
  const mappedDomainIds = mapping.scenarios
    .filter((scenario) => scenario.evidence.kind === "domain-batch")
    .map((scenario) => scenario.id)
    .sort();
  if (JSON.stringify(indexedIds) !== JSON.stringify(mappedDomainIds))
    errors.push("scenario witness index does not match domain-batch mapping");
  return errors;
}

function repositoryRoot(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value?.startsWith("--repo-root="))
      return resolve(value.slice("--repo-root=".length));
    if (value === "--repo-root" && argv[index + 1])
      return resolve(argv[index + 1]!);
  }
  return resolve(process.cwd());
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const root = repositoryRoot(argv);
  const mapping = JSON.parse(
    await readFile(
      join(root, "bin/fixtures/python-compatibility/mapping.json"),
      "utf8",
    ),
  ) as Mapping;
  const errors = validateMapping(mapping, root);
  if (errors.length) {
    errors.forEach((error) => console.error(`FAIL mapping ${error}`));
    return 1;
  }
  if (
    argv.includes("--run") &&
    ((await runEntrypoints(mapping, root)) !== 0 ||
      (await runScenarioWitnesses(mapping, root)) !== 0)
  )
    return 1;
  const states = mapping.scenarios.reduce<Record<string, number>>(
    (result, scenario) => {
      result[scenario.state] = (result[scenario.state] ?? 0) + 1;
      return result;
    },
    {},
  );
  console.log(
    `PASS mapping entrypoints=${mapping.entrypoints.length} scenarios=${mapping.scenarios.length} states=${JSON.stringify(states)} missing=${mapping.missing_scenarios.length}`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
