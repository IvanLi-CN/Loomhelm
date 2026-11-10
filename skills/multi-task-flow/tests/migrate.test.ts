import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../lib/store";
import { migrationCanonicalInput } from "../lib/store-migration";

const roots: string[] = [];
const initialInput = JSON.parse(
  readFileSync(join(import.meta.dir, "../examples/ledger-initialization/initial.json"), "utf8"),
);
const oldSha = "7bc041bb302fd5fa1ee4c6ce06637f77b7c50689";
const newSha = "c6b8a5254ef5a3aca914ef087d93cdbacdaa2fc8";
const parentPr = {
  provider: "github",
  repository: "example/project",
  id: "1291",
  url: "https://github.com/example/project/pull/1291",
};

function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), "ledger-migrate-"));
  roots.push(value);
  return value;
}

async function runOrchestrate(
  dataRoot: string,
  command: string,
  input: unknown,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/orchestrate.ts"),
      command,
      "--input",
      "-",
    ],
    {
      env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: dataRoot },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: JSON.parse(stdout), stderr };
}

async function createLegacyRun(dataRoot: string, runId = "legacy-run") {
  const input = structuredClone(initialInput);
  input.run_id = runId;
  const initialized = await runOrchestrate(dataRoot, "init", input);
  expect(initialized.exitCode).toBe(0);
  const ledgerPath = join(dataRoot, "runs", runId, "ledger.json");
  const legacy = JSON.parse(readFileSync(ledgerPath, "utf8"));
  legacy.groups[0] = {
    ...legacy.groups[0],
    agent_thread_id: "group-thread",
    state: "active",
    parent_branch: "parent",
    parent_pr: parentPr,
    current_sha: oldSha,
  };
  legacy.tasks = legacy.tasks.map((task: any) => ({
    ...task,
    base_sha: oldSha,
  }));
  legacy.schema_version = 1;
  delete legacy.source_schema_version;
  delete legacy.milestones;
  legacy.revision = 7;
  legacy.facts = [
    {
      id: "legacy-fact",
      kind: "pr_merged",
      subject_id: "task-1",
      status: "passed",
      source: "github",
      observed_at: "2026-01-01T00:00:00.000Z",
      sha: oldSha,
      evidence_ref: "legacy-receipt",
    },
  ];
  legacy.events = [
    {
      id: "legacy-event",
      type: "fact_observed",
      subject_id: "task-1",
      actor_id: "legacy-agent",
      occurred_at: "2026-01-01T00:00:00.000Z",
      recorded_at: "2026-01-01T00:00:00.000Z",
      data: { fact_id: "legacy-fact" },
    },
  ];
  for (const group of legacy.groups) delete group.lifecycle;
  for (const task of legacy.tasks) delete task.lifecycle;
  writeFileSync(ledgerPath, JSON.stringify(legacy, null, 2) + "\n");
  return { input, ledgerPath, legacy };
}

