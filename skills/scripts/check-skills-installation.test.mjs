import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkSkillsInstallation } from './check-skills-installation.mjs';

test('only skills/ supplies source, compiled entries, native support and contracts', () => {
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'loomhelm-skills-only-')));
  const source = resolve(import.meta.dirname, '..');
  const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
  try {
    cpSync(source, join(isolated, 'skills'), { recursive: true, filter: path => !['node_modules', '.cache'].includes(path.split('/').at(-1)) });
    execFileSync('npm', ['ci', '--prefix', join(isolated, 'skills'), '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'pipe' });
    const report = checkSkillsInstallation(isolated);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.requiredSparsePaths, ['skills']);
    assert.equal(report.skills, 29);
    assert.deepEqual(report.escapedImports, []);
    assert.equal(existsSync(join(isolated, 'bin')), false);
    assert.equal(existsSync(join(isolated, 'docs')), false);
    const env = { ...process.env, PATH: '/usr/bin:/bin', CODEX_HOME: join(isolated, 'absent-codex-home') };
    const run = (runtime, script, args, input = '') => spawnSync(runtime, [join(isolated, 'skills', script), ...args], { cwd: isolated, env, input, encoding: 'utf8', timeout: 30000 });
    const sourceContext = run(bun, 'dot-codex-development/scripts/context.ts', ['--help']);
    assert.equal(sourceContext.status, 0, sourceContext.stderr);
    const plan = readFileSync(join(isolated, 'skills/dev-plan/references/plan-cases/positive-fast-track.md'), 'utf8');
    for (const runtime of [process.execPath, bun]) {
      const context = run(runtime, 'dot-codex-development/scripts/context.js', ['--help']);
      assert.equal(context.status, 0, context.stderr);
      const check = run(runtime, 'bin/plan_contract_check.js', ['--plan', '-'], plan);
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /PASS/);
      const invalid = run(runtime, 'multi-task-flow/scripts/orchestrate.js', ['view', '--input', '-'], '{}');
      assert.equal(invalid.status, 2, invalid.stderr);
      assert.equal(JSON.parse(invalid.stdout).code, 'INVALID_INPUT');
    }
    // Recreate the original packaging mistake and require a specific failure.
    renameSync(join(isolated, 'skills/bin'), join(isolated, 'bin'));
    const broken = checkSkillsInstallation(isolated);
    assert.equal(broken.ok, false);
    assert.ok(broken.missing.includes('skills/bin/compatibility_cli.ts'));
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
