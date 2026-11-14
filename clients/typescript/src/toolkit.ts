import { createHash } from 'node:crypto';
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProcess, type ProcessOptions, type ProcessResult } from './runtime/process.ts';
import { identityDigest, validatePackageIdentity, type CanonicalDigestAlgorithm, type PackageIdentity } from './release.ts';

export interface SkillCapabilityReport { name: string; ready: boolean; readinessScope: 'all-declared-scenarios'; resourcesValid: boolean; dependencies: { skill: string; kind: 'skill' | 'command' | 'host'; strength: string; condition: string; available: boolean; code: string }[]; platform: string; arch: string; nativeSupported: boolean; source: string }
export interface ToolkitResource { path: string; sourcePath?: string; installedSha256?: string }
export interface ToolkitManifest { schemaVersion: 1; skills: string[]; files: ToolkitResource[]; additions?: ToolkitResource[] }
export interface ToolkitOmittedResource { path: string; reason: string }
export interface ToolkitArtifactFile { path: string; sha256: string }
export interface ToolkitDependency { name: string; version: string; mode?: 'consumer-install' | 'bundled'; path?: string; entry?: string }
export interface ToolkitArtifactManifest {
  schemaVersion: 2 | 3;
  packageName: string;
  packageVersion: string;
  compatibilityLine: string;
  skillVersion: string;
  sourceCommit: string;
  sourceSha: string;
  mergeSha: string | null;
  candidateSha: string;
  dirty: boolean;
  runtime: 'bun@1.4.4';
  identity: PackageIdentity;
  buildId: string;
  tarballDigest: string | null;
  gitTag: string | null;
  canonicalDigestAlgorithm?: CanonicalDigestAlgorithm;
  dependenciesBundled: boolean;
  dependencies: ToolkitDependency[];
  omittedResources: ToolkitOmittedResource[];
  files: ToolkitArtifactFile[];
}

function resourceFiles(manifest: ToolkitManifest): ToolkitResource[] {
  return [...manifest.files, ...(manifest.additions ?? [])];
}

function isSafeResourcePath(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}

function isSafePackageName(name: string): boolean {
  return /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(name);
}

