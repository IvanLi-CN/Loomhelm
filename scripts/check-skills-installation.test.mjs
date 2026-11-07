import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkSkillsInstallation } from './check-skills-installation.mjs';

test('vendor discovery alone omits runtime resources; explicit sparse paths restore them', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'loomhelm-skills-layout-')));
  const vendor = join(temporary, 'vendor');
  const source = resolve(import.meta.dirname, '..');
  const git = (...args) => execFileSync('git', ['-C', vendor, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', source, vendor], { stdio: 'pipe' });
    git('sparse-checkout', 'init', '--cone');
    git('sparse-checkout', 'set', 'skills');
    git('checkout', 'HEAD');
    const broken = checkSkillsInstallation(vendor);
    assert.equal(broken.code, 'SKILLS_INSTALLATION_INCOMPLETE');
    assert.ok(broken.missing.includes('bin/compatibility_cli.ts'));
    const helper = join(vendor, 'skills/dot-codex-development/scripts/context.ts');
    const before = spawnSync('bun', [helper, '--help'], { encoding: 'utf8' });
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /Cannot find module.*compatibility_cli/);

    git('sparse-checkout', 'set', ...broken.requiredSparsePaths);
    const restored = checkSkillsInstallation(vendor);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.skills, 29);
    const after = spawnSync('bun', [helper, '--help'], { encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /Usage:/);
    assert.equal(git('status', '--porcelain').trim(), '');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
