#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Source/vendor layouts share the migration inventory. Discovery of SKILL.md
// alone does not establish that its executable dependency closure was installed.
export function checkSkillsInstallation(root) {
  root = resolve(root);
  const inventory = resolve(root, 'skills/source-manifest.json');
  if (!existsSync(inventory)) return { ok: false, code: 'SKILLS_INVENTORY_MISSING', root, missing: ['skills/source-manifest.json'] };
  const manifest = JSON.parse(readFileSync(inventory, 'utf8'));
  const contained = path => {
    const file = resolve(root, path);
    if (!existsSync(file)) return false;
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && realpathSync(file).startsWith(realpathSync(resolve(root, 'skills')) + '/');
  };
  const missing = [...manifest.files, ...(manifest.additions ?? [])]
    .map(file => file.path).filter(path => !path.startsWith('skills/') || path.split('/').includes('..') || !contained(path));
  const escapedImports = [];
  for (const file of [...manifest.files, ...(manifest.additions ?? [])]) {
    if (!/\.(ts|mjs)$/.test(file.path) || !file.path.startsWith('skills/') || file.path.split('/').includes('..') || !contained(file.path)) continue;
    const text = readFileSync(resolve(root, file.path), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const target = resolve(root, dirname(file.path), match[1]);
      if (!target.startsWith(resolve(root, 'skills') + '/')) escapedImports.push({ file: file.path, import: match[1] });
    }
  }
  return {
    ok: missing.length === 0 && escapedImports.length === 0,
    code: missing.length || escapedImports.length ? 'SKILLS_INSTALLATION_INCOMPLETE' : 'SKILLS_SOURCE_LAYOUT_COMPLETE',
    root, skills: manifest.skills.length, missing, escapedImports,
    // Build outputs, external tools and host capabilities have separate gates.
    scope: 'source-resource-layout',
    requiredSparsePaths: ['skills'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
    console.error('Usage: node skills/scripts/check-skills-installation.mjs [--root PATH]');
    process.exitCode = 2;
  } else {
    try {
      const report = checkSkillsInstallation(args[1] ?? resolve(import.meta.dirname, '../..'));
      console.log(JSON.stringify(report));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      console.error(String(error));
      process.exitCode = 2;
    }
  }
}