function migrateInput(
  runId: string,
  expectedRevision: number,
  requestId = "migration-1",
) {
  return {
    run_id: runId,
    actor: { role: "main", thread_id: "example-main-thread" },
    request_id: requestId,
    expected_revision: expectedRevision,
    payload: {},
  };
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("orchestrate migrate", () => {
  test("ordinary migrate cannot repair historical policy gaps through child-review retirement", async () => {
    const dataRoot = root();
    const { ledgerPath } = await createLegacyRun(dataRoot);
    const historical = JSON.parse(readFileSync(ledgerPath, "utf8"));
    historical.schema_version = 2;
    historical.contract_version = 2;
    historical.facts.push({ kind: "child_review" });
    for (const task of historical.tasks) {
      delete task.execution_owner;
      delete task.conversation_policy;
      delete task.delivery_policy;
    }
    writeFileSync(ledgerPath, JSON.stringify(historical, null, 2) + "\n");
    const before = readFileSync(ledgerPath, "utf8");
    const result = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );

    expect(result).toMatchObject({
      exitCode: 4,
      output: { ok: false, code: "HISTORICAL_LEDGER_READ_ONLY" },
    });
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    expect(existsSync(join(dataRoot, "runs", "legacy-run", "ledger.migration-v1-migration-1.json"))).toBe(false);
  });

  test("ordinary migrate keeps complete but semantically invalid historical policies read-only", async () => {
    const dataRoot = root();
    const { ledgerPath } = await createLegacyRun(dataRoot);
    const historical = JSON.parse(readFileSync(ledgerPath, "utf8"));
    historical.schema_version = 2;
    historical.contract_version = 2;
    historical.facts.push({ kind: "child_review" });
    for (const task of historical.tasks)
      Object.assign(task, {
        execution_owner: "main",
        conversation_policy: "main_owned",
        delivery_policy: "none",
      });
    historical.tasks[0].conversation_policy = "task_agent";
    writeFileSync(ledgerPath, JSON.stringify(historical, null, 2) + "\n");
    const before = readFileSync(ledgerPath, "utf8");
    const result = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );

    expect(result).toMatchObject({
      exitCode: 4,
      output: { ok: false, code: "HISTORICAL_LEDGER_READ_ONLY" },
    });
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  });

  test("migrates a valid v1 ledger with an incremented revision and complete backup", async () => {
    const dataRoot = root();
    const { ledgerPath, legacy } = await createLegacyRun(dataRoot);
    const result = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      output: {
        ok: true,
        code: "APPLIED",
        revision: 8,
        result: {
          run_id: "legacy-run",
          source_schema_version: 1,
          schema_version: 2,
          contract_version: 2,
          revision: 8,
        },
      },
      stderr: "",
    });
    const saved = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(saved.schema_version).toBe(2);
    expect(saved.source_schema_version).toBe(1);
    expect(saved.contract_version).toBe(2);
    expect(saved.revision).toBe(8);
    expect(saved.events).toEqual(legacy.events);
    expect(saved.facts).toEqual(legacy.facts);
    expect(saved.groups[0].lifecycle).toEqual({
      workspace_ready: "unknown",
      pr_created: "unknown",
      pr_merged: "unknown",
      closed: "unknown",
    });
    expect(saved.requests.at(-1)).toMatchObject({
      request_id: "migration-1",
      command: "migrate",
      committed_revision: 8,
    });
    const backupPath = join(
      dataRoot,
      "runs",
      "legacy-run",
      result.output.result.backup,
    );
    expect(readFileSync(backupPath, "utf8")).toBe(
      JSON.stringify(legacy, null, 2) + "\n",
    );
  });

  test("recovers a legacy backup without a request identity sidecar", async () => {
    const dataRoot = root();
    const { legacy } = await createLegacyRun(dataRoot);
    const runPath = join(dataRoot, "runs", "legacy-run");
    const backupPath = join(runPath, "ledger.migration-v1-migration-1.json");
    writeFileSync(backupPath, JSON.stringify(legacy, null, 2) + "\n");
    const result = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );

    expect(result).toMatchObject({ exitCode: 0, output: { code: "APPLIED" } });
    expect(existsSync(`${backupPath}.request.json`)).toBe(true);
  });

  test("migration replay verifies committed backup artifacts", async () => {
    for (const artifact of ["backup", "identity"]) {
      const dataRoot = root();
      const { legacy } = await createLegacyRun(dataRoot, `legacy-${artifact}`);
      const request = migrateInput(`legacy-${artifact}`, 7, `migration-${artifact}`);
      const applied = await runOrchestrate(dataRoot, "migrate", request);
      const backupPath = join(
        dataRoot,
        "runs",
        `legacy-${artifact}`,
        applied.output.result.backup,
      );
      if (artifact === "backup") writeFileSync(backupPath, "corrupted");
      else writeFileSync(`${backupPath}.request.json`, "{}");
      const replay = await runOrchestrate(dataRoot, "migrate", request);
      expect(replay).toMatchObject({
        exitCode: 3,
        output: { ok: false, code: "MIGRATION_CONFLICT" },
      });
      expect(legacy.schema_version).toBe(1);
    }
  });

  test("legacy migration replay requires a digest-bearing identity", async () => {
    const dataRoot = root();
    const { ledgerPath } = await createLegacyRun(dataRoot);
    const request = migrateInput("legacy-run", 7);
    const applied = await runOrchestrate(dataRoot, "migrate", request);
    const runPath = join(dataRoot, "runs", "legacy-run");
    const identityPath = join(runPath, `${applied.output.result.backup}.request.json`);
    const saved = JSON.parse(readFileSync(ledgerPath, "utf8"));
    delete saved.requests.at(-1).result.source_ledger_sha256;
    writeFileSync(ledgerPath, JSON.stringify(saved, null, 2) + "\n");
    const identity = JSON.parse(readFileSync(identityPath, "utf8"));
    delete identity.source_ledger_sha256;
    writeFileSync(identityPath, JSON.stringify(identity) + "\n");

    const replay = await runOrchestrate(dataRoot, "migrate", request);
    expect(replay).toMatchObject({
      exitCode: 3,
      output: { ok: false, code: "MIGRATION_CONFLICT" },
    });
    expect(replay.output.message).toContain("explicit recovery is required");
  });

  test("replays the same request and lets the next normal command use the new revision", async () => {
    const dataRoot = root();
    await createLegacyRun(dataRoot);
    const request = migrateInput("legacy-run", 7);
    const applied = await runOrchestrate(dataRoot, "migrate", request);
    const replay = await runOrchestrate(dataRoot, "migrate", request);
    expect(replay).toMatchObject({
      exitCode: 0,
      output: { code: "REPLAYED", revision: 8 },
    });

    const next = await runOrchestrate(dataRoot, "group-base-reconcile", {
      run_id: "legacy-run",
      actor: { role: "group", thread_id: "group-thread" },
      request_id: "normal-after-migration",
      expected_revision: applied.output.revision,
      payload: {
        group_id: "group-1",
        provider_observation: {
          operation: "update-branch",
          branch: "parent",
          previous_sha: oldSha,
          sha: newSha,
          parent_pr: parentPr,
          source: "github",
          evidence_ref: "github-update-branch-1291",
        },
      },
    });
    expect(next).toMatchObject({
      exitCode: 0,
      output: { code: "APPLIED", revision: 9 },
    });
  });

  test("rejects an existing request ID with different content", async () => {
    const dataRoot = root();
    const { ledgerPath, legacy } = await createLegacyRun(dataRoot);
    legacy.requests = [
      {
        request_id: "migration-1",
        command: "show",
        canonical_input: "different",
        result: {},
        committed_revision: 7,
      },
    ];
    writeFileSync(ledgerPath, JSON.stringify(legacy, null, 2) + "\n");
    const result = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );
    expect(result).toMatchObject({
      exitCode: 3,
      output: { ok: false, code: "ID_CONFLICT" },
    });
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual(legacy);
  });

  test("rejects a stale expected revision without creating a backup", async () => {
    const dataRoot = root();
    const { ledgerPath, legacy } = await createLegacyRun(dataRoot);
    const result = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 6),
    );
    expect(result).toMatchObject({
      exitCode: 3,
      output: { ok: false, code: "REVISION_CONFLICT" },
    });
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual(legacy);
    expect(
      existsSync(
        join(
          dataRoot,
          "runs",
          "legacy-run",
          "ledger.migration-v1-migration-1.json",
        ),
      ),
    ).toBe(false);
  });

  test("rejects invalid CLI input, corrupted ledgers, and symlinked ledgers", async () => {
    const dataRoot = root();
    const { ledgerPath, legacy } = await createLegacyRun(dataRoot);
    const forbidden = await runOrchestrate(dataRoot, "migrate", {
      ...migrateInput("legacy-run", 7),
      actor: { role: "main", thread_id: "other-main-thread" },
    });
    expect(forbidden).toMatchObject({
      exitCode: 3,
      output: { ok: false, code: "FORBIDDEN" },
    });
    const invalid = await runOrchestrate(dataRoot, "migrate", {
      run_id: "legacy-run",
      actor: { role: "main", thread_id: "example-main-thread" },
      request_id: "migration-1",
      expected_revision: "7",
      payload: {},
    });
    expect(invalid).toMatchObject({
      exitCode: 2,
      output: { ok: false, code: "INVALID_INPUT" },
    });

    writeFileSync(ledgerPath, "not-json\n");
    const corrupted = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );
    expect(corrupted).toMatchObject({
      exitCode: 5,
      output: { ok: false, code: "LEDGER_UNREADABLE" },
    });
    writeFileSync(ledgerPath, JSON.stringify(legacy, null, 2) + "\n");

    const outside = join(dataRoot, "outside.json");
    writeFileSync(outside, JSON.stringify(legacy));
    unlinkSync(ledgerPath);
    Bun.spawnSync(["ln", "-s", outside, ledgerPath]);
    expect(lstatSync(ledgerPath).isSymbolicLink()).toBe(true);
    const unsafe = await runOrchestrate(
      dataRoot,
      "migrate",
      migrateInput("legacy-run", 7),
    );
    expect(unsafe.output.ok).toBe(false);
  });

  test("keeps the v1 ledger when the atomic migration is interrupted", async () => {
    const dataRoot = root();
    const { ledgerPath, legacy } = await createLegacyRun(dataRoot);
    const store = new LedgerStore(dataRoot, "legacy-run", (stage) => {
      if (stage === "migration_backup_committed")
        throw new Error("simulated interruption");
    });
    expect(() =>
      store.migrate({
        ...migrateInput("legacy-run", 7),
        canonical_input: migrationCanonicalInput("legacy-run", {
          role: "main",
          thread_id: "example-main-thread",
        }),
      }),
    ).toThrow("simulated interruption");
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual(legacy);
    expect(
      existsSync(
        join(
          dataRoot,
          "runs",
          "legacy-run",
          "ledger.migration-v1-migration-1.json",
        ),
      ),
    ).toBe(true);
    expect([
      ...new Bun.Glob(".ledger.json.*.tmp").scanSync(
        join(dataRoot, "runs", "legacy-run"),
      ),
    ]).toEqual([]);
  });
});
