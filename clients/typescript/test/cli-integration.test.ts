import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../src/runtime/process.ts';
import { flowProcessOptions } from '../src/cli/flow.ts';

const cliPath = resolve('src/cli.ts');
const fixturePath = resolve('test/fixtures/cli-codex-server.ts');
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'loomhelm-cli-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function setup(dir, mode = 'complete') {
  const bin = join(dir, 'bin'); await mkdir(bin);
  const codex = join(bin, 'codex');
  await writeFile(codex, `#!${process.execPath}\nimport ${JSON.stringify(fixturePath)};\n`);
  await chmod(codex, 0o755);
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, stateDir: join(dir, 'state'), processTimeoutMs: 3000 }));
  return { config, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOOMHELM_FIXTURE_MODE: mode,
    LOOMHELM_FIXTURE_DB: join(dir, 'codex-db.json'), LOOMHELM_FIXTURE_LOG: join(dir, 'codex.log'), LOOMHELM_FIXTURE_PID: join(dir, 'codex.pid') } };
}
async function invoke(config, env, args) {
  const result = await runProcess(process.execPath, [cliPath, '--config', config, ...args], { env, timeoutMs: 10_000 });
  let output;
  try { output = JSON.parse(result.stdout); } catch {
    const lines = result.stderr.trim().split('\n').filter(Boolean);
    try { output = JSON.parse(lines.at(-1)); } catch { output = null; }
  }
  return { code: result.code, output, stdout: result.stdout, stderr: result.stderr };
}
async function logEntries(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function waitFor(predicate, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await predicate()) return; await delay(10); }
  throw new Error(message);
}
function request(title, extras = {}) { return JSON.stringify({ title, prompt: 'initialize safely', cwd: '/tmp/project', model: 'fixture-model', effort: 'high', ...extras }); }

test('flow subprocess inherits the caller repository cwd', () => {
  const options = flowProcessOptions({ processTimeoutMs: 1000, maxOutputBytes: 1024 }, new Uint8Array());
  assert.equal(options.cwd, process.cwd());
});

test('real CLI subprocess dispatch maps current Codex request shapes and waits for completion', async () => temporary(async dir => {
  const { config, env } = await setup(dir, 'slow-complete');
  const started = Date.now();
  const result = await invoke(config, env, ['codex', 'dispatch', 'dispatch-success', request('CLI worker', { timeoutMs: 1000 })]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.state, 'initialized');
  assert.equal(result.output.threadId, 'thread-1');
  assert.ok(Date.now() - started >= 90, 'CLI must wait beyond the turn/start acknowledgement');
  const entries = await logEntries(env.LOOMHELM_FIXTURE_LOG);
  const threadStart = entries.find(entry => entry.method === 'thread/start').params;
  assert.equal(threadStart.model, 'fixture-model');
  assert.deepEqual(threadStart.config, { model_reasoning_effort: 'high' });
  assert.equal(threadStart.cwd, '/tmp/project');
  const turnStart = entries.find(entry => entry.method === 'turn/start').params;
  assert.deepEqual(turnStart.input, [{ type: 'text', text: 'initialize safely', text_elements: [] }]);
  assert.equal(turnStart.model, 'fixture-model');
  assert.equal(turnStart.effort, 'high');
  assert.equal((await logEntries(env.LOOMHELM_FIXTURE_LOG)).filter(entry => entry.method === 'thread/start').length, 1);
  const pid = Number(await readFile(env.LOOMHELM_FIXTURE_PID, 'utf8'));
  await waitFor(async () => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 'owned Codex process should stop after dispatch');
}));

test('approvals are explicitly accepted or declined and deterministic turn rejection stays failed', async () => temporary(async dir => {
  const { config, env } = await setup(dir, 'approval');
  const declined = await invoke(config, env, ['codex', 'dispatch', 'dispatch-declined', request('Decline test', { timeoutMs: 1000 })]);
  assert.equal(declined.code, 1);
  assert.equal(declined.output.state, 'failed');
  const firstResponse = (await logEntries(env.LOOMHELM_FIXTURE_LOG)).find(entry => entry.method === 'approval-response');
  assert.equal(firstResponse.result.decision, 'decline');
  const accepted = await invoke(config, env, ['codex', 'dispatch', 'dispatch-accepted', request('Accept test', { timeoutMs: 1000, approvalDecision: 'accept' })]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(accepted.output.state, 'initialized');
  assert.equal((await logEntries(env.LOOMHELM_FIXTURE_LOG)).filter(entry => entry.method === 'approval-response').at(-1).result.decision, 'accept');
  const rejectedEnv = { ...env, LOOMHELM_FIXTURE_MODE: 'reject-turn' };
  const rejected = await invoke(config, rejectedEnv, ['codex', 'dispatch', 'dispatch-rejected', request('Rejected test', { timeoutMs: 1000 })]);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.output.state, 'failed');
}));

