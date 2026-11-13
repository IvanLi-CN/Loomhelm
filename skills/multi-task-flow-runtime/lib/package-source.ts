import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function copySkillSources(root, output, { dependencies = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'skills/source-manifest.json'), 'utf8'));
  const files = new Map();
  const copy = (path, expected, sourcePath = path) => {
    const source = resolve(root, sourcePath);
    if (!path.startsWith('skills/') || !source.startsWith(resolve(root, 'skills') + '/')) throw new Error('Unsafe source resource: ' + path);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(source) !== source || (!path.includes('/node_modules/') && stat.nlink !== 1)) throw new Error('Unsafe source resource: ' + path);
    const sha256 = digest(readFileSync(source));
    if (expected && expected !== sha256) throw new Error('Source resource checksum mismatch: ' + path);
    const target = join(output, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); cpSync(source, target);
    files.set(path, sha256);
  };
  for (const file of [...manifest.files, ...(manifest.additions ?? [])]) copy(file.path, file.installedSha256, file.sourcePath ?? file.path);
  for (const path of ['skills/source-manifest.json', 'skills/catalog.json']) copy(path);
  for (const name of ['index.html','app.js','app.css']) copy('skills/multi-task-flow-runtime/dist/' + name);
  if (dependencies) {
    const walk = path => {
      for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
        if (entry.name === '.bin' || entry.name === '.cache') continue;
        const child = path + '/' + entry.name;
        if (entry.isDirectory()) walk(child); else copy(child);
      }
    };
    for (const path of ['skills/node_modules', 'skills/multi-task-flow-runtime/node_modules']) {
      if (!existsSync(join(root, path))) throw new Error('Prepared dependency directory missing: ' + path);
      walk(path);
    }
  }
  return Object.fromEntries([...files].sort(([a],[b]) => a.localeCompare(b)));
}
