import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsRuntime } from '../dist/index.js';

const runtime = new SkillsRuntime();
test('packaged catalog contains all approved Skills and rejects path escape', async () => {
  const skills = await runtime.list();
  assert.equal(skills.length, 29);
  assert.ok(skills.some(skill => skill.name === 'dev-plan'));
  assert.ok(skills.some(skill => skill.name === 'multi-task-flow'));
  await assert.rejects(runtime.run('../bin/plan_contract_check.ts', []), /Unknown toolkit script/);
});

test('packaged plan checker preserves stdin pass and rejection without invoking Bun', async () => {
  const plan = await readFile(join(runtime.root, 'skills/dev-plan/references/plan-cases/positive-fast-track.md'), 'utf8');
  const pass = await runtime.run('bin/plan_contract_check.ts', ['--plan', '-'], { input: plan });
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /PASS/);
  const reject = await runtime.run('bin/plan_contract_check.ts', ['--plan', '-'], { input: 'invalid' });
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
