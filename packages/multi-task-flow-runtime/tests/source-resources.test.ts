import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sourceResources } from "../lib/source-resources.ts";

test("source discovery maps new modules and excludes ignored local files without a digest refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "loomhelm-resources-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    execFileSync("git", ["init", "-q", root]);
    write(".gitignore", "node_modules/\ndist/\n");
    write("skills/example/SKILL.md", "example");
    write("skills/multi-task-flow/SKILL.md", "flow");
    write("packages/multi-task-flow-runtime/lib/new.ts", "export const value = 1;");
    write("packages/multi-task-flow-runtime/node_modules/local/secret", "local");
    write("packages/multi-task-flow-runtime/dist/app.js", "built");
    const before = sourceResources(root);
    expect(before.skills).toEqual(["example", "multi-task-flow"]);
    expect(before.files).toContainEqual({
      path: "skills/multi-task-flow/lib/new.ts",
      sourcePath: "packages/multi-task-flow-runtime/lib/new.ts",
    });
    expect(before.files.some((file) => /node_modules|dist\//.test(file.path))).toBe(false);
    write("packages/multi-task-flow-runtime/lib/new.ts", "export const value = 2;");
    expect(sourceResources(root)).toEqual(before);
    symlinkSync(join(root, ".gitignore"), join(root, "skills/example/linked"));
    expect(() => sourceResources(root)).toThrow("Unsafe source resource");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
