import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withExclusiveLockAsync } from "@loomhelm/runtime-core/modules/flow/storage";
import { callerIdentity, type RunIdentity, requireRunBinding } from "../lib/orchestration-identity";
import { requireQuiescentRun, withRunLifecycle } from "../lib/orchestration-lifecycle";
import { inspectOrchestration, upgradeOrchestration } from "../lib/orchestration-upgrade";
import { fixtureRun, serviceFixture } from "./service-fixture";

const source: RunIdentity = {
  package_name: "@loomhelm/multi-task-flow",
  package_version: "0.2.53",
  build_id: "a".repeat(64),
  source_sha: "a".repeat(40),
  compatibility_line: "compat-v1",
  ledger_contract: 3,
  api_contract: 1,
  frontend_contract: 1,
  viewer_contract: 5,
};
const target: RunIdentity = {
  ...source,
  package_version: "0.2.56",
  build_id: "b".repeat(64),
  source_sha: "b".repeat(40),
  ledger_contract: 4,
};
function fixture() {
  const { state } = serviceFixture();
  const { store } = fixtureRun(state.paths.data, "upgrade-run", 3);
  const runtime = join(store.runPath, "runtime");
  mkdirSync(runtime);
  writeFileSync(
    join(runtime, "viewer-binding.json"),
    JSON.stringify({
      schema_version: 1,
      run_id: "upgrade-run",
      ...source,
      revision: 0,
      request_id: "historical-binding",
      updated_at: new Date().toISOString(),
    }),
  );
  return store;
}
const dependencies = { withQuiescentRun: <T>(_ledger: any, action: () => T) => action() };