test('unknown completion survives process reconstruction and never repeats thread creation', async () => temporary(async dir => {
  const { config, env } = await setup(dir, 'unknown-turn');
  const encoded = request('Unknown test', { timeoutMs: 80 });
  const first = await invoke(config, env, ['codex', 'dispatch', 'dispatch-unknown', encoded]);
  assert.equal(first.code, 2, `stdout=${first.stdout} stderr=${first.stderr}`);
  assert.equal(first.output.state, 'unknown');
  const second = await invoke(config, env, ['codex', 'dispatch', 'dispatch-unknown', encoded]);
  assert.equal(second.code, 2);
  assert.equal(second.output.state, 'unknown');
  assert.equal((await logEntries(env.LOOMHELM_FIXTURE_LOG)).filter(entry => entry.method === 'thread/start').length, 1);
  const reconciled = await invoke(config, { ...env, LOOMHELM_FIXTURE_MODE: 'complete' }, ['codex', 'reconcile', first.output.dispatchId]);
  assert.equal(reconciled.output.state, 'started');
  assert.equal((await logEntries(env.LOOMHELM_FIXTURE_LOG)).filter(entry => entry.method === 'thread/start').length, 1);
}));

test('killed CLI leaves a created reservation that restart reports unknown without another external call', async () => temporary(async dir => {
  const { config, env } = await setup(dir, 'hold-thread');
  const args = [cliPath, '--config', config, 'codex', 'dispatch', 'dispatch-crash', request('Crash boundary', { timeoutMs: 1000 })];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  await waitFor(async () => {
    if ((await logEntries(env.LOOMHELM_FIXTURE_LOG)).some(entry => entry.method === 'thread/start')) return true;
    if (child.exitCode !== null) throw new Error(`CLI exited before thread/start (${child.exitCode}); stdout=${stdout} stderr=${stderr}`);
    return false;
  }, `fake server did not receive thread/start; stdout=${stdout} stderr=${stderr}`);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await new Promise(resolve => child.once('close', resolve));
  const restarted = await invoke(config, { ...env, LOOMHELM_FIXTURE_MODE: 'complete' }, ['codex', 'dispatch', 'dispatch-crash', request('Crash boundary', { timeoutMs: 1000 })]);
  assert.equal(restarted.code, 2);
  assert.equal(restarted.output.state, 'unknown');
  assert.equal(restarted.output.threadId, null);
  assert.match(restarted.output.detail, /automatic retry is disabled/);
  assert.equal((await logEntries(env.LOOMHELM_FIXTURE_LOG)).filter(entry => entry.method === 'thread/start').length, 1);
  const approve = await invoke(config, env, ['codex', 'approve', restarted.output.dispatchId]);
  assert.equal(approve.code, 1);
  assert.match(approve.output.error, /no known thread ID/);
}));

test('legacy flow arguments fail without changing old state; local validation is explicitly scoped', async () => temporary(async dir => {
  const { config } = await setup(dir);
  const legacy = join(dir, 'state', 'task-flow'); await mkdir(legacy, { recursive: true });
  const old = '{"schemaVersion":1,"tasks":[]}';
  await writeFile(join(legacy, 'orchestration.json'), old);
  const rejected = await invoke(config, process.env, ['flow', 'schedule']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /FLOW_LEGACY_ARGUMENTS_UNSUPPORTED/);
  assert.equal(await readFile(join(legacy, 'orchestration.json'), 'utf8'), old);
  const oldWorkflow = await invoke(config, process.env, ['workflow', 'verify', 'unused']);
  assert.equal(oldWorkflow.code, 1);
  assert.match(oldWorkflow.stderr, /WORKFLOW_LEGACY_COMMAND_UNSUPPORTED/);

  const repository = join(dir, 'repository'); await mkdir(repository);
  const git = async (...gitArgs) => {
    const result = await runProcess('git', ['-C', repository, ...gitArgs]);
    assert.equal(result.code, 0, result.stderr); return result;
  };
  await git('init', '-b', 'main');
  await git('-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  await git('switch', '-c', 'th/workflow-test');
  const manifest = join(dir, 'workflow.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, repository: './repository', base: 'main', contracts: [
    { kind: 'spec', disposition: 'not-needed', reason: 'CLI fixture', paths: [] },
    { kind: 'adr', disposition: 'not-needed', reason: 'CLI fixture', paths: [] },
  ], implementation: 'CLI fixture implementation', validations: [{ id: 'node', command: process.execPath, args: ['-e', 'process.stdout.write("verified")'] }] }));
  const workflow = await invoke(config, process.env, ['workflow', 'local-verify', manifest]);
  assert.equal(workflow.code, 0, workflow.stderr);
  assert.equal(workflow.output.readiness.ready, true);
  assert.equal(workflow.output.receipts[0].stdout, 'verified');
}));
