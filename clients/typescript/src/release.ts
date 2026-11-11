import { createHash } from 'node:crypto';

export const PACKAGE_NAME = '@loomhelm/multi-task-flow';
export const COMPATIBILITY_TAG_PREFIX = 'compat-v';
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPATIBILITY_TAG = /^compat-v([1-9]\d*)$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ExactSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  text: string;
}

export interface PackageContracts {
  ledgerContract: number;
  apiVersion: number;
  frontendContract: number;
  viewerContract: number;
  serviceVersion: string;
}

export interface PackageIdentity {
  packageName: string;
  packageVersion: string;
  compatibilityLine: string;
  skillVersion: string;
  sourceSha: string;
  mergeSha: string | null;
  dirty: boolean;
  contracts: PackageContracts;
  buildId: string;
  tarballDigest: string | null;
  gitTag: string | null;
}

export function parseExactSemVer(value: string): ExactSemVer {
  const match = EXACT_SEMVER.exec(value);
  if (!match) throw new Error(`Invalid exact SemVer: ${value}`);
  const prerelease = match[4] ?? null;
  if (prerelease?.split('.').some(part => /^0\d+$/.test(part))) throw new Error(`Invalid exact SemVer prerelease identifier: ${value}`);
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (numbers.some(number => !Number.isSafeInteger(number))) throw new Error(`SemVer component is too large: ${value}`);
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!, prerelease, text: value };
}

export function isExactSemVer(value: string): boolean {
  try { parseExactSemVer(value); return true; } catch { return false; }
}

export function compatibilityDistTag(compatibilityVersion: number): string {
  if (!Number.isSafeInteger(compatibilityVersion) || compatibilityVersion < 1) throw new Error('Compatibility version must be a positive safe integer');
  return `${COMPATIBILITY_TAG_PREFIX}${compatibilityVersion}`;
}

export function parseCompatibilityDistTag(value: string): number {
  const match = COMPATIBILITY_TAG.exec(value);
  if (!match) throw new Error(`Invalid compatibility dist-tag: ${value}`);
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) throw new Error(`Compatibility version is too large: ${value}`);
  return version;
}

export function isCompatibilityDistTag(value: string): boolean {
  try { parseCompatibilityDistTag(value); return true; } catch { return false; }
}

export function validatePublication(version: string, distTag?: string): { version: ExactSemVer; distTag: string } {
  const parsed = parseExactSemVer(version);
  if (distTag === undefined || distTag === version) return { version: parsed, distTag: version };
  parseCompatibilityDistTag(distTag);
  return { version: parsed, distTag };
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid package identity object: ${field}`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid package identity field: ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid package identity field: ${field}`);
  return value;
}

export function validatePackageIdentity(value: unknown): PackageIdentity {
  const raw = objectValue(value, 'identity');
  const packageName = requiredString(raw.packageName, 'packageName');
  if (packageName !== PACKAGE_NAME) throw new Error(`Unexpected package identity: ${packageName}`);
  const packageVersion = requiredString(raw.packageVersion, 'packageVersion');
  parseExactSemVer(packageVersion);
  const compatibilityLine = requiredString(raw.compatibilityLine, 'compatibilityLine');
  parseCompatibilityDistTag(compatibilityLine);
  const skillVersion = requiredString(raw.skillVersion, 'skillVersion');
  parseExactSemVer(skillVersion);
  const sourceSha = requiredString(raw.sourceSha, 'sourceSha');
  if (!SHA1.test(sourceSha)) throw new Error('Invalid package identity field: sourceSha');
  const mergeSha = nullableString(raw.mergeSha, 'mergeSha');
  if (mergeSha !== null && !SHA1.test(mergeSha)) throw new Error('Invalid package identity field: mergeSha');
  if (typeof raw.dirty !== 'boolean') throw new Error('Invalid package identity field: dirty');
  const contracts = objectValue(raw.contracts, 'contracts');
  const normalizedContracts: PackageContracts = {
    ledgerContract: positiveInteger(contracts.ledgerContract, 'contracts.ledgerContract'),
    apiVersion: positiveInteger(contracts.apiVersion, 'contracts.apiVersion'),
    frontendContract: positiveInteger(contracts.frontendContract, 'contracts.frontendContract'),
    viewerContract: positiveInteger(contracts.viewerContract, 'contracts.viewerContract'),
    serviceVersion: requiredString(contracts.serviceVersion, 'contracts.serviceVersion'),
  };
  const buildId = requiredString(raw.buildId, 'buildId');
  if (!SHA256.test(buildId)) throw new Error('Invalid package identity field: buildId');
  const tarballDigest = nullableString(raw.tarballDigest, 'tarballDigest');
  if (tarballDigest !== null && !SHA256.test(tarballDigest)) throw new Error('Invalid package identity field: tarballDigest');
  const gitTag = nullableString(raw.gitTag, 'gitTag');
  if (gitTag !== null && gitTag !== `multi-task-flow-v${packageVersion}`) throw new Error('Package identity Git tag does not match package version');
  return { packageName, packageVersion, compatibilityLine, skillVersion, sourceSha, mergeSha, dirty: raw.dirty, contracts: normalizedContracts, buildId, tarballDigest, gitTag };
}

export function identityDigest(value: Omit<PackageIdentity, 'buildId'> & { files: readonly { path: string; sha256: string }[] }): string {
  const body = { ...value, files: [...value.files].sort((left, right) => left.path.localeCompare(right.path)) };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
