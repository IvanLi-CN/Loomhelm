import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsRuntime } from '../dist/index.js';
import { spawnSync } from 'node:child_process';

const runtime = new SkillsRuntime();
test('missing external commands block readiness and CLI without executing or installing tools', async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    const report = await runtime.check('git-cleanup', []);
    assert.equal(report.ready, false);
    assert.equal(report.readinessScope, 'all-declared-scenarios');
    assert.ok(report.dependencies.some(dep => dep.kind === 'command' && dep.skill === 'gh' && !dep.available && dep.code === 'HOST_COMMAND_UNAVAILABLE'));
    const result = spawnSync(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname, 'skills', 'check', 'git-cleanup'], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr);
    assert.equal(JSON.parse(result.stdout).ready, false);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test('native host tools require an explicit host advertisement, not just installed resources', async () => {
  const unknown = await runtime.check('fresh-thread-dispatch', []);
  assert.equal(unknown.ready, false);
  assert.ok(unknown.dependencies.some(dep => dep.skill === 'mcp__codex_app__create_thread' && dep.code === 'HOST_CAPABILITY_UNVERIFIED'));
  const advertised = await runtime.check('fresh-thread-dispatch', [], ['mcp__codex_app__create_thread']);
  assert.equal(advertised.ready, advertised.nativeSupported);
  assert.equal(advertised.dependencies.find(dep => dep.kind === 'host').code, 'HOST_ADVERTISED');
});
test('packaged catalog contains all approved Skills and rejects path escape', async () => {
  const skills = await runtime.list();
  assert.equal(skills.length, 29);
  assert.ok(skills.some(skill => skill.name === 'dev-plan'));
  assert.ok(skills.some(skill => skill.name === 'multi-task-flow'));
  await assert.rejects(runtime.run('../bin/plan_contract_check.ts', []), /Unknown toolkit script/);
});

test('packaged plan checker preserves stdin pass and rejection without invoking Bun', async () => {
  const plan = await readFile(join(runtime.root, 'skills/dev-plan/references/plan-cases/positive-fast-track.md'), 'utf8');
  const pass = await runtime.run('skills/bin/plan_contract_check.ts', ['--plan', '-'], { input: plan });
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /PASS/);
  const reject = await runtime.run('skills/bin/plan_contract_check.ts', ['--plan', '-'], { input: 'invalid' });
  assert.equal(reject.code, 1, reject.stderr);
  assert.match(reject.stdout, /MISSING_FLOW_TYPE/);
});

test('canonical ledger initializes and reads unchanged schema2/contract2 state across child runtimes', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'loomhelm-canonical-')));
  try {
    const input = await readFile(join(runtime.root, 'skills/multi-task-flow/examples/ledger-initialization/initial.json'), 'utf8');
    const env = { ...process.env, TASK_ORCHESTRATION_DATA_ROOT: dir };
    const initialized = await runtime.run('skills/multi-task-flow/scripts/orchestrate.ts', ['init', '--input', '-'], { input, env });
    assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr);
    const path = join(dir, 'runs/example-run/ledger.json');
    const before = await readFile(path, 'utf8');
    const ledger = JSON.parse(before);
    assert.equal(ledger.schema_version, 2); assert.equal(ledger.contract_version, 2);
    const viewed = await runtime.run('skills/multi-task-flow/scripts/orchestrate.ts', ['show', '--input', '-'], { input: JSON.stringify({ run_id: 'example-run', actor: { role: 'main', thread_id: 'example-main-thread' } }), env });
    assert.equal(viewed.code, 0, viewed.stdout + viewed.stderr);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
