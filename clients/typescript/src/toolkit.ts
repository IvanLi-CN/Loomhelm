import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProcess, type ProcessOptions, type ProcessResult } from './runtime/process.js';

export interface SkillCapabilityReport { name: string; ready: boolean; resourcesValid: boolean; dependencies: { skill: string; strength: string; condition: string; available: boolean; code: string }[]; platform: string; arch: string; nativeSupported: boolean; source: string }
export interface ToolkitManifest { schemaVersion: 1; commit: string; skills: string[]; files: { path: string; source: string; sourceSha256: string }[] }
/** The packaged resources are authoritative; never fall back to a host checkout. */
export class SkillsRuntime {
  constructor(readonly root = fileURLToPath(new URL('./toolkit/', import.meta.url))) {}
  async manifest(): Promise<ToolkitManifest> {
    const value = JSON.parse(await readFile(resolve(this.root, 'skills/source-manifest.json'), 'utf8')) as ToolkitManifest;
    if (value.schemaVersion !== 1 || value.skills.length !== 29 || !Array.isArray(value.files)) throw new Error('Invalid toolkit resource manifest');
    return value;
  }
  async list(): Promise<{ name: string; path: string; scripts: string[] }[]> {
    const manifest = await this.manifest();
    return manifest.skills.map(name => ({ name, path: resolve(this.root, 'skills', name, 'SKILL.md'), scripts: manifest.files.filter(file => file.path.startsWith(`skills/${name}/scripts/`)).map(file => file.path) }));
  }
  async check(name: string, externalRoots = [resolve(homedir(), '.agents/skills'), resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'skills')]): Promise<SkillCapabilityReport> {
    const manifest = await this.manifest();
    if (!manifest.skills.includes(name)) throw new Error('Unknown toolkit Skill');
    const catalog = JSON.parse(await readFile(resolve(this.root, 'skills/catalog.json'), 'utf8')) as { entries: { name: string; externalSkills: { skill: string; strength: string; condition: string }[] }[] };
    const entry = catalog.entries.find(entry => entry.name === name)!;
    const dependencies = await Promise.all(entry.externalSkills.map(async dependency => {
      let available = false;
      for (const root of externalRoots) {
        try { if ((await stat(resolve(root, dependency.skill, 'SKILL.md'))).isFile()) { available = true; break; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return { ...dependency, available, code: available ? 'AVAILABLE' : 'HOST_SKILL_UNAVAILABLE' };
    }));
    const artifact = JSON.parse(await readFile(resolve(this.root, 'artifact-manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
    for (const file of artifact.files) {
      if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) throw new Error('Invalid resource inventory path');
      if (createHash('sha256').update(await readFile(resolve(this.root, file.path))).digest('hex') !== file.sha256) throw new Error('Toolkit resource checksum mismatch: ' + file.path);
    }
    return { name, ready: dependencies.every(dependency => dependency.available), resourcesValid: true, dependencies, platform: process.platform, arch: process.arch, nativeSupported: ['darwin', 'linux'].includes(process.platform), source: manifest.commit };
  }
  async run(script: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    const manifest = await this.manifest();
    if (!manifest.files.some(file => file.path === script) || !/^(skills\/[^/]+\/scripts|bin)\/.+/.test(script)) throw new Error('Unknown toolkit script');
    const compiled = script.endsWith('.ts') ? script.slice(0, -3) + '.js' : script;
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, compiled));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !(await stat(target)).isFile()) throw new Error('Unsafe toolkit script');
    const firstLine = (await readFile(target, 'utf8')).split('\n', 1)[0]!;
    const executable = script.endsWith('.ts') ? process.execPath : script.endsWith('.sh') ? '/bin/bash' : script.endsWith('.py') ? 'python3' : /^#!.*\bruby\b/.test(firstLine) ? 'ruby' : /^#!.*\b(bash|sh)\b/.test(firstLine) ? '/bin/bash' : undefined;
    if (!executable) throw new Error('Unsupported toolkit script interpreter');
    return runProcess(executable, [...(executable === '/bin/bash' ? ['-p'] : []), target, ...args], options);
  }
}
