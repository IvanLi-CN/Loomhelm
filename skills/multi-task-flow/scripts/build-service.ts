import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { compatibility } from "./service-contract";
import {
  buildId,
  digest,
  releaseFiles,
  verifyRelease,
} from "./service-release";
import { requireCondition } from "./errors";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const output = args.includes("--output") ? resolve(option("--output")!) : null;
const version = args.includes("--service-version")
  ? option("--service-version")
  : null;
requireCondition(
  output && version && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version),
  "INVALID_ARGUMENTS",
  "build-service.ts --output <new-directory> --service-version <semver>",
);
requireCondition(
  !existsSync(output),
  "OUTPUT_EXISTS",
  "Build output must be a new directory",
);
const root = resolve(import.meta.dir, "..");
const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
requireCondition(
  source.exitCode === 0,
  "SOURCE_IDENTITY_REQUIRED",
  "Build requires a source commit",
);
const sourceSha = source.stdout.toString().trim();
const clean = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root });
requireCondition(
  clean.exitCode === 0 && !clean.stdout.toString().trim(),
  "DIRTY_SOURCE",
  "Release builds require committed clean source",
);
mkdirSync(join(output, "dist"), { recursive: true, mode: 0o700 });
for (const file of ["index.html", "app.js", "app.css"])
  copyFileSync(join(root, "dist", file), join(output, "dist", file));
const toolkitRoot = resolve(root, "../..");
const compile = await Bun.build({
  entrypoints: [join(root, "scripts/service.ts")],
  outdir: output,
  naming: "viewer.mjs",
  target: "node",
  format: "esm",
  define: { "import.meta.main": "true" },
  plugins: [{ name: "viewer-native-binding", setup(build) {
    build.onLoad({ filter: /\/modules\/core\/posix\.ts$/ }, async ({ path }) => ({
      contents: readFileSync(path, "utf8").replace("const expectedBindingDigest: string | undefined = undefined;", `const expectedBindingDigest = "${digest(readFileSync(join(toolkitRoot, "bin/native/posix.node")))}";`).replace(/const source =[^;]+;/, 'const source = new URL("./modules/core/posix.js", import.meta.url);').replace("../../native/posix.node", "../../posix.node"),
      loader: "ts",
    }));
  } }],
});
requireCondition(compile.success, "BUILD_FAILED", "Viewer JavaScript compilation failed");
copyFileSync(join(toolkitRoot, "bin/native/posix.node"), join(output, "posix.node"));
const runtime = Bun.spawnSync(["/usr/bin/which", "node"]);
requireCondition(runtime.exitCode === 0, "RUNTIME_REQUIRED", "A Node.js 22/24 runtime is required for launchd packaging");
const executable = realpathSync(runtime.stdout.toString().trim());
const quoted = "'" + executable.replaceAll("'", "'\\''") + "'";
writeFileSync(join(output, "viewer"), '#!/bin/sh\nset -eu\nviewer_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec ' + quoted + ' "$viewer_dir/viewer.mjs" "$@"\n', { mode: 0o700 });
chmodSync(join(output, "viewer"), 0o700);
const manifest = {
  schema_version: 1 as const,
  source_sha: sourceSha,
  service_version: version,
  platform: `${process.platform}-${process.arch}` as
    "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64",
  api_versions: compatibility.api_versions,
  frontend_contracts: compatibility.frontend_contracts,
  readable: compatibility.readable,
  writable: compatibility.writable,
  files: Object.fromEntries(
    releaseFiles.map((file) => [
      file,
      digest(readFileSync(join(output, file))),
    ]),
  ),
};
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify({ ...manifest, build_id: buildId(manifest) }, null, 2) + "\n",
  { mode: 0o600 },
);
const verified = verifyRelease(output);
console.log(JSON.stringify({ ok: true, build_id: verified.build_id, output }));
