#!/usr/bin/env -S bun --no-install
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const path = resolve(root, 'skills/resource-manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const refresh = process.argv.includes('--write');
const additional = [...JSON.parse(readFileSync(resolve(root, 'skills/support-manifest.json'), 'utf8')), 'skills/bin/modules/core/runtime.ts', 'skills/bin/package.json', 'skills/multi-task-flow/tests/service-release.test.ts', 'skills/multi-task-flow/lib/notification-delivery.ts', 'skills/multi-task-flow/tests/notification-delivery.test.ts', 'skills/multi-task-flow/lib/conversation-archive.ts', 'skills/multi-task-flow/lib/task-runtime.ts', 'skills/multi-task-flow/web/task-state.ts', 'skills/multi-task-flow/web/conversation-control.ts', 'skills/multi-task-flow/tests/ui/conversation-control.test.ts', 'skills/multi-task-flow/tests/task-runtime.test.ts', 'skills/multi-task-flow/lib/atomic-orchestration.ts', 'skills/multi-task-flow/tests/atomic-orchestration-schema.test.ts', 'skills/multi-task-flow/tests/task-kind.test.ts', 'skills/multi-task-flow/web/atomic-graph-view.tsx'];
const sourcePath = file => file.sourcePath ?? file.path;
if (refresh) manifest.additions = additional.map(path => { const source = path.startsWith('skills/multi-task-flow/') ? 'packages/multi-task-flow-runtime/' + path.slice('skills/multi-task-flow/'.length) : path; return { path, sourcePath: source, installedSha256: hash(readFileSync(resolve(root, source))) }; });
const findings = [];
const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd:root, encoding:'utf8' });
if (gitRoot.status === 0 && gitRoot.stdout.trim() === root) {
  const tracked = spawnSync('git', ['ls-files', '-z', '--', 'skills/', 'clients/typescript/'], { cwd:root, encoding:'utf8' });
  if (tracked.status !== 0) throw new Error('Cannot verify tracked resource coverage');
  const covered = new Set([...manifest.files,...(manifest.additions ?? [])].map(file => file.path));
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (!existsSync(resolve(root, file))) continue;
    if (/\.(?:js|mjs|cjs)$/.test(file)) findings.push('owned-source-must-be-typescript:'+file);
    if (file.startsWith('packages/multi-task-flow-runtime/')) continue;
    if (file.startsWith('skills/') && !covered.has(file) && !['skills/resource-manifest.json','skills/catalog.json'].includes(file)) findings.push('unlisted:'+file);
  }
}

for (const file of [...manifest.files, ...(manifest.additions ?? [])]) {
  const source = resolve(root, sourcePath(file));
  if (!file.path.startsWith('skills/') || !source.startsWith(root + '/') || !existsSync(source)) { findings.push(`missing:${file.path}`); continue; }
  const target = source;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { findings.push(`unsafe:${file.path}`); continue; }
  const digest = hash(readFileSync(target));
  if (refresh) {
    file.installedSha256 = digest;
  } else if (digest !== file.installedSha256) findings.push(`digest:${file.path}`);
}
if (!Array.isArray(manifest.skills) || new Set(manifest.skills).size !== manifest.skills.length) findings.push('skill-index');
for (const name of manifest.skills) if (!manifest.files.some(file => file.path === `skills/${name}/SKILL.md`)) findings.push(`skill:${name}`);
if (findings.length) { console.error(JSON.stringify({ ok: false, findings })); process.exit(1); }
if (refresh) writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, skills: manifest.skills.length, sourceFiles: manifest.files.length, additions: manifest.additions?.length ?? 0, source: 'local-resource-manifest' }));
