import { expect, test } from "bun:test";
import {
  initializationPrompt,
  initializationRecoveryPrompt,
  verifyInterruptedInitializationTurn,
  verifyRecoveryTurn,
} from "../lib/codex-cli-initialization";
import { apply } from "../lib/engine";
import {
  type RecoveryDependencies,
  type RecoveryHistory,
  recoverInitialization,
  verifyRecoveryHistory,
} from "../lib/initialization-recovery";
import { type RecoveryAttempt, recoveryDigest } from "../lib/initialization-recovery-attempt";
import type { LedgerStore } from "../lib/store";
import { approve, fixture, head, request } from "./engine-fixtures";

const original = (role: "Task Agent" | "Delivery Agent" = "Task Agent") => ({
  id: "original-turn",
  status: "interrupted",
  itemsView: "full",
  items: [{ type: "userMessage", content: [{ type: "text", text: initializationPrompt(role) }] }],
});
function setup() {
  const ledger = fixture();
  approve(ledger);
  apply(ledger, "dispatch-claim", request(ledger, "claim", { task_id: "a", operation_id: "op" }));
  apply(
    ledger,
    "dispatch-bind-request",
    request(ledger, "bind", {
      operation_id: "op",
      native_request_id: "native",
      creation_parameters: {
        title: "task",
        prompt: "formal business prompt MUST NOT be sent",
        cwd: "/source",
        transport: "codex-exec",
        execution_profile: ledger.config.execution_profile,
      },
    }),
  );
  apply(
    ledger,
    "dispatch-progress",
    request(ledger, "observed", {
      operation_id: "op",
      native_request_id: "native",
      thread_id: "thread",
    }),
  );
  const store = {
    read: () => structuredClone(ledger),
    update: (fn: (raw: typeof ledger) => unknown) => fn(ledger),
  } as unknown as LedgerStore;
  let history: RecoveryHistory = {
    thread: {
      id: "thread",
      cwd: "/owned",
      model: ledger.config.execution_profile!.model,
      reasoningEffort: ledger.config.execution_profile!.thinking,
      status: { type: "notLoaded" },
    },
    turns: [original()],
  };
  let starts = 0;
  let writerCalls = 0;
  const dependencies: RecoveryDependencies = {
    verify: () => head,
    read: async () => structuredClone(history),
    writer: async (attempt, action, permissions) => {
      writerCalls++;
      if (!attempt.permissions?.original)
        permissions.capture({
          sandboxPolicy: { type: "dangerFullAccess" },
          approvalPolicy: "never",
          approvalsReviewer: "user",
        });
      return await action(
        async (method, params) => {
          if (method === "thread/read") return { thread: history.thread };
          if (method === "thread/turns/list")
            return { data: structuredClone(history.turns), nextCursor: null };
          if (method === "turn/start") {
            starts++;
            expect(ledger.operations[0].request.initialization_recovery).toBeDefined();
            expect(JSON.stringify(params)).not.toContain("formal business prompt");
            const text = (params.input as any[])[0].text;
            expect(recoveryDigest(text)).toBe(attempt.prompt_digest);
            const turn = {
              id: "recovered-turn",
              status: "completed",
              itemsView: "full",
              items: [
                { type: "userMessage", content: [{ type: "text", text }] },
                { type: "agentMessage", text: "READY" },
              ],
            };
            history.turns.push(turn);
            return { turn };
          }
          throw new Error(`unexpected ${method}`);
        },
        async () => {},
        () => {},
      );
    },
  };
  return {
    ledger,
    store,
    dependencies,
    counts: () => ({ starts, writerCalls }),
    getHistory: () => history,
    setHistory: (value: RecoveryHistory) => {
      history = value;
    },
  };
}

