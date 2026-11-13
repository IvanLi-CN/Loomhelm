import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'bun:test';

test('the installable Skill tree excludes npm runtime resources', () => {
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'loomhelm-skills-only-')));
  const source = resolve(import.meta.dirname, '../../multi-task-flow');
  try {
    cpSync(source, join(isolated, 'multi-task-flow'), { recursive: true });
    assert.equal(existsSync(join(isolated, 'multi-task-flow', 'SKILL.md')), true);
    for (const name of ['data', 'dist', 'examples', 'lib', 'scripts', 'tests', 'web', 'package.json', 'bun.lock']) {
      assert.equal(existsSync(join(isolated, 'multi-task-flow', name)), false, name);
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}, 60000);
