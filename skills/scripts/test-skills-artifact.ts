#!/usr/bin/env -S bun --no-install
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const client = resolve(import.meta.dirname, '../../clients/typescript');
const isolated = realpathSync(mkdtempSync(join(tmpdir(),'loomhelm-source-artifact-')));
try {
  for (const file of ['package.json','bun.lock','src','toolkit']) cpSync(join(client,file),join(isolated,file),{recursive:true});
  const install=spawnSync(process.execPath,['install','--frozen-lockfile','--ignore-scripts','--production','--backend=copy'],{cwd:isolated,env:process.env,encoding:'utf8'});
  assert.equal(install.status,0,install.stderr);
  assert.equal(existsSync(join(isolated,'dist')),false);
  assert.equal(existsSync(join(isolated,'toolkit/skills/bin/plan_review_view.js')),false);
  assert.equal(existsSync(join(isolated,'toolkit/skills/bin/native/posix.node')),false);
  const inventory=JSON.parse(readFileSync(join(isolated,'toolkit/artifact-manifest.json'),'utf8'));
  assert.equal(inventory.runtime,'bun@1.4.4'); assert.ok(inventory.files.every(file=>file.path.startsWith('skills/')));
  mkdirSync(join(isolated,'host'),{mode:0o700});
  const env={...process.env,PATH:'/usr/bin:/bin',CODEX_HOME:join(isolated,'host'),LOOMHELM_CODEX_APP_SERVER_SOCKET:join(isolated,'absent.sock')};
  const invoke=(args,input='')=>spawnSync(process.execPath,[join(isolated,'src/cli.ts'),...args],{cwd:isolated,env,input,encoding:'utf8',timeout:30000});
  const list=invoke(['skills','list']); assert.equal(list.status,0,list.stderr); assert.equal(JSON.parse(list.stdout).length,29);
  const plan=readFileSync(join(isolated,'toolkit/skills/dev-plan/references/plan-cases/positive-fast-track.md'),'utf8');
  const check=invoke(['skills','run','skills/bin/plan_contract_check.ts','--plan','-'],plan); assert.equal(check.status,0,check.stderr); assert.match(check.stdout,/PASS/);
  const invalid=invoke(['flow','init','--input','-'],'{}'); assert.equal(invalid.status,2,invalid.stderr); assert.equal(JSON.parse(invalid.stdout).code,'INVALID_INPUT');
  const ports=invoke(['skills','run','skills/global-port-manager/scripts/port_registry.ts','--help']); assert.equal(ports.status,0,ports.stderr);
  console.log(JSON.stringify({ok:true,runtime:'bun',sourceCheckoutRequired:false,globalCodexCodeRequired:false,serverRequired:false,precompiledJsRequired:false,skills:29}));
} finally { rmSync(isolated,{recursive:true,force:true}); }
