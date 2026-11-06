import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDispatchAdapter, ThreadDispatcher, TaskGraph, TaskOrchestrator } from '../dist/index.js';

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
  dispatcher.approve(record.id);
  adapter.startTurnResult = { outcome: 'succeeded', turnId: 'turn-2' };
  const retried = await dispatcher.retry(record.id);
  assert.equal(retried.state, 'initialized');
  assert.equal(retried.attempts, 2);
  assert.equal(adapter.calls.startThread, 1);
  assert.equal(adapter.calls.startTurn, 2);
});

test('task graph validates dependencies and scheduler enforces capacity with isolated failures', async () => {
  const scheduler = new TaskOrchestrator([
    { id: 'a', kind: 'contribution', goal: 'a' },
    { id: 'b', kind: 'verification', goal: 'b' },
    { id: 'c', kind: 'acceptance', goal: 'c', dependencies: ['a'] },
  ], { maxRunning: 2 });
  assert.deepEqual(scheduler.schedule(), ['a', 'b']);
  await scheduler.start('a'); await scheduler.start('b');
  await assert.rejects(scheduler.start('c'), /capacity|ready/);
  await scheduler.finish('a', 'failed', 'compile failed');
  assert.deepEqual(scheduler.schedule(), []);
  assert.equal(scheduler.snapshot().find(task => task.id === 'c').state, 'blocked');
  await scheduler.finish('b', 'passed');
  assert.equal(scheduler.result().succeeded, false);
  assert.deepEqual(scheduler.result().failed, ['a']);
});

test('superseded history is excluded and terminal status follows task kind', async () => {
  const graph = new TaskGraph([
    { id: 'old', kind: 'contribution', goal: 'old', superseded: true },
    { id: 'change', kind: 'contribution', goal: 'change' },
    { id: 'accept', kind: 'acceptance', goal: 'accept', dependencies: ['change'] },
  ]);
  const scheduler = new TaskOrchestrator(graph);
  assert.deepEqual(scheduler.ready(), ['change']);
  await scheduler.start('change');
  await assert.rejects(scheduler.finish('change', 'passed'), /does not satisfy/);
  await scheduler.finish('change', 'merged');
  await scheduler.start('accept');
  await scheduler.finish('accept', 'passed');
  const result = scheduler.result();
  assert.equal(result.complete, true);
  assert.equal(result.succeeded, true);
  assert.deepEqual(result.active, ['change', 'accept']);
  assert.deepEqual(result.superseded, ['old']);
});

test('running tasks can be recovered for a later bounded retry', async () => {
  const scheduler = new TaskOrchestrator([{ id: 'recover', kind: 'coordination', goal: 'recover' }]);
  await scheduler.start('recover');
  assert.deepEqual(scheduler.recover(), ['recover']);
  assert.deepEqual(scheduler.ready(), ['recover']);
  await scheduler.start('recover');
  await scheduler.finish('recover', 'completed');
  assert.equal(scheduler.result().succeeded, true);
});
