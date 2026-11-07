import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import { apply } from "../scripts/engine";
import { LedgerStore } from "../scripts/store";
import { deliverClaimedNotification, reconcileNotification, prepareNativeNotification } from "../scripts/notification-delivery";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mtf-delivery-")));
  const ledger = createDemoLedger();
  ledger.contract_version = 2;
  const task = ledger.tasks.find(t => t.id === "deploy")!;
  const actor = { role: "task" as const, thread_id: task.thread_id! };
  apply(ledger, "task-update", { run_id: ledger.orchestration_id, actor, request_id: "test-notice", expected_revision: ledger.revision, payload: { task_id: task.id, state: "waiting", detail: "Test notification", notification: { mode: "deliver", recipient: "owner" } } });
  const store = new LedgerStore(root, ledger.orchestration_id);
  store.create(ledger);
  const id = ledger.notifications[0]!.id;
  const parsed = { run_id: ledger.orchestration_id, actor, request_id: "send-notice", expected_revision: ledger.revision, payload: { notification_id: id } };
  return { root, store, id, parsed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const sent = { outcome: "sent" as const, provider_receipt: { provider: "codex-app-server" as const, evidence_ref: "test-provider:accepted", message_id: "test-turn" } };

test("explicit notification-send rejects a stale revision before persisting or delivering", async () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.store.read());
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/orchestrate.ts"), "notification-send", "--input", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: f.root, LOOMHELM_CODEX_APP_SERVER_SOCKET: join(f.root, "absent.sock") } });
    child.stdin.write(JSON.stringify({ ...f.parsed, expected_revision: f.parsed.expected_revision - 1 })); child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0); expect(output).toContain("REVISION_CONFLICT");
    expect(JSON.stringify(f.store.read())).toBe(before);
  } finally { f.cleanup(); }
});

test("a durable claim excludes concurrent senders and replay after acceptance", async () => {
  const f = fixture();
  try {
    let resolveSend!: (value: typeof sent) => void, calls = 0;
    const first = deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async input => {
      calls++;
      const current = f.store.read().notifications[0];
      expect(current.delivery_status).toBe("unknown");
      expect(current.last_attempt_id).toBe(input.request_id);
      return new Promise(resolve => { resolveSend = resolve; });
    });
    const blocked = await deliverClaimedNotification(new LedgerStore(f.root, f.parsed.run_id), f.parsed, f.id, "Notice", async () => { calls++; return sent; });
    expect((blocked as any).next_action).toBe("notification-reconcile");
    resolveSend(sent); await first;
    const replay = await deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return sent; });
    expect((replay as any).replayed).toBe(true); expect(calls).toBe(1);
    expect(f.store.read().notifications[0].delivery_status).toBe("sent");
  } finally { f.cleanup(); }
});

test("an unexpected adapter exit leaves unknown and prohibits a new send", async () => {
  const f = fixture();
  try {
    await expect(deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { throw new Error("provider accepted then sender failed"); })).rejects.toThrow("remains unknown");
    let calls = 0;
    await deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return sent; });
    expect(calls).toBe(0); expect(f.store.read().notifications[0].attempts).toBe(1);
  } finally { f.cleanup(); }
});

test("SIGKILL after the provider boundary preserves the claim across restart", async () => {
  const f = fixture();
  try {
    const script = `import {LedgerStore} from ${JSON.stringify(resolve(import.meta.dir, "../scripts/store.ts"))}; import {deliverClaimedNotification} from ${JSON.stringify(resolve(import.meta.dir, "../scripts/notification-delivery.ts"))}; await deliverClaimedNotification(new LedgerStore(${JSON.stringify(f.root)},${JSON.stringify(f.parsed.run_id)}),${JSON.stringify(f.parsed)},${JSON.stringify(f.id)},"Notice",async()=>{process.kill(process.pid,"SIGKILL"); return ${JSON.stringify(sent)};});`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    const recovered = new LedgerStore(f.root, f.parsed.run_id);
    expect(recovered.read().notifications[0].delivery_status).toBe("unknown");
    let calls = 0;
    await deliverClaimedNotification(recovered, f.parsed, f.id, "Notice", async () => { calls++; return sent; });
    expect(calls).toBe(0);
    reconcileNotification(recovered, { ...f.parsed, request_id: "post-crash-query", expected_revision: recovered.read().revision, payload: { notification_id: f.id, reconciliation_id: "post-crash-query", outcome: "failed", provider_receipt: { provider: "test-provider", evidence_ref: "test-query:no-delivery" } } });
    await deliverClaimedNotification(recovered, { ...f.parsed, request_id: "post-crash-retry", expected_revision: recovered.read().revision }, f.id, "Notice", async () => { calls++; return sent; });
    expect(calls).toBe(1);
  } finally { f.cleanup(); }
});

