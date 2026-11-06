#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const client = resolve(import.meta.dirname, '../clients/typescript');
const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'loomhelm-artifact-')));
const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
try {
  for (const file of ['package.json','package-lock.json']) cpSync(join(client,file),join(isolated,file));
  cpSync(join(client,'dist'),join(isolated,'dist'),{recursive:true});
  execFileSync('npm',['ci','--offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:isolated,stdio:'pipe'});
  mkdirSync(join(isolated,'host'),{mode:0o700});
  const env = { ...process.env, PATH: '/usr/bin:/bin', CODEX_HOME: join(isolated,'host'), LOOMHELM_CODEX_APP_SERVER_SOCKET: join(isolated,'absent.sock') };
  const outcomes=[];
  for (const runtime of [process.execPath,bun]) {
    const invoke=(args,input='')=>spawnSync(runtime,[join(isolated,'dist/cli.js'),...args],{cwd:isolated,env,input,encoding:'utf8',timeout:30000});
    const list=invoke(['skills','list']); assert.equal(list.status,0,list.stderr); assert.equal(JSON.parse(list.stdout).length,29);
    const plan=readFileSync(join(isolated,'dist/toolkit/skills/dev-plan/references/plan-cases/positive-fast-track.md'),'utf8');
    const check=invoke(['skills','run','bin/plan_contract_check.ts','--plan','-'],plan); assert.equal(check.status,0,check.stderr); assert.match(check.stdout,/PASS/);
    const invalid=invoke(['flow','init','--input','-'],'{}'); assert.equal(invalid.status,2,invalid.stderr); assert.equal(JSON.parse(invalid.stdout).code,'INVALID_INPUT');
    outcomes.push({runtime,skills:29,plan:true,jsonExitContract:true});
  }
  console.log(JSON.stringify({ok:true,sourceCheckoutRequired:false,globalCodexCodeRequired:false,serverRequired:false,outcomes}));
} finally { rmSync(isolated,{recursive:true,force:true}); }
