import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityDigest, PACKAGE_NAME, validatePackageIdentity, type PackageIdentity } from './release.ts';

type JsonObject = Record<string, unknown>;
type Contracts = Readonly<{ ledger: number | null; api: number | null; frontend: number | null; viewer: number | null; service: string | null }>;

function readJson(path: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
function validatedArtifactIdentity(): PackageIdentity | null {
  const artifact = readJson(resolve(packageRoot, 'toolkit/artifact-manifest.json'));
  if (!artifact || artifact.schemaVersion !== 3 || artifact.dependenciesBundled !== false || artifact.canonicalDigestAlgorithm !== 'path-byte-v2' || !Array.isArray(artifact.dependencies) || artifact.dependencies.length === 0 || artifact.dependencies.some(item => !item || typeof item !== 'object' || typeof (item as JsonObject).name !== 'string' || typeof (item as JsonObject).version !== 'string' || (item as JsonObject).mode !== 'consumer-install') || !Array.isArray(artifact.files)) return null;
  try {
    const identity = validatePackageIdentity(artifact.identity);
    if (artifact.packageName !== identity.packageName || artifact.packageVersion !== identity.packageVersion || artifact.compatibilityLine !== identity.compatibilityLine || artifact.skillVersion !== identity.skillVersion || artifact.sourceSha !== identity.sourceSha || artifact.mergeSha !== identity.mergeSha || artifact.dirty !== identity.dirty || artifact.buildId !== identity.buildId || artifact.tarballDigest !== identity.tarballDigest || artifact.gitTag !== identity.gitTag || artifact.canonicalDigestAlgorithm !== identity.canonicalDigestAlgorithm) return null;
    const { buildId, ...withoutBuildId } = identity;
    return identityDigest({ ...withoutBuildId, files: artifact.files as { path: string; sha256: string }[] }) === buildId ? identity : null;
  } catch {
    return null;
  }
}

const identity = validatedArtifactIdentity();
const contracts: Contracts = Object.freeze(identity ? {
  ledger: identity.contracts.ledgerContract,
  api: identity.contracts.apiVersion,
  frontend: identity.contracts.frontendContract,
  viewer: identity.contracts.viewerContract,
  service: identity.contracts.serviceVersion,
} : { ledger: null, api: null, frontend: null, viewer: null, service: null });

export const buildInfo = Object.freeze(identity ? {
  package_name: identity.packageName,
  version: identity.packageVersion,
  source_sha: identity.sourceSha,
  merge_sha: identity.mergeSha,
  compatibility_line: identity.compatibilityLine,
  skill_version: identity.skillVersion,
  build_id: identity.buildId,
  tarball_digest: identity.tarballDigest,
  canonical_digest_algorithm: identity.canonicalDigestAlgorithm ?? null,
  contracts,
  policy: 'loomhelm-manual-v1',
} : {
  package_name: PACKAGE_NAME,
  version: 'dev',
  source_sha: 'unknown',
  merge_sha: null,
  compatibility_line: 'unknown',
  skill_version: 'unknown',
  build_id: null,
  tarball_digest: null,
  canonical_digest_algorithm: null,
  contracts,
  policy: 'loomhelm-manual-v1',
});