test("prompt-only interrupted handshake is recoverable for both roles; failed, active and work items are rejected", () => {
  for (const role of ["Task Agent", "Delivery Agent"] as const) {
    expect(() => verifyInterruptedInitializationTurn(original(role), role)).not.toThrow();
    for (const status of ["failed", "inProgress", "completed"])
      expect(() =>
        verifyInterruptedInitializationTurn({ ...original(role), status }, role),
      ).toThrow("not interrupted");
    for (const item of [
      { type: "commandExecution" },
      { type: "mcpToolCall" },
      { type: "fileChange" },
      { type: "unknown" },
      null,
    ])
      expect(() =>
        verifyInterruptedInitializationTurn(
          { ...original(role), items: [...original(role).items, item] },
          role,
        ),
      ).toThrow();
  }
});
test("recovery response must be exact READY and bound to the fixed prompt", () => {
  const prompt = initializationRecoveryPrompt("Task Agent", "attempt", "original");
  for (const text of ["", "done", "READY then execute"])
    expect(() =>
      verifyRecoveryTurn(
        {
          status: "completed",
          items: [
            { type: "userMessage", text: prompt },
            { type: "agentMessage", text },
          ],
        },
        prompt,
      ),
    ).toThrow();
});
test("durable intent precedes native start; a retry only reads the registered chain", async () => {
  const s = setup();
  const recovered = await recoverInitialization(
    s.store,
    request(s.ledger, "recover", {}),
    "op",
    true,
    s.dependencies,
  );
  expect(s.counts()).toEqual({ starts: 1, writerCalls: 1 });
  expect(recovered.reconciliation.initialization_turn_id).toBe("original-turn");
  expect(s.ledger.operations[0].request.initialization_recovery).toMatchObject({
    recovery_turn_id: "recovered-turn",
    native_request_id: "native",
  });
  const replay = await recoverInitialization(
    s.store,
    request(s.ledger, "retry", {}),
    "op",
    true,
    s.dependencies,
  );
  expect(replay.reconciliation.initialization_recovery).toEqual(
    recovered.reconciliation.initialization_recovery,
  );
  expect(s.counts()).toEqual({ starts: 1, writerCalls: 2 });
});
test("a stopped claim before native send cannot silently retry", async () => {
  const s = setup();
  const writer = s.dependencies.writer;
  s.dependencies.writer = async () => {
    throw new Error("process stopped");
  };
  await expect(
    recoverInitialization(s.store, request(s.ledger, "recover", {}), "op", true, s.dependencies),
  ).rejects.toThrow("stopped");
  expect(s.ledger.operations[0].request.initialization_recovery).toBeDefined();
  s.dependencies.writer = writer;
  await expect(
    recoverInitialization(s.store, request(s.ledger, "retry", {}), "op", true, s.dependencies),
  ).rejects.toThrow("unexpected turn");
  expect(s.ledger.operations[0].status).toBe("unknown");
});
test("intervening business turn is caught after acquiring the native writer lock", async () => {
  const s = setup();
  const writer = s.dependencies.writer;
  s.dependencies.writer = async (attempt, action, permissions) => {
    s.getHistory().turns.push({
      id: "business",
      status: "completed",
      itemsView: "full",
      items: [],
    });
    return writer(attempt, action, permissions);
  };
  await expect(
    recoverInitialization(s.store, request(s.ledger, "recover", {}), "op", true, s.dependencies),
  ).rejects.toThrow("unexpected turn");
  expect(s.counts().starts).toBe(0);
});
test("revision conflict before claim creates no native side effect", async () => {
  const s = setup();
  const read = s.dependencies.read;
  s.dependencies.read = async (id) => {
    const result = await read(id);
    s.ledger.revision++;
    return result;
  };
  await expect(
    recoverInitialization(s.store, request(s.ledger, "recover", {}), "op", true, s.dependencies),
  ).rejects.toThrow("version changed");
  expect(s.counts().writerCalls).toBe(0);
});
test("history validation rejects profile, ownership HEAD, active state, turn and original item changes", async () => {
  const s = setup();
  await recoverInitialization(
    s.store,
    request(s.ledger, "recover", {}),
    "op",
    true,
    s.dependencies,
  );
  const attempt = s.ledger.operations[0].request.initialization_recovery as RecoveryAttempt;
  for (const mutate of [
    (h: RecoveryHistory) => {
      h.thread.model = "other";
    },
    (h: RecoveryHistory) => {
      h.thread.cwd = "/other";
    },
    (h: RecoveryHistory) => {
      h.thread.status = { type: "active" };
    },
    (h: RecoveryHistory) => {
      h.turns[0].items = [];
    },
    (h: RecoveryHistory) => {
      h.turns[1].id = "unregistered";
    },
    (h: RecoveryHistory) => {
      h.turns.push(h.turns[1]);
    },
  ]) {
    const history = structuredClone(s.getHistory());
    mutate(history);
    expect(() =>
      verifyRecoveryHistory(history, attempt, "/source", "Task Agent", true, s.dependencies.verify),
    ).toThrow();
  }
  expect(() =>
    verifyRecoveryHistory(s.getHistory(), attempt, "/source", "Task Agent", true, () =>
      "c".repeat(40),
    ),
  ).toThrow("HEAD changed");
});
test("engine rejects a second claim, mismatched turn identity and unregistered resolution; valid chain binds once", async () => {
  const s = setup();
  const recovered = await recoverInitialization(
    s.store,
    request(s.ledger, "recover", {}),
    "op",
    true,
    s.dependencies,
  );
  const attempt = s.ledger.operations[0].request.initialization_recovery as RecoveryAttempt;
  const { recovery_turn_id: ignoredTurn, ...claimedAttempt } = attempt;
  expect(() =>
    apply(
      s.ledger,
      "initialization-recovery-claim",
      request(s.ledger, "again", { operation_id: "op", attempt: claimedAttempt }),
    ),
  ).toThrow("already claimed");
  expect(() =>
    apply(
      s.ledger,
      "initialization-recovery-observe",
      request(s.ledger, "wrong", {
        operation_id: "op",
        attempt_id: attempt.attempt_id,
        turn_id: "other",
      }),
    ),
  ).toThrow("identity changed");
  const payload = {
    operation_id: "op",
    outcome: "succeeded",
    thread_id: "thread",
    native_evidence: {
      source: "multi-task-flow-reconcile",
      native_tool_name: "codex exec",
      operation_id: "op",
      native_request_id: "native",
      ...recovered.reconciliation,
    },
  };
  const wrong = structuredClone(payload);
  wrong.native_evidence.initialization_recovery.recovery_turn_id = "other";
  expect(() =>
    apply(s.ledger, "dispatch-resolve", request(s.ledger, "bad-resolution", wrong)),
  ).toThrow("registered");
  const req = request(s.ledger, "resolve", payload);
  apply(s.ledger, "dispatch-resolve", req);
  expect(s.ledger.operations[0].status).toBe("succeeded");
  expect(s.ledger.tasks[0].thread_id).toBe("thread");
  const notifications = s.ledger.notifications.length;
  expect((apply(s.ledger, "dispatch-resolve", req) as any).code).toBe("REPLAYED");
  expect(s.ledger.notifications.length).toBe(notifications);
});

