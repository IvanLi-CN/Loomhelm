import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureRelease, serviceFixture } from "./service-fixture";
import { buildId, digest, verifyRelease, requireSourceRelease } from "../scripts/service-release";

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
