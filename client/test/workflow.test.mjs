import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkflow, loadSkills, requireSkill, satisfiesVersion } from '../dist/workflow/index.js';
import { runProcess } from '../dist/runtime/process.js';

async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'loomhelm-workflow-'));
  try { await fn(await realpath(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function skill(root, name, manifest, body = '# Body') {
  const path = join(root, name); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: "Test skill"\n---\n${body}\n`);
  if (manifest !== undefined) await writeFile(join(path, 'loomhelm.json'), JSON.stringify(manifest));
  return path;
}
const compatible = (version = '1.2.3', scopes = ['project', 'user']) => ({ schemaVersion: 1, version, scopes });
const decisions = [
  { kind: 'spec', disposition: 'link', reason: 'Existing fixture contract', paths: ['SPEC.md'] },
  { kind: 'adr', disposition: 'not-needed', reason: 'No architectural change', paths: [] },
];
const command = (id, source, options = {}) => ({ id, command: process.execPath, args: ['-e', source], ...options });
async function fixture(dir) {
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = async args => {
    const result = await runProcess('git', ['-C', repo, ...args]);
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git(['init', '-b', 'feat/workflow-test']);
  await writeFile(join(repo, 'SPEC.md'), 'Fixture acceptance');
  await git(['add', 'SPEC.md']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
  const base = await git(['rev-parse', 'HEAD']);
  return { repo, git, base, workflow: await LocalWorkflow.open(repo, base) };
}
async function prepared(dir) {
  const value = await fixture(dir);
  await value.workflow.settleContracts(decisions);
  await value.workflow.recordImplementation('Implemented the fixture');
  return value;
}

test('project override, user fallback, symlink installation and content fingerprints', () => temporary(async dir => {
  const project = join(dir, 'project'), user = join(dir, 'user');
  await skill(user, 'shared', compatible('1.0.0'));
  await skill(project, 'shared', compatible('2.0.0'));
  await skill(user, 'legacy');
  const linked = await skill(join(dir, 'packages'), 'linked', compatible());
  await symlink(linked, join(user, 'linked'));
  const catalog = await loadSkills({ project, user });
  assert.deepEqual(catalog.diagnostics, []);
  const shared = requireSkill(catalog, 'shared', { range: '^2.0.0', scopes: ['project'] });
  assert.equal(shared.scope, 'project');
  assert.equal(requireSkill(catalog, 'linked').path, join(linked, 'SKILL.md'));
  assert.equal(requireSkill(catalog, 'legacy').version, null);
  assert.throws(() => requireSkill(catalog, 'legacy', { range: '*' }), /unknown/);
  assert.throws(() => requireSkill(catalog, 'shared', { range: '^1.0.0' }), /mismatch/);
  assert.throws(() => requireSkill(catalog, 'shared', { scopes: ['user'] }), /scope mismatch/);
  await skill(project, 'shared', compatible('2.0.0'), '# Changed');
  assert.notEqual(requireSkill(await loadSkills({ project }), 'shared').digest, shared.digest);
  assert.deepEqual(await loadSkills({ project: join(dir, 'absent') }), { skills: [], diagnostics: [] });
}));

test('invalid project overrides fail closed; scope, schema and identity checked', () => temporary(async dir => {
  const project = join(dir, 'project'), user = join(dir, 'user');
  await skill(user, 'restricted', compatible());
  await skill(project, 'restricted', compatible('1.0.0', ['user']));
  await skill(project, 'future', { schemaVersion: 2, version: '1.0.0', scopes: ['project'] });
  const wrong = await skill(project, 'wrong', compatible());
  await writeFile(join(wrong, 'SKILL.md'), '---\nname: other\ndescription: Wrong\n---\n');
  const bad = await skill(project, 'broken', compatible());
  await writeFile(join(bad, 'loomhelm.json'), '{');
  const catalog = await loadSkills({ project, user });
  assert.equal(catalog.skills.length, 0); assert.equal(catalog.diagnostics.length, 4);
  assert.throws(() => requireSkill(catalog, 'restricted'), /unavailable/);
}));

test('version ranges have strict parsing and correct zero-major bounds', () => {
  for (const [version, range, expected] of [
    ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false], ['1.3.0', '~1.2.3', false],
    ['1.2.3', '>=1.0.0 <2.0.0', true], ['1.2.3', '1.2.3', true],
    ['1.2.3', '*', true], ['1.2.3', '<=1.2.3', true], ['1.2.3', '>1.2.3', false],
  ]) assert.equal(satisfiesVersion(version, range), expected, `${version} ${range}`);
  for (const range of ['', '1.x', '>=2.0.0 rubbish', '1.2.3 || 2.0.0']) assert.throws(() => satisfiesVersion('1.2.3', range));
  for (const version of ['01.2.3', '1.0.0-beta', '9007199254740992.0.0']) assert.throws(() => satisfiesVersion(version, '*'));
});

test('stages enforce contracts, implementation, required validation and immutable snapshots', () => temporary(async dir => {
  const { workflow, repo, base } = await fixture(dir);
  assert.equal((await workflow.readiness()).firstUnfinishedGate, 'durable-contracts');
  await assert.rejects(workflow.validate([command('test', '')]), /Implementation/);
  await assert.rejects(workflow.recordImplementation('premature'), /contracts/);
  await assert.rejects(workflow.settleContracts([decisions[0]]), /dispositions/);
  await workflow.settleContracts(decisions); await workflow.recordImplementation('Implemented');
  const snapshot = await workflow.validate([
    command('test', 'process.stdout.write(process.cwd())'),
    command('optional', 'process.exit(4)', { required: false }),
  ]);
  assert.equal(snapshot.stage, 'can-open-pr');
  assert.equal(snapshot.receipts[0].stdout, repo); assert.equal(snapshot.receipts[0].head, base);
  assert.equal(snapshot.receipts[1].status, 'failed');
  assert.equal((await workflow.readiness()).ready, true);
  snapshot.receipts[0].status = 'failed'; assert.equal(workflow.snapshot().receipts[0].status, 'passed');
  await workflow.settleContracts(decisions); assert.equal(workflow.snapshot().stage, 'delivery-slices');
  assert.equal(workflow.snapshot().receipts.length, 0);
}));

test('nonzero, timeout, output limit, missing executable and optional-only cannot pass', () => temporary(async dir => {
  const { workflow } = await prepared(dir);
  for (const entry of [command('exit', 'console.error("fail");process.exit(7)'),
    command('timeout', 'setInterval(()=>{},1000)', { timeoutMs: 100 }),
    command('output', 'console.log("x".repeat(5000))', { maxOutputBytes: 10 }),
    { id: 'missing', command: 'loomhelm-does-not-exist', args: [] }]) {
    const snapshot = await workflow.validate([entry]);
    assert.equal(snapshot.stage, 'validation'); assert.equal(snapshot.receipts[0].status, 'failed');
    assert.equal((await workflow.readiness()).ready, false);
  }
  assert.equal((await workflow.validate([command('optional', '', { required: false })])).stage, 'validation');
  await assert.rejects(workflow.validate([]), /entries/);
  await assert.rejects(workflow.validate([command('dup', ''), command('dup', '')]), /duplicate/);
}));

test('dirty state and moved clean HEAD invalidate prior validation', () => temporary(async dir => {
  const { workflow, repo, git } = await prepared(dir);
  await workflow.validate([command('pass', '')]);
  await writeFile(join(repo, 'dirty'), 'preserve');
  assert.equal((await workflow.readiness()).ready, false);
  await assert.rejects(workflow.validate([command('test', '')]), /dirty/);
  assert.equal(await readFile(join(repo, 'dirty'), 'utf8'), 'preserve');
  await git(['add', 'dirty']); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'change']);
  await workflow.validate([command('pass', '')]);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'advance']);
  const readiness = await workflow.readiness(); assert.equal(readiness.ready, false); assert.match(readiness.reason, /stale/);
}));

test('validation modifying candidate cannot pass even when optional', () => temporary(async dir => {
  const { workflow, repo } = await prepared(dir);
  const snapshot = await workflow.validate([command('required', ''), command('mutate', 'require("fs").writeFileSync("unexpected", "change")', { required: false })]);
  assert.equal(snapshot.stage, 'validation');
  assert.equal(snapshot.receipts[1].candidateUnchanged, false);
  assert.equal(await readFile(join(repo, 'unexpected'), 'utf8'), 'change');
}));

test('contract drift and symlink escape fail closed', () => temporary(async dir => {
  const { workflow, repo, git } = await fixture(dir);
  await writeFile(join(dir, 'outside'), 'external');
  await symlink(join(dir, 'outside'), join(repo, 'escape'));
  await git(['add', 'escape']); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'escape fixture']);
  await assert.rejects(workflow.settleContracts([{ ...decisions[0], paths: ['escape'] }, decisions[1]]), /escapes/);
  await workflow.settleContracts(decisions); await workflow.recordImplementation('Implemented');
  await writeFile(join(repo, 'SPEC.md'), 'changed contract');
  await git(['add', 'SPEC.md']); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'contract changed']);
  await assert.rejects(workflow.validate([command('test', '')]), /Contract changed/);
  assert.equal((await workflow.readiness()).firstUnfinishedGate, 'durable-contracts');
}));

test('cancellation and concurrent operations preserve a non-ready gate', () => temporary(async dir => {
  const { workflow } = await prepared(dir);
  const controller = new AbortController();
  const pending = workflow.validate([command('wait', 'setInterval(()=>{},1000)')], controller.signal);
  await assert.rejects(workflow.validate([command('other', '')]), /in progress/);
  setTimeout(() => controller.abort(), 100);
  const snapshot = await pending;
  assert.equal(snapshot.stage, 'validation'); assert.equal(snapshot.receipts[0].status, 'interrupted');
}));

test('entry refuses default, detached, dirty and unrelated bases', () => temporary(async dir => {
  const { repo, git, base } = await fixture(dir);
  await git(['switch', '-c', 'main']); await assert.rejects(LocalWorkflow.open(repo, base), /Topic/);
  await git(['switch', '--detach', base]); await assert.rejects(LocalWorkflow.open(repo, base), /Topic/);
  await git(['switch', 'feat/workflow-test']);
  await writeFile(join(repo, 'dirty'), 'keep'); await assert.rejects(LocalWorkflow.open(repo, base), /Clean/);
  await rm(join(repo, 'dirty'));
  await assert.rejects(LocalWorkflow.open(repo, '--all'), /Explicit/);
  await assert.rejects(LocalWorkflow.open(repo, 'missing'), /resolve base/);
}));

const cliPath = new URL('../dist/workflow/cli.js', import.meta.url).pathname;
test('Node/Bun standalone CLI checks Skills then validates offline with JSON output', () => temporary(async dir => {
  const { repo, base } = await fixture(dir);
  const skillsRoot = join(dir, 'skills'); await skill(skillsRoot, 'engineering', compatible());
  const manifest = {
    schemaVersion: 1, repository: repo, base,
    skills: { project: skillsRoot, requirements: [{ name: 'engineering', range: '^1.0.0', scopes: ['project'] }] },
    contracts: decisions, implementation: 'Fixture implementation', validations: [command('test', 'console.log("verified")')],
  };
  const path = join(dir, 'workflow.json'); await writeFile(path, JSON.stringify(manifest));
  let result = await runProcess(process.execPath, [cliPath, 'verify', path]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout); assert.equal(output.readiness.ready, true);
  assert.equal(output.selectedSkills[0].version, '1.2.3');
  assert.equal(output.receipts[0].stdout.trim(), 'verified');
  manifest.validations = [command('fail', 'process.exit(9)')]; await writeFile(path, JSON.stringify(manifest));
  result = await runProcess(process.execPath, [cliPath, 'verify', path]);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).receipts[0].code, 9);
  manifest.skills.requirements[0].range = '^2.0.0'; await writeFile(path, JSON.stringify(manifest));
  result = await runProcess(process.execPath, [cliPath, 'verify', path]);
  assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /version mismatch/);
  result = await runProcess(process.execPath, [cliPath, 'skills', skillsRoot]);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).skills[0].name, 'engineering');
}));
