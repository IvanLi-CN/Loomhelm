#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const target = resolve(root, 'clients/typescript/dist/toolkit');
const manifest = JSON.parse(readFileSync(resolve(root, 'skills/source-manifest.json'), 'utf8'));
// This exact generated directory belongs to the client build. Recreate it so
// removed source resources cannot survive incremental packaging.
if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error('Unsafe toolkit output directory');
  rmSync(target, { recursive: true });
}
const outputs = [];
function copy(path) {
  const output = resolve(target, path); mkdirSync(dirname(output), { recursive: true });
  cpSync(resolve(root, path), output, { dereference: false });
  outputs.push({ path, sha256: createHash("sha256").update(readFileSync(output)).digest("hex") });
}
for (const file of [...manifest.files, ...(manifest.additions ?? [])]) {
  copy(file.path);
  if (file.path.endsWith('.ts')) {
    const compiled = file.path.slice(0, -3) + '.js';
    if (existsSync(resolve(root, compiled))) copy(compiled);
  }
}
for (const path of ['skills/bin/package.json', 'skills/bin/native/posix.node', 'skills/bin/native/build.json', 'skills/source-manifest.json', 'skills/catalog.json']) copy(path);
for (const name of ['index.html','app.js','app.css']) copy(`skills/multi-task-flow/dist/${name}`);
writeFileSync(resolve(target, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
writeFileSync(resolve(target, 'artifact-manifest.json'), JSON.stringify({ schemaVersion: 1, sourceCommit: manifest.commit, candidateSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()), files: outputs }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, resources: manifest.files.length, source: manifest.commit }));
