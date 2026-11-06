import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { SkillsRuntime } from '../dist/index.js';
import { LedgerStore } from '../dist/toolkit/skills/multi-task-flow/scripts/store.js';
import { apply } from '../dist/toolkit/skills/multi-task-flow/scripts/engine.js';
import { deliverClaimedNotification, reconcileNotification } from '../dist/toolkit/skills/multi-task-flow/scripts/notification-delivery.js';

const accepted = { outcome: 'sent', provider_receipt: { provider: 'codex-app-server', evidence_ref: 'fixture:accepted', message_id: 'fixture-turn' } };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'loomhelm-notification-')));
  try {
    const runtime = new SkillsRuntime();
    const input = await readFile(join(runtime.root, 'skills/multi-task-flow/examples/ledger-initialization/initial.json'), 'utf8');
    const result = await runtime.run('skills/multi-task-flow/scripts/orchestrate.ts', ['init', '--input', '-'], { input, env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: join(root, 'seed') } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const ledger = JSON.parse(await readFile(join(root, 'seed/runs/example-run/ledger.json'), 'utf8'));
    // Synthetic unit fixture, never a host conversation or real old run.
    const task = ledger.tasks[0]; task.state = 'starting'; task.thread_id = 'fixture-notification-sender';
    const actor = { role: 'task', thread_id: task.thread_id };
    apply(ledger, 'task-update', { run_id: ledger.orchestration_id, actor, request_id: 'fixture-notice', expected_revision: ledger.revision, payload: { task_id: task.id, state: 'waiting', detail: 'Fixture notice', notification: { mode: 'deliver', recipient: 'owner' } } });
    const store = new LedgerStore(join(root, 'delivery'), ledger.orchestration_id); store.create(ledger);
    const id = ledger.notifications[0].id;
    return { root, store, id, request: { run_id: ledger.orchestration_id, actor, request_id: 'fixture-send', expected_revision: ledger.revision, payload: { notification_id: id } }, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

function cli(f, command, request) {
  return spawnSync(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname, 'flow', command, '--input', '-'], { input: JSON.stringify(request), env: { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: join(f.root, 'delivery'), LOOMHELM_CODEX_APP_SERVER_SOCKET: join(f.root, 'absent.sock') }, encoding: 'utf8' });
}

test('stale production notification-send preserves historical bytes, revision and backup', async () => {
  const f = await fixture();
  try {
    const raw = JSON.parse(await readFile(f.store.ledgerPath, 'utf8')); delete raw.source_schema_version;
    await writeFile(f.store.ledgerPath, JSON.stringify(raw, null, 2) + '\n');
    const before = await readFile(f.store.ledgerPath, 'utf8');
    const files = await readdir(f.store.runPath);
    const result = cli(f, 'notification-send', { ...f.request, expected_revision: raw.revision - 1 });
    assert.equal(result.status, 3, result.stderr); assert.equal(JSON.parse(result.stdout).code, 'REVISION_CONFLICT');
    assert.equal(await readFile(f.store.ledgerPath, 'utf8'), before);
    assert.deepEqual(await readdir(f.store.runPath), files);
    assert.equal(f.store.read().revision, raw.revision);
  } finally { await f.cleanup(); }
});

test('production notification flight lock excludes cross-process reconciliation and caches acceptance', async () => {
  const f = await fixture(); let finish;
  try {
    let calls = 0;
    const first = deliverClaimedNotification(f.store, f.request, f.id, 'Fixture', async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const replay = await deliverClaimedNotification(f.store, f.request, f.id, 'Fixture', async () => { calls++; return accepted; });
    assert.equal(replay.replayed, true);
    const query = { ...f.request, request_id: 'fixture-query', expected_revision: f.store.read().revision, payload: { notification_id: f.id, reconciliation_id: 'fixture-query', outcome: 'failed', provider_receipt: { provider: 'fixture-query', evidence_ref: 'fixture:absent' } } };
    const blocked = cli(f, 'notification-reconcile', query);
    assert.equal(JSON.parse(blocked.stdout).code, 'NOTIFICATION_IN_FLIGHT'); assert.notEqual(blocked.status, 0);
    await assert.rejects(deliverClaimedNotification(f.store, { ...f.request, request_id: 'second-send', expected_revision: f.store.read().revision }, f.id, 'Fixture', async () => { calls++; return accepted; }), /active sender/);
    finish(accepted); await first; finish = undefined;
    const final = await deliverClaimedNotification(f.store, f.request, f.id, 'Fixture', async () => { calls++; return accepted; });
    assert.equal(final.replayed, true); assert.equal(calls, 1); assert.equal(f.store.read().notifications[0].attempts, 1);
  } finally { if (finish) finish(accepted); await f.cleanup(); }
});

test('production notification failure replays immutable result and unknown requires explicit reconciliation', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const failed = await deliverClaimedNotification(f.store, f.request, f.id, 'Fixture', async () => { calls++; return { outcome: 'failed', provider_receipt: { provider: 'codex-app-server', evidence_ref: 'fixture:unavailable' } }; });
    const retry = { ...f.request, request_id: 'fixture-retry', expected_revision: f.store.read().revision };
    await assert.rejects(deliverClaimedNotification(f.store, retry, f.id, 'Fixture', async () => { calls++; throw new Error('fixture interrupted'); }), /remains unknown/);
    const unknown = f.store.read(); assert.equal(unknown.notifications[0].delivery_status, 'unknown');
    await assert.rejects(deliverClaimedNotification(f.store, { ...f.request, request_id: 'forbidden-retry', expected_revision: unknown.revision }, f.id, 'Fixture', async () => { calls++; return accepted; }), /must be reconciled/);
    reconcileNotification(f.store, { ...f.request, request_id: 'fixture-reconcile', expected_revision: unknown.revision, payload: { notification_id: f.id, reconciliation_id: 'fixture-reconcile', outcome: 'failed', provider_receipt: { provider: 'fixture-query', evidence_ref: 'fixture:confirmed-absent' } } });
    await deliverClaimedNotification(f.store, { ...f.request, request_id: 'fixture-new-attempt', expected_revision: f.store.read().revision }, f.id, 'Fixture', async () => { calls++; return accepted; });
    const replay = await deliverClaimedNotification(f.store, { ...f.request, expected_revision: f.store.read().revision }, f.id, 'Fixture', async () => { calls++; return accepted; });
    assert.deepEqual(replay, { ...failed, replayed: true }); assert.equal(calls, 3);
    assert.equal(f.store.read().notifications[0].attempts, 3);
  } finally { await f.cleanup(); }
});
