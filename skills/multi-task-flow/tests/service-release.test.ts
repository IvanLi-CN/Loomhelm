import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRelease, serviceFixture } from "./service-fixture";
import { buildId, verifyRelease } from "../scripts/service-release";

test("legacy four-file releases remain readable; new runtime resources are an all-or-none pair", () => {
  const { root } = serviceFixture();
  try {
    const { source, manifest } = fixtureRelease(root);
    const { build_id, ...legacy } = manifest;
    delete legacy.files["viewer.mjs"];
    delete legacy.files["posix.node"];
    writeFileSync(join(source, "manifest.json"), JSON.stringify({ ...legacy, build_id: buildId(legacy) }));
    expect(verifyRelease(source).build_id).toBe(buildId(legacy));
    legacy.files["viewer.mjs"] = "a".repeat(64);
    writeFileSync(join(source, "manifest.json"), JSON.stringify({ ...legacy, build_id: buildId(legacy) }));
    expect(() => verifyRelease(source)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
