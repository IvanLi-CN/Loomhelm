import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalTarballDigest, packPackageTarball, removeTarballDirectory } from '../src/release-tarball.ts';
import { CANONICAL_TARBALL_DIGEST_ALGORITHM, compatibilityDistTag, identityDigest, isCompatibilityDistTag, isExactSemVer, parseCompatibilityDistTag, parseExactSemVer, validatePackageIdentity, validatePublication } from '../src/release.ts';

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
    dirty: false,
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
  assert.equal(validatePackageIdentity({ ...identity, canonicalDigestAlgorithm: CANONICAL_TARBALL_DIGEST_ALGORITHM }).canonicalDigestAlgorithm, CANONICAL_TARBALL_DIGEST_ALGORITHM);
  assert.throws(() => validatePackageIdentity({ ...identity, canonicalDigestAlgorithm: 'unknown' }), /canonicalDigestAlgorithm/);
});

test('release validation binds the requested version to the packaged artifact', () => {
  const cli = resolve(import.meta.dir, '../src/cli.ts');
  const mismatched = spawnSync(process.execPath, ['--no-install', cli, 'release', 'validate', '--version', '9.9.9'], { encoding: 'utf8' });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr + mismatched.stdout, /Publication version does not match artifact version/);

  const missingProvenance = spawnSync(process.execPath, ['--no-install', cli, 'release', 'validate', '--version', '0.2.8', '--require-provenance'], { encoding: 'utf8' });
  assert.notEqual(missingProvenance.status, 0);
  assert.match(missingProvenance.stderr + missingProvenance.stdout, /Publication requires (a clean toolkit artifact|artifact merge provenance)/);
});

test('publication digest is computed from real npm-compatible tarball contents', { timeout: 30_000 }, () => {
  const packageRoot = resolve(import.meta.dir, '..');
  const first = packPackageTarball(packageRoot);
  const second = packPackageTarball(packageRoot);
  try {
    const firstDigest = canonicalTarballDigest(first);
    assert.match(firstDigest, /^[a-f0-9]{64}$/);
    assert.equal(canonicalTarballDigest(second), firstDigest);
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { scripts?: { 'publish:exact'?: string; 'publish:compat'?: string } };
    assert.equal(packageJson.scripts?.['publish:exact'], undefined);
    assert.equal(packageJson.scripts?.['publish:compat'], undefined);
    const cli = resolve(packageRoot, 'src/cli.ts');
    const directPublish = spawnSync(process.execPath, ['--no-install', cli, 'release', 'publish', '--dist-tag', '0.2.8'], { encoding: 'utf8' });
    assert.notEqual(directPublish.status, 0);
    assert.match(directPublish.stderr + directPublish.stdout, /Direct npm publication is disabled/);
  } finally {
    removeTarballDirectory(first);
    removeTarballDirectory(second);
  }
});
