import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { startTurnAndWait, websocketFrame } from "../lib/codex-rpc";
import {
  digest,
  executeInvocation,
  inspectInvocation,
  inspectRecoveryInvocation,
  readMarker,
  reconcileInvocation,
  registerInvocationResource,
} from "../lib/invocation-journal";
import type { RunIdentity } from "../lib/orchestration-identity";
import { withRunLifecycle } from "../lib/orchestration-lifecycle";
import { upgradeOrchestration } from "../lib/orchestration-upgrade";
import { fixtureRun, serviceFixture } from "./service-fixture";

const source: RunIdentity = {
  package_name: "@loomhelm/multi-task-flow",
  package_version: "0.3.0",
  build_id: "a".repeat(64),
  source_sha: "a".repeat(40),
  compatibility_line: "compat-v1",
  ledger_contract: 3,
  api_contract: 1,
  frontend_contract: 1,
  viewer_contract: 5,
};
const target = {
  ...source,
  package_version: "0.4.0",
  ledger_contract: 5,
  build_id: "b".repeat(64),
};
const previous = process.env.LOOMHELM_CALLER_IDENTITY;
afterEach(() => {
  if (previous === undefined) delete process.env.LOOMHELM_CALLER_IDENTITY;
  else process.env.LOOMHELM_CALLER_IDENTITY = previous;
});
function fixture() {
  const { state } = serviceFixture();
  const { store } = fixtureRun(state.paths.data, "invocation-run", 3);
  mkdirSync(join(store.runPath, "runtime"));
  writeFileSync(
    join(store.runPath, "runtime", "viewer-binding.json"),
    JSON.stringify({
      schema_version: 2,
      run_id: "invocation-run",
      ...source,
      revision: 0,
      request_id: "source",
      updated_at: new Date().toISOString(),
    }),
  );
  upgradeOrchestration(store, target, target, {});
  process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(target);
  return store;
}
function request(store: ReturnType<typeof fixture>) {
  const inspected = inspectInvocation(store)!;
  return {
    run_id: "invocation-run",
    actor: { role: "main", thread_id: store.read().control.owner_thread_id },
    request_id: "repair-1",
    expected_revision: store.read().revision,
    payload: {
      invocation_id: inspected.invocation_id,
      marker_digest: digest(readMarker(store)),
      evidence_refs: inspected.evidence_refs ?? [],
    },
  };
}
function removeStop(store: ReturnType<typeof fixture>) {
  const marker = readMarker(store)!;
  unlinkSync(join(store.runPath, "runtime", "invocations", marker.invocation_id, "stopped.json"));
  writeFileSync(
    join(store.runPath, "runtime", "call.json"),
    JSON.stringify({ ...marker, state: "running" }),
  );
}

test("success and error share finalization; joined receipts are immutable and inspection does not write", async () => {
  const store = fixture();
  const ledger = store.readRaw();
  await executeInvocation(store, "test", {}, async () => {
    registerInvocationResource("test-provider", { request_id: "native-1" }).end({
      status: "completed",
    });
  });
  expect(inspectInvocation(store)?.quiescent).toBe(true);
  const marker = readMarker(store)!;
  const dir = join(store.runPath, "runtime", "invocations", marker.invocation_id);
  const before = Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
  inspectRecoveryInvocation(store, {
    role: "main",
    thread_id: store.read().control.owner_thread_id,
  });
  expect(
    Object.fromEntries(
      readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
    ),
  ).toEqual(before);
  expect(store.readRaw()).toBe(ledger);
  await expect(
    executeInvocation(store, "error", {}, async () => {
      throw new Error("business failure");
    }),
  ).rejects.toThrow("business failure");
  expect(inspectInvocation(store)?.quiescent).toBe(true);
});

test("missing native terminal evidence remains blocked even when action and process have ended", async () => {
  const store = fixture();
  await executeInvocation(store, "unknown", {}, async () => {
    registerInvocationResource("test-provider", { request_id: "unjoined" }).unknown();
  });
  expect(inspectInvocation(store)?.quiescent).toBe(false);
  expect(
    inspectInvocation(store)?.missing_evidence.some((item) => item.startsWith("resource:")),
  ).toBe(true);
  expect(() => reconcileInvocation(store, request(store))).toThrow(
    "missing execution or native-call evidence",
  );
});

test("reconciliation recovers a missing stop publication without changing business data and rejects conflicting replay", async () => {
  const store = fixture();
  await executeInvocation(store, "test", {}, async () => {
    registerInvocationResource("test-provider", { request_id: "done" }).end({
      status: "completed",
    });
  });
  removeStop(store);
  const ledger = store.readRaw();
  const input = request(store);
  expect(() =>
    reconcileInvocation(store, { ...input, payload: { ...input.payload, evidence_refs: [] } }),
  ).toThrow("Evidence digests");
  const result = reconcileInvocation(store, input);
  expect(inspectInvocation(store)?.quiescent).toBe(true);
  expect(reconcileInvocation(store, input)).toEqual(result);
  expect(() => reconcileInvocation(store, { ...input, request_id: "different" })).toThrow(
    "Recovery request input",
  );
  expect(store.readRaw()).toBe(ledger);
});

