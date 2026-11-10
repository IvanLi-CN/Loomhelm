import {switchRelease} from "../lib/service-maintenance";
import {afterEach, expect, test} from "bun:test";
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {serviceFixture, fixtureRelease, fixtureRun} from "./service-fixture";
import {buildId} from "../lib/service-release";
import {compatibilityReport, requireReport} from "../lib/service-compatibility";
import {maintenanceCheck, maintenanceApply} from "../lib/ledger-maintenance";
import {requireLedgerCompatibility} from "../lib/service-contract";
import {serviceCommand} from "../scripts/service";
import {LedgerStore} from "../lib/store";
import {contractMigrationCandidate} from "../lib/store-migration";
import {type ServiceState} from "../lib/service-state";

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
function setup() {
  const f=serviceFixture(); roots.push(f.root);
  const release=releaseFor(f.state,"current");
  f.state.saveConfig({schema_version:1,port:49152,registry_dir:join(f.root,"registry"),current_build:release.manifest.build_id,previous_build:null,agent_ttl_ms:3600000});
  const {store}=fixtureRun(f.state.paths.data,"demo-run");
  const raw=JSON.parse(readFileSync(store.ledgerPath,"utf8")); raw.operations=raw.operations.filter((op:any)=>op.status!=="claimed"&&op.status!=="unknown"); raw.contract_version=1; raw.config.execution_profile=null;
  writeFileSync(store.ledgerPath,JSON.stringify(raw));
  return {...f,store,raw,release};
}
function historicalPolicySetup() {
  const f=setup();
  const raw=JSON.parse(readFileSync(f.store.ledgerPath,"utf8"));
  raw.contract_version=2;
  raw.version=null;
  raw.config.execution_profile={model:"gpt-6.1-sol",thinking:"medium"};
  raw.events.push({id:"branch-repair",type:"publish_branch_repaired",subject_id:raw.groups[0].id,actor_id:raw.control.owner_thread_id,occurred_at:"2026-01-01T00:00:00.000Z",recorded_at:"2026-01-01T00:00:00.000Z",data:{evidence_ref:"branch-repair"}});
  for(const task of raw.tasks) {
    delete task.execution_owner;
    delete task.conversation_policy;
    delete task.delivery_policy;
  }
  writeFileSync(f.store.ledgerPath,JSON.stringify(raw));
  return {...f,raw};
}
function releaseFor(state: ServiceState,name: string,patch: object={}) {
  const release=fixtureRelease(state.paths.root,name);
  const {build_id,...body}=release.manifest;
  const next={...body,...patch}; const manifest={...next,build_id:buildId(next)};
  writeFileSync(join(release.source,"manifest.json"),JSON.stringify(manifest));
  mkdirSync(state.paths.releases,{recursive:true});cpSync(release.source,join(state.paths.releases,manifest.build_id),{recursive:true});
  return {source:release.source,manifest};
}
function request(state: ServiceState,action="contract",extra={}) {
  const op={run_id:"demo-run",action,...extra};
  const check=maintenanceCheck(state,op);
  return {...op,expected_owner_thread_id:check.owner_thread_id,expected_revision:check.revision,expected_ledger_sha256:check.ledger_sha256,operation_digest:check.operation_digest,request_id:"maint-1",maintenance_thread_id:"real-maintainer",approval_ref:"owner-message-1",reason:"Approved schema maintenance",writers_paused:true};
}
const caps=async()=>[{model:"gpt-6-luna",thinking:["high"]}];

