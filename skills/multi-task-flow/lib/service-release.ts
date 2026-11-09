import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRegular } from "../lib/store";
import { requireCondition } from "../lib/errors";
import { readRegularNoFollow } from "../../bin/modules/visual/secure_io";
import {
  releaseManifestSchema,
  type ReleaseManifest,
} from "../lib/service-contract";
import { SKILL_ID, SKILL_VERSION, VIEWER_CONTRACT } from "../lib/contract";

export const releaseFiles = [
  "viewer",
  "skills/multi-task-flow/scripts/service.ts",
  "skills/bin/plan_bunfig.toml",
  "skills/multi-task-flow/dist/index.html",
  "skills/multi-task-flow/dist/app.js",
  "skills/multi-task-flow/dist/app.css",
] as const;
const legacyFiles = ["viewer", "dist/index.html", "dist/app.js", "dist/app.css"];
export function requireSourceRelease(manifest: ReleaseManifest): void {
  requireCondition(manifest.schema_version === 2, "SOURCE_RELEASE_REQUIRED", "Legacy viewer package is diagnostic-only; explicitly prepare a Bun source package");
}
export const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export function buildId(manifest: Omit<ReleaseManifest, "build_id">): string {
  const body = { ...manifest } as Record<string, unknown>;
  if (body.skill_id === SKILL_ID) delete body.skill_id;
  if (body.skill_version === SKILL_VERSION) delete body.skill_version;
  if (body.ledger_contract === 2) delete body.ledger_contract;
  if (body.viewer_contract === VIEWER_CONTRACT) delete body.viewer_contract;
  // The launcher embeds this identity and therefore cannot be part of its own
  // identity. The bootstrap verifier applies the same rule before checking
  // the immutable resource inventory.
  const files = { ...(body.files as Record<string, string>) };
  delete files.viewer;
  return digest(
    JSON.stringify({
      ...body,
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    }),
  );
}
export function verifyRelease(root: string): ReleaseManifest {
  requireCondition(
    realpathSync(root) === resolve(root) && lstatSync(root).isDirectory(),
    "UNSAFE_RELEASE",
    "Release directory must be canonical",
  );
  const manifest = releaseManifestSchema.parse(
    JSON.parse(readRegular(join(root, "manifest.json"))),
  );
  const { build_id, ...body } = manifest;
  requireCondition(
    buildId(body) === build_id,
    "INVALID_RELEASE",
    "Release identity mismatch",
  );
  const names = Object.keys(manifest.files);
  const required = manifest.schema_version === 2 ? releaseFiles : legacyFiles;
  requireCondition(required.every(file => names.includes(file)) && (manifest.schema_version === 2 || names.length === 4 || (names.length === 6 && names.includes("viewer.mjs") && names.includes("posix.node"))), "INVALID_RELEASE", "Release files are incomplete");
  for (const file of names) {
    requireCondition(!file.includes("\\") && !file.split("/").some(part => !part || part === "." || part === "..") && (manifest.schema_version === 2 ? file === "viewer" || file.startsWith("skills/") : [...legacyFiles,"viewer.mjs","posix.node"].includes(file)), "UNSAFE_RELEASE", "Release resource path is forbidden");
    const path = join(root, file);
    requireCondition(
      realpathSync(path) === path &&
        !lstatSync(path).isSymbolicLink() &&
        lstatSync(path).isFile(),
      "UNSAFE_RELEASE",
      "Release file must be regular",
    );
    requireCondition(
      digest(readRegularNoFollow(path, root, undefined, 256 * 1024 * 1024)) ===
        manifest.files[file],
      "INVALID_RELEASE",
      "Release checksum mismatch",
    );
  }
  if (manifest.schema_version === 2) {
    const walk = (directory: string) => {
      for (const entry of readdirSync(join(root,directory), {withFileTypes:true})) {
        const path = directory ? directory + "/" + entry.name : entry.name;
        requireCondition(!entry.isSymbolicLink(), "UNSAFE_RELEASE", "Release links are forbidden");
        if (entry.isDirectory()) walk(path);
        else requireCondition(path === "manifest.json" || names.includes(path), "INVALID_RELEASE", "Unlisted release resource: " + path);
      }
    };
    walk("");
    // Resolve the actual service import graph inside the verified resource set.
    const pending = ["skills/multi-task-flow/scripts/service.ts"];
    const visited = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const scan = new Bun.Transpiler({loader:file.endsWith(".ts") ? "ts" : "js"});
      for (const item of scan.scanImports(readFileSync(join(root,file), "utf8"))) {
        const specifier = item.path;
        if (specifier.startsWith("node:") || specifier.startsWith("bun:") || builtinModules.includes(specifier)) continue;
        let target: string;
        try { target = Bun.resolveSync(specifier, resolve(root,file,"..")); }
        catch { throw new Error("Source dependency is missing: " + file + " -> " + specifier); }
        requireCondition(target.startsWith(root + "/") && names.includes(target.slice(root.length+1)), "INVALID_RELEASE", "Source dependency is outside resource inventory: " + file + " -> " + specifier);
        if (/\.(?:ts|mjs|js|cjs)$/.test(target)) pending.push(target.slice(root.length+1));
      }
    }
  }
  return manifest;
}
