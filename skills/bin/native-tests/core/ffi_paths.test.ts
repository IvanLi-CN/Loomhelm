import { expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (process.env.FFI_PATH_TEST_CHILD === "1") {
  // Mock only the call boundary. Every wrapped symbol still invokes libc.
  const original = await import("bun:ffi");
  const dlopen = original.dlopen;
  let calls = 0;
  const slots: Record<string, number[]> = {openat:[1],unlinkat:[1],mkdirat:[1],renameat:[1,3],renameat2:[1,3],renameatx_np:[1,3]};
  mock.module("bun:ffi", () => ({...original, dlopen(library: any, definitions: any) {
    const loaded = dlopen(library,definitions);
    return {...loaded,close:()=>loaded.close(),symbols:Object.fromEntries(Object.entries(loaded.symbols).map(([name,fn])=>[name,(...args: any[])=>{
      for (const slot of slots[name]??[]) assert.ok(args[slot] instanceof Uint8Array,"unowned pathname passed to "+name);
      if (++calls % 31 === 0) Bun.gc(true);
      return (fn as Function)(...args);
    }]))};
  }}));
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"ffi-path-lifetime-")));
  try {
    const io = await import("../../modules/plan/io");
    const safe = await import("../../modules/visual/secure_io");
    const security = await import("../../modules/core/security_file");
    const snapshots = await import("../../modules/plan/private_snapshot");
    const outside = join(root,"outside"); fs.writeFileSync(outside,"preserved");
    const trustedRoot = join(root,"trusted"); fs.mkdirSync(trustedRoot);
    for (const path of [join(trustedRoot,"..\0suffix","outside"),join(trustedRoot,"leaf\0suffix")]) {
      assert.throws(()=>safe.writeAtomicNoFollow(path,"unsafe",trustedRoot),/NUL/);
      assert.throws(()=>safe.readRegularNoFollow(path,trustedRoot),/NUL/);
      assert.throws(()=>safe.unlinkNoFollow(path,trustedRoot),/NUL/);
    }
    assert.throws(()=>safe.renameNoReplace(outside,join(root,"target\0suffix"),root),/NUL/);
    assert.equal(fs.readFileSync(outside,"utf8"),"preserved");
    for (let index=0;index<12;index++) {
      await io.writeCandidateText(join(root,"candidate"),String(index),root);
      assert.equal(await io.readCandidateText(join(root,"candidate"),root),String(index));
      safe.writeAtomicNoFollow(join(root,"source"),"value",root);
      safe.renameNoReplace(join(root,"source"),join(root,"target"),root);
      assert.equal(fs.readFileSync(join(root,"target"),"utf8"),"value");
      safe.unlinkNoFollow(join(root,"target"),root);
      const lock = security.tryLockFile(join(root,"operation.lock")); assert.ok(lock); lock.release();
      const snapshot = snapshots.createPrivateSnapshot(); snapshots.cleanupPrivateSnapshot(snapshot.path,snapshot.identity,snapshot.parentIdentity);
      Bun.gc(true);
    }
    const entry = join(import.meta.dir,"../../plan_review_view.ts");
    process.env.PLAN_REVIEW_ENTRYPOINT_PATH=entry;
    process.argv=[process.execPath,entry,"--input",join(import.meta.dir,"../../../dev-plan/references/plan-cases/positive-fast-track.md")];
    await import("../../plan_review_view.ts");
    assert.equal(process.exitCode??0,0);
    assert.ok(calls>100); console.log("FFI_BUFFER_LIFETIME_OK");
  } finally {fs.rmSync(root,{recursive:true,force:true});}
} else {
  test("pathname buffers remain owned across GC and actual system calls", () => {
    const result = Bun.spawnSync([process.execPath,"--no-install",import.meta.filename],{env:{...process.env,FFI_PATH_TEST_CHILD:"1",BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0"},timeout:60000});
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FFI_BUFFER_LIFETIME_OK");
  },65000);
}