test("old read-only runs do not block regardless of completion events and usage leases",()=>{
  const f=setup(); const bytes=readFileSync(f.store.ledgerPath);
  for (const completed of [false,true]) for (const leased of [false,true]) {
    const raw=structuredClone(f.raw);
    if(completed) raw.events.push({id:"completed-event",type:"run_completed",subject_id:"demo-run",actor_id:"owner",occurred_at:null,recorded_at:new Date().toISOString(),data:{}});
    writeFileSync(f.store.ledgerPath,JSON.stringify(raw));
    if(leased) f.state.renew({id:"test-agent",kind:"agent",run_id:"demo-run",thread_id:"main"},60000); else f.state.release("test-agent");
    const before=readFileSync(f.store.ledgerPath);
    const report=compatibilityReport(f.state,f.release.manifest); expect(report.errors).toEqual([]);expect(report.write_downgrades).toEqual([]);requireReport(report);
    expect(readFileSync(f.store.ledgerPath)).toEqual(before);
  }
  writeFileSync(f.store.ledgerPath,bytes);
});
test("compatibility report exposes migration guides for affected contracts",()=>{
  const f=setup();
  const guide={id:"1.9.0-ledger-contract-3",path:"docs/migrations/1.9.0/from-contract-2.md",sha256:"a".repeat(64),required_for:["schema-2/contract-1"],operation:"ledger-maintenance-apply"};
  const target=releaseFor(f.state,"guide",{migration_guides:[guide]});
  const report=compatibilityReport(f.state,target.manifest);
  expect(report.runs[0]?.migration_guides).toEqual([guide.id]);
});
test("candidate reader failure uses an executed previous viewer read-only proof",()=>{
  const f=setup();
  const old=fixtureRelease(f.root,"old",{readOnly:true});
  const {build_id: _oldBuild, ...oldBody}=old.manifest;
  const oldManifest={...oldBody,writable:["schema-2/contract-2"]};
  const oldId=buildId(oldManifest); writeFileSync(join(old.source,"manifest.json"),JSON.stringify({...oldManifest,build_id:oldId})); cpSync(old.source,join(f.state.paths.releases,oldId),{recursive:true});
  f.state.saveConfig({...f.state.config(),current_build:oldId});
  const target=releaseFor(f.state,"target",{readable:["schema-2/contract-2"]});
  const report=compatibilityReport(f.state,target.manifest,target.source);
  expect(report.errors).toEqual([]);
  expect(report.runs[0]).toMatchObject({fallback_build_id:oldId,fallback_readable:true,target_readable:false});
  const noFallback=fixtureRelease(f.root,"no-fallback");
  const noId=noFallback.manifest.build_id; cpSync(noFallback.source,join(f.state.paths.releases,noId),{recursive:true});
  f.state.saveConfig({...f.state.config(),current_build:noId});
  expect(compatibilityReport(f.state,target.manifest,target.source).errors[0]).toMatchObject({capability:"read"});
});
test("new write loss needs exact approval; changes invalidate it",()=>{
  const f=setup();const old=releaseFor(f.state,"old",{writable:["schema-2/contract-1"]});f.state.saveConfig({...f.state.config(),current_build:old.manifest.build_id});
  const report=compatibilityReport(f.state,f.release.manifest);expect(report.write_downgrades).toEqual(["demo-run"]);
  expect(()=>requireReport(report)).toThrow("exact compatibility");
  const approval={report_digest:report.report_digest,approval_ref:"owner",maintenance_thread_id:"maint"};requireReport(report,approval);
  writeFileSync(f.store.ledgerPath,JSON.stringify({...f.raw,revision:f.raw.revision+1}));
  expect(()=>requireReport(compatibilityReport(f.state,f.release.manifest),approval)).toThrow();
  expect(()=>requireReport(compatibilityReport(f.state,old.manifest),approval)).toThrow("No write downgrade");
});
test("unreadable, malformed, symlinked and incompatible custom runs cannot be approved away",()=>{
  const f=setup();
  const target=releaseFor(f.state,"future",{readable:["schema-2/contract-2"]});
  expect(compatibilityReport(f.state,target.manifest).errors[0]?.capability).toBe("read");
  const view=join(f.store.runPath,"view");mkdirSync(view,{recursive:true});writeFileSync(join(view,"view.manifest.json"),JSON.stringify({api_version:9,frontend_contract:1}));
  expect(compatibilityReport(f.state,f.release.manifest).errors[0]?.capability).toBe("custom_view");
  writeFileSync(f.store.ledgerPath,"{broken");expect(compatibilityReport(f.state,f.release.manifest).errors[0]?.run_id).toBe("demo-run");
  unlinkSync(f.store.ledgerPath);symlinkSync(join(f.root,"absent"),f.store.ledgerPath);expect(compatibilityReport(f.state,f.release.manifest).errors).not.toBeEmpty();
});
test("public compatibility and maintenance checks leave state byte-identical",async()=>{
  const f=setup();const snap=()=>[readFileSync(f.store.ledgerPath,"utf8"),readFileSync(join(f.state.paths.config,"service.json"),"utf8"),readdirSync(f.state.paths.state).sort()];const before=snap();
  expect(await serviceCommand("compatibility-check",{source:f.release.source},f.state)).toHaveProperty("report_digest");
  expect(await serviceCommand("ledger-maintenance-check",{run_id:"demo-run",action:"contract"},f.state)).toHaveProperty("operation_digest");
  expect(snap()).toEqual(before);
  await expect(serviceCommand("compatibility-check",{source:f.release.source,rollback:true},f.state)).rejects.toThrow();
});
test("contract maintenance repairs historical policy declarations with an auditable replay",async()=>{
  const f=historicalPolicySetup();
  const before=readFileSync(f.store.ledgerPath,"utf8");
  const report:any=maintenanceCheck(f.state,{run_id:"demo-run",action:"contract"});
  expect(report.source_contract).toBe("schema-2/contract-2");
  expect(report.target_contract).toBe("schema-2/contract-2");
  expect(report.task_execution_policy_migration).toMatchObject({mode:"declare-null"});
  expect(report.task_execution_policy_migration.tasks).toHaveLength(f.raw.tasks.length);
  expect(()=>contractMigrationCandidate(f.raw)).toThrow("Only legacy and contract-1 ledgers can migrate");
  const req=request(f.state);
  const applied:any=await maintenanceApply(f.state,req);
  expect(applied.code).toBe("APPLIED");
  const saved=JSON.parse(readFileSync(f.store.ledgerPath,"utf8"));
  expect(saved.revision).toBe(f.raw.revision+1);
  expect(saved.control).toEqual(f.raw.control);
  expect(saved.groups).toEqual(f.raw.groups);
  expect(saved.events).toEqual(f.raw.events);
  expect(saved.facts).toEqual(f.raw.facts);
  expect(saved.operations).toEqual(f.raw.operations);
  for(const [index,task] of f.raw.tasks.entries()) {
    const savedTask=saved.tasks[index];
    for(const key of Object.keys(task)) expect(savedTask[key]).toEqual(task[key]);
    expect(savedTask.execution_owner).toBeNull();
    expect(savedTask.conversation_policy).toBeNull();
    expect(savedTask.delivery_policy).toBeNull();
  }
  expect(saved.requests.at(-1)).toMatchObject({command:"ledger-maintenance-apply",committed_revision:f.raw.revision+1});
  expect(saved.requests.at(-1).result.task_execution_policy_migration).toEqual(report.task_execution_policy_migration);
  expect(readFileSync(join(f.store.runPath,applied.result.backup),"utf8")).toBe(before);
  expect(()=>requireLedgerCompatibility(saved,"write")).not.toThrow();
  const committed=readFileSync(f.store.ledgerPath,"utf8");
  expect((await maintenanceApply(f.state,req) as any).code).toBe("REPLAYED");
  expect(readFileSync(f.store.ledgerPath,"utf8")).toBe(committed);
});
test("partial historical policy declarations remain read-only without a backup",()=>{
  for (const patch of [
    {execution_owner:"main"},
    {execution_owner:null,conversation_policy:null},
  ]) {
    const f=historicalPolicySetup();
    Object.assign(f.raw.tasks[0],patch);
    writeFileSync(f.store.ledgerPath,JSON.stringify(f.raw));
    const before=readFileSync(f.store.ledgerPath,"utf8");
    const beforeEntries=readdirSync(f.store.runPath).sort();
    let error:any;
    try { maintenanceCheck(f.state,{run_id:"demo-run",action:"contract"}); } catch (caught) { error=caught; }
    expect(error).toMatchObject({code:"TASK_EXECUTION_POLICY_INCOMPLETE"});
    expect(readFileSync(f.store.ledgerPath,"utf8")).toBe(before);
    expect(readdirSync(f.store.runPath).sort()).toEqual(beforeEntries);
  }
});
test("maintenance commits one backup and audit without impersonation, then profiles independently",async()=>{
  const f=setup();const before=readFileSync(f.store.ledgerPath,"utf8");const req=request(f.state);
  const result:any=await maintenanceApply(f.state,req);expect(result.code).toBe("APPLIED");
  let saved=JSON.parse(readFileSync(f.store.ledgerPath,"utf8"));expect(saved.control).toEqual(f.raw.control);expect(saved.events).toEqual(f.raw.events);expect(saved.revision).toBe(f.raw.revision+1);
  expect(readFileSync(join(f.store.runPath,result.result.backup),"utf8")).toBe(before);expect(result.result.maintenance_thread_id).toBe("real-maintainer");
  expect((await maintenanceApply(f.state,req) as any).code).toBe("REPLAYED");
  await expect(maintenanceApply(f.state,{...req,reason:"changed"})).rejects.toThrow("different content");
  const profile=request(f.state,"execution-profile",{execution_profile:{model:"gpt-6-luna",thinking:"high"}});profile.request_id="profile-1";
  await expect(maintenanceApply(f.state,profile,async()=>[])).rejects.toThrow("Unsupported execution profile");
  await maintenanceApply(f.state,profile,caps);saved=JSON.parse(readFileSync(f.store.ledgerPath,"utf8"));expect(saved.config.execution_profile).toEqual({model:"gpt-6-luna",thinking:"high"});expect(saved.revision).toBe(f.raw.revision+2);
  expect((await maintenanceApply(f.state,profile,async()=>{throw Error("offline")}) as any).code).toBe("REPLAYED");
});
test("maintenance rejects stale targets, owner, revision, digest and incompatible viewer",async()=>{
  const f=setup();const req=request(f.state);
  for(const patch of [{expected_owner_thread_id:"other"},{expected_revision:-1},{expected_ledger_sha256:"a".repeat(64)},{operation_digest:"a".repeat(64)},{writers_paused:false}]) await expect(maintenanceApply(f.state,{...req,...patch})).rejects.toThrow();
  const old=releaseFor(f.state,"old",{readable:["schema-2/contract-1"],writable:["schema-2/contract-1"]});f.state.saveConfig({...f.state.config(),current_build:old.manifest.build_id});
  await expect(maintenanceApply(f.state,req)).rejects.toThrow("changed");
  await expect(maintenanceApply(f.state,request(f.state))).rejects.toThrow("readable for source and target");
  expect(readFileSync(f.store.ledgerPath,"utf8")).toBe(JSON.stringify(f.raw));
});
test("backup interruption recovers and commit-response loss replays; conflicting backup is retained",async()=>{
  for(const stage of ["migration_backup_identity_committed","migration_backup_committed","migration_candidate_synced","migration_committed"]) {
    const f=setup();const req=request(f.state);const store=new LedgerStore(f.state.paths.data,"demo-run",at=>{if(at===stage)throw Error("interrupted");});
    await expect(maintenanceApply(f.state,req,caps,store)).rejects.toThrow("interrupted");
    if(stage==="migration_backup_identity_committed") {
      expect(existsSync(join(f.store.runPath,"ledger.maintenance-maint-1.json"))).toBe(false);
      expect(existsSync(join(f.store.runPath,"ledger.maintenance-maint-1.json.request.json"))).toBe(true);
    }
    const retried:any=await maintenanceApply(f.state,req);expect(retried.code).toBe(stage==="migration_committed"?"REPLAYED":"APPLIED");
    expect(JSON.parse(readFileSync(f.store.ledgerPath,"utf8")).revision).toBe(f.raw.revision+1);
  }
  const f=setup();const req=request(f.state);const path=join(f.store.runPath,"ledger.maintenance-maint-1.json");writeFileSync(path,"conflict");await expect(maintenanceApply(f.state,req)).rejects.toThrow("different content");expect(readFileSync(path,"utf8")).toBe("conflict");
});
test("identity-only interruption rejects a changed request identity",async()=>{
  const f=setup();const req=request(f.state);const store=new LedgerStore(f.state.paths.data,"demo-run",at=>{if(at==="migration_backup_identity_committed")throw Error("interrupted");});
  await expect(maintenanceApply(f.state,req,caps,store)).rejects.toThrow("interrupted");
  await expect(maintenanceApply(f.state,{...req,reason:"different"})).rejects.toThrow("different request");
  expect(JSON.parse(readFileSync(f.store.ledgerPath,"utf8"))).toEqual(f.raw);
});
test("a concurrent writer during capability lookup invalidates the profile request",async()=>{
  const f=setup();await maintenanceApply(f.state,request(f.state));const req=request(f.state,"execution-profile",{execution_profile:{model:"gpt-6-luna",thinking:"high"}});req.request_id="profile-2";
  await expect(maintenanceApply(f.state,req,async()=>{f.store.update(raw=>{raw.revision+=1;return null;});return caps();})).rejects.toThrow("version changed");
});