test("unsupported native capability is rejected before durable intent", async () => {
  const s = setup();
  s.dependencies.capability = () => {
    throw new Error("capability unavailable");
  };
  await expect(
    recoverInitialization(
      s.store,
      request(s.ledger, "unsupported", {}),
      "op",
      true,
      s.dependencies,
    ),
  ).rejects.toThrow("capability unavailable");
  expect(s.ledger.operations[0].request.initialization_recovery).toBeUndefined();
  expect(s.counts().writerCalls).toBe(0);
});
test("native completion lost before turn observation is reconciled by exact registered prompt without resending", async () => {
  const s = setup();
  const writer = s.dependencies.writer;
  s.dependencies.writer = async (attempt, action, permissions) =>
    writer(
      attempt,
      async (native, restore, confirmTerminalTurn) => {
        const wrapped = async (method: string, params: Record<string, unknown>) => {
          const result = await native(method, params);
          if (method === "turn/start") throw new Error("lost native start response");
          return result;
        };
        return action(wrapped, restore, confirmTerminalTurn);
      },
      permissions,
    );
  await expect(
    recoverInitialization(s.store, request(s.ledger, "lost", {}), "op", true, s.dependencies),
  ).rejects.toThrow("lost native");
  expect(
    (s.ledger.operations[0].request.initialization_recovery as RecoveryAttempt).recovery_turn_id,
  ).toBeUndefined();
  const recovered = await recoverInitialization(
    s.store,
    request(s.ledger, "reconcile", {}),
    "op",
    false,
    s.dependencies,
  );
  expect(recovered.reconciliation.initialization_recovery.recovery_turn_id).toBe("recovered-turn");
  expect(s.counts()).toEqual({ starts: 1, writerCalls: 2 });
});
test("concurrent ledger writes after native start are not silently adopted into the caller revision", async () => {
  const s = setup();
  const writer = s.dependencies.writer;
  s.dependencies.writer = async (attempt, action, permissions) => {
    const result = await writer(attempt, action, permissions);
    s.ledger.revision++;
    return result;
  };
  const recovered = await recoverInitialization(
    s.store,
    request(s.ledger, "recover", {}),
    "op",
    true,
    s.dependencies,
  );
  expect(recovered.revision).toBe(s.ledger.revision - 1);
});

