import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSkillsInstallation } from "../scripts/check-skills-installation.ts";

test("the installable Skill tree excludes npm runtime resources", () => {
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), "loomhelm-skills-only-")));
  const source = resolve(import.meta.dirname, "../../../skills/multi-task-flow");
  try {
    cpSync(source, join(isolated, "multi-task-flow"), { recursive: true });
    assert.equal(existsSync(join(isolated, "multi-task-flow", "SKILL.md")), true);
    for (const name of [
      "data",
      "dist",
      "examples",
      "lib",
      "scripts",
      "tests",
      "web",
      "package.json",
      "bun.lock",
    ]) {
      assert.equal(existsSync(join(isolated, "multi-task-flow", name)), false, name);
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}, 60000);

test("generated installation inventories require a matching checksum on every resource", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loomhelm-generated-inventory-")));
  try {
    mkdirSync(join(root, "skills/example"), { recursive: true });
    mkdirSync(join(root, "packages/multi-task-flow-runtime"), { recursive: true });
    writeFileSync(join(root, "skills/example/SKILL.md"), "example");
    writeFileSync(join(root, "skills/package.json"), JSON.stringify({ dependencies: {} }));
    const sha = createHash("sha256").update("example").digest("hex");
    for (const installedSha256 of [sha, undefined, "", "invalid", "0".repeat(64)]) {
      writeFileSync(
        join(root, "skills/resource-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          skills: ["example"],
          files: [{ path: "skills/example/SKILL.md", installedSha256 }],
        }),
      );
      const report = checkSkillsInstallation(root);
      expect(report.sourceComplete).toBe(installedSha256 === sha);
      expect(report.modified).toEqual(installedSha256 === sha ? [] : ["skills/example/SKILL.md"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