test("unresolved operations block maintenance without clearing their facts",async()=>{
  const f=setup(); f.raw.operations.push({...f.raw.operations[0],id:"pending-maintenance",status:"unknown"});
  writeFileSync(f.store.ledgerPath,JSON.stringify(f.raw));
  const req=request(f.state);await expect(maintenanceApply(f.state,req)).rejects.toThrow("Reconcile unresolved");
  expect(JSON.parse(readFileSync(f.store.ledgerPath,"utf8")).operations).toEqual(f.raw.operations);
});
test("two independent CLI writers serialize one migration and replay the same request",async()=>{
  const f=setup();const input=request(f.state);
  const invoke=async()=>{
    const child=Bun.spawn([process.execPath,join(import.meta.dir,"../scripts/service.ts"),"ledger-maintenance-apply","--input","-"],{env:{...process.env,MULTI_TASK_FLOW_PROFILE:"test",MULTI_TASK_FLOW_ROOT:f.root},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    child.stdin.write(JSON.stringify(input));child.stdin.end();
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code).toBe(0);expect(err).toBe("");return JSON.parse(out).result.code;
  };
  expect((await Promise.all([invoke(),invoke()])).sort()).toEqual(["APPLIED","REPLAYED"]);
  expect(JSON.parse(readFileSync(f.store.ledgerPath,"utf8")).revision).toBe(f.raw.revision+1);
});
test("the public CLI returns exact blocker details without stopping service control",async()=>{
  const f=setup();const rejected=releaseFor(f.state,"reject",{readable:["schema-2/contract-2"]});
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../scripts/service.ts"),"upgrade","--input","-"],{env:{...process.env,MULTI_TASK_FLOW_PROFILE:"test",MULTI_TASK_FLOW_ROOT:f.root},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  child.stdin.write(JSON.stringify({source:rejected.source}));child.stdin.end();
  const stderr=await new Response(child.stderr).text();expect(await child.exited).not.toBe(0);
  const error=JSON.parse(stderr);expect(error.code).toBe("INCOMPATIBLE_RELEASE");expect(error.details.errors[0]).toMatchObject({run_id:"demo-run",capability:"read"});
  expect(f.state.config().current_build).toBe(f.release.manifest.build_id);
});

test("custom view rejection including dangling manifests happens before status or unload",async()=>{
  const f=setup();const view=join(f.store.runPath,"view");mkdirSync(view,{recursive:true});
  const manifest=join(view,"view.manifest.json");let touched=false;
  f.state.transaction(runtime=>{runtime.phase="running";runtime.pid=process.pid;runtime.generation="test-generation";});
  const control={status:async()=>{touched=true;throw Error("must not check running service");},start:()=>{touched=true;},unload:()=>{touched=true;}};
  writeFileSync(manifest,JSON.stringify({api_version:99,frontend_contract:1}));
  await expect(switchRelease(f.state,f.release.source,false,control)).rejects.toMatchObject({code:"INCOMPATIBLE_RELEASE"});expect(touched).toBe(false);
  unlinkSync(manifest);symlinkSync(join(f.root,"missing-manifest"),manifest);
  const report=compatibilityReport(f.state,f.release.manifest);expect(report.errors).toHaveLength(1);expect(report.errors[0]?.run_id).toBe("demo-run");
  await expect(switchRelease(f.state,f.release.source,false,control)).rejects.toMatchObject({code:"INCOMPATIBLE_RELEASE"});expect(touched).toBe(false);
});
