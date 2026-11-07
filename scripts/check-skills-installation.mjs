#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Source/vendor layouts share the migration inventory. Discovery of SKILL.md
// alone does not establish that its executable dependency closure was installed.
export function checkSkillsInstallation(root) {
  root = resolve(root);
  const inventory = resolve(root, 'skills/source-manifest.json');
  if (!existsSync(inventory)) return { ok: false, code: 'SKILLS_INVENTORY_MISSING', root, missing: ['skills/source-manifest.json'] };
  const manifest = JSON.parse(readFileSync(inventory, 'utf8'));
  const missing = [...manifest.files, ...(manifest.additions ?? [])]
    .map(file => file.path).filter(path => !existsSync(resolve(root, path)));
  return {
    ok: missing.length === 0,
    code: missing.length ? 'SKILLS_INSTALLATION_INCOMPLETE' : 'SKILLS_SOURCE_LAYOUT_COMPLETE',
    root, skills: manifest.skills.length, missing,
    // Build outputs, external tools and host capabilities have separate gates.
    scope: 'source-resource-layout',
    requiredSparsePaths: ['skills', 'bin', 'docs/vendor/dot-codex', 'scripts'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
    console.error('Usage: node scripts/check-skills-installation.mjs [--root PATH]');
    process.exitCode = 2;
  } else {
    try {
      const report = checkSkillsInstallation(args[1] ?? resolve(import.meta.dirname, '..'));
      console.log(JSON.stringify(report));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      console.error(String(error));
      process.exitCode = 2;
    }
  }
}