test("sender authorization fails before any provider side effect", async () => {
  const f = fixture();
  try {
    let calls = 0;
    await expect(deliverClaimedNotification(f.store, { ...f.parsed, actor: { role: "main", thread_id: "unbound" } }, f.id, "Notice", async () => { calls++; return sent; })).rejects.toThrow();
    expect(calls).toBe(0); expect(f.store.read().notifications[0].delivery_status).toBe("pending");
  } finally { f.cleanup(); }
});

test("definite pre-delivery failure permits a new attempt without schema conversion", async () => {
  const f = fixture();
  try {
    await deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => ({ outcome: "failed", provider_receipt: { provider: "codex-app-server", evidence_ref: "test-provider:unavailable" }, error: "No connection" }));
    expect(f.store.read().notifications[0].delivery_status).toBe("failed");
    await deliverClaimedNotification(f.store, { ...f.parsed, request_id: "retry-notice", expected_revision: f.store.read().revision }, f.id, "Notice", async () => sent);
    const ledger = f.store.read();
    expect(ledger.notifications[0].attempts).toBe(2);
    expect(ledger.schema_version).toBe(2); expect(ledger.contract_version).toBe(2);
  } finally { f.cleanup(); }
});

test("active sender excludes reconciliation and a second provider call", async () => {
  const f = fixture();
  try {
    let resolveSend!: (value: typeof sent) => void, calls = 0;
    const first = deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return new Promise(resolve => { resolveSend = resolve; }); });
    const reconciliation = { ...f.parsed, request_id: "explicit-resolution", expected_revision: f.store.read().revision, payload: { notification_id: f.id, reconciliation_id: "explicit-resolution", outcome: "failed", provider_receipt: { provider: "test-provider", evidence_ref: "test-query:no-delivery" } } };
    expect(() => reconcileNotification(new LedgerStore(f.root, f.parsed.run_id), reconciliation)).toThrow("active sender");
    await expect(deliverClaimedNotification(f.store, { ...f.parsed, request_id: "second-send", expected_revision: f.store.read().revision }, f.id, "Notice", async () => { calls++; return sent; })).rejects.toThrow("active sender");
    // The public command must use the same guard, including across processes.
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/orchestrate.ts"), "notification-reconcile", "--input", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: f.root } });
    child.stdin.write(JSON.stringify(reconciliation)); child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0); expect(output).toContain("NOTIFICATION_IN_FLIGHT");
    resolveSend(sent); await first;
    expect(calls).toBe(1); expect(f.store.read().notifications[0].attempts).toBe(1);
  } finally { f.cleanup(); }
});

test("failed request replays its immutable result with original or fresh revision after a later successful retry", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const failure = await deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return { outcome: "failed", provider_receipt: { provider: "codex-app-server", evidence_ref: "test-provider:unavailable" }, error: "No connection" }; });
    for (const expected_revision of [f.parsed.expected_revision, f.store.read().revision]) {
      const replay: any = await deliverClaimedNotification(f.store, { ...f.parsed, expected_revision }, f.id, "Notice", async () => { calls++; return sent; });
      expect(replay).toEqual({ ...(failure as any), replayed: true });
    }
    await deliverClaimedNotification(f.store, { ...f.parsed, request_id: "retry", expected_revision: f.store.read().revision }, f.id, "Notice", async () => { calls++; return sent; });
    const replay: any = await deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return sent; });
    expect(replay).toEqual({ ...(failure as any), replayed: true });
    expect(calls).toBe(2); expect(f.store.read().notifications[0].attempts).toBe(2);
    await expect(deliverClaimedNotification(f.store, f.parsed, "different-notice", "Notice", async () => { calls++; return sent; })).rejects.toThrow("different content");
    expect(calls).toBe(2);
  } finally { f.cleanup(); }
});

