import { test, expect } from "bun:test";
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
