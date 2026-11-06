import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type SkillScope = 'project' | 'user';
export interface Skill {
  name: string;
  description: string;
  content: string;
  path: string;
  scope: SkillScope;
  version: string | null;
  digest: string;
}
export interface SkillCatalog {
  skills: Skill[];
  diagnostics: { name: string; scope: SkillScope; message: string }[];
}
export interface SkillRoots { project: string; user?: string }
const namePattern = /^[a-z0-9][a-z0-9-]*$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(version: string): number[] {
  if (!versionPattern.test(version)) throw new Error(`Unsupported version: ${version}`);
  const parts = version.split('.').map(Number);
  if (parts.some(value => !Number.isSafeInteger(value))) throw new Error('Version component exceeds safe integer');
  return parts;
}
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1; }
  return 0;
}
/** Deliberately small range grammar: *, exact, ^, ~, or whitespace-separated comparators. */
export function satisfiesVersion(version: string, range: string): boolean {
  const actual = versionParts(version);
  if (range === '*') return true;
  const terms = range.trim().split(/\s+/);
  if (!range.trim()) throw new Error('Empty version range');
  // Parse all terms before comparing, so malformed suffixes never silently pass.
  const checks = terms.map(term => {
    const match = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(term);
    if (!match) throw new Error(`Unsupported version range: ${range}`);
    const target = versionParts(match[2]!);
    const operator = match[1] ?? '=';
    const order = compare(actual, target);
    switch (operator) {
      case '=': return order === 0;
      case '>': return order > 0;
      case '>=': return order >= 0;
      case '<': return order < 0;
      case '<=': return order <= 0;
      case '~': return order >= 0 && actual[0] === target[0] && actual[1] === target[1];
      case '^': {
        const fixed = target[0] !== 0 ? 1 : target[1] !== 0 ? 2 : 3;
        return order >= 0 && actual.slice(0, fixed).every((value, i) => value === target[i]);
      }
      default: throw new Error('Unsupported version operator');
    }
  });
  return checks.every(Boolean);
}

// Skill bodies remain opaque Markdown. Only the conventional name and description
// scalar fields are read; machine compatibility lives in a separate JSON sidecar.
function metadata(content: string): { name: string; description: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) throw new Error('SKILL.md requires frontmatter');
  const scalar = (key: string): string => {
    const matches = [...frontmatter[1]!.matchAll(new RegExp(`^${key}:\\s*(.+)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`Expected one ${key} scalar`);
    const value = matches[0]![1]!.trim();
    if (value.startsWith('"')) {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'string' || !parsed.trim()) throw new Error(`Invalid ${key}`);
      return parsed;
    }
    if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error(`Invalid ${key}`);
      return value.slice(1, -1).replaceAll("''", "'");
    }
    if (/^[>|[{&*!]/.test(value)) throw new Error(`Unsupported ${key} scalar`);
    return value;
  };
  const name = scalar('name'), description = scalar('description');
  if (!namePattern.test(name) || !description.trim()) throw new Error('Invalid skill identity');
  return { name, description };
}

async function optionalText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Roots are explicit skill directories, e.g. <repo>/.agents/skills and ~/.agents/skills.
 * Symlinked skill packages are supported; nothing is written or executed. */
export async function loadSkills(roots: SkillRoots): Promise<SkillCatalog> {
  const result: SkillCatalog = { skills: [], diagnostics: [] };
  const claimed = new Set<string>();
  for (const scope of ['project', 'user'] as const) {
    const root = roots[scope];
    if (!root) continue;
    let entries;
    try { entries = await readdir(resolve(root), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !namePattern.test(entry.name)) continue;
      if (claimed.has(entry.name)) continue;
      claimed.add(entry.name); // An invalid project override must not fall back to a user skill.
      try {
        const path = await realpath(join(root, entry.name, 'SKILL.md'));
        const content = await readFile(path, 'utf8');
        const fields = metadata(content);
        if (fields.name !== entry.name) throw new Error('Skill name must match its directory');
        const sidecar = await optionalText(join(root, entry.name, 'loomhelm.json'));
        let version: string | null = null;
        if (sidecar !== null) {
          const data: unknown = JSON.parse(sidecar);
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid skill manifest');
          const value = data as Record<string, unknown>;
          if (value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'version', 'scopes'].includes(key))) throw new Error('Unsupported skill manifest');
          if (value.version !== undefined) {
            if (typeof value.version !== 'string') throw new Error('Invalid skill version');
            versionParts(value.version); version = value.version;
          }
          if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.some(s => s !== 'project' && s !== 'user')) throw new Error('Invalid skill scopes');
          if (!value.scopes.includes(scope)) throw new Error(`Skill is not applicable to ${scope} scope`);
        }
        result.skills.push({ ...fields, content, path, scope, version, digest: createHash('sha256').update(JSON.stringify([content, sidecar])).digest('hex') });
      } catch (error) {
        result.diagnostics.push({ name: entry.name, scope, message: error instanceof Error ? error.message : 'Unable to load skill' });
      }
    }
  }
  return result;
}

export function requireSkill(catalog: SkillCatalog, name: string, options: { range?: string; scopes?: readonly SkillScope[] } = {}): Skill {
  if (options.range !== undefined && typeof options.range !== 'string') throw new Error('Invalid version range');
  if (options.scopes !== undefined && (!Array.isArray(options.scopes) || options.scopes.length === 0 || options.scopes.some(scope => scope !== 'project' && scope !== 'user'))) throw new Error('Invalid required scopes');
  const skill = catalog.skills.find(item => item.name === name);
  if (!skill) throw new Error(`Skill unavailable: ${name}`);
  if (options.scopes && !options.scopes.includes(skill.scope)) throw new Error(`Skill scope mismatch: ${name}`);
  if (options.range !== undefined) {
    if (skill.version === null) throw new Error(`Skill version unknown: ${name}`);
    if (!satisfiesVersion(skill.version, options.range)) throw new Error(`Skill version mismatch: ${name}`);
  }
  return structuredClone(skill);
}
