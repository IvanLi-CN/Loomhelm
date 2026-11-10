import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/engine";
import { validateLedger } from "../lib/schema";
import { LedgerStore } from "../lib/store";

const createdRoots: string[] = [];
const initialInput = JSON.parse(
  readFileSync(join(import.meta.dir, "../examples/ledger-initialization/initial.json"), "utf8"),
);

function temporaryRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "orchestration-init-"));
  createdRoots.push(root);
  return root;
}

async function runInit(root: string, input: unknown) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/orchestrate.ts"),
      "init",
      "--input",
      "-",
    ],
    {
      env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: JSON.parse(stdout), stderr };
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

async function runCommand(root: string, command: string, input: unknown) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/orchestrate.ts"),
      command,
      "--input",
      "-",
    ],
    {
      env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: JSON.parse(stdout), stderr };
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

afterEach(() => {
  for (const root of createdRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("orchestrate init", () => {
  test("creates an unbound revision-zero ledger without task conversations", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    const result = await runInit(root, input);
    const ledgerPath = join(root, "runs", input.run_id, "ledger.json");

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      code: "CREATED",
      revision: 0,
    });
    expect(result.stderr).toBe("");

    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(ledger.revision).toBe(0);
    expect(ledger.operations).toEqual([]);
    expect(ledger.events).toEqual([]);
    expect(ledger.resources).toEqual([]);
    expect(
      ledger.groups.every(
        (group: any) =>
          group.agent_thread_id === null && group.state === "planned",
      ),
    ).toBe(true);
    expect(
      ledger.tasks.every(
        (task: any) => task.thread_id === null && task.state === "planned",
      ),
    ).toBe(true);
  });

  test("preserves registered requirements paths during initialisation", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    input.payload.groups[0].requirements_path = "requirements/group-core.md";
    input.payload.tasks[0].requirements_path = "requirements/task-core.md";
    const result = await runInit(root, input);

    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(root, "runs", input.run_id, "ledger.json"), "utf8"));
    expect(ledger.groups[0].requirements_path).toBe("requirements/group-core.md");
    expect(ledger.tasks[0].requirements_path).toBe("requirements/task-core.md");
  });

  test("rejects unsafe initial requirements paths", async () => {
    const cases = ["../outside.md", "requirements/../outside.md", "requirements/task-core.txt"];
    for (const requirements_path of cases) {
      const root = temporaryRoot();
      const input = structuredClone(initialInput);
      input.payload.tasks[0].requirements_path = requirements_path;
      const result = await runInit(root, input);

      expect(result.exitCode).toBe(2);
      expect(result.output).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(existsSync(join(root, "runs", input.run_id))).toBe(false);
    }
  });

  test("defaults a new delivery unit to its independent five-step atom plan", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    input.payload.initial_plan.group_atoms = [];
    input.payload.groups = input.payload.groups.map((group: any) => ({ ...group, atoms: [] }));
    const result = await runInit(root, input);
    expect(result.output).toMatchObject({ ok: true, code: "CREATED" });
    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(root, "runs", input.run_id, "ledger.json"), "utf8"));

    expect(ledger.plans[0].group_atoms).toHaveLength(5);
    expect(ledger.groups[0].atoms.map((atom: any) => atom.title)).toEqual([
      "准备父分支",
      "创建父 PR",
      "验收集成结果",
      "合并父 PR",
      "收口",
    ]);
    expect(ledger.groups[0].atoms.every((atom: any) => atom.status === "planned")).toBe(true);
  });

  test("accepts one main-owned bootstrap unit and rejects invalid bootstrap topology", async () => {
    const valid = structuredClone(initialInput);
    valid.payload.groups[0].delivery_unit_kind = "bootstrap";
    valid.payload.groups[0].owner_kind = "main";
    expect((await runInit(temporaryRoot(), valid)).exitCode).toBe(0);
    const cases = [
      (input: any) => { input.payload.groups.push(structuredClone(input.payload.groups[0])); input.payload.groups[1].id = "group-bootstrap-2"; },
      (input: any) => { input.payload.groups[0].owner_kind = "group"; },
      (input: any) => { input.payload.groups[0].agent_thread_id = "group-thread"; },
    ];
    for (const mutate of cases) {
      const input = structuredClone(valid); mutate(input);
      const result = await runInit(temporaryRoot(), input);
      expect(result.exitCode).not.toBe(0);
      expect(result.output.ok).toBe(false);
    }
  });

  test("rejects forged runtime state before creating any run files", async () => {
    const cases = [
      (input: any) => {
        input.payload.groups[0].agent_thread_id = "existing-group-thread";
      },
      (input: any) => {
        input.payload.tasks[0].thread_id = "existing-task-thread";
      },
      (input: any) => {
        input.payload.groups[0].state = "active";
      },
      (input: any) => {
        input.payload.tasks[0].state = "running";
      },
      (input: any) => {
        input.payload.tasks[0].atoms[0].status = "running";
      },
      (input: any) => {
        input.payload.groups[0].parent_branch = "parent";
      },
      (input: any) => {
        input.payload.tasks[0].base_sha = "a".repeat(40);
      },
      (input: any) => {
        input.payload.tasks[0].started_at = "2026-01-01T00:00:00.000Z";
      },
    ];

    for (const mutate of cases) {
      const root = temporaryRoot();
      const input = structuredClone(initialInput);
      mutate(input);
      const result = await runInit(root, input);

      expect(result.exitCode).toBe(2);
      expect(result.output).toMatchObject({
        ok: false,
        code: "INVALID_INITIAL_STATE",
        revision: null,
        message:
          "Initial groups and tasks must be unbound and planned with planned atoms",
      });
      expect(existsSync(join(root, "runs", input.run_id))).toBe(false);
    }
  });

  test("rejects runtime groups that are absent from the active plan", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    input.payload.groups.push({
      id: "group-orphan",
      title: "Orphan",
      agent_thread_id: null,
      state: "planned",
      parent_branch: null,
      parent_pr: null,
      cut_sha: null,
      current_sha: null,
      merge_sha: null,
      requirements_path: null,
    });
    const result = await runInit(root, input);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({ ok: false, code: "ORPHAN_GROUP" });
    expect(existsSync(join(root, "runs", input.run_id))).toBe(false);
  });

  test("rejects dev-plan handoff fields as foreign input", async () => {
    const cases = [
      (input: any) => {
        input.payload.initial_plan.dev_plan_handoff = {};
      },
      (input: any) => {
        input.payload.dev_plan_handoff_source = {};
      },
    ];

    for (const mutate of cases) {
      const root = temporaryRoot();
      const input = structuredClone(initialInput);
      mutate(input);
      const result = await runInit(root, input);

      expect(result.exitCode).toBe(2);
      expect(result.output).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
        revision: null,
      });
      expect(existsSync(join(root, "runs", input.run_id))).toBe(false);
    }
  });

  test("rejects runtime tasks that are absent from the active plan", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    const extra = structuredClone(input.payload.tasks[0]);
    extra.id = "task-3";
    extra.title = "Unplanned task";
    extra.atoms[0].id = "atom-3";
    extra.atoms[0].title = "Unplanned task";
    input.payload.tasks.push(extra);

    const result = await runInit(root, input);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({
      ok: false,
      code: "UNKNOWN_PLAN_TASK",
      revision: null,
    });
    expect(existsSync(join(root, "runs", input.run_id))).toBe(false);
  });

  test("reads and atomically migrates legacy handoff ledgers", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    const result = await runInit(root, input);
    const ledgerPath = join(root, "runs", input.run_id, "ledger.json");
    const legacy = JSON.parse(readFileSync(ledgerPath, "utf8"));
    legacy.plans[0].dev_plan_handoff = {};
    writeFileSync(ledgerPath, JSON.stringify(legacy, null, 2) + "\n");

    const store = new LedgerStore(root, input.run_id);
    expect(result.exitCode).toBe(0);
    expect(store.read().plans[0]).not.toHaveProperty("dev_plan_handoff");
    store.update((ledger) => {
      ledger.revision = 1;
    });
    expect(
      JSON.parse(readFileSync(ledgerPath, "utf8")).plans[0],
    ).not.toHaveProperty("dev_plan_handoff");
  });

  test("reads schema v1 as an unknown lifecycle view without rewriting the legacy ledger", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    const result = await runInit(root, input);
    const ledgerPath = join(root, "runs", input.run_id, "ledger.json");
    const legacy = JSON.parse(readFileSync(ledgerPath, "utf8"));
    legacy.schema_version = 1;
    delete legacy.source_schema_version;
    delete legacy.milestones;
    legacy.groups[0].agent_thread_id = "legacy-group-thread";
    legacy.groups[0].state = "active";
    legacy.groups[0].parent_branch = "parent";
    legacy.groups[0].current_sha = "a".repeat(40);
    legacy.tasks[0].thread_id = "legacy-task-thread";
    legacy.tasks[0].state = "running";
    legacy.tasks[0].pr = {
      provider: "github",
      repository: "example/project",
      id: "legacy-pr",
      url: "https://github.com/example/project/pull/1",
    };
    legacy.facts.push({
      id: "legacy-merge",
      kind: "pr_merged",
      subject_id: legacy.tasks[0].id,
      status: "passed",
      source: "github",
      observed_at: "2026-01-01T00:00:00.000Z",
      sha: "b".repeat(40),
      evidence_ref: "legacy-receipt",
    });
    legacy.operations.push({
      id: "legacy-merge-op",
      kind: "merge",
      actor_id: "legacy-task-thread",
      target_id: legacy.groups[0].id,
      status: "succeeded",
      request: { mode: "child", task_id: legacy.tasks[0].id },
      expected_sha: "a".repeat(40),
      receipt_fact_id: "legacy-merge",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    for (const group of legacy.groups) delete group.lifecycle;
    for (const task of legacy.tasks) {
      delete task.branch;
      delete task.lifecycle;
    }
    writeFileSync(ledgerPath, JSON.stringify(legacy, null, 2) + "\n");
    const store = new LedgerStore(root, input.run_id);
    const view = store.read();
    expect(result.exitCode).toBe(0);
    expect(view.schema_version).toBe(2);
    expect(view.source_schema_version).toBe(1);
    expect(view.groups[0].lifecycle).toEqual({
      workspace_ready: "unknown",
      pr_created: "unknown",
      pr_merged: "unknown",
      closed: "unknown",
    });
    expect(view.tasks[0].lifecycle.pr_created).toBe("unknown");
    expect(view.tasks[0].pr.id).toBe("legacy-pr");
    expect(
      view.facts.find((fact: any) => fact.id === "legacy-merge")?.status,
    ).toBe("passed");
    expect(
      view.operations.find(
        (operation: any) => operation.id === "legacy-merge-op",
      )?.status,
    ).toBe("succeeded");
    expect(() =>
      store.update((ledger) => {
        ledger.revision += 1;
      }),
    ).toThrow("read-only");
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).schema_version).toBe(1);
  });

  test("rejects unknown ledger schemas at the store boundary", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    const result = await runInit(root, input);
    const ledgerPath = join(root, "runs", input.run_id, "ledger.json");
    const unknown = JSON.parse(readFileSync(ledgerPath, "utf8"));
    unknown.schema_version = 3;
    writeFileSync(ledgerPath, JSON.stringify(unknown, null, 2) + "\n");
    const store = new LedgerStore(root, input.run_id);
    expect(result.exitCode).toBe(0);
    expect(() => store.read()).toThrow("unsupported");
    expect(() => store.update((ledger) => ledger)).toThrow("unsupported");
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).schema_version).toBe(3);
  });

  test("accepts a cut-proven task reassignment after initialization", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    const result = await runInit(root, input);
    const ledgerPath = join(root, "runs", input.run_id, "ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const secondGroup = structuredClone(ledger.groups[0]);
    secondGroup.id = "group-2";
    secondGroup.title = "Second group";
    ledger.groups.push(secondGroup);
    ledger.plans[0].cut_rules.push({
      id: "cut-1",
      group_id: "group-1",
      priority: 0,
      required_task_ids: [],
      status: "applied",
    });
    const cutSha = "a".repeat(40);
    ledger.groups[0].current_sha = cutSha;
    const taskSnapshot = structuredClone(ledger.tasks[0]);
    ledger.groups[0].cut_sha = cutSha;
    ledger.tasks[0].group_id = "group-2";
    ledger.tasks[0].assignment_history.push({
      group_id: "group-2",
      effective_at: "2026-01-01T00:01:00.000Z",
      reason: "dynamic cut",
      cut_operation_id: "cut-1",
    });
    ledger.operations.push({
      id: "cut-1",
      kind: "cut",
      actor_id: "main",
      target_id: "group-1",
      status: "succeeded",
      request: { operation_id: "cut-1", group_id: "group-1", rule_id: "cut-1" },
      expected_sha: cutSha,
      receipt_fact_id: null,
      created_at: "2026-01-01T00:01:00.000Z",
      updated_at: "2026-01-01T00:01:00.000Z",
    });
    ledger.events.push({
      id: "event-cut-claim",
      type: "cut_claimed",
      subject_id: "group-1",
      actor_id: "main",
      occurred_at: "2026-01-01T00:01:00.000Z",
      recorded_at: "2026-01-01T00:01:00.000Z",
      data: {
        operation_id: "cut-1",
        group_id: "group-1",
        rule_id: "cut-1",
        expected_sha: cutSha,
        drained: true,
      },
    });
    ledger.events.push({
      id: "event-cut",
      type: "cut_applied",
      subject_id: "group-1",
      actor_id: "main",
      occurred_at: "2026-01-01T00:01:00.000Z",
      recorded_at: "2026-01-01T00:01:00.000Z",
      data: {
        operation_id: "cut-1",
        old_group_id: "group-1",
        old_group_current_sha: cutSha,
        old_group_snapshot: structuredClone(ledger.groups[0]),
        cut_evidence: {
          source: "github",
          observed_at: "2026-01-01T00:01:00.000Z",
          sha: cutSha,
          evidence_ref: "cut-proof",
        },
        new_group_id: "group-2",
        new_group_state: "planned",
        new_group_agent_thread_id: null,
        new_group_parent_branch: null,
        new_group_parent_pr: null,
        new_group_cut_sha: null,
        new_group_current_sha: null,
        new_group_merge_sha: null,
        new_group_requirements_path: null,
        new_group_snapshot: structuredClone(secondGroup),
        cut_sha: cutSha,
        included_task_ids: [],
        reassigned_task_ids: ["task-1"],
        task_snapshots: [taskSnapshot],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(() => validateLedger(ledger)).not.toThrow();
    const postCutLifecycle = structuredClone(ledger);
    postCutLifecycle.groups[0].state = "merged";
    postCutLifecycle.groups[0].merge_sha = cutSha;
    expect(() => validateLedger(postCutLifecycle)).not.toThrow();
    const forgedOperationSha = structuredClone(ledger);
    forgedOperationSha.operations[0].expected_sha = "b".repeat(40);
    expect(() => validateLedger(forgedOperationSha)).toThrow(
      "cut_applied event",
    );
    const forged = structuredClone(ledger);
    forged.operations[0].target_id = "group-2";
    expect(() => validateLedger(forged)).toThrow("cut_applied event");
    for (const mutate of [
      (group: any) => {
        group.agent_thread_id = "forged-thread";
      },
      (group: any) => {
        group.state = "active";
      },
      (group: any) => {
        group.current_sha = "b".repeat(40);
      },
    ]) {
      const forgedGroup = structuredClone(ledger);
      mutate(forgedGroup.groups[1]);
      expect(() => validateLedger(forgedGroup)).toThrow("dynamic group");
    }
    const forgedLifecycle = structuredClone(ledger);
    forgedLifecycle.groups[1].state = "active";
    forgedLifecycle.events.push({
      id: "event-forged-group-update",
      type: "group_updated",
      subject_id: "group-2",
      actor_id: "main",
      occurred_at: "2026-01-01T00:02:00.000Z",
      recorded_at: "2026-01-01T00:02:00.000Z",
      data: { group_id: "group-2", state: "active" },
    });
    expect(() => validateLedger(forgedLifecycle)).toThrow("group snapshot");
    const forgedBoundary = structuredClone(ledger);
    forgedBoundary.groups[0].cut_sha = null;
    expect(() => validateLedger(forgedBoundary)).toThrow("cut_applied event");
    const forgedEvidence = structuredClone(ledger);
    delete forgedEvidence.events.find(
      (event: any) => event.type === "cut_applied",
    )!.data.cut_evidence;
    expect(() => validateLedger(forgedEvidence)).toThrow(
      "verified provider evidence",
    );
    const forgedClaim = structuredClone(ledger);
    forgedClaim.events = forgedClaim.events.filter(
      (event: any) => event.type !== "cut_claimed",
    );
    expect(() => validateLedger(forgedClaim)).toThrow("matching cut claim");
    const forgedSnapshot = structuredClone(ledger);
    forgedSnapshot.events.find(
      (event: any) => event.type === "cut_applied",
    )!.data.old_group_snapshot.title = "forged";
    expect(() => validateLedger(forgedSnapshot)).toThrow(
      "old group boundary snapshot",
    );
    const forgedTaskState = structuredClone(ledger);
    forgedTaskState.events
      .find((event: any) => event.type === "cut_applied")!
      .data.task_snapshots.find((task: any) => task.id === "task-1").state =
      "running";
    expect(() => validateLedger(forgedTaskState)).toThrow(
      "task boundary snapshot",
    );
    const forgedTaskBoundary = structuredClone(ledger);
    delete forgedTaskBoundary.events.find(
      (event: any) => event.type === "cut_applied",
    )!.data.task_snapshots;
    expect(() => validateLedger(forgedTaskBoundary)).toThrow(
      "task boundary snapshots",
    );
    const duplicateEvent = structuredClone(ledger);
    duplicateEvent.events.push({
      ...structuredClone(
        duplicateEvent.events.find(
          (event: any) => event.type === "cut_applied",
        )!,
      ),
      id: "event-cut-duplicate",
    });
    expect(() => validateLedger(duplicateEvent)).toThrow("cut_applied event");
    const omittedTask = structuredClone(ledger);
    omittedTask.tasks[0].group_id = "group-1";
    omittedTask.tasks[0].assignment_history = [];
    omittedTask.events.find(
      (event: any) => event.type === "cut_applied",
    )!.data.reassigned_task_ids = [];
    expect(() => validateLedger(omittedTask)).toThrow(
      "cover every old-delivery-unit contribution task",
    );
  });

  test("preserves dotted task IDs in the independent runtime plan", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    input.payload.tasks[0].id = "task.a";
    input.payload.initial_plan.atoms[0].task_id = "task.a";
    input.payload.initial_plan.nodes.find(
      (node: any) => node.ref_id === "task-1",
    ).ref_id = "task.a";

    const result = await runInit(root, input);
    const ledger = JSON.parse(
      readFileSync(join(root, "runs", input.run_id, "ledger.json"), "utf8"),
    );

    expect(result.exitCode).toBe(0);
    expect(ledger.tasks.map((task: any) => task.id)).toContain("task.a");
  });

  test("documents init as an explicit mutation boundary", () => {
    const skill = readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8");
    const design = readFileSync(
      join(
        import.meta.dir,
        "../../../skills/docs/vendor/dot-codex/design/multi-task-flow/data-and-scripts.md",
      ),
      "utf8",
    );

    expect(skill).toContain("Initialization is a mutating runtime action");
    expect(skill).toContain(
      "must not call `init` or a native conversation-creation tool",
    );
    expect(design).toContain("失败返回 `INVALID_INITIAL_STATE`");
    expect(design).toContain("不创建任务会话");
  });
});

