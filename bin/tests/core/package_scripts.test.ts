import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("migrated regression surfaces are exposed without installing a user viewer", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  for (const surface of ["core", "hosting", "flow", "plan", "docs", "workspace", "visual", "checks"]) {
    expect(scripts[`test:${surface}`]).toBe(`bun test ./bin/tests/${surface}`);
  }
  expect(scripts["skills:test"]).toContain("bun test ./bin/tests");
  expect(scripts["skills:test"]).not.toContain("dashboard:install");
  expect(scripts["skills:build"]).toContain("build-skills-native.mjs");
});