test("atomic claim rejects an intervening write after the caller's read", async () => {
  const f = fixture();
  try {
    const callerSnapshot = f.store.read();
    f.store.update(raw => apply(raw, "task-update", { ...f.parsed, request_id: "unrelated-write", expected_revision: raw.revision, payload: { task_id: "deploy", state: "running", detail: "Concurrent update" } }));
    const before = JSON.stringify(f.store.read()); let calls = 0;
    await expect(deliverClaimedNotification(f.store, { ...f.parsed, expected_revision: callerSnapshot.revision }, f.id, "Notice", async () => { calls++; return sent; })).rejects.toThrow("version changed");
    expect(calls).toBe(0); expect(JSON.stringify(f.store.read())).toBe(before);
  } finally { f.cleanup(); }
});


test("native delivery claims once without a provider process and requires the matching platform receipt", () => {
  const f = fixture();
  try {
    const claim: any = prepareNativeNotification(f.store, f.parsed, f.id, "Native task");
    expect(claim.should_send).toBe(true);
    expect(claim.tool_request.prompt).toBe("Native task");
    expect(f.store.read().notifications[0].delivery_status).toBe("unknown");
    const replay: any = prepareNativeNotification(f.store, f.parsed, f.id, "Native task");
    expect(replay.should_send).toBe(false); expect(replay.tool_request).toBeNull();
    expect(() => prepareNativeNotification(f.store, f.parsed, f.id, "Changed task")).toThrow("different content");
    expect(() => prepareNativeNotification(f.store, { ...f.parsed, request_id: "another-sender", expected_revision: f.store.read().revision }, f.id, "Native task")).toThrow("reconciled");
    const receipt = { ...f.parsed, request_id: "native-receipt", expected_revision: f.store.read().revision,
      payload: { notification_id: f.id, reconciliation_id: "native-result", outcome: "sent", provider_receipt: { provider: "codex-app-tools", evidence_ref: "native:accepted", message_id: "accepted-message" } } };
    expect(() => reconcileNotification(f.store, receipt)).toThrow("active delivery attempt");
    expect(() => reconcileNotification(f.store, { ...receipt, payload: { ...receipt.payload, delivery_attempt_id: claim.delivery_attempt_id,
      provider_receipt: { ...receipt.payload.provider_receipt, provider: "codex-app-server" } } })).toThrow("matching platform provider");
    reconcileNotification(f.store, { ...receipt, payload: { ...receipt.payload, delivery_attempt_id: claim.delivery_attempt_id } });
    expect(f.store.read().notifications[0].delivery_status).toBe("sent");
    expect(f.store.read().notifications[0].ack_status).toBe("unacknowledged");
    expect((prepareNativeNotification(f.store, f.parsed, f.id, "Native task") as any).should_send).toBe(false);
  } finally { f.cleanup(); }
});


test("bound main can claim a task notification for native forwarding without impersonating its sender", () => {
  const f = fixture();
  try {
    const actor = { role: "main" as const, thread_id: f.store.read().control.owner_thread_id };
    const result: any = prepareNativeNotification(f.store, { ...f.parsed, actor }, f.id, "Forward task event");
    expect(result.should_send).toBe(true);
    expect(result.tool_request.threadId).toBe(actor.thread_id);
  } finally { f.cleanup(); }
});

test("native compatibility commands cannot report delivery without a persistent attempt and receipt", () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.store.read());
    const actor = { role: "main" as const, thread_id: f.store.read().control.owner_thread_id };
    for (const command of ["notification-deliver", "notification-sent"]) {
      expect(() => f.store.update(raw => apply(raw, command, { ...f.parsed, actor, request_id: command,
        expected_revision: raw.revision, payload: { notification_id: f.id, delivery_attempt_id: "bypass", outcome: "sent",
          provider_receipt: { provider: "codex-app-tools", evidence_ref: "unclaimed:sent" } } }))).toThrow("Native delivery");
      expect(JSON.stringify(f.store.read())).toBe(before);
    }
    const claim: any = prepareNativeNotification(f.store, { ...f.parsed, actor }, f.id, "Forward once");
    expect(claim.should_send).toBe(true);
    expect(f.store.read().notifications[0].delivery_status).toBe("unknown");
  } finally { f.cleanup(); }
});