test("explicit migration preserves business state and is idempotent", () => {
  const store = fixture();
  const before = store.read();
  expect(inspectOrchestration(store, target).compatible).toBe(false);
  upgradeOrchestration(store, target, target, dependencies, true);
  expect(store.read().revision).toBe(before.revision);
  upgradeOrchestration(store, target, target, dependencies);
  const after = store.read();
  expect(after.contract_version).toBe(4);
  expect(after.upgrade.phase).toBe("completed");
  expect(after.operations).toEqual(before.operations);
  expect(after.tasks).toEqual(before.tasks);
  requireRunBinding(store.rootPath, "upgrade-run", after, target);
  expect(() => requireRunBinding(store.rootPath, "upgrade-run", after, source)).toThrow(
    "bound CLI",
  );
  expect((upgradeOrchestration(store, target, target, dependencies) as any).changed).toBe(false);
  expect(store.read().revision).toBe(after.revision);
});
for (const phase of ["prepared", "migrated", "binding_switched", "completed"]) {
  test(`resume after persisted ${phase} without changing target or business state`, () => {
    const store = fixture();
    expect(() =>
      upgradeOrchestration(store, target, target, {
        ...dependencies,
        afterStage(stage) {
          if (stage === phase) throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    const interrupted = store.read();
    if (phase !== "completed") {
      expect(() => requireRunBinding(store.rootPath, "upgrade-run", interrupted, target)).toThrow(
        "Resume",
      );
      const other = { ...target, package_version: "0.2.57" };
      expect(() => upgradeOrchestration(store, other, other, dependencies)).toThrow(
        "immutable target",
      );
    }
    upgradeOrchestration(store, target, target, dependencies);
    requireRunBinding(store.rootPath, "upgrade-run", store.read(), target);
    expect(store.read().upgrade.operation_id).toBe(interrupted.upgrade.operation_id);
  });
}
test("reject downgrade, executor mismatch, tampered backup, and absent historical identity", () => {
  const store = fixture();
  const older = { ...target, package_version: "0.2.52" };
  expect(() => upgradeOrchestration(store, older, older, dependencies)).toThrow("newer");
  expect(() => upgradeOrchestration(store, source, target, dependencies)).toThrow(
    "target package CLI",
  );
  expect(() =>
    upgradeOrchestration(store, target, target, {
      ...dependencies,
      afterStage(phase) {
        if (phase === "prepared") throw new Error("crash");
      },
    }),
  ).toThrow();
  const raw = store.read();
  writeFileSync(join(store.runPath, raw.upgrade.backup), "{}");
  expect(() => upgradeOrchestration(store, target, target, dependencies)).toThrow("backup");
});
test("unknown state needs a native-call stop receipt, never just a dead PID", () => {
  const store = fixture();
  const ledger = store.read();
  ledger.operations = [{ status: "unknown" }];
  expect(() => requireQuiescentRun(store, ledger, () => true)).toThrow("Historical");
  const path = join(store.runPath, "runtime", "call.json");
  writeFileSync(path, JSON.stringify({ state: "running", pid: 999999999 }));
  expect(() => requireQuiescentRun(store, ledger, () => true)).toThrow("safe-stop");
  writeFileSync(path, JSON.stringify({ state: "stopped" }));
  expect(requireQuiescentRun(store, ledger, () => true)).toBe(true);
});
test("diagnosis and dry-run leave both persistent objects unchanged", () => {
  const store = fixture();
  const path = join(store.runPath, "runtime", "viewer-binding.json");
  const before = store.readRaw(),
    binding = readFileSync(path, "utf8");
  inspectOrchestration(store, target);
  upgradeOrchestration(store, target, target, dependencies, true);
  expect(store.readRaw()).toBe(before);
  expect(readFileSync(path, "utf8")).toBe(binding);
});

function child(
  store: ReturnType<typeof fixture>,
  identity: RunIdentity,
  extra: Record<string, unknown> = {},
) {
  const process = Bun.spawn(
    [Bun.which("bun")!, join(import.meta.dir, "orchestration-upgrade-worker.ts")],
    {
      env: { ...globalThis.process.env, LOOMHELM_CALLER_IDENTITY: JSON.stringify(identity) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  process.stdin.write(JSON.stringify({ root: store.rootPath, run_id: "upgrade-run", ...extra }));
  process.stdin.end();
  return process;
}
function markFixtureQuiescent(store: ReturnType<typeof fixture>) {
  // This fixture never starts a native call. Retain its unknown business operations unchanged.
  writeFileSync(
    join(store.runPath, "runtime", "call.json"),
    JSON.stringify({ state: "stopped", identity: source }),
  );
}
for (const phase of [
  "directory_exchanged",
  "prepared",
  "migrated",
  "binding_switched",
  "completed",
]) {
  test(`isolated SIGKILL after ${phase} resumes through a fresh process`, async () => {
    const store = fixture();
    markFixtureQuiescent(store);
    const first = child(store, target, { kill_after: phase });
    expect(await first.exited).not.toBe(0);
    const operation = store.read().upgrade.operation_id;
    const next = child(store, target);
    const stderr = await new Response(next.stderr).text();
    expect({ exit: await next.exited, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(store.read().upgrade.operation_id).toBe(operation);
    expect(store.read().upgrade.phase).toBe("completed");
  });
}
test("concurrent upgrades commit one operation and no additional revisions", async () => {
  for (let iteration = 0; iteration < 8; iteration++) {
    const store = fixture();
    markFixtureQuiescent(store);
    const revision = store.read().revision;
    const a = child(store, target),
      b = child(store, target);
    const outputs = await Promise.all(
      [a, b].map(async (child) => ({
        exit: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(
      outputs.map((output) => output.exit),
      JSON.stringify(outputs),
    ).toEqual([0, 0]);
    expect(store.read().revision).toBe(revision + 4);
  }
});

test("native lock acquisition rejection retries only a replaced boundary before any action", async () => {
  for (const nativeError of [
    "secure_lock_parent_rejected",
    "secure_lock_file_changed",
    "secure_lock_open_failed",
  ]) {
    const store = fixture();
    let acquisitions = 0,
      actions = 0;
    const value = await withRunLifecycle(
      store,
      async () => ++actions,
      async (path, action, timeout) => {
        if (++acquisitions === 1) {
          upgradeOrchestration(store, target, target, dependencies);
          throw new Error(nativeError);
        }
        return withExclusiveLockAsync(path, action, timeout);
      },
    );
    expect({ value, actions, acquisitions }).toEqual({ value: 1, actions: 1, acquisitions: 2 });
    await expect(
      withRunLifecycle(
        store,
        async () => ++actions,
        async () => {
          throw new Error(nativeError);
        },
      ),
    ).rejects.toThrow(nativeError);
    await expect(
      withRunLifecycle(store, async () => {
        throw new Error("action failed");
      }),
    ).rejects.toThrow("action failed");
    expect(actions).toBe(1);
  }
});

test("CLI stop receipt never covers an outstanding desktop notification tool", () => {
  const store = fixture();
  markFixtureQuiescent(store);
  const ledger = store.read();
  ledger.notifications = [{ id: "notice", last_attempt_id: "attempt", delivery_status: "unknown" }];
  ledger.events = [
    {
      type: "notification_delivery_resolved",
      data: {
        notification_id: "notice",
        delivery_attempt_id: "attempt",
        provider: "codex-app-tools",
      },
    },
  ];
  expect(() => requireQuiescentRun(store, ledger, () => true)).toThrow("external notification");
  ledger.events[0].data.provider = "codex-app-server";
  expect(requireQuiescentRun(store, ledger, () => true)).toBe(true);
  ledger.events = [];
  expect(() => requireQuiescentRun(store, ledger, () => true)).toThrow("external notification");
  ledger.notifications[0].delivery_status = "sent";
  expect(requireQuiescentRun(store, ledger, () => true)).toBe(true);
});
test("upgrade waits for an actual native-call lifetime to exit without killing it", async () => {
  const store = fixture();
  markFixtureQuiescent(store);
  upgradeOrchestration(store, target, target, dependencies);
  const release = join(store.runPath, "release-fixture");
  const holder = child(store, target, { mode: "hold", release });
  const path = join(store.runPath, "runtime", "call.json");
  const deadline = Date.now() + 5_000;
  while (JSON.parse(readFileSync(path, "utf8")).state !== "running") {
    if (Date.now() > deadline) throw new Error("Fixture invocation did not acquire lifecycle lock");
    await Bun.sleep(10);
  }
  const newer = { ...target, package_version: "0.2.57", build_id: "c".repeat(64) };
  const waiting = child(store, newer);
  await Bun.sleep(75);
  expect(store.read().runtime_identity.package_version).toBe(target.package_version);
  writeFileSync(release, "release");
  expect(await holder.exited).toBe(0);
  expect(await waiting.exited).toBe(0);
  expect(store.read().runtime_identity.package_version).toBe(newer.package_version);
});

test("a crash before atomic publication leaves the original run and binding intact", () => {
  const store = fixture();
  const before = store.readRaw();
  const bindingPath = join(store.runPath, "runtime", "viewer-binding.json");
  const binding = readFileSync(bindingPath, "utf8");
  expect(() =>
    upgradeOrchestration(store, target, target, {
      ...dependencies,
      afterStage(phase) {
        if (phase === "candidate_synced") throw new Error("before exchange");
      },
    }),
  ).toThrow("before exchange");
  expect(store.readRaw()).toBe(before);
  expect(readFileSync(bindingPath, "utf8")).toBe(binding);
  upgradeOrchestration(store, target, target, dependencies);
  expect(store.read().upgrade.phase).toBe("completed");
});

test("an old lock waiter cannot read through the replaced directory boundary", async () => {
  const store = fixture();
  const ready = join(store.rootPath, "reader-ready");
  let reader: ReturnType<typeof child>;
  upgradeOrchestration(store, target, target, {
    ...dependencies,
    afterStage(phase) {
      if (phase !== "candidate_synced") return;
      reader = child(store, source, { mode: "stale-read", ready });
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("Reader did not capture its boundary");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    },
  });
  expect(await reader!.exited).toBe(0);
  const result = JSON.parse(await new Response(reader!.stdout).text());
  expect(
    result.code === "UNSAFE_PATH" || result.message === "secure_lock_parent_rejected",
    `Stale-reader outcome: ${JSON.stringify(result)}`,
  ).toBe(true);
});