test("native writer remains held through final verification and synchronous resolution on start and reentry", async () => {
  for (const reentry of [false, true]) {
    const s = setup();
    if (reentry)
      await recoverInitialization(
        s.store,
        request(s.ledger, "prime", {}),
        "op",
        true,
        s.dependencies,
      );
    let held = false;
    let committed = false;
    const writer = s.dependencies.writer;
    s.dependencies.writer = async (attempt, action, permissions) => {
      held = true;
      try {
        return await writer(attempt, action, permissions);
      } finally {
        held = false;
      }
    };
    const req = request(s.ledger, "resolve-locked", {});
    await recoverInitialization(s.store, req, "op", !reentry, s.dependencies, (recovered) => {
      expect(held).toBe(true);
      apply(s.ledger, "dispatch-resolve", {
        ...req,
        expected_revision: recovered.revision,
        payload: {
          operation_id: "op",
          outcome: "succeeded",
          thread_id: "thread",
          native_evidence: {
            source: "multi-task-flow-reconcile",
            native_tool_name: "codex exec",
            operation_id: "op",
            native_request_id: "native",
            ...recovered.reconciliation,
          },
        },
      });
      committed = true;
    });
    expect(held).toBe(false);
    expect(committed).toBe(true);
    expect(s.ledger.operations[0].status).toBe("succeeded");
    expect(s.ledger.notifications).toHaveLength(1);
    expect(s.counts().starts).toBe(1);
  }
});

test("original permission snapshot is immutable and restoration failure blocks resolution", async () => {
  const s = setup();
  const writer = s.dependencies.writer;
  let committed = false;
  s.dependencies.writer = async (attempt, action, permissions) =>
    writer(
      attempt,
      (native, _restore, confirmTerminalTurn) =>
        action(
          native,
          async () => {
            throw new Error("restore failed");
          },
          confirmTerminalTurn,
        ),
      permissions,
    );
  await expect(
    recoverInitialization(
      s.store,
      request(s.ledger, "restore-failure", {}),
      "op",
      true,
      s.dependencies,
      () => {
        committed = true;
      },
    ),
  ).rejects.toThrow("restore failed");
  expect(committed).toBe(false);
  expect(s.ledger.operations[0].status).toBe("unknown");
  expect(s.ledger.notifications).toHaveLength(0);
  const attempt = s.ledger.operations[0].request.initialization_recovery as RecoveryAttempt;
  expect(() =>
    apply(
      s.ledger,
      "initialization-recovery-permissions",
      request(s.ledger, "overwrite", {
        operation_id: "op",
        attempt_id: attempt.attempt_id,
        original: {
          sandboxPolicy: { type: "workspaceWrite" },
          approvalPolicy: "never",
          approvalsReviewer: "user",
        },
      }),
    ),
  ).toThrow("permissions changed");
  s.dependencies.writer = writer;
  await recoverInitialization(
    s.store,
    request(s.ledger, "restore-reentry", {}),
    "op",
    false,
    s.dependencies,
  );
  expect(s.counts().starts).toBe(1);
});
