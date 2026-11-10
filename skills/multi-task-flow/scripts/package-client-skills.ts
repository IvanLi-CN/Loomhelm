#!/usr/bin/env -S bun --no-install
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const target = resolve(root, 'clients/typescript/toolkit');
const manifest = JSON.parse(readFileSync(resolve(root, 'skills/source-manifest.json'), 'utf8'));
const requireDependencies = process.argv.includes('--require-dependencies');
const packageMetadata = JSON.parse(readFileSync(resolve(root, 'clients/typescript/package.json'), 'utf8')) as { name?: unknown; version?: unknown };
if (requireDependencies && (packageMetadata.name !== '@loomhelm/multi-task-flow' || typeof packageMetadata.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(packageMetadata.version) || packageMetadata.version.split('-')[1]?.split('.').some(part => /^0\d+$/.test(part)))) throw new Error('Package name/version must be @loomhelm/multi-task-flow with exact SemVer');
// Only this exact disposable resource output is replaced. TS is never emitted.
if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error('Unsafe toolkit output directory');
  rmSync(target, { recursive: true });
}
const outputs = new Map();
function copy(path, expected) {
  const source = resolve(root, path);
  if (!path.startsWith('skills/') || !source.startsWith(resolve(root, 'skills') + '/')) throw new Error('Unsafe toolkit resource path');
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(source) !== source) throw new Error('Unsafe toolkit resource: ' + path);
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (expected && sha256 !== expected) throw new Error('Toolkit resource checksum mismatch: ' + path);
  const output = resolve(target, path); mkdirSync(dirname(output), { recursive: true });
  cpSync(source, output);
  outputs.set(path, { path, sha256 });
}
for (const file of [...manifest.files, ...(manifest.additions ?? [])]) copy(file.path, file.installedSha256);
for (const path of ['skills/source-manifest.json', 'skills/catalog.json']) copy(path);
for (const name of ['index.html','app.js','app.css']) copy(`skills/multi-task-flow/dist/${name}`);
const copyDependencies = (path: string) => {
  const sourceRoot = resolve(root, path);
  if (!existsSync(sourceRoot)) {
    if (requireDependencies) throw new Error(`Prepared dependency directory missing: ${path}`);
    return false;
  }
  const walk = (relativePath: string) => {
    for (const entry of readdirSync(resolve(sourceRoot, relativePath), { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const source = resolve(sourceRoot, child);
      const stat = lstatSync(source);
      if (stat.isDirectory()) walk(child);
      else copy(`${path}/${child}`, undefined);
    }
  };
  walk('');
  return true;
};
const bundledDependencies = [copyDependencies('skills/node_modules'), copyDependencies('skills/multi-task-flow/node_modules')].filter(Boolean).length;
const candidateSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(resolve(target, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
writeFileSync(resolve(target, 'artifact-manifest.json'), JSON.stringify({ schemaVersion: 2, sourceCommit: manifest.commit, candidateSha, dirty: Boolean(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()), runtime: 'bun@1.4.4', dependenciesBundled: bundledDependencies > 0, files: [...outputs.values()] }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, runtime: 'bun@1.4.4', resources: outputs.size, dependenciesBundled: bundledDependencies > 0, source: manifest.commit }));
