#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const target = resolve(root, 'clients/typescript/toolkit');
const manifest = JSON.parse(readFileSync(resolve(root, 'skills/source-manifest.json'), 'utf8'));
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
writeFileSync(resolve(target, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
writeFileSync(resolve(target, 'artifact-manifest.json'), JSON.stringify({ schemaVersion: 2, sourceCommit: manifest.commit, candidateSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()), runtime: 'bun@1.4.4', files: [...outputs.values()] }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, runtime: 'bun@1.4.4', resources: outputs.size, source: manifest.commit }));
