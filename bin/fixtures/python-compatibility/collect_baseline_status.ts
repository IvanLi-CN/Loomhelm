import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  baselineManifestDigest,
  baselineRecordDigest,
  type BaselineRecord,
} from "./baseline_contract";
import {
  assertSafeDirectory,
  assertSafeRunId,
  pathUnderRoot,
} from "./baseline_paths";
import { readVerifiedLog, regularBytes } from "./baseline_logs";
import {
  readRegularTextNoFollow,
  writeRegularTextNoFollow,
} from "./baseline_io";
import { sha256Bytes } from "../../modules/flow/common";

type Scenario = { id: string; source: string };
type Status = "pass" | "skipped" | "failed" | "unavailable" | "timeout";
type RunManifest = {
  schema_version: 2;
  run_id: string;
  started_at: string;
  source_revision: string;
  scenario_ids: string[];
  log_files: string[];
  log_digests: Record<string, string>;
  manifest_digest: string;
};

function safeLog(source: string, runId: string): string {
  assertSafeRunId(runId);
  return `${source.replaceAll("/", "_")}.${runId}.log`;
}

function methodName(id: string): string {
  return id.slice(id.lastIndexOf("::") + 2);
}

function statusFromLine(line: string | undefined): Status | undefined {
  if (!line) return;
  const status = line.match(/\.\.\.\s+(ok|skipped|FAIL|ERROR)(?:\s|$)/)?.[1];
  if (status === "ok") return "pass";
  if (status === "skipped") return "skipped";
  if (status === "FAIL" || status === "ERROR") return "failed";
}

function fallbackStatus(text: string): Exclude<Status, "pass" | "skipped"> {
  if (/timed out|TimeoutExpired|TIMEOUT/i.test(text)) return "timeout";
  if (/ModuleNotFoundError|ImportError|No module named|Traceback/.test(text))
    return "unavailable";
  if (/FAILED/.test(text)) return "failed";
  return "unavailable";
}

function reason(status: Status, line: string | undefined, log: string): string {
  if (status === "pass") return "Python unittest completed successfully.";
  if (status === "skipped")
    return line ?? "Python unittest skipped this method.";
  const completedLine =
    line && /\.\.\.\s+(?:ok|skipped|FAIL|ERROR)(?:\s|$)/.test(line)
      ? line
      : undefined;
  const signal =
    completedLine ??
    log
      .split("\n")
      .find((item) =>
        /ModuleNotFoundError|ImportError|No module named|AssertionError|RuntimeError|AdapterError|remote_unavailable|Too many levels|returned code/.test(
          item,
        ),
      ) ??
    log.split("\n").find((item) => /Traceback|FAILED|ERROR/.test(item)) ??
    "Python unittest did not produce a method-level result.";
  return `${status}: ${signal.trim()}`;
}

