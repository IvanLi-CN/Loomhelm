import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { servicePaths } from "../lib/service-paths";
import { ServiceAuth } from "../lib/service-auth";
import { ServiceState } from "../lib/service-state";
import { compatibility } from "../lib/service-contract";
import { buildId, digest, releaseFiles } from "../lib/service-release";
import { LedgerStore } from "../lib/store";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";

export function serviceFixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "mtf-service-")));
  const state = new ServiceState(servicePaths({ MULTI_TASK_FLOW_PROFILE: "test", MULTI_TASK_FLOW_ROOT: root }));
  state.initialize(); new ServiceAuth(state).initialize();
  return { root, state };
}
export function fixtureRelease(root: string, name = "bundle", options: { readOnly?: boolean } = {}) {
  const source = join(root, name); mkdirSync(join(source, "dist"), { recursive: true });
  const viewer = `#!/usr/bin/env bun\nconst input = await new Response(Bun.stdin.stream()).json();\nconst ledger = input.ledger;\nif (Bun.argv[2] === "read-only-view") ${options.readOnly ? 'console.log(JSON.stringify({ok:true,code:"OK",result:{view:{run_id:ledger.orchestration_id,revision:ledger.revision}}}));' : 'process.exit(2);'}\nelse console.log(JSON.stringify({ok:true,code:"OK",result:{contract:"schema-2/contract-1",revision:ledger.revision}}));\n`;
  for (const file of releaseFiles) { mkdirSync(dirname(join(source,file)),{recursive:true}); writeFileSync(join(source, file), file === "viewer" ? viewer : file === "skills/multi-task-flow/dist/index.html" ? "<!doctype html><html><body><h1>Run</h1></body></html>" : "// " + file + name); }
  chmodSync(join(source, "viewer"), 0o700);
  const manifest = { schema_version: 2 as const, source_sha: "a".repeat(40), service_version: "0.0.0-test", platform: `${process.platform}-${process.arch}` as "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64", ...compatibility, files: Object.fromEntries(releaseFiles.map(file => [file, digest(file === "viewer" ? viewer : file === "skills/multi-task-flow/dist/index.html" ? "<!doctype html><html><body><h1>Run</h1></body></html>" : "// " + file + name)])) };
  const result = { ...manifest, build_id: buildId(manifest) };
  writeFileSync(join(source, "manifest.json"), JSON.stringify(result));
  return { source, manifest: result };
}
export function fixtureRun(root: string, id = "demo-run") {
  const run = createDemoLedger(); run.orchestration_id = id;
  run.schema_version = 2;
  run.source_schema_version = null;
  run.contract_version = 2;
  const store = new LedgerStore(root, id); store.create(run);
  return { run, store };
}

export function fixtureLegacyRelease(root: string) {
  const source = join(root, "legacy-bundle");
  const names = ["viewer", "dist/index.html", "dist/app.js", "dist/app.css"];
  for (const file of names) { mkdirSync(dirname(join(source,file)), {recursive:true}); writeFileSync(join(source,file), file); }
  const body = {schema_version:1 as const, source_sha:"a".repeat(40), service_version:"0.0.0-test", platform:`${process.platform}-${process.arch}` as "darwin-arm64" | "linux-x64", ...compatibility, files:Object.fromEntries(names.map(file => [file,digest(file)]))};
  const manifest = {...body,build_id:buildId(body)};
  writeFileSync(join(source,"manifest.json"),JSON.stringify(manifest));
  return {source,manifest};
}
