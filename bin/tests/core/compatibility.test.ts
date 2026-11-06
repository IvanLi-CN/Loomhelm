import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatch } from "../../compatibility_dispatch";
import {
  collect,
  finalizeBaselineRun,
  prepareBaselineRun,
} from "../../fixtures/python-compatibility/collect_baseline_status";
import { baselineManifestDigest } from "../../fixtures/python-compatibility/baseline_contract";
import { validateMapping } from "../../fixtures/python-compatibility/verify";

async function runCompatibilityCommand(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const script = resolve(
    fileURLToPath(new URL("../../compatibility_cli.ts", import.meta.url)),
  );
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: resolve(fileURLToPath(new URL("../../../", import.meta.url))),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("compatibility mapping records every baseline scenario and its evidence state", async () => {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const mapping = JSON.parse(
    await readFile(
      new URL(
        "../../fixtures/python-compatibility/mapping.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(validateMapping(mapping, root)).toEqual([]);
  expect(mapping.entrypoints).toHaveLength(82);
  expect(mapping.scenarios).toHaveLength(986);
  expect(
    mapping.scenarios.some(
      ({ state }: { state: string }) => state === "equivalent",
    ),
  ).toBe(true);
  expect(mapping.missing_scenarios).toHaveLength(0);
  expect(
    mapping.scenarios.some(
      ({ state }: { state: string }) => state === "baseline_failed",
    ),
  ).toBe(true);
  expect(
    mapping.scenarios.some(
      ({ state }: { state: string }) => state === "baseline_unavailable",
    ),
  ).toBe(true);
  expect(
    mapping.scenarios.every(
      ({ state }: { state: string }) => state !== "planned",
    ),
  ).toBe(true);
});

test("wave compatibility entrypoints retain distinct baseline contracts", async () => {
  expect(await dispatch("wave_thread_flow", [])).toBe(2);
  expect(await dispatch("wave_thread_replay_check", [])).toBe(2);
  expect(await dispatch("wave_thread_roundtrip", [])).toBe(2);
});

test("compatibility CLI preserves documented command and cases routes", async () => {
  const command = await runCompatibilityCommand(["wave_thread_roundtrip"]);
  expect(command.exitCode).not.toBe(0);
  const cases = await runCompatibilityCommand([
    "browser_policy_replay_check",
    "--cases",
    "docs/vendor/dot-codex/specs/gui-escalation-gate/replay/cases.txt",
  ]);
  expect(cases.exitCode).toBe(0);
  expect(cases.stdout).toContain("PASS file=");
  const summary = await runCompatibilityCommand([
    "pr_skill_replay_check",
    "--summary",
    "--cases",
    "docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/cases.txt",
  ]);
  expect(summary.exitCode).toBe(0);
  expect(summary.stdout).toContain("SUMMARY file=");
  expect(summary.stdout).not.toContain("SUMMARY cases=");
  const directSummary = await runCompatibilityCommand([
    "pr_skill_replay_check",
    "--summary",
    "docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/negative-session-approval-evidence-ignored.jsonl",
  ]);
  expect(directSummary.exitCode).toBe(1);
  expect(directSummary.stdout).toContain("codes=");
});

test("summary replay cases retain mismatch diagnostics", async () => {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const temporary = await mkdtemp(join(tmpdir(), "dot-codex-cases-"));
  const cases = join(temporary, "cases.txt");
  try {
    await writeFile(
      cases,
      `pass ${join(
        root,
        "docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/negative-session-approval-evidence-ignored.jsonl",
      )} -\n`,
    );
    const result = await runCompatibilityCommand([
      "pr_skill_replay_check",
      "--summary",
      "--cases",
      cases,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERROR file=");
    expect(result.stderr).toContain("saw findings");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live instruction replay keeps the model-runner interface", async () => {
  expect(await dispatch("instruction_behavior_replay", ["--help"])).toBe(0);
  expect(
    await dispatch("instruction_behavior_replay", ["--model", "fixture"]),
  ).toBe(2);
});

test("baseline logs stay bound to one run manifest and matching source digests", async () => {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const resultsRoot = await mkdtemp(join(tmpdir(), "dot-codex-results-"));
  const verboseRoot = await mkdtemp(join(tmpdir(), "dot-codex-verbose-"));
  const output = join(resultsRoot, "baseline-status.json");
  try {
    const protectedResultsRoot = await mkdtemp(
      join(tmpdir(), "dot-codex-protected-results-"),
    );
    const protectedVerboseRoot = await mkdtemp(
      join(tmpdir(), "dot-codex-protected-verbose-"),
    );
    const protectedTarget = join(
      tmpdir(),
      `dot-codex-protected-target-${randomUUID()}`,
    );
    await writeFile(protectedTarget, "sentinel\n");
    await symlink(
      protectedTarget,
      join(protectedResultsRoot, "run-manifest.json"),
      "file",
    );
    await expect(
      prepareBaselineRun(root, protectedResultsRoot, protectedVerboseRoot),
    ).rejects.toThrow();
    expect(await readFile(protectedTarget, "utf8")).toBe("sentinel\n");
    await rm(join(protectedResultsRoot, "run-manifest.json"), { force: true });
    await link(
      protectedTarget,
      join(protectedResultsRoot, "run-manifest.json"),
    );
    await expect(
      prepareBaselineRun(root, protectedResultsRoot, protectedVerboseRoot),
    ).rejects.toThrow("baseline file is not regular");
    expect(await readFile(protectedTarget, "utf8")).toBe("sentinel\n");
    await rm(protectedResultsRoot, { recursive: true, force: true });
    await rm(protectedVerboseRoot, { recursive: true, force: true });
    await rm(protectedTarget, { force: true });
    const manifest = await prepareBaselineRun(root, resultsRoot, verboseRoot);
    const mapping = JSON.parse(
      await readFile(
        new URL(
          "../../fixtures/python-compatibility/mapping.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { scenarios: Array<{ id: string; source: string }> };
    const first = mapping.scenarios[0]!;
    const log = manifest.log_files.find((file) =>
      file.startsWith(first.source.replaceAll("/", "_") + "."),
    )!;
    const method = first.id.slice(first.id.lastIndexOf("::") + 2);
    for (const file of new Set(manifest.log_files)) {
      await writeFile(join(resultsRoot, file), "");
      await writeFile(join(verboseRoot, file), "");
    }
    await writeFile(join(resultsRoot, log), `${method} (current.run) ... ok\n`);
    await writeFile(join(verboseRoot, log), `${method} (current.run) ... ok\n`);
    const finalized = await finalizeBaselineRun(
      root,
      resultsRoot,
      verboseRoot,
      manifest.run_id,
    );
    expect(finalized.log_digests[log]).toMatch(/^[0-9a-f]{64}$/);
    await collect(
      root,
      resultsRoot,
      verboseRoot,
      output,
      manifest.run_id,
      finalized.manifest_digest,
    );
    const baseline = JSON.parse(await readFile(output, "utf8")) as {
      run_id: string;
      manifest_digest: string;
      scenarios: Array<{
        id: string;
        status: string;
        log: string;
        evidence_digest: string;
      }>;
    };
    expect(baseline.run_id).toBe(manifest.run_id);
    expect(baseline.manifest_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      baseline.scenarios.find((scenario) => scenario.id === first.id),
    ).toEqual(
      expect.objectContaining({
        status: "pass",
        log,
      }),
    );
    expect(
      baseline.scenarios.find((scenario) => scenario.id === first.id)
        ?.evidence_digest,
    ).toMatch(/^[0-9a-f]{64}$/);
    const outsideLog = join(tmpdir(), `dot-codex-outside-log-${randomUUID()}`);
    await writeFile(outsideLog, `${method} (outside) ... ok\n`);
    await rm(join(resultsRoot, log), { force: true });
    await symlink(outsideLog, join(resultsRoot, log), "file");
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline log is missing from one run directory");
    await rm(join(resultsRoot, log), { force: true });
    await writeFile(join(resultsRoot, log), `${method} (current.run) ... ok\n`);
    await rm(outsideLog, { force: true });
    await writeFile(join(resultsRoot, log), `${method} (tampered) ... FAIL\n`);
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline log content digest mismatch");
    await writeFile(join(resultsRoot, log), `${method} (current.run) ... ok\n`);
    const outputTarget = join(
      tmpdir(),
      `dot-codex-outside-output-${randomUUID()}`,
    );
    await writeFile(outputTarget, "output-sentinel\n");
    await rm(output, { force: true });
    await symlink(outputTarget, output, "file");
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline file is not regular");
    expect(await readFile(outputTarget, "utf8")).toBe("output-sentinel\n");
    await rm(output, { force: true });
    await link(outputTarget, output);
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline file is not regular");
    expect(await readFile(outputTarget, "utf8")).toBe("output-sentinel\n");
    await rm(output, { force: true });
    await rm(outputTarget, { force: true });
    const otherManifest = JSON.parse(
      await readFile(join(verboseRoot, "run-manifest.json"), "utf8"),
    ) as { run_id: string };
    await writeFile(
      join(verboseRoot, "run-manifest.json"),
      `${JSON.stringify({ ...otherManifest, run_id: "different-run" })}\n`,
    );
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline run manifest is missing or does not match");
    await writeFile(join(resultsRoot, log), `${method} (current.run) ... ok\n`);
    await writeFile(
      join(verboseRoot, "run-manifest.json"),
      `${JSON.stringify(finalized)}\n`,
    );
    const forgedManifest = {
      ...finalized,
      log_digests: {
        ...finalized.log_digests,
        [log]: "0".repeat(64),
      },
      manifest_digest: "",
    };
    forgedManifest.manifest_digest = baselineManifestDigest(forgedManifest);
    await writeFile(
      join(resultsRoot, "run-manifest.json"),
      `${JSON.stringify(forgedManifest)}\n`,
    );
    await writeFile(
      join(verboseRoot, "run-manifest.json"),
      `${JSON.stringify(forgedManifest)}\n`,
    );
    await writeFile(join(resultsRoot, log), `${method} (forged) ... FAIL\n`);
    await writeFile(join(verboseRoot, log), `${method} (forged) ... FAIL\n`);
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline run manifest is missing or does not match");
    await writeFile(
      join(resultsRoot, "run-manifest.json"),
      `${JSON.stringify(finalized)}\n`,
    );
    await writeFile(
      join(verboseRoot, "run-manifest.json"),
      `${JSON.stringify(finalized)}\n`,
    );
    await writeFile(join(resultsRoot, log), `${method} (current.run) ... ok\n`);
    await writeFile(join(verboseRoot, log), `${method} (current.run) ... ok\n`);
    const linkedRoot = join(tmpdir(), `dot-codex-results-link-${randomUUID()}`);
    await symlink(resultsRoot, linkedRoot, "dir");
    await expect(
      collect(
        root,
        linkedRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline root cannot be a symlink");
    await rm(linkedRoot, { force: true });
    const manifestTarget = join(
      tmpdir(),
      `dot-codex-outside-manifest-${randomUUID()}`,
    );
    await writeFile(manifestTarget, `${JSON.stringify(finalized)}\n`);
    await rm(join(resultsRoot, "run-manifest.json"), { force: true });
    await symlink(
      manifestTarget,
      join(resultsRoot, "run-manifest.json"),
      "file",
    );
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline run manifest is missing or does not match");
    await rm(join(resultsRoot, "run-manifest.json"), { force: true });
    await writeFile(
      join(resultsRoot, "run-manifest.json"),
      `${JSON.stringify(finalized)}\n`,
    );
    await rm(manifestTarget, { force: true });
    const escapedManifest = {
      ...finalized,
      run_id: "../../outside",
    };
    await writeFile(
      join(resultsRoot, "run-manifest.json"),
      `${JSON.stringify(escapedManifest)}\n`,
    );
    await expect(
      collect(
        root,
        resultsRoot,
        verboseRoot,
        output,
        manifest.run_id,
        finalized.manifest_digest,
      ),
    ).rejects.toThrow("baseline run manifest is missing or does not match");
  } finally {
    await rm(resultsRoot, { recursive: true, force: true });
    await rm(verboseRoot, { recursive: true, force: true });
  }
});

test("retirement cannot reassign unrelated baseline scenarios", async () => {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const mapping = JSON.parse(
    await readFile(
      resolve(root, "bin/fixtures/python-compatibility/mapping.json"),
      "utf8",
    ),
  );
  const scenario = mapping.scenarios.find(
    (row: { state: string }) => row.state !== "retired",
  );
  scenario.source = "bin/test_wave_thread_plan_contract.py";
  scenario.state = "retired";
  scenario.evidence = {
    kind: "retired",
    reason: "unrelated scenario disguised as retired",
  };
  expect(validateMapping(mapping, root)).toContain(
    `scenario source differs from baseline identity: ${scenario.id}`,
  );
});
