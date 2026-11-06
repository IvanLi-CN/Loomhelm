import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ledger, StateLock, runProcess, GitAdapter, loadConfig, LocalClient } from '../dist/index.js';

async function temporary(fn) { const dir = await mkdtemp(join(tmpdir(), 'loomhelm-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
const task = (id, dependencies = []) => ({ type: 'task.create', task: { id, goal: 'Implement core', scope: 'Client only', acceptance: 'Tests pass', dependencies } });

test('dependencies, retry, terminal state and operation identity', () => temporary(async dir => {
  const ledger = await Ledger.open(dir);
  try {
    await ledger.execute('create-a', task('a'));
    await ledger.execute('create-b', task('b', ['a']));
    await assert.rejects(ledger.execute('blocked', { type: 'run.start', taskId: 'b', runId: 'b1' }), /Dependencies/);
    const input = { type: 'run.start', taskId: 'a', runId: 'a1' };
    const [first, second] = await Promise.all([ledger.execute('start-a', input), ledger.execute('start-a', input)]);
    assert.deepEqual(first, second);
    await assert.rejects(ledger.execute('start-a', task('c')), /conflict/);
    await ledger.execute('fail-a', { type: 'run.finish', runId: 'a1', status: 'failed', detail: 'test failed' });
    await ledger.execute('retry-a', { type: 'run.start', taskId: 'a', runId: 'a2' });
    await ledger.execute('pass-a', { type: 'run.finish', runId: 'a2', status: 'succeeded', detail: 'test passed' });
    await ledger.execute('start-b', { type: 'run.start', taskId: 'b', runId: 'b1' });
    assert.equal(ledger.snapshot().runs.a2.attempt, 2);
    await assert.rejects(ledger.execute('repeat', { type: 'run.start', taskId: 'a', runId: 'a3' }), /cannot start/);
    await assert.rejects(ledger.execute('unknown-dep', task('c', ['missing'])), /Dependency/);
    await assert.rejects(ledger.execute('bad-id', task('__proto__')), /identity/);
    const copy = ledger.history(); copy[0].operation.task.goal = 'mutated';
    assert.equal(ledger.history()[0].operation.task.goal, 'Implement core');
  } finally { await ledger.close(); }
}));

test('exclusive writer, restart reconciliation and corrupt history refusal', () => temporary(async dir => {
  let ledger = await Ledger.open(dir);
  await ledger.execute('create', task('a'));
  await ledger.execute('start', { type: 'run.start', taskId: 'a', runId: 'r1' });
  await assert.rejects(Ledger.open(dir), /locked/);
  await ledger.close();
  ledger = await Ledger.open(dir);
  assert.equal(ledger.snapshot().tasks.a.status, 'interrupted');
  const count = ledger.history().length;
  await ledger.close();
  ledger = await Ledger.open(dir); assert.equal(ledger.history().length, count); await ledger.close();
  const path = join(dir, 'ledger.json');
  const data = JSON.parse(await readFile(path, 'utf8')); data.receipts[0].operation.task.goal = 'tampered';
  await writeFile(path, JSON.stringify(data));
  await assert.rejects(Ledger.open(dir), /receipt chain/);
  // A failed open releases its lock without replacing corrupt evidence.
  await assert.rejects(Ledger.open(dir), /receipt chain/);
  assert.match(await readFile(path, 'utf8'), /tampered/);
}));

test('lock release checks ownership; stale locks are never automatically stolen', () => temporary(async dir => {
  const lock = await StateLock.acquire(dir);
  const path = join(dir, 'writer.lock');
  await writeFile(path, JSON.stringify({ token: 'other', pid: 99999999 }));
  await assert.rejects(lock.release(), /ownership/);
  await assert.rejects(StateLock.acquire(dir), /locked/);
}));

test('config is explicit, versioned and resolves relative state paths', () => temporary(async dir => {
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, stateDir: 'state' }));
  assert.equal((await loadConfig(path)).stateDir, join(dir, 'state'));
  assert.equal((await loadConfig(path)).maxOutputBytes, 1024 * 1024);
  for (const value of [{ schemaVersion: 2 }, { mode: 'connected' }, { processTimeoutMs: 0 }, { maxOutputBytes: 0 }, { maxOutputBytes: 64 * 1024 * 1024 + 1 }, { secret: 'bad' }, null]) {
    await writeFile(path, JSON.stringify(value)); await assert.rejects(loadConfig(path));
  }
}));

test('LocalClient owns task process lifecycle and stops active work on close', () => temporary(async dir => {
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ stateDir: 'state', processTimeoutMs: 5000 }));
  const client = await LocalClient.open(config);
  await client.ledger.execute('create', task('runtime'));
  const pending = client.runTask('runtime-op', 'runtime', [process.execPath, '-e', 'setInterval(()=>{},1000)']);
  await client.close();
  const receipt = await pending;
  assert.equal(receipt.operation.type, 'run.finish');
  assert.equal(receipt.operation.status, 'interrupted');
}));