test("legacy stopped projection and another run's journal never establish quiescence", async () => {
  const store = fixture();
  writeFileSync(
    join(store.runPath, "runtime", "call.json"),
    JSON.stringify({ invocation_id: randomUUID(), identity: target, state: "stopped" }),
  );
  expect(inspectInvocation(store)?.quiescent).toBe(false);
  expect(() => reconcileInvocation(store, request(store))).toThrow("no uniquely verifiable");
  await executeInvocation(store, "test", {}, async () => {});
  const marker = readMarker(store)!;
  const path = join(store.runPath, "runtime", "invocations", marker.invocation_id, "start.json");
  const start = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...start, run_id: "different-run" }));
  chmodSync(path, 0o600);
  expect(inspectInvocation(store)?.missing_evidence).toContain("invocation_start");
});

function snapshot(path: string): unknown {
  const stat = statSync(path, { bigint: true });
  return stat.isDirectory()
    ? {
        mtime: String(stat.mtimeNs),
        entries: Object.fromEntries(
          readdirSync(path)
            .sort()
            .map((name) => [name, snapshot(join(path, name))]),
        ),
      }
    : { mtime: String(stat.mtimeNs), digest: digest(readFileSync(path).toString("base64")) };
}
test("show/view/task-context remain readonly and responsive while an invocation owns the lifecycle lock", async () => {
  const store = fixture();
  await withRunLifecycle(store, () =>
    executeInvocation(store, "holding", {}, async () => {
      const ledger = store.read();
      const actor = { role: "main", thread_id: ledger.control.owner_thread_id };
      const task = ledger.tasks.find((task) => task.thread_id)!;
      const run = (command: string, input: unknown, identity = target) => {
        const child = Bun.spawnSync(
          [
            process.execPath,
            join(import.meta.dir, "../scripts/orchestrate.ts"),
            command,
            "--input",
            "-",
          ],
          {
            stdin: Buffer.from(JSON.stringify(input)),
            timeout: 2000,
            env: {
              ...process.env,
              TASK_ORCHESTRATION_DATA_ROOT: store.rootPath,
              LOOMHELM_CALLER_IDENTITY: JSON.stringify(identity),
            },
          },
        );
        return { code: child.exitCode, output: JSON.parse(child.stdout.toString()) };
      };
      const before = snapshot(store.runPath);
      for (const section of ["summary", "full", "summary"]) {
        const result = run("show", { run_id: "invocation-run", actor, section });
        expect(result.code).toBe(0);
        expect(result.output.invocation).toMatchObject({ state: "running", quiescent: false });
      }
      expect(run("view", { run_id: "invocation-run", actor }).code).toBe(0);
      expect(
        run("show", {
          run_id: "invocation-run",
          actor: { role: "task", thread_id: task.thread_id },
          section: "task-context",
          task_id: task.id,
        }).code,
      ).toBe(0);
      expect(
        run("show", { run_id: "invocation-run", actor: { role: "main", thread_id: "intruder" } })
          .output.code,
      ).toBe("ACTOR_MISMATCH");
      expect(
        run("show", { run_id: "invocation-run", actor }, { ...target, build_id: "c".repeat(64) })
          .output.code,
      ).toBe("RUN_VERSION_MISMATCH");
      expect(snapshot(store.runPath)).toEqual(before);
    }),
  );
});

test("turn receipt requires the acknowledged turn identity; a failed matching turn is stopped but not successful", async () => {
  const store = fixture();
  const socket = new EventEmitter() as Socket;
  socket.write = (() => {
    queueMicrotask(() =>
      socket.emit(
        "data",
        websocketFrame(JSON.stringify({ id: 3, result: { turn: { id: "expected" } } })),
      ),
    );
    queueMicrotask(() =>
      socket.emit(
        "data",
        websocketFrame(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread", turn: { id: "other", status: "completed" } },
          }),
        ),
      ),
    );
    setTimeout(
      () =>
        socket.emit(
          "data",
          websocketFrame(
            JSON.stringify({
              method: "turn/completed",
              params: { threadId: "thread", turn: { id: "expected", status: "failed" } },
            }),
          ),
        ),
      10,
    );
    return true;
  }) as Socket["write"];
  await expect(
    executeInvocation(store, "turn", {}, () =>
      startTurnAndWait(socket, { value: Buffer.alloc(0) }, { threadId: "thread" }, "thread"),
    ),
  ).rejects.toThrow("status failed");
  expect(inspectInvocation(store)?.quiescent).toBe(true);
});

