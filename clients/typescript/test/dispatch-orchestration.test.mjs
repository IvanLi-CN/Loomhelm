import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeDispatchAdapter, ThreadDispatcher, StateLock } from '../dist/index.js';

const dispatchInput = { requestId: 'request-1', title: 'worker', prompt: 'initialize' };

test('dispatch records real identities and duplicate requests are idempotent', async () => {
  const adapter = new FakeDispatchAdapter();
  const dispatcher = new ThreadDispatcher(adapter);
  const first = await dispatcher.dispatch(dispatchInput);
  const second = await dispatcher.dispatch({ ...dispatchInput });
  assert.equal(first.state, 'initialized');
  assert.equal(first.threadId, 'thread-1');
  assert.equal(second.id, first.id);
  assert.equal(adapter.calls.startThread, 1);
  assert.equal(adapter.calls.startTurn, 1);
  await assert.rejects(dispatcher.dispatch({ ...dispatchInput, prompt: 'different' }), /identity conflict/);
});

test('initialization failure is durable and never silently retried', async () => {
  const adapter = new FakeDispatchAdapter();
  adapter.startTurnResult = { outcome: 'failed', detail: 'initial turn rejected' };
  const dispatcher = new ThreadDispatcher(adapter);
  const record = await dispatcher.dispatch(dispatchInput);
  assert.equal(record.state, 'failed');
  assert.equal(record.detail, 'initial turn rejected');
  assert.equal((await dispatcher.dispatch(dispatchInput)).id, record.id);
  assert.equal(adapter.calls.startThread, 1);
});

test('dispatch reconstructs persisted identity after a new instance', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'loomhelm-dispatch-'));
  try {
    const firstAdapter = new FakeDispatchAdapter();
    const first = new ThreadDispatcher(firstAdapter, { stateDir });
    const created = await first.dispatch(dispatchInput);
    const secondAdapter = new FakeDispatchAdapter();
    const second = new ThreadDispatcher(secondAdapter, { stateDir });
    const restored = await second.dispatch({ ...dispatchInput });
    assert.equal(restored.id, created.id);
    assert.equal(restored.threadId, created.threadId);
    assert.equal(restored.state, 'initialized');
    assert.equal(secondAdapter.calls.startThread, 0);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('concurrent persistent dispatch reservations create one external thread', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'loomhelm-dispatch-race-'));
  try {
    const a = new FakeDispatchAdapter(); const b = new FakeDispatchAdapter();
    const one = new ThreadDispatcher(a, { stateDir }); const two = new ThreadDispatcher(b, { stateDir });
    const results = await Promise.all([one.dispatch(dispatchInput), two.dispatch(dispatchInput)]);
    assert.equal(a.calls.startThread + b.calls.startThread, 1);
    assert.equal(results[0].id, results[1].id);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('unknown initialization requires reconciliation and explicit approval before retry', async () => {
  const adapter = new FakeDispatchAdapter();
  adapter.startTurnResult = { outcome: 'unknown', detail: 'transport lost' };
  const dispatcher = new ThreadDispatcher(adapter);
  const record = await dispatcher.dispatch(dispatchInput);
  assert.equal(record.state, 'unknown');
  assert.equal(adapter.calls.startThread, 1);
  const reconciled = await dispatcher.reconcile(record.id);
  assert.equal(reconciled.state, 'started');
  assert.equal(adapter.calls.startThread, 1);
  await assert.rejects(dispatcher.retry(record.id), /explicit approval/);
  await dispatcher.approve(record.id);
  adapter.startTurnResult = { outcome: 'succeeded', turnId: 'turn-2' };
  const retried = await dispatcher.retry(record.id);
  assert.equal(retried.state, 'initialized');
  assert.equal(retried.attempts, 2);
  assert.equal(adapter.calls.startThread, 1);
  assert.equal(adapter.calls.startTurn, 2);
});

test('durable operations wait through a slow live writer without stealing its lock', async () => {
  for (const kind of ['dispatch']) {
    const stateDir = await mkdtemp(join(tmpdir(), `loomhelm-slow-${kind}-`));
    let owner;
    try {
      owner = await StateLock.acquire(stateDir);
      const adapter = new FakeDispatchAdapter();
      const pending = new ThreadDispatcher(adapter, { stateDir }).dispatch(dispatchInput);
      const observed = Promise.allSettled([pending]);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(adapter.calls.startThread, 0);
      await assert.rejects(StateLock.acquire(stateDir), /State directory locked/);
      await owner.release(); owner = undefined;
      const [result] = await observed;
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.equal(adapter.calls.startThread, 1);
    } finally {
      if (owner) await owner.release();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});
