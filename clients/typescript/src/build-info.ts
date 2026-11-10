import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = readJson(resolve(packageRoot, 'package.json')) ?? {};
const packageMetadata = packageJson.loomhelm && typeof packageJson.loomhelm === 'object' ? packageJson.loomhelm as JsonObject : {};
const packageContracts = packageMetadata.contracts && typeof packageMetadata.contracts === 'object' ? packageMetadata.contracts as JsonObject : {};
const artifact = readJson(resolve(packageRoot, 'toolkit/artifact-manifest.json')) ?? {};
const artifactIdentity = artifact.identity && typeof artifact.identity === 'object' ? artifact.identity as JsonObject : {};
const artifactContracts = artifactIdentity.contracts && typeof artifactIdentity.contracts === 'object' ? artifactIdentity.contracts as JsonObject : {};

const contracts: Contracts = Object.freeze({
  ledger: typeof artifactContracts.ledgerContract === 'number' ? artifactContracts.ledgerContract : typeof packageContracts.ledger === 'number' ? packageContracts.ledger : null,
  api: typeof artifactContracts.apiVersion === 'number' ? artifactContracts.apiVersion : typeof packageContracts.api === 'number' ? packageContracts.api : null,
  frontend: typeof artifactContracts.frontendContract === 'number' ? artifactContracts.frontendContract : typeof packageContracts.frontend === 'number' ? packageContracts.frontend : null,
  viewer: typeof artifactContracts.viewerContract === 'number' ? artifactContracts.viewerContract : typeof packageContracts.viewer === 'number' ? packageContracts.viewer : null,
  service: nullableString(artifactContracts.serviceVersion) ?? nullableString(packageContracts.service),
});

export const buildInfo = Object.freeze({
  package_name: stringValue(packageJson.name, '@loomhelm/multi-task-flow'),
  version: stringValue(packageJson.version, 'dev'),
  source_sha: stringValue(artifactIdentity.sourceSha ?? artifact.sourceSha ?? artifact.candidateSha, 'unknown'),
  merge_sha: nullableString(artifactIdentity.mergeSha ?? artifact.mergeSha),
  compatibility_line: stringValue(artifactIdentity.compatibilityLine ?? artifact.compatibilityLine ?? packageMetadata.compatibilityLine, 'unknown'),
  skill_version: stringValue(artifactIdentity.skillVersion ?? artifact.skillVersion ?? packageMetadata.skillVersion, 'unknown'),
  build_id: nullableString(artifactIdentity.buildId ?? artifact.buildId),
  tarball_digest: nullableString(artifactIdentity.tarballDigest ?? artifact.tarballDigest),
  contracts,
  policy: 'loomhelm-manual-v1',
});