test("turn acknowledgement followed by transport loss cannot establish stop evidence", async () => {
  const store = fixture();
  const socket = new EventEmitter() as Socket;
  socket.write = (() => {
    queueMicrotask(() => {
      socket.emit(
        "data",
        websocketFrame(JSON.stringify({ id: 3, result: { turn: { id: "expected" } } })),
      );
      socket.emit("close");
    });
    return true;
  }) as Socket["write"];
  await expect(
    executeInvocation(store, "turn", {}, () =>
      startTurnAndWait(socket, { value: Buffer.alloc(0) }, { threadId: "thread" }, "thread"),
    ),
  ).rejects.toThrow("before turn completion");
  expect(inspectInvocation(store)?.quiescent).toBe(false);
});

for (const contract of [3, 4]) {
  test(`historical contract ${contract} can reconcile proven execution before upgrading, while ordinary commands stay fenced`, async () => {
    const store = fixture();
    const historical = { ...source, ledger_contract: contract };
    const ledger = store.read();
    ledger.contract_version = contract;
    delete ledger.upgrade;
    if (contract === 3) delete ledger.runtime_identity;
    else ledger.runtime_identity = historical;
    writeFileSync(store.ledgerPath, JSON.stringify(ledger));
    const path = join(store.runPath, "runtime", "viewer-binding.json");
    const binding = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...binding, ...historical, schema_version: 2 }));
    process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(historical);
    await executeInvocation(store, "historical-fixture", {}, async () => {});
    removeStop(store);
    process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(target);
    const input = request(store);
    const invoke = (command: string, value: unknown) => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/orchestrate.ts"),
          command,
          "--input",
          "-",
        ],
        {
          stdin: Buffer.from(JSON.stringify(value)),
          timeout: 2000,
          env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: store.rootPath },
        },
      );
      return { code: child.exitCode, output: JSON.parse(child.stdout.toString()) };
    };
    const query = { run_id: input.run_id, actor: input.actor };
    expect(invoke("show", query).output.code).toBe("RUN_VERSION_MISMATCH");
    const inspected = invoke("invocation-inspect", query);
    expect(inspected.code).toBe(0);
    expect(inspected.output.source.ledger_contract).toBe(contract);
    expect(inspected.output.executor.ledger_contract).toBe(5);
    expect(invoke("invocation-reconcile", input).code).toBe(0);
    upgradeOrchestration(store, target, target);
    expect(store.read().contract_version).toBe(5);
    expect(inspectInvocation(store)?.quiescent).toBe(true);
  });
}

test("IPC ignores a foreign invocation id and acknowledges only after its own resources stop", async () => {
  const store = fixture();
  const id = randomUUID();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const messages: any[] = [];
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/invocation-worker.ts")],
    {
      stdin: Buffer.from(
        JSON.stringify({ root: store.rootPath, run_id: "invocation-run", request_id: "wait" }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOOMHELM_INVOCATION_ID: id },
      ipc: (value) => {
        messages.push(value);
        if (value.type === "ready") ready();
      },
    },
  );
  try {
    await started;
    child.send({ type: "stop", invocation_id: randomUUID() });
    await Bun.sleep(30);
    expect(inspectInvocation(store)?.state).toBe("running");
    expect(messages.some((value) => value.type === "stopped")).toBe(false);
    child.send({ type: "stop", invocation_id: id });
    expect(await child.exited).toBe(0);
    expect(inspectInvocation(store)?.quiescent).toBe(true);
    expect(messages).toContainEqual({ type: "stopped", invocation_id: id });
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
});

test("parent transport disconnect triggers the same stop path without a fabricated acknowledgement", async () => {
  const store = fixture();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/invocation-worker.ts")],
    {
      stdin: Buffer.from(
        JSON.stringify({
          root: store.rootPath,
          run_id: "invocation-run",
          request_id: "disconnect",
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOOMHELM_INVOCATION_ID: randomUUID() },
      ipc: (value) => {
        if (value.type === "ready") ready();
      },
    },
  );
  try {
    await started;
    child.disconnect();
    expect(await child.exited).toBe(0);
    expect(inspectInvocation(store)?.quiescent).toBe(true);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`${signal} preserves the distinction between cooperative stop and forced process death`, async () => {
    const store = fixture();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/invocation-worker.ts")],
      {
        stdin: Buffer.from(
          JSON.stringify({ root: store.rootPath, run_id: "invocation-run", request_id: signal }),
        ),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LOOMHELM_INVOCATION_ID: randomUUID() },
        ipc: (value) => {
          if (value.type === "ready") ready();
        },
      },
    );
    try {
      await started;
      child.kill(signal);
      await child.exited;
      expect(inspectInvocation(store)?.quiescent).toBe(signal === "SIGTERM");
      if (signal === "SIGKILL") expect(inspectInvocation(store)?.state).toBe("running");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });
}
