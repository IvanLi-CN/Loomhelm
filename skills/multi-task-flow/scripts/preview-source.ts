import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  readFileSync,
  realpathSync,
  watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  createViewerValidationLedger,
  viewerValidationName,
} from "../examples/orchestration-viewer";
import { ServiceState } from "./service-state";
import { servicePaths } from "./service-paths";
import { ServiceAuth } from "./service-auth";
import { runDaemon } from "./service-lifecycle";
import { compatibility, type ReleaseManifest } from "./service-contract";
import { buildId, digest } from "./service-release";
import { LedgerStore } from "./store";
import {
  PortRegistry,
  defaultRegistryDir,
} from "../../bin/modules/workspace/port_registry";

const moduleRoot = resolve(import.meta.dir, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mtf-source-preview-")));
const assetsDir = join(root, "assets");
mkdirSync(assetsDir);
async function build() {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/build.ts",
      "--output",
      join(root, "staging"),
    ],
    {
      cwd: moduleRoot,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0)
    throw new Error(
      "Source build failed; keeping the last successful preview revision",
    );
  for (const name of ["index.html", "app.js", "app.css"]) {
    copyFileSync(join(root, "staging", name), join(assetsDir, name + ".next"));
    renameSync(join(assetsDir, name + ".next"), join(assetsDir, name));
  }
}
await build();
const state = new ServiceState(
  servicePaths({
    MULTI_TASK_FLOW_PROFILE: "development",
    MULTI_TASK_FLOW_ROOT: root,
  }),
);
state.initialize();
const auth = new ServiceAuth(state);
auth.initialize();
const run = createViewerValidationLedger();
const store = new LedgerStore(state.paths.data, run.orchestration_id);
store.create(run);
cpSync(
  join(moduleRoot, "examples", "orchestration-viewer", "requirements"),
  join(store.runPath, "requirements"),
  { recursive: true },
);
const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: moduleRoot });
if (source.exitCode !== 0) throw new Error("Cannot resolve source commit");
const files = Object.fromEntries(
  ["index.html", "app.js", "app.css"].map((name) => [
    `dist/${name}`,
    digest(readFileSync(join(assetsDir, name))),
  ]),
);
files.viewer = digest(readFileSync(import.meta.path));
const body = {
  schema_version: 1 as const,
  source_sha: source.stdout.toString().trim(),
  service_version: "source-preview",
  platform:
    `${process.platform}-${process.arch}` as ReleaseManifest["platform"],
  ...compatibility,
  files,
};
const manifest = { ...body, build_id: buildId(body) };
const registry = new PortRegistry(defaultRegistryDir());
const allocation = await registry.allocate({
  scopeId: state.paths.scope,
  service: "viewer",
  project: "multi-task-flow-source-preview",
  repoRoot: resolve(moduleRoot, "../.."),
  branch: Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd: moduleRoot,
  })
    .stdout.toString()
    .trim(),
  worktreePath: resolve(moduleRoot, "../.."),
});
const port = Number(allocation.port);
state.saveConfig({
  schema_version: 1,
  port,
  registry_dir: defaultRegistryDir(),
  current_build: manifest.build_id,
  previous_build: null,
  agent_ttl_ms: 3_600_000,
});
state.renew(
  {
    id: "source-preview",
    kind: "agent",
    thread_id: null,
    run_id: run.orchestration_id,
  },
  3_600_000,
);
let revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
const daemon = await runDaemon(state, {
  manifest,
  name: viewerValidationName,
  assetsDir,
  revision: () => revision,
});
let pending = false,
  building = false;
let timer: ReturnType<typeof setTimeout> | undefined;
async function rebuild() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  do {
    pending = false;
    try {
      await build();
      revision = digest(
        ["index.html", "app.js", "app.css"]
          .map((name) => readFileSync(join(assetsDir, name)).toString())
          .join("\n"),
      );
      console.log("Source preview rebuilt");
    } catch (error) {
      console.error(error);
    }
  } while (pending);
  building = false;
}
const watcher = watch(join(moduleRoot, "web"), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 150);
});
const renew = setInterval(
  () =>
    state.renew(
      {
        id: "source-preview",
        kind: "agent",
        thread_id: null,
        run_id: run.orchestration_id,
      },
      3_600_000,
    ),
  60_000,
);
const stop = () => {
  watcher.close();
  clearTimeout(timer);
  clearInterval(renew);
  void daemon.stop();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
console.log(
  JSON.stringify({
    mode: "source-preview",
    name: viewerValidationName,
    run_id: run.orchestration_id,
    root,
    pid: process.pid,
    port,
    scope: state.paths.scope,
    url: `http://127.0.0.1:${port}/login#${auth.ticket(`/runs/${run.orchestration_id}/`)}`,
    source_commit: manifest.source_sha,
  }),
);
