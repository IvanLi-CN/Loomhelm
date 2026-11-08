import { test, expect } from "bun:test";
import { apply } from "../scripts/engine";
import { rmSync } from "node:fs";
import { fixtureRun, serviceFixture } from "./service-fixture";
import { retryConversationArchive, retryConversationUnarchive, sweepConversationArchives, type ArchiveProvider } from "../scripts/conversation-archive";

function fixture() {
  const { root, state } = serviceFixture();
  const { store } = fixtureRun(state.paths.data);
  const ledger = store.read();
  const task = ledger.tasks.find((task: any) => task.thread_id)!;
  store.update(raw => {
    raw.tasks.find((item: any) => item.id === task.id).state = "completed";
    raw.operations = raw.operations.filter((op: any) => !["claimed", "unknown"].includes(op.status));
    raw.notifications = [];
    raw.follow_prs = [];
  });
  return { store, task, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const success: ArchiveProvider = {
  archive: async () => ({ outcome: "succeeded", evidence_ref: "fixture:archive" }),
  isArchived: async () => true,
};

test("archive persists unknown intent before provider call and closes without changing task state", async () => {
  const f = fixture();
  try {
    const result = await retryConversationArchive(f.store, f.task.id, {
      ...success,
      archive: async () => {
        expect(f.store.read().resources.find((r: any) => r.target === f.task.thread_id)?.status).toBe("archive_unknown");
        return { outcome: "succeeded", evidence_ref: "fixture:archive" };
      },
    });
    expect(result.status).toBe("closed");
    expect(f.store.read().tasks.find((t: any) => t.id === f.task.id).state).toBe("completed");
    let calls = 0;
    await retryConversationArchive(f.store, f.task.id, { ...success, archive: async () => { calls++; return { outcome: "succeeded", evidence_ref: "duplicate" }; } });
    expect(calls).toBe(0);
  } finally { f.cleanup(); }
});

test("definite failure can retry; unknown result reconciles without sending twice", async () => {
  const f = fixture();
  try {
    expect((await retryConversationArchive(f.store, f.task.id, { ...success, archive: async () => ({ outcome: "failed", evidence_ref: "fixture:failed", error: "rejected" }) })).status).toBe("archive_failed");
    expect((await retryConversationArchive(f.store, f.task.id, { ...success, archive: async () => ({ outcome: "unknown", evidence_ref: "fixture:lost", error: "connection lost" }) })).status).toBe("archive_unknown");
    let calls = 0;
    const api: ArchiveProvider = { archive: async () => { calls++; return { outcome: "succeeded", evidence_ref: "unexpected" }; }, isArchived: async () => false };
    expect((await retryConversationArchive(f.store, f.task.id, api)).status).toBe("archive_unknown");
    expect(calls).toBe(0);
    expect((await retryConversationArchive(f.store, f.task.id, { ...api, isArchived: async () => true })).status).toBe("closed");
    expect(calls).toBe(0);
  } finally { f.cleanup(); }
});

test("concurrent archive attempts cannot cross the provider boundary", async () => {
  const f = fixture();
  try {
    let finish!: (value: Awaited<ReturnType<ArchiveProvider["archive"]>>) => void;
    const first = retryConversationArchive(f.store, f.task.id, { ...success, archive: () => new Promise(resolve => { finish = resolve; }) });
    await expect(retryConversationArchive(f.store, f.task.id, success)).rejects.toThrow("already in progress");
    finish({ outcome: "succeeded", evidence_ref: "fixture:done" });
    expect((await first).status).toBe("closed");
  } finally { f.cleanup(); }
});

test("pending active turns can be retried after termination", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const api: ArchiveProvider = { ...success, archive: async () => { calls++; return calls === 1 ? { outcome: "deferred", evidence_ref: "fixture:active" } : { outcome: "succeeded", evidence_ref: "fixture:idle" }; } };
    expect((await retryConversationArchive(f.store, f.task.id, api)).status).toBe("pending");
    await retryConversationArchive(f.store, f.task.id, api);
    expect(calls).toBe(2);
    expect(f.store.read().resources.find((r: any) => r.target === f.task.thread_id).status).toBe("closed");
  } finally { f.cleanup(); }
});

test("unrelated in-flight operations do not block an eligible task", async () => {
  const f = fixture();
  try {
    f.store.update(raw => { raw.operations.push({ id: "other", kind: "dispatch", actor_id: "other", target_id: "other-task", status: "unknown", request: {}, expected_sha: null, receipt_fact_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as any); });
    expect((await retryConversationArchive(f.store, f.task.id, success)).status).toBe("closed");
  } finally { f.cleanup(); }
});

test("active tasks cannot archive their conversation", async () => {
  const f = fixture();
  try {
    f.store.update(raw => { raw.tasks.find((t: any) => t.id === f.task.id).state = "running"; });
    await expect(retryConversationArchive(f.store, f.task.id, { ...success, archive: async () => { throw new Error("must not call"); } })).rejects.toMatchObject({ code: "TASK_NOT_TERMINAL" });
  } finally { f.cleanup(); }
});


test("unarchive keeps the terminal task intact and manual restoration survives lifecycle sweeps", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const api: ArchiveProvider = { ...success, unarchive: async () => { calls++; return { outcome: "succeeded", evidence_ref: "fixture:unarchive" }; }, isUnarchived: async () => true };
    await retryConversationArchive(f.store, f.task.id, api);
    const resource = await retryConversationUnarchive(f.store, f.task.id, api);
    expect(resource.status).toBe("active");
    expect(resource.archive_policy).toBe("manual");
    await retryConversationUnarchive(f.store, f.task.id, api);
    expect(calls).toBe(1);
    await sweepConversationArchives(f.store, { ...api, archive: async () => { throw new Error("manual restore must not rearchive"); } });
    expect(f.store.read().resources.find((r: any) => r.id === resource.id).status).toBe("active");
    expect(f.store.read().tasks.find((t: any) => t.id === f.task.id).state).toBe("completed");
  } finally { f.cleanup(); }
});

