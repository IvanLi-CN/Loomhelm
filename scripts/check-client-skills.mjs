#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const path = resolve(root, 'skills/source-manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const refresh = process.argv.includes('--write');
const additional = ['bin/modules/core/runtime.ts', 'bin/modules/core/posix.ts', 'bin/native/posix.c', 'bin/package.json', 'skills/multi-task-flow/tests/service-release.test.ts', 'skills/multi-task-flow/scripts/notification-delivery.ts', 'skills/multi-task-flow/tests/notification-delivery.test.ts'];
if (refresh) manifest.additions = additional.map(path => ({ path, installedSha256: hash(readFileSync(resolve(root, path))) }));
const findings = [];
for (const file of [...manifest.files, ...(manifest.additions ?? [])]) {
  const target = resolve(root, file.path);
  if (!target.startsWith(root + '/') || !existsSync(target)) { findings.push(`missing:${file.path}`); continue; }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { findings.push(`unsafe:${file.path}`); continue; }
  const digest = hash(readFileSync(target));
  if (refresh) {
    file.installedSha256 = digest;
    if (file.sourceSha256) file.adaptation = digest === file.sourceSha256 ? 'unchanged' : 'loomhelm-runtime-path-or-contract-adaptation';
  } else if (digest !== file.installedSha256) findings.push(`digest:${file.path}`);
}
if (manifest.skills.length !== 29 || new Set(manifest.skills).size !== 29) findings.push('skill-count');
for (const name of manifest.skills) if (!manifest.files.some(file => file.path === `skills/${name}/SKILL.md`)) findings.push(`skill:${name}`);
if (findings.length) { console.error(JSON.stringify({ ok: false, findings })); process.exit(1); }
if (refresh) writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, skills: manifest.skills.length, sourceFiles: manifest.files.length, adapted: manifest.files.filter(file => file.adaptation !== 'unchanged').length, additions: manifest.additions?.length ?? 0, source: manifest.commit }));
