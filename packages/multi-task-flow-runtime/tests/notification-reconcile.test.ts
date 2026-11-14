import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/engine";
import { LedgerStore } from "../lib/store";

const createdRoots: string[] = [];
const initialInput = JSON.parse(
  readFileSync(join(import.meta.dir, "../examples/ledger-initialization/initial.json"), "utf8"),
);

function temporaryRoot(): string {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "notification-reconcile-"),
  );
  createdRoots.push(root);
  return root;
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

describe("orchestrate notification-reconcile", () => {
  test("lists unknown notifications and records an explicit platform reconciliation", async () => {
    const root = temporaryRoot();
    const input = structuredClone(initialInput);
    input.run_id = "cli-notification-run";
    const init = await runCommand(root, "init", input);
    expect(init.exitCode).toBe(0);
    const store = new LedgerStore(root, input.run_id);
    store.update((ledger) => {
      const task = ledger.tasks[0];
      task.thread_id = "task-thread";
      task.state = "running";
      apply(ledger, "task-update", {
        run_id: input.run_id,
        actor: { role: "task", thread_id: "task-thread" },
        request_id: "cli-notification-intent",
        expected_revision: ledger.revision,
        payload: {
          task_id: task.id,
          state: "waiting",
          detail: "Waiting for reconciliation",
          notification: { mode: "deliver", recipient: "owner" },
        },
      });
    });
    const afterIntent = store.read();
    const notificationId = afterIntent.notifications[0].id;
    const unknown = await runCommand(root, "notification-deliver", {
      run_id: input.run_id,
      actor: { role: "task", thread_id: "task-thread" },
      request_id: "cli-notification-unknown",
      expected_revision: afterIntent.revision,
      payload: {
        notification_id: notificationId,
        delivery_attempt_id: "cli-attempt-1",
        outcome: "unknown",
        provider_receipt: { provider: "codex", evidence_ref: "codex-timeout" },
      },
    });
    expect(unknown.exitCode).toBe(0);
    const owner = { role: "main", thread_id: "example-main-thread" };
    const listed = await runCommand(root, "notification-reconcile", {
      run_id: input.run_id,
      actor: owner,
      status: "unknown",
    });
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toMatchObject({
      ok: true,
      code: "OK",
      result: {
        pending: 1,
        notifications: [{ id: notificationId, status: "unknown" }],
      },
    });
    const reconciled = await runCommand(root, "notification-reconcile", {
      run_id: input.run_id,
      actor: owner,
      request_id: "cli-notification-reconcile",
      expected_revision: 2,
      payload: {
        notification_id: notificationId,
        reconciliation_id: "cli-reconcile-1",
        outcome: "failed",
        provider_receipt: {
          provider: "codex",
          evidence_ref: "codex-confirmed-absent",
        },
      },
    });
    expect(reconciled.exitCode).toBe(0);
    expect(reconciled.output).toMatchObject({
      ok: true,
      code: "APPLIED",
      result: { notification_id: notificationId, delivery_status: "failed" },
    });
    expect(existsSync(join(root, "runs", input.run_id, "ledger.json"))).toBe(
      true,
    );
  });
});
