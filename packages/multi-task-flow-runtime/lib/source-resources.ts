import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Source inventory is derived from repository files; digests belong to build outputs. */
export function sourceResources(root: string) {
  root = realpathSync(root);
  const paths = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "skills/",
      "packages/multi-task-flow-runtime/",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const files = new Map<string, { path: string; sourcePath?: string }>();
  for (const sourcePath of [...new Set(paths)].sort()) {
    if (
      [
        "skills/catalog.json",
        "skills/resource-manifest.json",
        "packages/multi-task-flow-runtime/.gitignore",
      ].includes(sourcePath)
    )
      continue;
    const source = resolve(root, sourcePath);
    if (!existsSync(source)) continue;
    const stat = lstatSync(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      realpathSync(source) !== source
    )
      throw new Error("Unsafe source resource: " + sourcePath);
    const path = sourcePath.replace(
      /^packages\/multi-task-flow-runtime\//,
      "skills/multi-task-flow/",
    );
    if (files.has(path)) throw new Error("Duplicate source resource: " + path);
    files.set(path, path === sourcePath ? { path } : { path, sourcePath });
  }
  files.set("skills/multi-task-flow/references/cli-contract.md", {
    path: "skills/multi-task-flow/references/cli-contract.md",
    sourcePath: "docs/specs/multi-task-flow-unified-atomic-orchestration/CLI_CONTRACT.md",
  });
  const skills = [...files.keys()]
    .filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    .map((path) => path.split("/")[1]!)
    .sort();
  return {
    schemaVersion: 1,
    skills,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
