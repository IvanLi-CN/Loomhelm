import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureRelease, fixtureLegacyRelease, serviceFixture } from "./service-fixture";
import { buildId, digest, verifyRelease, requireSourceRelease } from "../lib/service-release";

function update(source: string, manifest: any) {
  const { build_id, ...body } = manifest;
  writeFileSync(join(source, "manifest.json"), JSON.stringify({ ...body, build_id: buildId(body) }));
}
test("v2 checks complete resources, content, links and contained import closure", () => {
  const { root } = serviceFixture();
  try {
    const { source, manifest } = fixtureRelease(root);
    expect(verifyRelease(source).schema_version).toBe(2);
    const entry = "skills/multi-task-flow/scripts/service.ts";
    writeFileSync(join(source, entry), 'import "./missing.ts";');
    manifest.files[entry] = digest('import "./missing.ts";'); update(source, manifest);
    expect(() => verifyRelease(source)).toThrow("dependency is missing");
    writeFileSync(join(source, entry), '// restored');
    manifest.files[entry] = digest('// restored'); update(source, manifest);
    const asset = "skills/multi-task-flow/dist/app.js";
    writeFileSync(join(source, asset), "tampered");
    expect(() => verifyRelease(source)).toThrow("checksum");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate discovery selects the newest verified build and ignores the current build", async () => {
  const { root, state } = serviceFixture();
  try {
    const old = fixtureRelease(root, "old");
    const newer = fixtureRelease(root, "newer");
    const rewrite = (source: string, manifest: any, service_version: string) => {
      const { build_id, ...body } = manifest;
      const updated = { ...body, service_version, build_id: buildId({ ...body, service_version }) };
      writeFileSync(join(source, "manifest.json"), JSON.stringify(updated));
      return updated;
    };
    const oldManifest = rewrite(old.source, old.manifest, "1.8.0");
    const newerManifest = rewrite(newer.source, newer.manifest, "1.10.0");
    mkdirSync(state.paths.candidates, { recursive: true });
    cpSync(old.source, join(state.paths.candidates, oldManifest.build_id), { recursive: true });
    cpSync(newer.source, join(state.paths.candidates, newerManifest.build_id), { recursive: true });
    state.saveConfig({ schema_version: 1, port: 49152, registry_dir: join(root, "registry"), current_build: oldManifest.build_id, previous_build: null, agent_ttl_ms: 3600000 });
    const { discoverCandidate } = await import("../lib/service-maintenance");
    expect(discoverCandidate(state)?.service_version).toBe("1.10.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("v1 packages remain diagnostic-only and reject incomplete native pairs", () => {
  const { root } = serviceFixture();
  try {
    const { source, manifest } = fixtureRelease(root);
    rmSync(join(source, "skills"), {recursive:true});
    const names = ["viewer", "dist/index.html", "dist/app.js", "dist/app.css"];
    for (const name of names) { mkdirSync(dirname(join(source,name)), {recursive:true}); writeFileSync(join(source,name), name); }
    const legacy = {...manifest, schema_version:1, files:Object.fromEntries(names.map(name => [name,digest(name)]))};
    update(source, legacy);
    expect(verifyRelease(source).schema_version).toBe(1);
    expect(() => requireSourceRelease(verifyRelease(source))).toThrow("diagnostic-only");
    legacy.files["viewer.mjs"] = "a".repeat(64); update(source, legacy);
    expect(() => verifyRelease(source)).toThrow("incomplete");
    delete legacy.files["viewer.mjs"]; legacy.files["../escape"] = "a".repeat(64); update(source,legacy);
    expect(() => verifyRelease(source)).toThrow();
  } finally { rmSync(root, {recursive:true,force:true}); }
});


test("rollback refuses a legacy package before touching config or service control", async () => {
  const {root,state} = serviceFixture();
  try {
    const legacy = fixtureLegacyRelease(root);
    mkdirSync(state.paths.releases,{recursive:true});
    cpSync(legacy.source,join(state.paths.releases,legacy.manifest.build_id),{recursive:true});
    state.saveConfig({schema_version:1,port:49152,registry_dir:join(root,"registry"),current_build:"b".repeat(64),previous_build:legacy.manifest.build_id,agent_ttl_ms:3600000});
    const before = readFileSync(join(state.paths.config,"service.json"),"utf8");
    let calls = 0;
    const control = {unload(){calls++;},start(){calls++;},async status(){calls++;return {} as any;}};
    const {switchRelease} = await import("../lib/service-maintenance");
    await expect(switchRelease(state,"",true,control)).rejects.toThrow("diagnostic-only");
    expect(calls).toBe(0); expect(readFileSync(join(state.paths.config,"service.json"),"utf8")).toBe(before);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("failed v2 startup restores legacy config without restarting the legacy program", async () => {
  const {root,state} = serviceFixture();
  try {
    const legacy = fixtureLegacyRelease(root); const next = fixtureRelease(root);
    mkdirSync(state.paths.releases,{recursive:true}); cpSync(legacy.source,join(state.paths.releases,legacy.manifest.build_id),{recursive:true});
    state.saveConfig({schema_version:1,port:49152,registry_dir:join(root,"registry"),current_build:legacy.manifest.build_id,previous_build:null,agent_ttl_ms:3600000});
    state.transaction(runtime => {runtime.pid=process.pid;runtime.phase="running";});
    let starts=0;
    const control={unload(){state.transaction(runtime=>{runtime.pid=null;runtime.phase="stopped";});}, start(){starts++;throw Error("controlled startup failure");}, async status(){return {} as any;}};
    const {switchRelease}=await import("../lib/service-maintenance");
    await expect(switchRelease(state,next.source,false,control)).rejects.toThrow("controlled startup failure");
    expect(starts).toBe(1); expect(state.config().current_build).toBe(legacy.manifest.build_id); expect(state.runtime().pid).toBeNull();
  } finally { rmSync(root,{recursive:true,force:true}); }
});
