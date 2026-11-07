import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRegular } from "./store";
import { requireCondition } from "./errors";
import { readRegularNoFollow } from "../../bin/modules/visual/secure_io";
import {
  releaseManifestSchema,
  type ReleaseManifest,
} from "./service-contract";

export const releaseFiles = [
  "viewer",
  "viewer.mjs",
  "posix.node",
  "dist/index.html",
  "dist/app.js",
  "dist/app.css",
] as const;
export const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export function buildId(manifest: Omit<ReleaseManifest, "build_id">): string {
  return digest(
    JSON.stringify({
      ...manifest,
      files: Object.fromEntries(
        Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
      ),
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
  requireCondition(
    (Object.keys(manifest.files).length === 4 && !manifest.files["viewer.mjs"] && !manifest.files["posix.node"]) || Object.keys(manifest.files).length === releaseFiles.length,
    "INVALID_RELEASE",
    "Release files are incomplete",
  );
  for (const file of (Object.keys(manifest.files).length === 4 ? releaseFiles.filter(file => file !== "viewer.mjs" && file !== "posix.node") : releaseFiles)) {
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
  return manifest;
}
