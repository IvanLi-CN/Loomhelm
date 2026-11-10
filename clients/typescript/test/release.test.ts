import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { compatibilityDistTag, isCompatibilityDistTag, isExactSemVer, parseCompatibilityDistTag, parseExactSemVer, validatePublication } from '../src/release.ts';

test('accepts exact SemVer and rejects ranges, build metadata, and leading zeroes', () => {
  assert.equal(isExactSemVer('1.2.3'), true);
  assert.equal(isExactSemVer('1.2.3-rc.1'), true);
  assert.equal(isExactSemVer('^1.2.3'), false);
  assert.equal(isExactSemVer('1.2.3+build.4'), false);
  assert.equal(isExactSemVer('1.2.3-01'), false);
  assert.deepEqual(parseExactSemVer('2.4.6'), { major: 2, minor: 4, patch: 6, prerelease: null, text: '2.4.6' });
});

test('supports compatibility dist-tags without confusing them with versions', () => {
  assert.equal(compatibilityDistTag(4), 'compat-v4');
  assert.equal(parseCompatibilityDistTag('compat-v12'), 12);
  assert.equal(isCompatibilityDistTag('compat-v1'), true);
  assert.equal(isCompatibilityDistTag('compat-v0'), false);
  assert.equal(isCompatibilityDistTag('latest'), false);
  assert.deepEqual(validatePublication('1.2.3', 'compat-v2').distTag, 'compat-v2');
  assert.throws(() => validatePublication('1.2.3', 'next'), /Invalid compatibility dist-tag/);
});