test("unarchive failure retries; unknown delivery requires positive reconciliation and blocks opposite archive", async () => {
  const f = fixture();
  try {
    await retryConversationArchive(f.store, f.task.id, success);
    const api: ArchiveProvider = { ...success, unarchive: async () => ({ outcome: "failed", evidence_ref: "fixture:rejected" }), isUnarchived: async () => false };
    expect((await retryConversationUnarchive(f.store, f.task.id, api)).status).toBe("unarchive_failed");
    expect((await retryConversationUnarchive(f.store, f.task.id, { ...api, unarchive: async () => ({ outcome: "unknown", evidence_ref: "fixture:lost" }) })).status).toBe("unarchive_unknown");
    await expect(retryConversationArchive(f.store, f.task.id, api)).rejects.toMatchObject({ code: "ARCHIVE_STATE_CONFLICT" });
    const noResend = { ...api, unarchive: async () => { throw new Error("must only reconcile"); } };
    expect((await retryConversationUnarchive(f.store, f.task.id, noResend)).status).toBe("unarchive_unknown");
    expect((await retryConversationUnarchive(f.store, f.task.id, { ...noResend, isUnarchived: async () => true })).status).toBe("active");
  } finally { f.cleanup(); }
});

for (const claimed of [false, true]) {
  test(`archive atomically rejects a notification that wins before intent (claimed=${claimed})`, async () => {
    const f = fixture();
    try {
      const update = f.store.update.bind(f.store);
      let injected = false, archiveCalls = 0;
      f.store.update = ((callback: any) => {
        if (!injected) {
          injected = true;
          update(raw => {
            const sender = raw.tasks.find((task: any) => task.id === "deploy");
            const actor = { role: "task", thread_id: sender.thread_id };
            apply(raw, "task-update", { run_id: raw.orchestration_id, actor, request_id: "racing-notice", expected_revision: raw.revision, payload: { task_id: sender.id, state: "waiting", detail: "Notify before archive intent", notification: { mode: "deliver", recipient: { thread_id: f.task.thread_id } } } });
            if (claimed) apply(raw, "notification-deliver", { run_id: raw.orchestration_id, actor, request_id: "racing-claim", expected_revision: raw.revision, payload: { notification_id: raw.notifications[0].id, delivery_attempt_id: "racing-attempt", outcome: "unknown", provider_receipt: { provider: "codex-app-server", evidence_ref: "fixture:in-flight" } } });
          });
        }
        return update(callback);
      }) as typeof f.store.update;
      await expect(retryConversationArchive(f.store, f.task.id, { ...success, archive: async () => { archiveCalls++; return { outcome: "succeeded", evidence_ref: "must-not-archive" }; } })).rejects.toMatchObject({ code: "NOTIFICATIONS_PENDING" });
      expect(archiveCalls).toBe(0);
      const ledger = f.store.read();
      expect(ledger.tasks.find((task: any) => task.id === f.task.id).state).toBe("completed");
      expect(ledger.resources.find((resource: any) => resource.target === f.task.thread_id)?.status).not.toBe("archive_unknown");
      expect(ledger.notifications[0].delivery_status).toBe(claimed ? "unknown" : "pending");
    } finally { f.cleanup(); }
  });
}

test("integrated tasks stay ineligible in the view and manual archive path", async () => {
  const f = fixture();
  try {
    const { buildView } = await import("../scripts/view");
    f.store.update(raw => { raw.tasks.find((t: any) => t.id === f.task.id).state = "integrated"; });
    expect(buildView(f.store.read()).tasks.find(t => t.id === f.task.id)?.conversation_archive.eligible).toBe(false);
    await expect(retryConversationArchive(f.store, f.task.id, success)).rejects.toMatchObject({ code: "TASK_NOT_TERMINAL" });
  } finally { f.cleanup(); }
});

test("eligible terminal task projects first archive without a conversation resource", async () => {
  const f = fixture();
  try {
    const { buildView } = await import("../scripts/view");
    const task = buildView(f.store.read()).tasks.find(t => t.id === f.task.id)!;
    expect(task.conversation_resource).toBeNull();
    expect(task.conversation_archive).toEqual({ eligible: true, reason: null });
  } finally { f.cleanup(); }
});

test("reconciliation and restoration survive lost archive eligibility", async () => {
  const f = fixture();
  try {
    let sends = 0;
    await retryConversationArchive(f.store, f.task.id, { ...success, archive: async () => ({ outcome: "unknown", evidence_ref: "fixture:lost" }) });
    f.store.update(raw => { raw.tasks.find((t: any) => t.id === f.task.id).state = "running"; });
    const api: ArchiveProvider = { ...success, archive: async () => { throw Error("must not resend"); }, unarchive: async () => { sends++; return { outcome: "succeeded", evidence_ref: "fixture:restored" }; }, isUnarchived: async () => true };
    expect((await retryConversationArchive(f.store, f.task.id, api)).status).toBe("closed");
    expect((await retryConversationUnarchive(f.store, f.task.id, api)).status).toBe("active");
    expect(sends).toBe(1);
    expect(f.store.read().tasks.find((t: any) => t.id === f.task.id).state).toBe("running");
  } finally { f.cleanup(); }
});
