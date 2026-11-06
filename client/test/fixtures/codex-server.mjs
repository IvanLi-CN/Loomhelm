// Deterministic stdio peer: no credentials, model calls, services or network.
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
const mode = process.argv[2] ?? 'normal';
let initialized = false, handshake = false, delayed, outstanding, approvalTurn;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (request, value) => send({ id: request.id, result: value });
const turn = status => ({ id: 'turn-1', status, items: [], error: null });
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (handshake || request.jsonrpc || !request.params.clientInfo.name) process.exit(21);
    handshake = true;
    if (mode === 'init-timeout') return;
    if (mode === 'init-invalid') return result(request, null);
    if (mode === 'init-error') return send({ id: request.id, error: { code: -32600, message: 'bad initialize' } });
    result(request, { userAgent: 'fixture/1', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux' });
    return;
  }
  if (request.method === 'initialized') {
    if (!handshake || initialized || 'id' in request) process.exit(22);
    initialized = true;
    send({ method: 'fixture/ready', params: { client: 'loomhelm' } });
    return;
  }
  if (!initialized) process.exit(23);
  if (!('method' in request)) {
    if (outstanding === undefined || outstanding === null || request.id !== outstanding) process.exit(24);
    send({ method: 'fixture/answer', params: request });
    if (approvalTurn) result(approvalTurn, { turn: turn('inProgress') });
    outstanding = null; approvalTurn = null;
    return;
  }
  if (request.method === 'thread/start') {
    if (mode === 'disconnect') return process.exit(9);
    if (mode === 'eof') return closeSync(1);
    if (mode === 'invalid-payload') return result(request, { thread: { id: null } });
    if (mode === 'malformed') return process.stdout.write('{bad\n');
    if (mode === 'invalid-response') return send({ id: request.id, result: {}, error: { code: 1, message: 'both' } });
    if (mode === 'oversize') return process.stdout.write('x'.repeat(3000));
    if (mode === 'timeout') return;
    if (mode === 'late') return setTimeout(() => result(request, { thread: { id: 'late' } }), 200);
    if (mode === 'error') return send({ id: request.id, error: { code: -32001, message: 'denied', data: { reason: 'fixture' } } });
    return result(request, { thread: { id: 'thread-1', turns: [] }, model: request.params.model ?? 'fixture', reasoningEffort: 'high', params: request.params });
  }
  if (request.method === 'thread/read') {
    if (request.params.threadId === 'first') { delayed = request; return; }
    result(request, { thread: { id: request.params.threadId }, params: request.params });
    if (delayed) { result(delayed, { thread: { id: delayed.params.threadId } }); delayed = null; }
    return;
  }
  if (request.method === 'turn/start') {
    if (mode === 'approval' || mode === 'unknown-call' || mode === 'resolved') {
      approvalTurn = request; outstanding = 0;
      send({ id: 0, method: mode === 'approval' ? 'item/commandExecution/requestApproval' : 'future/serverCall',
        params: { threadId: request.params.threadId, turnId: 'turn-1', itemId: 'item-1', command: 'fixture', reason: 'Needs owner' } });
      if (mode === 'resolved') setTimeout(() => {
        send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 0 } });
        result(request, { turn: turn('inProgress') });
      }, 15);
      return;
    }
    const delta = { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '心羽🐱' } };
    const wire = Buffer.from(JSON.stringify(delta) + '\n');
    const split = wire.indexOf(Buffer.from('🐱')) + 1;
    process.stdout.write(wire.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(wire.subarray(split));
      send(delta); // Intentional repeated event; adapter preserves it for reconciliation.
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('failed') } });
      result(request, { turn: turn('inProgress'), params: request.params });
    }, 5);
    return;
  }
  if (request.method === 'thread/resume' || request.method === 'thread/fork') return result(request, { thread: { id: request.params.threadId }, params: request.params });
  if (request.method === 'thread/list') return result(request, { data: [{ id: 'thread-1' }], nextCursor: 'page-2', params: request.params });
  if (request.method === 'thread/turns/list') return result(request, { data: [turn('failed')], nextCursor: null, params: request.params });
  if (request.method === 'model/list') return result(request, { data: [], nextCursor: null });
  if (['thread/name/set', 'turn/interrupt'].includes(request.method)) return result(request, {});
  send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
});
