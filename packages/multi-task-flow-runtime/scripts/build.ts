import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SKILL_VERSION, VIEWER_CONTRACT } from "../lib/contract";
import {
  ARTIFACT_BUILD_ID_PLACEHOLDER,
  serializeViewerProvenance,
  staticViewerProvenanceSchema,
  VIEWER_PROVENANCE_SCRIPT_ID,
} from "../lib/runtime-metadata";

const root = join(import.meta.dir, "..");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0 && !process.argv[outputIndex + 1])
  throw new Error("Missing --output directory");
const output = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]!) : join(root, "dist");
mkdirSync(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "web", "app.ts")],
  outdir: output,
  naming: "app.js",
  target: "browser",
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "import.meta.env": JSON.stringify({ MODE: "production" }),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const css = Bun.spawnSync(
  [
    join(root, "node_modules", ".bin", "tailwindcss"),
    "-i",
    "web/app.css",
    "-o",
    join(output, "app.css"),
    "--minify",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (css.exitCode !== 0) process.exit(css.exitCode ?? 1);
const indexPath = join(output, "index.html");
copyFileSync(join(root, "web", "index.html"), indexPath);
const repoRoot = resolve(root, "../..");
const packageMetadata = JSON.parse(
  readFileSync(join(repoRoot, "clients/typescript/package.json"), "utf8"),
) as {
  name: string;
  version: string;
  loomhelm?: { compatibilityLine?: string };
};
const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot });
if (source.exitCode !== 0) throw new Error("Viewer provenance requires a source commit");
const viewerProvenance = staticViewerProvenanceSchema.parse({
  schema_version: 1,
  source: "package",
  package_name: packageMetadata.name,
  package_version: packageMetadata.version,
  compatibility_line: packageMetadata.loomhelm?.compatibilityLine,
  skill_version: SKILL_VERSION,
  viewer_contract: VIEWER_CONTRACT,
  build_id: ARTIFACT_BUILD_ID_PLACEHOLDER,
  source_sha: source.stdout.toString().trim(),
});
const marker = '<script id="' + VIEWER_PROVENANCE_SCRIPT_ID + '" type="application/json">';
const endTag = "</script>";
const html = readFileSync(indexPath, "utf8");
const markerStart = html.indexOf(marker);
const bodyEnd = markerStart < 0 ? -1 : html.indexOf(endTag, markerStart + marker.length);
if (markerStart < 0 || bodyEnd < 0 || html.indexOf(marker, markerStart + 1) >= 0)
  throw new Error("Viewer provenance marker is missing or duplicated");
writeFileSync(
  indexPath,
  html.slice(0, markerStart) +
    serializeViewerProvenance(viewerProvenance) +
    html.slice(bodyEnd + endTag.length),
);
console.log("Dashboard assets built successfully");
