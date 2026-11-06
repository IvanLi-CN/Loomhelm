import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.LOOMHELM_FIXTURE_MODE ?? 'complete';
const dbPath = process.env.LOOMHELM_FIXTURE_DB;
const logPath = process.env.LOOMHELM_FIXTURE_LOG;
writeFileSync(process.env.LOOMHELM_FIXTURE_PID, String(process.pid));
const db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, 'utf8')) : { threads: [] };
let initialized = false;
let heldTurn;
let thread;
const log = value => appendFileSync(logPath, JSON.stringify(value) + '\n');
const persist = () => writeFileSync(dbPath, JSON.stringify(db));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const turn = (id, status, error = null) => ({ id, status, error, items: [], itemsView: 'summary', startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: 1 });
const complete = (id, status = 'completed') => {
  const value = turn(id, status, status === 'failed' ? { message: 'approval declined' } : null);
  const record = db.threads.find(item => item.id === thread.id);
  record.turns.push(value); persist();
  send({ method: 'turn/completed', params: { threadId: thread.id, turn: value } });
};

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fixture/1', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'test' } }); return;
  }
  if (message.method === 'initialized') { initialized = true; return; }
  if (!initialized) process.exit(10);
  if (!('method' in message)) {
    log({ method: 'approval-response', result: message.result });
    if (heldTurn) { send({ id: heldTurn.id, result: { turn: turn('turn-1', 'inProgress') } }); complete('turn-1', message.result.decision === 'accept' ? 'completed' : 'failed'); heldTurn = null; }
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.method === 'thread/start') {
    if (mode === 'hold-thread') {
      thread = { id: 'thread-held', model: message.params.model ?? 'fixture-model', reasoningEffort: message.params.config?.model_reasoning_effort ?? null, turns: [] };
      db.threads.push(thread); persist();
      return;
    }
    thread = { id: `thread-${db.threads.length + 1}`, model: message.params.model ?? 'fixture-model', reasoningEffort: message.params.config?.model_reasoning_effort ?? null, turns: [] };
    db.threads.push(thread); persist();
    send({ id: message.id, result: { thread: { id: thread.id }, model: thread.model, reasoningEffort: thread.reasoningEffort } }); return;
  }
  if (message.method === 'thread/name/set') { send({ id: message.id, result: {} }); return; }
  if (message.method === 'thread/read') {
    const found = db.threads.find(item => item.id === message.params.threadId);
    if (found) send({ id: message.id, result: { thread: { id: found.id } } });
    else send({ id: message.id, error: { code: -32004, message: 'thread not found' } });
    return;
  }
  if (message.method === 'thread/turns/list') {
    const found = db.threads.find(item => item.id === message.params.threadId);
    send({ id: message.id, result: { data: found?.turns ?? [], nextCursor: null, backwardsCursor: null } }); return;
  }
  if (message.method === 'turn/start') {
    if (mode === 'reject-turn') { send({ id: message.id, error: { code: -32001, message: 'turn rejected' } }); return; }
    const newTurn = turn('turn-1', 'inProgress');
    thread.turns.push(newTurn); persist();
    if (mode === 'approval') {
      heldTurn = message;
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: 'turn-1', itemId: 'item-1', command: 'fixture', reason: 'test approval' } });
      return;
    }
    send({ id: message.id, result: { turn: newTurn } });
    if (mode === 'unknown-turn') return;
    const delay = mode === 'slow-complete' ? 120 : 15;
    setTimeout(() => complete('turn-1'), delay);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unexpected method ${message.method}` } });
});
