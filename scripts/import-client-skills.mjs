#!/usr/bin/env node
// Maintenance-only importer. Never reads the provider's working-tree files.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-client-skills.mjs SOURCE_REPOSITORY');
const commit = '505961771a0d2496155d23132a8c0bd8beac0a24';
const git = (...args) => execFileSync('git', ['-C', source, ...args], { maxBuffer: 32 * 1024 * 1024 });
const tree = git('ls-tree', '-rz', commit, 'skills', 'bin', 'docs').toString().split('\0').filter(Boolean);
const files = [];
for (const item of tree) {
  const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(item);
  if (!match) throw new Error('Unsupported source tree entry');
  const [, mode, blob, path] = match;
  if (path.split('/').some(part => ['..', 'node_modules', '__pycache__', '.git'].includes(part))) throw new Error('Rejected source path');
  if (path.startsWith('bin/fixtures/python-compatibility/') || path.startsWith('docs/specs/bun-typescript-scripts/')) continue;
  const destination = path.startsWith('docs/') ? `docs/vendor/dot-codex/${path.slice(5)}` : path;
  if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  const content = git('cat-file', 'blob', blob);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, { flag: 'wx' });
  chmodSync(destination, mode === '100755' ? 0o755 : 0o644);
  files.push({ source: path, path: destination, sourceBlob: blob, sourceSha256: createHash('sha256').update(content).digest('hex') });
}
const skills = files.filter(file => /^skills\/[^/]+\/SKILL\.md$/.test(file.source)).map(file => file.source.split('/')[1]).sort();
if (skills.length !== 29) throw new Error('Source Skill count differs from approved inventory');
writeFileSync(resolve('skills/source-manifest.json'), JSON.stringify({ schemaVersion: 1, repository: 'IvanLi-CN/dot-codex', commit, skills, files, exclusions: [{ sourcePrefix: "bin/fixtures/python-compatibility/", reason: "Provider historical language migration audit, not client functionality" }, { sourcePrefix: "docs/specs/bun-typescript-scripts/", reason: "Provider historical language migration topic" }] }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ skills: skills.length, files: files.length, commit }));
