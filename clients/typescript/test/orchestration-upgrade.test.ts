import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/runtime/process.ts';

const cli = process.env.MULTI_TASK_FLOW_CANDIDATE_CLI ?? resolve('src/cli.ts');
test('packaged CLI fences old bindings, diagnoses without writes, and explicitly migrates forward', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'loomhelm-forward-upgrade-')));
  const env = { ...process.env, MULTI_TASK_FLOW_PROFILE: 'test', MULTI_TASK_FLOW_ROOT: root, TASK_ORCHESTRATION_DATA_ROOT: join(root, 'data') };
  const invoke = async (args: string[], input?: unknown) => {
    const result = await runProcess(process.execPath, [cli, ...args], { env, ...(input === undefined ? {} : { input: JSON.stringify(input) }), timeoutMs: 15_000 });
    return { ...result, text: result.stdout + result.stderr };
  };
  try {
    const input = JSON.parse(await readFile(new URL('../../../packages/multi-task-flow-runtime/examples/ledger-initialization/initial.json', import.meta.url), 'utf8'));
    const initialized = await invoke(['flow', 'init', '--input', '-'], input);
    assert.equal(initialized.code, 0, initialized.text);
    const runPath = join(root, 'data/runs/example-run');
    const ledgerPath = join(runPath, 'ledger.json');
    const bindingPath = join(runPath, 'runtime/viewer-binding.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    assert.equal(ledger.contract_version, 4);
    assert.equal(binding.schema_version, 2);
    const version = binding.package_version;
    // Disposable historical source fixture; no live run or global package is modified.
    ledger.contract_version = 3; delete ledger.runtime_identity;
    binding.schema_version = 1; binding.ledger_contract = 3; binding.package_version = '0.2.53';
    binding.build_id = 'a'.repeat(64); binding.source_sha = 'a'.repeat(40);
    await writeFile(ledgerPath, JSON.stringify(ledger)); await writeFile(bindingPath, JSON.stringify(binding));
    const before = [await readFile(ledgerPath, 'utf8'), await readFile(bindingPath, 'utf8')];
    const query = { run_id: 'example-run', actor: { role: 'main', thread_id: 'example-main-thread' } };
    const refused = await invoke(['flow', 'show', '--input', '-'], query);
    assert.notEqual(refused.code, 0); assert.match(refused.text, /RUN_VERSION_MISMATCH/);
    const checked = await invoke(['orchestration', 'compatibility-check', '--run-id', 'example-run']);
    assert.equal(checked.code, 0, checked.text); assert.equal(JSON.parse(checked.stdout).result.compatible, false);
    const dry = await invoke(['orchestration', 'upgrade', '--run-id', 'example-run', '--dry-run', version]);
    assert.equal(dry.code, 0, dry.text);
    assert.deepEqual([await readFile(ledgerPath, 'utf8'), await readFile(bindingPath, 'utf8')], before);
    const upgraded = await invoke(['orchestration', 'upgrade', '--run-id', 'example-run', version]);
    assert.equal(upgraded.code, 0, upgraded.text);
    const migrated = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(migrated.upgrade.phase, 'completed'); assert.equal(migrated.runtime_identity.package_version, version);
    assert.equal((await readdir(join(root, 'data/runs'))).filter(name => name.startsWith('.upgrade-')).length, 1);
    const shown = await invoke(['flow', 'show', '--input', '-'], query); assert.equal(shown.code, 0, shown.text);
    const replay = await invoke(['orchestration', 'upgrade', '--run-id', 'example-run', version]);
    assert.equal(replay.code, 0, replay.text); assert.equal(JSON.parse(replay.stdout).result.changed, false);
    const rollback = await invoke(['orchestration', 'upgrade', '--run-id', 'example-run', '--rollback', '0.2.53']);
    assert.notEqual(rollback.code, 0); assert.match(rollback.text, /DOWNGRADE_FORBIDDEN/);
    // Same version, different build must reject ordinary reads as well.
    const changed = JSON.parse(await readFile(bindingPath, 'utf8')); changed.build_id = 'f'.repeat(64);
    await writeFile(bindingPath, JSON.stringify(changed));
    const mismatch = await invoke(['flow', 'show', '--input', '-'], query);
    assert.notEqual(mismatch.code, 0); assert.match(mismatch.text, /RUN_VERSION_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
