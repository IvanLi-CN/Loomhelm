import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { servicePaths } from "../lib/service-paths";
import { ServiceAuth } from "../lib/service-auth";
import { ServiceState } from "../lib/service-state";
import { compatibility } from "../lib/service-contract";
import { versionEnvelope } from "../lib/contract";
import { buildId, digest, releaseFiles } from "../lib/service-release";
import { LedgerStore } from "../lib/store";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import type { View } from "../web/model";

export function serviceFixture(profile: "test" | "production" = "test") {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "mtf-service-")));
  const state = new ServiceState(servicePaths({ MULTI_TASK_FLOW_PROFILE: profile, MULTI_TASK_FLOW_ROOT: root }));
  state.initialize(); new ServiceAuth(state).initialize();
  return { root, state };
}
export function fixtureRelease(root: string, name = "bundle", options: { readOnly?: boolean } = {}) {
  const source = join(root, name); mkdirSync(join(source, "dist"), { recursive: true });
  const viewer = `#!/usr/bin/env bun\nconst input = await new Response(Bun.stdin.stream()).json();\nconst ledger = input.ledger;\nif (Bun.argv[2] === "read-only-view") ${options.readOnly ? 'console.log(JSON.stringify({ok:true,code:"OK",result:{view:{orchestration:{id:ledger.orchestration_id,revision:ledger.revision}}}}));' : 'process.exit(2);'}\nelse console.log(JSON.stringify({ok:true,code:"OK",result:{contract:\`schema-2/contract-\${ledger.contract_version === 2 ? 2 : 1}\`,revision:ledger.revision}}));\n`;
  for (const file of releaseFiles) { mkdirSync(dirname(join(source,file)),{recursive:true}); writeFileSync(join(source, file), file === "viewer" ? viewer : file === "skills/multi-task-flow/dist/index.html" ? "<!doctype html><html><body><h1>Run</h1></body></html>" : "// " + file + name); }
  chmodSync(join(source, "viewer"), 0o700);
  const manifest = { schema_version: 2 as const, source_sha: "a".repeat(40), service_version: "0.0.0-test", platform: `${process.platform}-${process.arch}` as "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64", ...versionEnvelope, ...compatibility, files: Object.fromEntries(releaseFiles.map(file => [file, digest(file === "viewer" ? viewer : file === "skills/multi-task-flow/dist/index.html" ? "<!doctype html><html><body><h1>Run</h1></body></html>" : "// " + file + name)])) };
  const result = { ...manifest, build_id: buildId(manifest) };
  writeFileSync(join(source, "manifest.json"), JSON.stringify(result));
  return { source, manifest: result };
}
export function fixtureRun(root: string, id = "demo-run", contract: 2 | 3 = 2) {
  const run = createDemoLedger(); run.orchestration_id = id;
  run.schema_version = 2;
  run.source_schema_version = null;
  run.contract_version = contract;
  if (contract === 3) {
    run.version = versionEnvelope;
    const sharedTask = run.tasks.find((task) => task.kind === "contribution");
    if (!sharedTask) throw new Error("Contract-3 fixture needs a contribution task");
    sharedTask.execution_owner = "delivery_agent";
    sharedTask.conversation_policy = "delivery_owned";
    sharedTask.delivery_policy = "shared_delivery_unit";
  }
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

export function emptyBootstrapView(): View {
  const groups: View["groups"] = [
    { id: "bootstrap", title: "版本化 Skill 发布合同", delivery_unit_kind: "bootstrap", owner_kind: "main", agent_thread_id: null, state: "active", parent_pr: null, requirements_path: null },
    { id: "regular", title: "后续交付", delivery_unit_kind: "regular", owner_kind: "group", agent_thread_id: null, state: "active", parent_pr: null, requirements_path: null },
  ];
  const tasks: View["tasks"] = [{
    id: "later-task", title: "后续实现任务", kind: "contribution", group_id: "regular", thread_id: null, state: "planned", is_ready: false,
    pr: null, requirements_path: null, started_at: null, finished_at: null, blocker: null,
  }];
  const nodes: View["nodes"] = [
    { id: "main-start", kind: "main_start", ref_id: null, group_id: null, planned_group_id: null, label: "主任务开始" },
    { id: "bootstrap-start", kind: "group_start", ref_id: "bootstrap", group_id: "bootstrap", planned_group_id: "bootstrap", label: "bootstrap 开始" },
    { id: "bootstrap-end", kind: "group_end", ref_id: "bootstrap", group_id: "bootstrap", planned_group_id: "bootstrap", label: "bootstrap 收口" },
    { id: "regular-start", kind: "group_start", ref_id: "regular", group_id: "regular", planned_group_id: "regular", label: "regular 开始" },
    { id: "later-task-node", kind: "task", ref_id: "later-task", group_id: "regular", planned_group_id: "regular", label: "后续实现任务" },
    { id: "regular-end", kind: "group_end", ref_id: "regular", group_id: "regular", planned_group_id: "regular", label: "regular 收口" },
    { id: "main-end", kind: "main_end", ref_id: null, group_id: null, planned_group_id: null, label: "主任务完成" },
  ];
  const edge = (id: string, from_node_id: string, to_node_id: string, requires: string): View["edges"][number] => ({ id, from_node_id, to_node_id, requires });
  return {
    orchestration: { id: "empty-bootstrap-run", repository: { owner: "example", name: "loomhelm", host: "github.com" }, revision: 1, updated_at: "2026-01-01T00:00:00.000Z", display_timezone: "UTC", max_running_tasks: 1, conversation_links_verified: true },
    groups, tasks, plans: [], selected_plan_id: "", follow_prs: [], nodes,
    edges: [
      edge("main-to-bootstrap", "main-start", "bootstrap-start", "completed"),
      edge("bootstrap-through", "bootstrap-start", "bootstrap-end", "completed"),
      edge("bootstrap-to-regular", "bootstrap-end", "regular-start", "merged"),
      edge("regular-to-task", "regular-start", "later-task-node", "completed"),
      edge("task-to-regular-end", "later-task-node", "regular-end", "completed"),
      edge("regular-to-main-end", "regular-end", "main-end", "completed"),
    ],
    planned_intervals: [], actual_intervals: [], actual_milestones: [], warnings: [],
  };
}
