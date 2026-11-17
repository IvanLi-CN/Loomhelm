import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/runtime/process.ts';
const fixture = resolve('test/fixtures/cli-output-runtime.ts');
async function isolated(fn: (config: string, log: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-human-'));
  try {
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, stateDir: join(dir, 'state') }));
    await fn(config, join(dir, 'calls.jsonl'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function invoke(config: string, log: string, args: string[], input?: string) {
  return runProcess(process.execPath, [fixture, '--config', config, ...args], { env: { ...process.env, CLI_OUTPUT_CALL_LOG: log }, ...(input === undefined ? {} : { input }) });
}
test('query shorthand and stdin reach the same runtime with explicit identity', async () => isolated(async (config, log) => {
  const r = await invoke(config, log, ['--output', 'human', 'flow', 'show', '--run-id', 'demo', '--actor-role', 'main', '--thread-id', 'bound-thread']);
  expect(r.code).toBe(0); expect(r.stdout).toContain('运行：demo'); expect(r.stdout).toContain('已静止：否'); expect(r.stderr).toBe('');
  const request = { run_id: 'demo', actor: { role: 'main', thread_id: 'bound-thread' }, section: 'summary' };
  const j = await invoke(config, log, ['flow', 'show', '--output', 'json', '--input', '-'], JSON.stringify(request));
  expect(j.code).toBe(0); expect(JSON.parse(j.stdout).result.section).toBe('summary');
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toHaveLength(2); expect(calls[0].input).toEqual(calls[1].input); expect(calls[0].args).toEqual(['show', '--input', '-']);
}));
test('legacy JSON default stays full and actor failures preserve code while human uses stderr', async () => isolated(async (config, log) => {
  const request = { run_id: 'demo', actor: { role: 'main', thread_id: 'bound-thread' } };
  const old = await invoke(config, log, ['--output', 'json', 'flow', 'show', '--input', '-'], JSON.stringify(request));
  expect(JSON.parse(old.stdout).result.section).toBe('full');
  const invalid = ['flow', 'show', '--run-id', 'demo', '--actor-role', 'main', '--thread-id', 'wrong'];
  const json = await invoke(config, log, ['--output', 'json', ...invalid]);
  const human = await invoke(config, log, ['--output', 'human', ...invalid]);
  expect(json.code).toBe(3); expect(human.code).toBe(3); expect(JSON.parse(json.stdout).code).toBe('ACTOR_MISMATCH');
  expect(json.stderr).toBe(''); expect(human.stdout).toBe(''); expect(human.stderr).toContain('ACTOR_MISMATCH'); expect(human.stderr).toContain('核对');
}));
test('service status/doctor compile to empty JSON without reading stdin', async () => isolated(async (config, log) => {
  for (const name of ['status', 'doctor']) {
    const r = await invoke(config, log, ['--output', 'human', 'service', name]);
    expect(r.code).toBe(0); expect(r.stdout).toContain('已安装：否');
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(c => c.input)).toEqual([{}, {}]);
}));
test('invalid or ambiguous input fails before any runtime invocation', async () => isolated(async (config, log) => {
  for (const args of [
    ['flow', 'show', '--run-id', 'demo'],
    ['flow', 'show', '--run-id', 'demo', '--actor-role', 'main', '--thread-id', 'bound-thread', '--input', '-'],
    ['--output', 'json', '--output', 'human', 'service', 'ensure'],
  ]) { const r = await invoke(config, log, args); expect(r.code).toBe(1); }
  await expect(readFile(log)).rejects.toThrow();
}));

test('real CLI preserves explicit JSON on simulated terminal parse errors', async () => isolated(async (config, log) => {
  for (const args of [['--output=json', '--color=invalid'], ['--color=invalid', '--output', 'json']]) {
    const r = await runProcess(process.execPath, [fixture, '--config', config, ...args, 'service', 'ensure'], {
      env: { ...process.env, CLI_OUTPUT_CALL_LOG: log, CLI_OUTPUT_TTY: '1', MULTI_TASK_FLOW_OUTPUT: 'human', CI: 'false', CONTINUOUS_INTEGRATION: 'false', CODEX_THREAD_ID: '', MULTI_TASK_FLOW_AGENT: '0' },
    });
    expect(r.code).toBe(1); expect(r.stdout).toBe(''); expect(JSON.parse(r.stderr).code).toBe('CLI_ERROR');
  }
  await expect(readFile(log)).rejects.toThrow();
}));
