import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0 && !process.argv[outputIndex + 1])
  throw new Error("Missing --output directory");
const output =
  outputIndex >= 0
    ? resolve(process.argv[outputIndex + 1]!)
    : join(root, "dist");
mkdirSync(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "web", "app.ts")],
  outdir: output,
  naming: "app.js",
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production"), "import.meta.env": JSON.stringify({MODE:"production"}) },
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
copyFileSync(join(root, "web", "index.html"), join(output, "index.html"));
console.log("Dashboard assets built successfully");