test('LocalClient replays a completed operation without rerunning the process', () => temporary(async dir => {
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ stateDir: 'state' }));
  const client = await LocalClient.open(config);
  try {
    await client.ledger.execute('create', task('runtime'));
    const command = [process.execPath, '-e', 'process.stdout.write("ok")'];
    const first = await client.runTask('runtime-op', 'runtime', command);
    const second = await client.runTask('runtime-op', 'runtime', command);
    assert.deepEqual(second, first);
    assert.equal(client.ledger.history().filter(receipt => receipt.operation.type === 'run.finish').length, 1);
  } finally { await client.close(); }
}));

test('process timeout, cancellation, output bounds, spawn error and nonzero result', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("ok"); process.exitCode=7']);
  assert.equal(result.code, 7); assert.equal(result.stdout.trim(), 'ok');
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(4096))'], { maxOutputBytes: 128 }), /limit/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /aborted/);
  await assert.rejects(runProcess('loomhelm-command-does-not-exist', []), error => error.code === 'ENOENT');
});

test('Git worktree creation preserves existing state and refuses unsafe requests', () => temporary(async dir => {
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = async args => { const value = await runProcess('git', ['-C', repo, ...args]); assert.equal(value.code, 0, value.stderr); return value.stdout.trim(); };
  await git(['init']); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
  const adapter = new GitAdapter(repo);
  const before = await adapter.inspect();
  const target = join(dir, 'new worktree');
  const created = await adapter.createWorktree(target, 'feat/client-test');
  assert.equal(created.head, before.head); assert.equal((await new GitAdapter(target).inspect()).branch, 'feat/client-test');
  await assert.rejects(adapter.createWorktree(target, 'feat/other'), /exists/);
  await assert.rejects(adapter.createWorktree(join(dir, 'next'), '--force'), /valid refs/);
  await assert.rejects(adapter.createWorktree('relative', 'feat/path'), /Absolute/);
  await writeFile(join(repo, 'dirty'), 'keep');
  await assert.rejects(adapter.createWorktree(join(dir, 'next'), 'feat/dirty'), /dirty/);
  assert.equal(await readFile(join(repo, 'dirty'), 'utf8'), 'keep');
}));

test('offline CLI creates, executes and queries a task without a server', () => temporary(async dir => {
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ stateDir: 'state' }));
  const cli = async args => {
    const result = await runProcess(process.execPath, [resolve('dist/cli.js'), '--config', config, ...args]);
    assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  };
  await cli(['apply', 'create', JSON.stringify(task('cli-task'))]);
  const receipt = await cli(['run', 'validate', 'cli-task', JSON.stringify([process.execPath, '-e', 'console.log("verified")'])]);
  assert.equal(receipt.operation.status, 'succeeded');
  assert.equal((await cli(['tasks'])).tasks['cli-task'].status, 'succeeded');
  assert.equal((await cli(['status'])).mode, 'local');
  assert.deepEqual(await cli(['run', 'validate', 'cli-task', JSON.stringify([process.execPath, '-e', 'console.log("verified")'])]), receipt);
}));

test('explicit dead-owner recovery and live-owner refusal', () => temporary(async dir => {
  const lock = await StateLock.acquire(dir);
  const owner = JSON.parse(await readFile(join(dir, 'writer.lock'), 'utf8'));
  await assert.rejects(StateLock.recover(dir, owner.token), /alive/);
  await assert.rejects(StateLock.recover(dir, 'wrong'), /identity/);
  await lock.release();
  // Get a genuine exited process PID rather than assuming a numeric PID is dead.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  await writeFile(join(dir, 'writer.lock'), JSON.stringify({ ...owner, pid: child.pid }));
  await StateLock.recover(dir, owner.token);
  const reopened = await Ledger.open(dir); await reopened.close();
}));

test('failed durable write does not publish in-memory state', () => temporary(async dir => {
  const ledger = await Ledger.open(dir);
  try {
    await mkdir(join(dir, 'ledger.json'));
    await assert.rejects(ledger.execute('create', task('a')));
    assert.equal(Object.keys(ledger.snapshot().tasks).length, 0);
    assert.equal(ledger.history().length, 0);
    await rm(join(dir, 'ledger.json'), { recursive: true });
    await ledger.execute('create', task('a'));
    assert.equal(ledger.snapshot().tasks.a.status, 'pending');
  } finally { await ledger.close(); }
}));

test('process crash preserves uncertain Run until explicit lock recovery', () => temporary(async dir => {
  const { spawn } = await import('node:child_process');
  const source = `
    const {Ledger}=await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const ledger=await Ledger.open(${JSON.stringify(dir)});
    await ledger.execute('create', ${JSON.stringify(task('crashed'))});
    await ledger.execute('start', {type:'run.start',taskId:'crashed',runId:'uncertain'});
    console.log('ready');setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Crash fixture did not start')), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited early')); });
    });
    child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve));
    await assert.rejects(Ledger.open(dir), /locked/);
    const owner = JSON.parse(await readFile(join(dir, 'writer.lock'), 'utf8'));
    await StateLock.recover(dir, owner.token);
    const recovered = await Ledger.open(dir);
    try { assert.equal(recovered.snapshot().runs.uncertain.status, 'interrupted'); }
    finally { await recovered.close(); }
  } finally { child.kill('SIGKILL'); }
}));