describe("orchestrate group-base-reconcile", () => {
  test("records an update-branch observation through the CLI contract", async () => {
    const root = temporaryRoot();
    const oldSha = "7bc041bb302fd5fa1ee4c6ce06637f77b7c50689";
    const newSha = "c6b8a5254ef5a3aca914ef087d93cdbacdaa2fc8";
    const at = "2026-11-04T00:00:00.000Z";
    const parentPr = {
      provider: "github",
      repository: "example/project",
      id: "1291",
      url: "https://github.com/example/project/pull/1291",
    };
    const input = structuredClone(initialInput);
    input.run_id = "cli-reconcile-run";
    input.payload.groups[0].atoms = input.payload.initial_plan.group_atoms.filter((atom: any) => atom.group_id === input.payload.groups[0].id).map(({ group_id, ...atom }: any) => ({ ...atom, status: "planned" }));
    input.payload.groups[0] = {
      ...input.payload.groups[0],
      agent_thread_id: "group-thread",
      state: "active",
      parent_branch: "parent",
      parent_pr: parentPr,
      current_sha: oldSha,
    };
    input.payload.tasks = input.payload.tasks.map((task: any) => ({
      ...task,
      base_sha: oldSha,
    }));
    const ledger = validateLedger({
      schema_version: 2,
      source_schema_version: null,
      contract_version: 2,
      orchestration_id: input.run_id,
      revision: 0,
      repository: input.payload.repository,
      control: {
        owner_thread_id: "main-thread",
        ownership: "bound",
        approval_id: null,
      },
      config: input.payload.config,
      plans: [input.payload.initial_plan],
      active_plan_id: input.payload.initial_plan.id,
      execution_plan_id: input.payload.initial_plan.id,
      groups: input.payload.groups,
      tasks: input.payload.tasks,
      follow_prs: [],
      facts: [],
      operations: [],
      events: [],
      requests: [],
      notifications: [],
      resources: [],
      updated_at: at,
    });
    new LedgerStore(root, input.run_id).create(ledger);

    const result = await runCommand(root, "group-base-reconcile", {
      run_id: input.run_id,
      actor: { role: "group", thread_id: "group-thread" },
      request_id: "cli-reconcile-parent",
      expected_revision: 0,
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

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.output).toMatchObject({
      ok: true,
      code: "APPLIED",
      revision: 1,
      result: { current_sha: newSha },
    });
    const saved = JSON.parse(
      readFileSync(join(root, "runs", input.run_id, "ledger.json"), "utf8"),
    );
    expect(saved.groups[0].current_sha).toBe(newSha);
    expect(saved.events.at(-1)).toMatchObject({
      type: "group_base_reconciled",
    });
  });
});
