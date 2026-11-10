import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { compatibilityDistTag, identityDigest, isCompatibilityDistTag, isExactSemVer, parseCompatibilityDistTag, parseExactSemVer, validatePackageIdentity, validatePublication } from '../src/release.ts';

test('accepts exact SemVer and rejects ranges, build metadata, and leading zeroes', () => {
  assert.equal(isExactSemVer('1.2.3'), true);
  assert.equal(isExactSemVer('1.2.3-rc.1'), true);
  assert.equal(isExactSemVer('^1.2.3'), false);
  assert.equal(isExactSemVer('1.2.3+build.4'), false);
  assert.equal(isExactSemVer('1.2.3-01'), false);
  assert.deepEqual(parseExactSemVer('2.4.6'), { major: 2, minor: 4, patch: 6, prerelease: null, text: '2.4.6' });
});

test('uses explicit compatibility tags without deriving them from package versions', () => {
  assert.equal(compatibilityDistTag(4), 'compat-v4');
  assert.equal(parseCompatibilityDistTag('compat-v12'), 12);
  assert.equal(isCompatibilityDistTag('compat-v1'), true);
  assert.equal(isCompatibilityDistTag('compat-v0'), false);
  assert.equal(isCompatibilityDistTag('latest'), false);
  assert.deepEqual(validatePublication('1.2.3', 'compat-v2').distTag, 'compat-v2');
  assert.throws(() => validatePublication('1.2.3', 'next'), /Invalid compatibility dist-tag/);
});

test('validates independent package identity dimensions', () => {
  const identity = {
    packageName: '@loomhelm/multi-task-flow',
    packageVersion: '0.1.0',
    compatibilityLine: 'compat-v1',
    skillVersion: '2.7.2',
    sourceSha: 'a'.repeat(40),
    mergeSha: null,
    contracts: { ledgerContract: 2, apiVersion: 1, frontendContract: 1, viewerContract: 5, serviceVersion: '1' },
    buildId: 'b'.repeat(64),
    tarballDigest: null,
    gitTag: null,
  } as const;
  assert.deepEqual(validatePackageIdentity(identity), identity);
  const { buildId: _buildId, ...identityWithoutBuildId } = identity;
  assert.equal(identityDigest({ ...identityWithoutBuildId, files: [{ path: 'a', sha256: 'c'.repeat(64) }] }).length, 64);
  assert.throws(() => validatePackageIdentity({ ...identity, compatibilityLine: 'compat-v0' }), /compatibility/);
  assert.throws(() => validatePackageIdentity({ ...identity, mergeSha: 'not-a-sha' }), /mergeSha/);
});