export async function collect(
  root = resolve(process.cwd()),
  resultsRoot: string | undefined = undefined,
  verboseRoot: string | undefined = undefined,
  output = join(root, "bin/fixtures/python-compatibility/baseline-status.json"),
  expectedRunId: string | undefined = undefined,
  expectedManifestDigest: string | undefined = undefined,
): Promise<void> {
  const mapping = JSON.parse(
    await readFile(
      join(root, "bin/fixtures/python-compatibility/mapping.json"),
      "utf8",
    ),
  ) as { scenarios: Scenario[] };
  const scenarioIds = mapping.scenarios.map((scenario) => scenario.id).sort();
  let actualResultsRoot =
    resultsRoot ?? join(tmpdir(), `dot-codex-baseline-results-${randomUUID()}`);
  let actualVerboseRoot =
    verboseRoot ?? join(tmpdir(), `dot-codex-baseline-verbose-${randomUUID()}`);
  const explicitRoots = resultsRoot !== undefined || verboseRoot !== undefined;
  if (
    explicitRoots &&
    (!resultsRoot ||
      !verboseRoot ||
      !expectedRunId?.trim() ||
      !expectedManifestDigest?.trim())
  )
    throw new Error(
      "explicit baseline result roots require the current run manifest id and finalized manifest digest",
    );
  if (explicitRoots) {
    assertSafeRunId(expectedRunId!);
    actualResultsRoot = assertSafeDirectory(actualResultsRoot);
    actualVerboseRoot = assertSafeDirectory(actualVerboseRoot);
  } else {
    await mkdir(actualResultsRoot, { recursive: true });
    await mkdir(actualVerboseRoot, { recursive: true });
  }
  const manifest = explicitRoots
    ? await loadRunManifest(
        root,
        actualResultsRoot,
        actualVerboseRoot,
        scenarioIds,
        expectedRunId,
        expectedManifestDigest,
      )
    : await prepareBaselineRun(root, actualResultsRoot, actualVerboseRoot);
  if (!manifest)
    throw new Error("baseline run manifest is missing or does not match");
  const scenarios = mapping.scenarios.map((scenario) => {
    const method = methodName(scenario.id);
    const file = safeLog(scenario.source, manifest.run_id);
    const logPath = explicitRoots
      ? join(actualVerboseRoot, file)
      : firstAvailableLog([
          join(actualVerboseRoot, file),
          join(actualResultsRoot, file),
        ]);
    const log = explicitRoots
      ? readVerifiedLog(
          actualResultsRoot,
          actualVerboseRoot,
          file,
          manifest.log_digests[file],
        )
      : (() => {
          const bytes = logPath
            ? (regularBytes(logPath, actualVerboseRoot) ??
              regularBytes(logPath, actualResultsRoot))
            : undefined;
          return bytes ? Buffer.from(bytes).toString("utf8") : "";
        })();
    const line = log.split("\n").find((item) => item.startsWith(`${method} (`));
    // A file-level OK is not evidence that this method ran. Only a method
    // result line may produce pass/skipped; file-level signals explain
    // failures and missing execution without creating a false success.
    const status = statusFromLine(line) ?? fallbackStatus(log);
    const record: BaselineRecord = {
      id: scenario.id,
      source: scenario.source,
      method,
      status,
      reason: reason(status, line, log),
      command: `PYTHONPATH=<baseline-root> python3 ${scenario.source} -v`,
      log: logPath ? basename(logPath) : "unavailable",
    };
    return { ...record, evidence_digest: baselineRecordDigest(record) };
  });
  const counts = scenarios.reduce<Record<string, number>>((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  const outputDirectory = assertSafeDirectory(dirname(output));
  writeRegularTextNoFollow(
    join(outputDirectory, basename(output)),
    `${JSON.stringify(
      {
        schema_version: 2,
        run_id: manifest.run_id,
        manifest_digest: manifest.manifest_digest,
        source_revision: manifest.source_revision,
        log_digests: manifest.log_digests,
        counts,
        scenarios,
      },
      null,
      2,
    )}\n`,
    outputDirectory,
  );
  console.log(
    `Collected baseline scenarios=${scenarios.length} counts=${JSON.stringify(counts)}`,
  );
}

async function loadRunManifest(
  root: string,
  resultsRoot: string,
  verboseRoot: string,
  scenarioIds: string[],
  expectedRunId?: string,
  expectedManifestDigest?: string,
  requireLogDigests = true,
): Promise<RunManifest | undefined> {
  const sourceRevision = sourceRevisionFor(root);
  const manifests: RunManifest[] = [];
  for (const directory of [resultsRoot, verboseRoot]) {
    const path = join(directory, "run-manifest.json");
    try {
      const manifest = JSON.parse(
        readRegularTextNoFollow(path, directory),
      ) as RunManifest;
      const expectedLogFiles = scenarioIds
        .map((id) => safeLog(id.split("::")[0]!, manifest.run_id))
        .sort();
      const logDigests = manifest.log_digests ?? {};
      const logDigestKeys = Object.keys(logDigests).sort();
      const validLogDigests =
        JSON.stringify(logDigestKeys) ===
          JSON.stringify([...new Set(expectedLogFiles)].sort()) &&
        Object.values(logDigests).every((digest) =>
          /^[0-9a-f]{64}$/i.test(digest),
        );
      if (
        manifest.schema_version !== 2 ||
        !manifest.run_id ||
        manifest.manifest_digest !== baselineManifestDigest(manifest) ||
        (expectedManifestDigest !== undefined &&
          manifest.manifest_digest !== expectedManifestDigest) ||
        (requireLogDigests ? !validLogDigests : logDigestKeys.length !== 0) ||
        (expectedRunId !== undefined && manifest.run_id !== expectedRunId) ||
        manifest.source_revision !== sourceRevision ||
        Number.isNaN(Date.parse(manifest.started_at)) ||
        JSON.stringify([...manifest.scenario_ids].sort()) !==
          JSON.stringify(scenarioIds) ||
        JSON.stringify([...manifest.log_files].sort()) !==
          JSON.stringify(expectedLogFiles)
      )
        return;
      manifests.push(manifest);
    } catch {}
  }
  const first = manifests[0];
  if (
    !first ||
    manifests.length !== 2 ||
    manifests.some(
      (manifest) =>
        manifest.run_id !== first.run_id ||
        manifest.source_revision !== first.source_revision ||
        manifest.started_at !== first.started_at ||
        JSON.stringify(manifest.log_files) !==
          JSON.stringify(first.log_files) ||
        JSON.stringify(manifest.log_digests) !==
          JSON.stringify(first.log_digests),
    )
  )
    return;
  return first;
}

export async function finalizeBaselineRun(
  root = resolve(process.cwd()),
  resultsRoot: string,
  verboseRoot: string,
  expectedRunId: string,
): Promise<RunManifest> {
  assertSafeRunId(expectedRunId);
  resultsRoot = assertSafeDirectory(resultsRoot);
  verboseRoot = assertSafeDirectory(verboseRoot);
  const mapping = JSON.parse(
    await readFile(
      join(root, "bin/fixtures/python-compatibility/mapping.json"),
      "utf8",
    ),
  ) as { scenarios: Scenario[] };
  const scenarioIds = mapping.scenarios.map((scenario) => scenario.id).sort();
  const manifest = await loadRunManifest(
    root,
    resultsRoot,
    verboseRoot,
    scenarioIds,
    expectedRunId,
    undefined,
    false,
  );
  if (!manifest)
    throw new Error("baseline run manifest is missing or does not match");
  const logDigests: Record<string, string> = {};
  for (const file of [...new Set(manifest.log_files)].sort()) {
    const resultBytes = regularBytes(
      pathUnderRoot(resultsRoot, file),
      resultsRoot,
    );
    const verboseBytes = regularBytes(
      pathUnderRoot(verboseRoot, file),
      verboseRoot,
    );
    if (!resultBytes || !verboseBytes)
      throw new Error(
        `baseline log is missing from one run directory: ${file}`,
      );
    const resultDigest = sha256Bytes(resultBytes);
    const verboseDigest = sha256Bytes(verboseBytes);
    if (resultDigest !== verboseDigest)
      throw new Error(
        `baseline log content differs between run directories: ${file}`,
      );
    logDigests[file] = resultDigest;
  }
  const finalized: RunManifest = {
    ...manifest,
    log_digests: logDigests,
    manifest_digest: "",
  };
  finalized.manifest_digest = baselineManifestDigest(finalized);
  for (const directory of [resultsRoot, verboseRoot])
    writeRegularTextNoFollow(
      join(directory, "run-manifest.json"),
      `${JSON.stringify(finalized, null, 2)}\n`,
      directory,
    );
  return finalized;
}

function firstAvailableLog(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

export async function prepareBaselineRun(
  root = resolve(process.cwd()),
  resultsRoot = join(tmpdir(), `dot-codex-baseline-results-${randomUUID()}`),
  verboseRoot = join(tmpdir(), `dot-codex-baseline-verbose-${randomUUID()}`),
): Promise<RunManifest> {
  const mapping = JSON.parse(
    await readFile(
      join(root, "bin/fixtures/python-compatibility/mapping.json"),
      "utf8",
    ),
  ) as { scenarios: Scenario[] };
  const scenarioIds = mapping.scenarios.map((scenario) => scenario.id).sort();
  const runId = randomUUID();
  const manifest: RunManifest = {
    schema_version: 2,
    run_id: runId,
    started_at: new Date().toISOString(),
    source_revision: sourceRevisionFor(root),
    scenario_ids: scenarioIds,
    log_files: scenarioIds
      .map((id) => safeLog(id.split("::")[0]!, runId))
      .sort(),
    log_digests: {},
    manifest_digest: "",
  };
  manifest.manifest_digest = baselineManifestDigest(manifest);
  for (const directory of [resultsRoot, verboseRoot]) {
    await mkdir(directory, { recursive: true });
    const safeDirectory = assertSafeDirectory(directory);
    writeRegularTextNoFollow(
      join(safeDirectory, "run-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      safeDirectory,
    );
  }
  return manifest;
}

function sourceRevisionFor(root: string): string {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(revision)) return revision.toLowerCase();
  } catch {}
  throw new Error("baseline source revision is unavailable");
}

if (import.meta.main)
  await collect(...(process.argv.slice(2) as Parameters<typeof collect>));
