import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAppServer, CodexRequestError } from '../src/codex/index.ts';
const fixture = fileURLToPath(new URL('./fixtures/codex-server.ts', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(mode = 'normal', options = {}) {
  return CodexAppServer.start({ command: process.execPath, args: [fixture, mode], shutdownGraceMs: 40, requestTimeoutMs: 3000, ...options });
}
async function using(mode, fn, options) {
  const client = await start(mode, options);
  try { await fn(client); } finally { await client.stop(); }
  assert.equal(client.state, 'closed');
}
function event(client, name, filter = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Missing event ${name}`)); }, 3000);
    const off = client.on(name, value => { if (filter(value)) { clearTimeout(timer); off(); resolve(value); } });
  });
}

test('handshake, thread/turn operations and exact protocol params', () => using('normal', async client => {
  assert.equal(client.state, 'ready'); assert.ok(client.pid > 0);
  assert.equal(client.initializeResult.userAgent, 'fixture/1');
  const params = { model: 'fixture', cwd: '/tmp', config: { model_reasoning_effort: 'high' } };
  assert.deepEqual((await client.startThread(params)).params, params);
  assert.equal((await client.resumeThread({ threadId: 'thread-1' })).thread.id, 'thread-1');
  assert.equal((await client.forkThread({ threadId: 'thread-1', lastTurnId: 'turn-1' })).params.lastTurnId, 'turn-1');
  const threads = await client.listThreads({ cursor: 'page-1', limit: 3 });
  assert.equal(threads.nextCursor, 'page-2'); assert.equal(threads.params.cursor, 'page-1');
  assert.equal((await client.listTurns({ threadId: 'thread-1' })).data[0].status, 'failed');
  assert.deepEqual(await client.setThreadName({ threadId: 'thread-1', name: 'Test' }), {});
  assert.deepEqual(await client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' }), {});
  assert.deepEqual((await client.listModels()).data, []);
}));

test('concurrent requests correlate independently of response order', () => using('normal', async client => {
  const first = client.readThread({ threadId: 'first' });
  const second = client.readThread({ threadId: 'second', includeTurns: true });
  assert.equal((await second).thread.id, 'second');
  assert.equal((await first).thread.id, 'first');
}));

test('split UTF-8, duplicate notifications, early terminal event and failed status are preserved', () => using('normal', async client => {
  const notifications = []; client.on('notification', n => notifications.push(n));
  const params = { threadId: 'thread-1', input: [{ type: 'text', text: 'Hello', text_elements: [] }], effort: 'high' };
  assert.deepEqual((await client.startTurn(params)).params, params);
  const deltas = notifications.filter(n => n.method === 'item/agentMessage/delta');
  assert.equal(deltas.length, 2); assert.equal(deltas[0].params.delta, '心羽🐱');
  assert.equal(notifications.find(n => n.method === 'turn/completed').params.turn.status, 'failed');
}));

test('approval is explicitly handed to caller and replied once with numeric id zero', () => using('approval', async client => {
  const approval = event(client, 'serverRequest');
  let settled = false;
  const turn = client.startTurn({ threadId: 'thread-1', input: [] }).then(value => { settled = true; return value; });
  const call = await approval;
  assert.equal(call.id, 0); assert.equal(call.approval, true); assert.equal(call.params.command, 'fixture');
  await pause(20); assert.equal(settled, false);
  const answered = event(client, 'notification', n => n.method === 'fixture/answer');
  await assert.rejects(call.respond(undefined), /must contain/);
  await call.respond({ decision: 'decline' });
  assert.deepEqual((await answered).params, { id: 0, result: { decision: 'decline' } });
  await turn;
  await assert.rejects(call.respond({ decision: 'accept' }), /already answered/);
}));

test('future server request is forwarded and caller can explicitly reject', () => using('unknown-call', async client => {
  const incoming = event(client, 'serverRequest');
  const turn = client.startTurn({ threadId: 'thread-1', input: [] });
  const call = await incoming; assert.equal(call.approval, false);
  await call.reject({ code: -32601, message: 'Unsupported method' }); await turn;
}));

test('unanswered approval cannot be reused after disconnect', () => using('approval', async client => {
  const incoming = event(client, 'serverRequest');
  const turn = client.startTurn({ threadId: 'thread-1', input: [] });
  const rejection = assert.rejects(turn, error => error.outcome === 'unknown');
  const call = await incoming; await client.stop(); await rejection;
  await assert.rejects(call.respond({ decision: 'accept' }), /disconnected/);
}));

test('RPC errors preserve code/data and definitive rejection', () => using('error', async client => {
  await assert.rejects(client.startThread(), error => {
    assert.ok(error instanceof CodexRequestError); assert.equal(error.method, 'thread/start');
    assert.equal(error.outcome, 'rejected'); assert.equal(error.rpcError.code, -32001);
    assert.deepEqual(error.rpcError.data, { reason: 'fixture' }); return true;
  });
  assert.equal(client.state, 'ready');
}));

for (const mode of ['disconnect', 'eof', 'malformed', 'invalid-response', 'invalid-payload', 'oversize']) {
  test(`${mode} rejects pending operation as unknown and closes child`, () => using(mode, async client => {
    const disconnected = event(client, 'disconnect');
    await assert.rejects(client.startThread(), error => error instanceof CodexRequestError && error.outcome === 'unknown');
    await disconnected; await client.stop();
    await assert.rejects(client.startThread(), /not ready/);
  }, { maxFrameBytes: 2048 }));
}

test('timeout retains request identity and does not replay; late response is orphaned', () => using('late', async client => {
  const orphan = event(client, 'orphanResponse');
  let requestId;
  await assert.rejects(client.startThread(), error => { requestId = error.requestId; return error.outcome === 'unknown'; });
  assert.equal((await orphan).id, requestId);
  assert.equal((await client.readThread({ threadId: 'reconcile' })).thread.id, 'reconcile');
}, { requestTimeoutMs: 100 }));

test('pending and serialization limits fail before sending', () => using('normal', async client => {
  const pending = client.readThread({ threadId: 'first' });
  const rejection = assert.rejects(pending, error => error.outcome === 'unknown');
  await assert.rejects(client.startThread(), error => error.outcome === 'not-sent');
  await client.stop(); await rejection;
}, { maxPendingRequests: 1 }));

test('oversized outgoing payload and circular params are not-sent', () => using('normal', async client => {
  await assert.rejects(client.startThread({ model: 'x'.repeat(3000) }), error => error.outcome === 'not-sent');
  const circular = {}; circular.config = circular;
  await assert.rejects(client.startThread(circular), error => error.outcome === 'not-sent');
  assert.equal((await client.startThread()).thread.id, 'thread-1');
}, { maxFrameBytes: 2048 }));

test('listener exceptions do not poison protocol correlation', () => using('normal', async client => {
  const failure = event(client, 'handlerError');
  client.on('notification', () => { throw new Error('owner listener'); });
  await client.startTurn({ threadId: 'thread-1', input: [] });
  assert.equal((await failure).message, 'owner listener');
  assert.equal(client.state, 'ready');
}));

test('stop is idempotent and kills a child ignoring EOF and TERM', () => using('stubborn', async client => {
  const pid = client.pid;
  const first = client.stop(); assert.equal(first, client.stop()); await first;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
}));

test('spawn, initialize rejection, timeout and invalid limits fail without ready connection', async () => {
  await assert.rejects(CodexAppServer.start({ command: '/nonexistent/loomhelm-codex' }), /ENOENT/);
  await assert.rejects(start('init-invalid'), error => error.outcome === 'unknown');
  await assert.rejects(start('init-error'), error => error.outcome === 'rejected');
  await assert.rejects(start('init-timeout', { requestTimeoutMs: 100 }), error => error.outcome === 'unknown');
  await assert.rejects(start('normal', { requestTimeoutMs: 0 }), /Invalid requestTimeoutMs/);
});


test('async listener failures are surfaced and stop is safe from disconnect callbacks', () => using('normal', async client => {
  const failure = event(client, 'handlerError');
  client.on('notification', async () => { throw new Error('async owner listener'); });
  await client.startTurn({ threadId: 'thread-1', input: [] });
  assert.equal((await failure).message, 'async owner listener');
  client.on('disconnect', () => { void client.stop(); });
  await client.stop();
}));


test('serverRequest/resolved invalidates stale reply handles and still reaches caller', () => using('resolved', async client => {
  const incoming = event(client, 'serverRequest');
  const resolved = event(client, 'notification', n => n.method === 'serverRequest/resolved');
  const turn = client.startTurn({ threadId: 'thread-1', input: [] });
  const call = await incoming;
  await resolved; await turn;
  await assert.rejects(call.respond({ decision: 'accept' }), /already answered or disconnected/);
}));