test("a legacy unknown attempt cannot be reinterpreted as a native platform receipt", async () => {
  const f = fixture();
  try {
    await deliverClaimedNotification(f.store, f.parsed, f.id, "Legacy task", async () => ({
      outcome: "unknown", provider_receipt: { provider: "codex-app-server", evidence_ref: "legacy:uncertain" },
    }));
    const before = JSON.stringify(f.store.read());
    for (const identity of [{}, { delivery_attempt_id: f.store.read().notifications[0].last_attempt_id }]) {
      expect(() => reconcileNotification(f.store, { ...f.parsed, request_id: `cross-provider-${Object.keys(identity).length}`,
        expected_revision: f.store.read().revision, payload: { notification_id: f.id, reconciliation_id: "cross-provider",
          outcome: "sent", ...identity, provider_receipt: { provider: "codex-app-tools", evidence_ref: "native:unmatched" } } })).toThrow("matching platform provider");
      expect(JSON.stringify(f.store.read())).toBe(before);
    }
    reconcileNotification(f.store, { ...f.parsed, request_id: "legacy-reconcile", expected_revision: f.store.read().revision,
      payload: { notification_id: f.id, reconciliation_id: "legacy-query", outcome: "failed",
        provider_receipt: { provider: "codex-app-server", evidence_ref: "legacy:no-delivery" } } });
    expect(f.store.read().notifications[0].delivery_status).toBe("failed");
  } finally { f.cleanup(); }
});

for (const status of ["closed", "archive_unknown", "unarchive_unknown", "unarchive_failed"] as const) {
  test(`native notification claim respects ${status} and resumes only after manual restore`, () => {
    const f = fixture();
    try {
      f.store.update(raw => { raw.resources.push({ id: "native-recipient-archive", kind: "conversation", target: raw.notifications[0].recipient_thread_id, status, evidence_ref: "fixture:archive" }); });
      const before = JSON.stringify(f.store.read());
      expect(() => prepareNativeNotification(f.store, f.parsed, f.id, "Native notice")).toThrow("请先手动取消归档");
      expect(JSON.stringify(f.store.read())).toBe(before);
      f.store.update(raw => { raw.resources.find((r: any) => r.id === "native-recipient-archive").status = "active"; });
      const claim: any = prepareNativeNotification(f.store, { ...f.parsed, expected_revision: f.store.read().revision }, f.id, "Native notice");
      expect(claim.should_send).toBe(true);
      expect(f.store.read().notifications[0].delivery_status).toBe("unknown");
    } finally { f.cleanup(); }
  });
  test(`notification ${status} recipient is rejected before provider delivery and after manual restore can send`, async () => {
    const f = fixture();
    try {
      f.store.update(raw => { raw.resources.push({ id: "recipient-archive", kind: "conversation", target: raw.notifications[0].recipient_thread_id, status, evidence_ref: "fixture:archive" }); });
      const before = JSON.stringify(f.store.read());
      let calls = 0;
      await expect(deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return sent; })).rejects.toThrow("请先手动取消归档");
      expect(calls).toBe(0); expect(JSON.stringify(f.store.read())).toBe(before);
      f.store.update(raw => { raw.resources.find((r: any) => r.id === "recipient-archive").status = "active"; });
      await deliverClaimedNotification(f.store, f.parsed, f.id, "Notice", async () => { calls++; return sent; });
      expect(calls).toBe(1);
    } finally { f.cleanup(); }
  });
}
test("notification creation rejects an archived bound task recipient", () => {
  const ledger = createDemoLedger();
  const target = ledger.tasks.find(t => t.id === "model")!;
  ledger.resources.push({ id: "archived-task", kind: "conversation", target: target.thread_id!, status: "closed", evidence_ref: "fixture:archive" });
  const sender = ledger.tasks.find(t => t.id === "deploy")!;
  expect(() => apply(ledger, "task-update", { run_id: ledger.orchestration_id, actor: { role: "task", thread_id: sender.thread_id! }, request_id: "archived-recipient", expected_revision: ledger.revision, payload: { task_id: sender.id, state: "waiting", detail: "Notify archived recipient", notification: { mode: "deliver", recipient: { thread_id: target.thread_id } } } })).toThrow("请先手动取消归档");
  expect(ledger.notifications).toHaveLength(0);
});
