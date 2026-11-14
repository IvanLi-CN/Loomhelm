#!/usr/bin/env -S bun --no-install
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Source/vendor layouts share the migration inventory. Discovery of SKILL.md
// alone does not establish that its executable dependency closure was installed.
export function checkSkillsInstallation(root, { probe = false } = {}) {
  root = resolve(root);
  const inventory = resolve(root, 'skills/source-manifest.json');
  if (!existsSync(inventory)) return { ok: false, code: 'SKILLS_INVENTORY_MISSING', root, missing: ['skills/source-manifest.json'] };
  const manifest = JSON.parse(readFileSync(inventory, 'utf8'));
  const localPath = resource => {
    const target = resolve(root, resource.path);
    if (existsSync(target)) return resource.path;
    return resource.sourcePath ?? resource.path;
  };
  const contained = path => {
    const file = resolve(root, path);
    if (!existsSync(file)) return false;
    const stat = lstatSync(file);
    const skillsRoot = realpathSync(resolve(root, 'skills')) + '/';
    const runtimeRoot = realpathSync(resolve(root, 'packages/multi-task-flow-runtime')) + '/';
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && realpathSync(file) === file && (realpathSync(file).startsWith(skillsRoot) || realpathSync(file).startsWith(runtimeRoot));
  };
  const allowed = path => (path.startsWith('skills/') || path.startsWith('packages/multi-task-flow-runtime/')) && !path.split('/').includes('..');
  const missing = [...manifest.files, ...(manifest.additions ?? [])]
    .map(file => localPath(file)).filter(path => !allowed(path) || !contained(path));
  const modified = [...manifest.files, ...(manifest.additions ?? [])].filter(file => { const path = localPath(file); return !missing.includes(path) && createHash("sha256").update(readFileSync(resolve(root,path))).digest("hex") !== file.installedSha256; }).map(file => file.path);
  const escapedImports = [];
  for (const file of [...manifest.files, ...(manifest.additions ?? [])]) {
    const path = localPath(file);
    if (!/\.(ts|mjs)$/.test(path) || !allowed(path) || !contained(path)) continue;
    const text = readFileSync(resolve(root, path), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const target = resolve(root, dirname(path), match[1]);
      const skillsRoot = resolve(root, 'skills') + '/';
      const runtimeRoot = resolve(root, 'packages/multi-task-flow-runtime') + '/';
      if (!target.startsWith(skillsRoot) && !target.startsWith(runtimeRoot)) escapedImports.push({ file: file.path, import: match[1] });
    }
  }
  const sourceComplete = missing.length === 0 && modified.length === 0 && escapedImports.length === 0;
  const runtime = { name: 'bun', required: '1.4.4', actual: typeof Bun === 'undefined' ? null : Bun.version, available: typeof Bun !== 'undefined' && Bun.version === '1.4.4' };
  const declared = sourceComplete ? JSON.parse(readFileSync(resolve(root,'skills/package.json'),'utf8')).dependencies ?? {} : {};
  const dependencyRoots = [resolve(root,'skills/node_modules')];
  // The independent client declares and prepares its packaged toolkit dependencies.
  const clientPackage = resolve(root,'../package.json');
  try {
    if (sourceComplete && root.endsWith('/toolkit') && existsSync(clientPackage) && JSON.parse(readFileSync(clientPackage,'utf8')).name === '@loomhelm/multi-task-flow') dependencyRoots.push(resolve(root,'../node_modules'));
  } catch { /* Invalid parent metadata cannot authorize a dependency fallback. */ }
  const dependencyMissing = Object.entries(declared).filter(([name,version]) => !dependencyRoots.some(directory => {
    const file=resolve(directory,name,'package.json');
    try { return realpathSync(file).startsWith(realpathSync(directory)+'/') && JSON.parse(readFileSync(file,'utf8')).version === version; } catch { return false; }
  })).map(([name])=>name);
  const dependencies = { status:!sourceComplete ? 'not_checked' : dependencyMissing.length ? 'missing' : 'prepared', missing:dependencyMissing };
  const entrypoints = { status: dependencyMissing.length ? 'blocked' : 'not_checked', results: [] };
  if (probe && sourceComplete && runtime.available && dependencyMissing.length === 0) {
    for (const [script, args] of [['skills/bin/plan-cli.sh',['--help']], ['skills/dot-codex-development/scripts/context.ts',['--help']], ['packages/multi-task-flow-runtime/scripts/orchestrate.ts',['view','--input','-']]]) {
      const result = spawnSync(script.endsWith('.sh') ? '/bin/bash' : process.execPath, [...(script.endsWith('.sh') ? ['-p'] : ['--no-install']), resolve(root,script), ...args], { cwd:root, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0' }, input:'{}', encoding:'utf8', timeout:30000 });
      const expected = script.endsWith('orchestrate.ts') ? 2 : 0;
      entrypoints.results.push({script, code:result.status, ok:!result.error && result.status === expected, error: result.error ? String(result.error) : result.status === expected ? undefined : result.stderr});
    }
    entrypoints.status = entrypoints.results.every(result => result.ok) ? 'passed' : 'failed';
  }
  return {
    runtime, sourceComplete, dependencies, entrypoints,
    ready: sourceComplete && runtime.available && entrypoints.status === 'passed',
    ok: sourceComplete && (!probe || (runtime.available && entrypoints.status === 'passed')),
    code: missing.length || modified.length || escapedImports.length ? 'SKILLS_INSTALLATION_INCOMPLETE' : probe && dependencyMissing.length ? 'SKILLS_RUNTIME_DEPENDENCY_MISSING' : 'SKILLS_SOURCE_LAYOUT_COMPLETE',
    root, skills: manifest.skills.length, missing, modified, escapedImports,
    // Host capabilities remain separate from these source and executable probes.
    scope: 'source-resource-layout',
    requiredSparsePaths: ['skills', 'packages/multi-task-flow-runtime'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const probe = process.argv.includes('--probe');
  const args = process.argv.slice(2).filter(arg => arg !== '--probe');
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
    console.error('Usage: bun packages/multi-task-flow-runtime/scripts/check-skills-installation.ts [--root PATH] [--probe]');
    process.exitCode = 2;
  } else {
    try {
      const report = checkSkillsInstallation(args[1] ?? resolve(import.meta.dirname, '../../..'), {probe});
      console.log(JSON.stringify(report));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      console.error(String(error));
      process.exitCode = 2;
    }
  }
}
