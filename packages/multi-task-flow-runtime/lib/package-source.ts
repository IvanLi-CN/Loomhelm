import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sourceResources } from "./source-resources.ts";
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export function copySkillSources(root, output, { dependencies = false } = {}) {
  const manifest = sourceResources(root);
  const skill = "multi-task-flow";
  const selected = (resource) =>
    resource.path === `skills/${skill}` || resource.path.startsWith(`skills/${skill}/`);
  const files = new Map();
  const copy = (path, expected, sourcePath = path) => {
    const source = resolve(root, sourcePath);
    const allowedSourceRoots = [
      resolve(root, "skills") + "/",
      resolve(root, "packages/multi-task-flow-runtime") + "/",
      resolve(root, "docs/specs/multi-task-flow-unified-atomic-orchestration") + "/",
    ];
    if (
      !path.startsWith("skills/") ||
      !allowedSourceRoots.some((prefix) => source.startsWith(prefix))
    )
      throw new Error("Unsafe source resource: " + path);
    const stat = lstatSync(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      realpathSync(source) !== source ||
      (!path.includes("/node_modules/") && stat.nlink !== 1)
    )
      throw new Error("Unsafe source resource: " + path);
    const contents = readFileSync(source);
    const sha256 = digest(contents);
    if (expected && expected !== sha256)
      throw new Error("Source resource checksum mismatch: " + path);
    const target = join(output, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents);
    files.set(path, digest(contents));
  };
  const selectedFiles = manifest.files.filter(selected);
  for (const file of selectedFiles) copy(file.path, undefined, file.sourcePath ?? file.path);
  const packageManifest = {
    schemaVersion: 1,
    skills: [skill],
    files: selectedFiles.map((file) => ({
      path: file.path,
      installedSha256: files.get(file.path),
    })),
  };
  const manifestTarget = join(output, "skills/resource-manifest.json");
  mkdirSync(dirname(manifestTarget), { recursive: true, mode: 0o700 });
  writeFileSync(manifestTarget, JSON.stringify(packageManifest, null, 2) + "\n");
  files.set("skills/resource-manifest.json", digest(readFileSync(manifestTarget)));
  const catalog = JSON.parse(readFileSync(join(root, "skills/catalog.json"), "utf8"));
  const catalogTarget = join(output, "skills/catalog.json");
  writeFileSync(
    catalogTarget,
    JSON.stringify(
      { ...catalog, entries: catalog.entries.filter((entry) => entry.name === skill) },
      null,
      2,
    ) + "\n",
  );
  files.set("skills/catalog.json", digest(readFileSync(catalogTarget)));
  for (const name of ["index.html", "app.js", "app.css"])
    copy(
      "skills/multi-task-flow/dist/" + name,
      undefined,
      "packages/multi-task-flow-runtime/dist/" + name,
    );
  if (dependencies) {
    const walk = (path, outputPrefix) => {
      for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
        if (entry.name === ".bin" || entry.name === ".cache") continue;
        const child = path + "/" + entry.name;
        const outputPath = outputPrefix + "/" + entry.name;
        if (entry.isDirectory()) walk(child, outputPath);
        else copy(outputPath, undefined, child);
      }
    };
    for (const [path, outputPrefix] of [["skills/node_modules", "skills/node_modules"]]) {
      if (!existsSync(join(root, path)))
        throw new Error("Prepared dependency directory missing: " + path);
      walk(path, outputPrefix);
    }
  }
  return Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
}
