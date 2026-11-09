import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'bun:test';
import { checkSkillsInstallation } from './check-skills-installation.ts';

test('a source-only skills installation runs official TS entrypoints and detects missing resources', () => {
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'loomhelm-skills-only-')));
  const source = resolve(import.meta.dirname, '../../..');
  const manifest = JSON.parse(readFileSync(join(source,'source-manifest.json'),'utf8'));
  const sources = new Set([...manifest.files,...manifest.additions].map(file => resolve(source,'..',file.path)));
  try {
    cpSync(source, join(isolated,'skills'), { recursive:true, filter:path => !['node_modules','.cache','dist'].includes(path.split('/').at(-1)) && !path.endsWith('.node') && (!path.endsWith('.js') || sources.has(path)) });
    const unprepared = checkSkillsInstallation(isolated,{probe:true});
    assert.equal(unprepared.sourceComplete,true);
    assert.equal(unprepared.ready,false); assert.equal(unprepared.ok,false);
    assert.equal(unprepared.code,'SKILLS_RUNTIME_DEPENDENCY_MISSING');
    assert.deepEqual(unprepared.dependencies.missing.sort(),['sharp','zod']);
    assert.equal(unprepared.entrypoints.status,'blocked');
    const install = spawnSync(process.execPath, ['install','--cwd',join(isolated,'skills'),'--frozen-lockfile','--ignore-scripts','--backend=copy'], {env:process.env,encoding:'utf8'});
    assert.equal(install.status,0,install.stderr);
    const report = checkSkillsInstallation(isolated,{probe:true});
    assert.equal(report.ok,true,JSON.stringify(report)); assert.equal(report.ready,true);
    assert.equal(report.skills,29); assert.deepEqual(report.requiredSparsePaths,['skills']);
    assert.equal(existsSync(join(isolated,'bin')),false);
    assert.equal(existsSync(join(isolated,'skills/bin/plan_review_view.js')),false);
    assert.equal(existsSync(join(isolated,'skills/bin/native/posix.node')),false);
    const plan=readFileSync(join(isolated,'skills/dev-plan/references/plan-cases/positive-fast-track.md'),'utf8');
    const finalized=spawnSync('/bin/bash',['-p',join(isolated,'skills/bin/plan-cli.sh'),'--input','-'],{cwd:source,env:process.env,input:plan,encoding:'utf8',timeout:30000});
    assert.equal(finalized.status,0,finalized.stderr); assert.match(finalized.stdout,/<proposed_plan>/);
    const context=join(isolated,'skills/dot-codex-development/scripts/context.ts');
    const original=readFileSync(context); writeFileSync(context,'// tampered');
    assert.equal(checkSkillsInstallation(isolated).sourceComplete,false);
    writeFileSync(context,original);
    renameSync(context,join(isolated,'context.ts')); symlinkSync(join(isolated,'context.ts'),context);
    assert.equal(checkSkillsInstallation(isolated).ok,false);
    rmSync(context); renameSync(join(isolated,'context.ts'),context);
    renameSync(join(isolated,'skills/bin'),join(isolated,'bin'));
    const broken=checkSkillsInstallation(isolated,{probe:true});
    assert.equal(broken.ok,false); assert.equal(broken.ready,false);
    assert.ok(broken.missing.includes('skills/bin/plan_review_view.ts'));
  } finally { rmSync(isolated,{recursive:true,force:true}); }
},60000);
