/** Release metadata rules shared by the package CLI and publication tooling. */
export const COMPATIBILITY_TAG_PREFIX = 'compat-v';

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPATIBILITY_TAG = /^compat-v([1-9]\d*)$/;

export interface ExactSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  text: string;
}

export function parseExactSemVer(value: string): ExactSemVer {
  const match = EXACT_SEMVER.exec(value);
  if (!match) throw new Error(`Invalid exact SemVer: ${value}`);
  const prerelease = match[4] ?? null;
  if (prerelease?.split('.').some(part => /^0\d+$/.test(part))) {
    throw new Error(`Invalid exact SemVer prerelease identifier: ${value}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease, text: value };
}

export function isExactSemVer(value: string): boolean {
  try { parseExactSemVer(value); return true; } catch { return false; }
}

export function compatibilityDistTag(compatibilityVersion: number): string {
  if (!Number.isSafeInteger(compatibilityVersion) || compatibilityVersion < 1) {
    throw new Error('Compatibility version must be a positive safe integer');
  }
  return `${COMPATIBILITY_TAG_PREFIX}${compatibilityVersion}`;
}

export function parseCompatibilityDistTag(value: string): number {
  const match = COMPATIBILITY_TAG.exec(value);
  if (!match) throw new Error(`Invalid compatibility dist-tag: ${value}`);
  return Number(match[1]);
}

export function isCompatibilityDistTag(value: string): boolean {
  return COMPATIBILITY_TAG.test(value);
}

export function validatePublication(version: string, distTag?: string): { version: ExactSemVer; distTag: string } {
  const parsed = parseExactSemVer(version);
  if (distTag === undefined || distTag === version) return { version: parsed, distTag: version };
  parseCompatibilityDistTag(distTag);
  return { version: parsed, distTag };
}
