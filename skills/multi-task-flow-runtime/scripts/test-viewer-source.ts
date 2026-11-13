#!/usr/bin/env -S bun --no-install
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'viewer-source-test-')));
const output = join(temporary, 'package');
const env = { ...process.env, MULTI_TASK_FLOW_PROFILE:'test', MULTI_TASK_FLOW_ROOT:join(temporary,'state') };
try {
  const build=spawnSync(process.execPath,[join(root,'skills/multi-task-flow-runtime/scripts/build-service.ts'),'--output',output,'--service-version','0.0.0-test'],{cwd:temporary,env:{...env,LOOMHELM_SERVICE_BUNDLE_BUILD:'1'},encoding:'utf8',timeout:120000});
  assert.equal(build.status,0,build.stderr);
  const manifest=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));
  assert.equal(manifest.schema_version,2);
  assert.equal(existsSync(join(output,'viewer.mjs')),false);
  assert.equal(existsSync(join(output,'posix.node')),false);
  const marker=join(temporary,'environment-marker');
  const tools=join(temporary,'caller-tools'); mkdirSync(tools);
  const gh=join(tools,'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s' '{"number":42,"title":"fixture","url":"https://github.com/owner/repo/pull/42","state":"MERGED","mergedAt":null,"statusCheckRollup":[]}'\n`); chmodSync(gh,0o700);
  const preload=join(temporary,'preload.ts');
  writeFileSync(preload,`import {PRDetailsCache} from ${JSON.stringify(join(output,'skills/multi-task-flow/lib/pr-details.ts'))}; const snapshot=await new PRDetailsCache().read({host:"github.com",owner:"owner",name:"repo"},"https://github.com/owner/repo/pull/42"); await Bun.write(${JSON.stringify(marker)},JSON.stringify({snapshot,path:process.env.PATH,option:process.env.NODE_OPTIONS}));`);
  const callerPath=tools+':'+process.env.PATH;
  const invoke=spawnSync(join(output,'viewer'),['invalid','--input','-'],{cwd:temporary,env:{...env,PATH:callerPath,NODE_OPTIONS:'--trace-warnings',BUN_OPTIONS:'--preload='+preload},input:'{}',encoding:'utf8',timeout:30000});
  assert.notEqual(invoke.status,0); assert.equal(JSON.parse(invoke.stderr).code,'INVALID_COMMAND');
  const inherited=JSON.parse(readFileSync(marker,'utf8'));
  assert.equal(inherited.path,callerPath); assert.equal(inherited.option,'--trace-warnings');
  assert.equal(inherited.snapshot.data?.state,'MERGED'); assert.equal(inherited.snapshot.stale,false); assert.equal(inherited.snapshot.error,null);
  rmSync(marker);
  const unsafe = join(temporary,'unsafe-temp'); mkdirSync(unsafe); chmodSync(unsafe,0o777);
  const unsafeInvoke=spawnSync(join(output,'viewer'),['invalid'],{env:{...env,TMPDIR:unsafe},encoding:'utf8',timeout:30000});
  assert.notEqual(unsafeInvoke.status,0); assert.match(unsafeInvoke.stderr,/VIEWER_TEMP_UNTRUSTED/);
  chmodSync(unsafe,0o700);
  for (const resource of ['skills/bin/plan_bunfig.toml','skills/multi-task-flow/scripts/service.ts']) {
    const path=join(output,resource), original=readFileSync(path);
    writeFileSync(path,resource.endsWith('.toml') ? 'preload = ['+JSON.stringify(preload)+']\n' : `await Bun.write(${JSON.stringify(marker)},'unsafe');`);
    const rejected=spawnSync(join(output,'viewer'),['invalid'],{env,encoding:'utf8',timeout:30000});
    assert.notEqual(rejected.status,0); assert.match(rejected.stderr,/VIEWER_RESOURCE_CHECKSUM/); assert.equal(existsSync(marker),false);
    writeFileSync(path,original);
  }
  const shadow=join(output,'skills/multi-task-flow/lib/service-state.tsx');
  writeFileSync(shadow,`import {writeFileSync as __writeMarker} from 'node:fs'; __writeMarker(${JSON.stringify(marker)},'unsafe');\n`+readFileSync(join(output,'skills/multi-task-flow/lib/service-state.ts'),'utf8'));
  const shadowInvoke=spawnSync(join(output,'viewer'),['invalid','--input','-'],{env,input:'{}',encoding:'utf8',timeout:30000});
  assert.notEqual(shadowInvoke.status,0); assert.match(shadowInvoke.stderr,/VIEWER_RESOURCE_UNLISTED/); assert.equal(existsSync(marker),false);
  rmSync(shadow);
  const { verifyRelease }=await import(pathToFileURL(join(output,'skills/multi-task-flow/lib/service-release.ts')));
  verifyRelease(output);
  // Actual packaged TS modules own an isolated HTTP lifecycle, never user services.
  const { ServiceState }=await import(pathToFileURL(join(output,'skills/multi-task-flow/lib/service-state.ts')));
  const { servicePaths }=await import(pathToFileURL(join(output,'skills/multi-task-flow/lib/service-paths.ts')));
  const { ServiceAuth }=await import(pathToFileURL(join(output,'skills/multi-task-flow/lib/service-auth.ts')));
  const { startSharedViewer }=await import(pathToFileURL(join(output,'skills/multi-task-flow/lib/service-http.ts')));
  const state=new ServiceState(servicePaths(env)); state.initialize(); const auth=new ServiceAuth(state); auth.initialize();
  const viewer=await startSharedViewer(state,manifest,join(output,'skills/multi-task-flow/dist'),0);
  try {
    const base='http://127.0.0.1:'+viewer.port;
    assert.equal((await fetch(base+'/api/v1/runs')).status,401);
    assert.equal((await fetch(base+'/api/v1/runs',{headers:{authorization:'Bearer '+auth.credential()}})).status,200);
  } finally { await viewer.stop(); }
  writeFileSync(join(output,'skills/multi-task-flow/dist/app.js'),'tampered');
  assert.throws(()=>verifyRelease(output),/checksum/);
  console.log(JSON.stringify({ok:true,schemaVersion:2,runtime:'bun@1.4.4',sourceEntry:true,environmentPreserved:true,isolatedHttp:true,checksums:true,resources:Object.keys(manifest.files).length}));
} finally { rmSync(temporary,{recursive:true,force:true}); }