/** The packaged resources are authoritative; never fall back to a host checkout. */
export class SkillsRuntime {
  constructor(readonly root = fileURLToPath(new URL('../toolkit/', import.meta.url))) {}
  async manifest(): Promise<ToolkitManifest> {
    const value = JSON.parse(await readFile(resolve(this.root, 'skills/resource-manifest.json'), 'utf8')) as ToolkitManifest;
    if (value.schemaVersion !== 1 || !Array.isArray(value.skills) || value.skills.length !== 29 || new Set(value.skills).size !== 29 || !Array.isArray(value.files)) throw new Error('Invalid toolkit resource manifest');
    return value;
  }
  async artifact(): Promise<ToolkitArtifactManifest> {
    const value = JSON.parse(await readFile(resolve(this.root, 'artifact-manifest.json'), 'utf8')) as ToolkitArtifactManifest & { identity?: unknown };
    const dependencyShapeIsValid = Array.isArray(value.dependencies) && value.dependencies.length > 0 && value.dependencies.every(dependency => {
      if (!dependency || !isSafePackageName(dependency.name) || typeof dependency.version !== 'string' || dependency.version.length === 0) return false;
      if (value.schemaVersion === 3) return value.dependenciesBundled === false && dependency.mode === 'consumer-install' && dependency.path === undefined && dependency.entry === undefined;
      return value.dependenciesBundled === true && typeof dependency.path === 'string' && isSafeResourcePath(dependency.path) && typeof dependency.entry === 'string' && isSafeResourcePath(dependency.entry);
    });
    const commonShapeIsValid = (value.schemaVersion === 2 || value.schemaVersion === 3) && value.packageName === '@loomhelm/multi-task-flow' && value.runtime === 'bun@1.4.4' && typeof value.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(value.sourceCommit) && typeof value.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(value.sourceSha) && typeof value.candidateSha === 'string' && /^[a-f0-9]{40}$/.test(value.candidateSha) && value.candidateSha === value.sourceSha && typeof value.dirty === 'boolean' && Array.isArray(value.dependencies) && new Set(value.dependencies.map(item => item.name)).size === value.dependencies.length && Array.isArray(value.omittedResources) && value.omittedResources.every(item => item && isSafeResourcePath(item.path) && typeof item.reason === 'string' && item.reason.length > 0) && new Set(value.omittedResources.map(item => item.path)).size === value.omittedResources.length && Array.isArray(value.files) && value.files.every(file => file && isSafeResourcePath(file.path) && /^[a-f0-9]{64}$/.test(file.sha256)) && new Set(value.files.map(file => file.path)).size === value.files.length && Boolean(value.identity);
    if (!commonShapeIsValid || !dependencyShapeIsValid || (value.schemaVersion === 3 && value.canonicalDigestAlgorithm !== 'path-byte-v2') || (value.schemaVersion === 2 && value.canonicalDigestAlgorithm !== undefined && value.canonicalDigestAlgorithm !== 'legacy-locale-en-us-v1')) throw new Error('Invalid toolkit artifact manifest');
    const identity = validatePackageIdentity(value.identity);
    if (identity.packageName !== value.packageName || identity.packageVersion !== value.packageVersion || identity.compatibilityLine !== value.compatibilityLine || identity.skillVersion !== value.skillVersion || identity.sourceSha !== value.sourceSha || identity.mergeSha !== value.mergeSha || identity.dirty !== value.dirty || identity.buildId !== value.buildId || identity.tarballDigest !== value.tarballDigest || identity.gitTag !== value.gitTag || identity.canonicalDigestAlgorithm !== value.canonicalDigestAlgorithm) throw new Error('Toolkit artifact identity mismatch');
    const { buildId, ...withoutBuildId } = identity;
    if (identityDigest({ ...withoutBuildId, files: value.files }) !== buildId) throw new Error('Toolkit artifact build ID mismatch');
    if (value.schemaVersion === 2) for (const dependency of value.dependencies) {
      try {
        const dependencyRoot = resolve(this.root, dependency.path!);
        const dependencyManifest = resolve(dependencyRoot, 'package.json');
        if (await realpath(dependencyRoot) !== dependencyRoot || !(await stat(dependencyRoot)).isDirectory() || await realpath(dependencyManifest) !== dependencyManifest || !(await stat(dependencyManifest)).isFile()) throw new Error('Unsafe toolkit dependency: ' + dependency.name);
        const metadata = JSON.parse(await readFile(dependencyManifest, 'utf8')) as { name?: string; version?: string };
        if (metadata.name !== dependency.name || metadata.version !== dependency.version) throw new Error('Toolkit dependency identity mismatch: ' + dependency.name);
        const entry = resolve(dependencyRoot, dependency.entry!);
        const entryRel = relative(dependencyRoot, entry);
        if (isAbsolute(entryRel) || entryRel === '..' || entryRel.startsWith(`..${sep}`) || await realpath(entry) !== entry || !(await stat(entry)).isFile()) throw new Error('Unsafe toolkit dependency entry: ' + dependency.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Missing toolkit dependency: ' + dependency.name);
        throw error;
      }
    }
    return value;
  }
  private async findConsumerDependencyRoot(packageRoot: string, name: string): Promise<string> {
    // Follow only the package's normal node_modules ancestry; never consult a global or checkout fallback.
    const marker = `${sep}node_modules${sep}`;
    const markerIndex = packageRoot.lastIndexOf(marker);
    const boundary = markerIndex >= 0 ? packageRoot.slice(0, markerIndex) || sep : packageRoot;
    let current = packageRoot;
    while (true) {
      const dependencyRoot = resolve(current, 'node_modules', name);
      try {
        const metadata = await lstat(dependencyRoot);
        if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(dependencyRoot) !== dependencyRoot) throw new Error('Unsafe consumer dependency: ' + name);
        return dependencyRoot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (current === boundary) break;
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
    throw new Error('Missing toolkit dependency: ' + name);
  }
  private async validateArtifact(): Promise<ToolkitArtifactManifest> {
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe toolkit root');
    const root = await realpath(this.root);
    if (root !== resolve(this.root)) throw new Error('Unsafe toolkit root');
    const artifact = await this.artifact();
    const seen = new Set<string>();
    for (const file of artifact.files) {
      if (!file || typeof file.path !== 'string' || !isSafeResourcePath(file.path) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid resource inventory path');
      seen.add(file.path);
      const target = resolve(root, file.path);
      const rel = relative(root, target);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || await realpath(target) !== target || !(await stat(target)).isFile()) throw new Error('Unsafe toolkit resource: ' + file.path);
      if (createHash('sha256').update(await readFile(target)).digest('hex') !== file.sha256) throw new Error('Toolkit resource checksum mismatch: ' + file.path);
    }
    const omitted = new Set(artifact.omittedResources.map(item => item.path));
    const actual = new Set<string>();
    const walk = async (relativePath: string): Promise<void> => {
      const directory = resolve(root, relativePath);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const target = resolve(root, child);
        if (entry.isSymbolicLink()) throw new Error('Unsafe toolkit resource: ' + child);
        if (entry.isDirectory()) { await walk(child); continue; }
        if (!entry.isFile() || await realpath(target) !== target) throw new Error('Unsafe toolkit resource: ' + child);
        actual.add(child);
      }
    };
    await walk('');
    if (artifact.schemaVersion === 3 && [...actual].some(path => path === 'node_modules' || path.startsWith('node_modules/') || path.includes('/node_modules/'))) throw new Error('Published toolkit contains node_modules');
    for (const path of actual) if (!seen.has(path) && !omitted.has(path)) throw new Error('Unlisted toolkit resource: ' + path);
    if (artifact.schemaVersion === 3) await this.validateConsumerDependencies(artifact);
    return artifact;
  }
  private async validateConsumerDependencies(artifact: ToolkitArtifactManifest): Promise<void> {
    let packageRoot = resolve(this.root, '..');
    let packageManifest = resolve(packageRoot, 'package.json');
    let packageMetadata: { dependencies?: Record<string, unknown> };
    try {
      packageMetadata = JSON.parse(await readFile(packageManifest, 'utf8')) as { dependencies?: Record<string, unknown> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      packageRoot = this.root;
      packageManifest = resolve(packageRoot, 'package.json');
      try {
        packageMetadata = JSON.parse(await readFile(packageManifest, 'utf8')) as { dependencies?: Record<string, unknown> };
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Missing package dependency manifest');
        throw fallbackError;
      }
    }
    for (const dependency of artifact.dependencies) {
      if (packageMetadata.dependencies?.[dependency.name] !== dependency.version) throw new Error('Toolkit package dependency declaration mismatch: ' + dependency.name);
      const dependencyRoot = await this.findConsumerDependencyRoot(packageRoot, dependency.name);
      try {
        const dependencyManifest = resolve(dependencyRoot, 'package.json');
        const manifestStat = await lstat(dependencyManifest);
        if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || await realpath(dependencyManifest) !== dependencyManifest) throw new Error('Unsafe consumer dependency: ' + dependency.name);
        const metadata = JSON.parse(await readFile(dependencyManifest, 'utf8')) as { name?: string; version?: string };
        if (metadata.name !== dependency.name || metadata.version !== dependency.version) throw new Error('Consumer dependency identity mismatch: ' + dependency.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Missing toolkit dependency: ' + dependency.name);
        throw error;
      }
    }
  }
  async validate(): Promise<ToolkitArtifactManifest> { return this.validateArtifact(); }
  async list(): Promise<{ name: string; path: string; scripts: string[] }[]> {
    const manifest = await this.manifest();
    await this.validateArtifact();
    const resources = resourceFiles(manifest);
    return manifest.skills.map(name => ({ name, path: resolve(this.root, 'skills', name, 'SKILL.md'), scripts: resources.filter(file => file.path.startsWith(`skills/${name}/scripts/`)).map(file => file.path) }));
  }
  async check(name: string, externalRoots = [resolve(homedir(), '.agents/skills'), resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'skills')], advertisedHostCapabilities: readonly string[] = []): Promise<SkillCapabilityReport> {
    const manifest = await this.manifest();
    if (!manifest.skills.includes(name)) throw new Error('Unknown toolkit Skill');
    type Requirement = { strength: string; condition: string };
    const catalog = JSON.parse(await readFile(resolve(this.root, 'skills/catalog.json'), 'utf8')) as { entries: { name: string; externalSkills: (Requirement & { skill: string })[]; externalCommands: (Requirement & { command: string })[]; hostCapabilities: (Requirement & { capability: string })[] }[] };
    const entry = catalog.entries.find(entry => entry.name === name)!;
    const dependencies: SkillCapabilityReport['dependencies'] = await Promise.all(entry.externalSkills.map(async dependency => {
      let available = false;
      for (const root of externalRoots) {
        try { if ((await stat(resolve(root, dependency.skill, 'SKILL.md'))).isFile()) { available = true; break; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return { ...dependency, kind: 'skill' as const, available, code: available ? 'AVAILABLE' : 'HOST_SKILL_UNAVAILABLE' };
    }));
    for (const dependency of entry.externalCommands) {
      let available = false;
      for (const dir of (process.env.PATH ?? '').split(delimiter).filter(dir => isAbsolute(dir))) {
        const path = resolve(dir, dependency.command);
        try { if ((await stat(path)).isFile()) { await access(path, constants.X_OK); available = true; break; } }
        catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      dependencies.push({ skill: dependency.command, kind: 'command', strength: dependency.strength, condition: dependency.condition, available, code: available ? 'AVAILABLE' : 'HOST_COMMAND_UNAVAILABLE' });
    }
    for (const dependency of entry.hostCapabilities) {
      // Only the invoking native host can advertise its actual tools. A socket
      // pathname or a Skill file alone never proves native capability support.
      const available = advertisedHostCapabilities.includes(dependency.capability);
      dependencies.push({ skill: dependency.capability, kind: 'host', strength: dependency.strength, condition: dependency.condition, available, code: available ? 'HOST_ADVERTISED' : 'HOST_CAPABILITY_UNVERIFIED' });
    }
    await this.validateArtifact();
    const nativeSupported = (process.platform === 'darwin' && process.arch === 'arm64') || (process.platform === 'linux' && process.arch === 'x64');
    return { name, ready: nativeSupported && dependencies.every(dependency => dependency.available), readinessScope: 'all-declared-scenarios', resourcesValid: true, dependencies, platform: process.platform, arch: process.arch, nativeSupported, source: 'local-resource-manifest' };
  }
  async run(script: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    const manifest = await this.manifest();
    await this.validateArtifact();
    if (!resourceFiles(manifest).some(file => file.path === script) || !/^(skills\/[^/]+\/scripts|skills\/bin)\/.+/.test(script)) throw new Error('Unknown toolkit script');
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, script));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !(await stat(target)).isFile()) throw new Error('Unsafe toolkit script');
    const firstLine = (await readFile(target, 'utf8')).split('\n', 1)[0]!;
    const executable = script.endsWith('.ts') ? process.execPath : script.endsWith('.sh') ? '/bin/bash' : script.endsWith('.py') ? 'python3' : /^#!.*\bruby\b/.test(firstLine) ? 'ruby' : /^#!.*\b(bash|sh)\b/.test(firstLine) ? '/bin/bash' : undefined;
    if (!executable) throw new Error('Unsupported toolkit script interpreter');
    const env = { ...process.env, ...(options.env ?? {}) };
    if (options.env?.LOOMHELM_TOOLKIT_ROOT === undefined) env.LOOMHELM_TOOLKIT_ROOT = root;
    return runProcess(executable, [...(script.endsWith('.ts') ? ['--no-install'] : executable === '/bin/bash' ? ['-p'] : []), target, ...args], { ...options, cwd: options.cwd ?? root, env });
  }
}
