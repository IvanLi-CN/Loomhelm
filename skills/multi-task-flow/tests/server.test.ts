import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../scripts/store";
import { apply } from "../scripts/engine";
import { validateLedger } from "../scripts/schema";
import { startDashboard } from "../scripts/server";

const paths: string[] = [];
const at = "2026-01-01T00:00:00.000Z";
const token = "0123456789abcdefghijklmnopqrstuv";
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "orchestration-server-")); paths.push(root);
  const assets = join(root, "assets"); mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<h1>Demo</h1>");
  const store = new LedgerStore(root, "run");
  store.create({
    schema_version: 2, source_schema_version: null, contract_version: 2, orchestration_id: "run", revision: 0,
    repository: { provider: "github", host: "github.com", owner: "example", name: "repo", target_branch: "main" },
    control: { owner_thread_id: "main-thread", ownership: "bound", approval_id: null },
    config: { execution_profile: { model: "gpt-6.1-sol", thinking: "medium" }, max_running_tasks: 3, display_timezone: "Asia/Shanghai" },
    plans: [{ lifecycle: "proposed", revision: null, id: "plan", supersedes_id: null, approval_id: null, created_at: at, start_at: null, atoms: [], atomic_edges: [], nodes: [], edges: [], cut_rules: [], actions: [] }],
    active_plan_id: "plan", execution_plan_id: "plan", groups: [], tasks: [], follow_prs: [], facts: [], operations: [], events: [], milestones: [], requests: [], notifications: [], resources: [], updated_at: at,
  });
  return { root, assets, store };
}

describe("read-only dashboard server", () => {
  test("requires a token and rejects writes and foreign origins", async () => {
    const { root, assets } = setup();
    const server = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${base}/s/wrong/api/view`)).status).toBe(404);
      expect((await fetch(`${base}/s/${token}/api/view`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${base}/s/${token}/api/view`, { headers: { origin: "https://example.invalid" } })).status).toBe(403);
      const view = await fetch(`${base}/s/${token}/api/view`);
      expect(view.status).toBe(200);
      expect((await view.json() as any).revision).toBe(0);
      expect((await (await fetch(`${base}/s/${token}/api/view`)).json() as any)).toMatchObject({ active_plan_id: "plan", execution_plan_id: "plan", view: { execution_phase: "planning" } });
      expect((await fetch(`${base}/s/${token}/api/view?plan=bad%2Fplan`)).status).toBe(404);
      const page = await fetch(`${base}/s/${token}/`);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(page.headers.get("content-security-policy")).not.toContain("fonts.googleapis.com");
      expect((await fetch(`${base}/s/${token}/api/document/task-a`)).status).toBe(404);
    } finally { await server.stop(); }
  });

  test("pushes the new revision after an atomic ledger replacement", async () => {
    const { root, assets, store } = setup();
    const server = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/s/${token}/api/events`);
      const reader = response.body!.getReader();
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain('"revision":0');
      store.update((ledger) => { ledger.revision = 1; });
      let payload = "";
      const waitForRevision = (async () => {
        while (!payload.includes('"revision":1')) {
          const changed = await reader.read();
          if (changed.done) break;
          payload += new TextDecoder().decode(changed.value);
        }
        return payload;
      })();
      await Promise.race([
        waitForRevision,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No revision notification")), 5_000)),
      ]);
      expect(payload).toContain('"revision":1');
      await reader.cancel();
    } finally { await server.stop(); }
  });

  test("serves tokenized theme preferences without changing the ledger", async () => {
    const { root, assets, store } = setup();
    const before = JSON.stringify(store.read());
    const server = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token });
    const base = `http://127.0.0.1:${server.port}/s/${token}`;
    try {
      expect(await (await fetch(`${base}/api/preferences`)).json()).toEqual({ schema_version: 1, theme: "system" });
      expect((await fetch(`${base}/api/preferences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "dark" }) })).status).toBe(200);
      expect(await (await fetch(`${base}/api/preferences`)).json()).toEqual({ schema_version: 1, theme: "dark" });
      expect((await fetch(`${base}/api/preferences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "blue" }) })).status).toBe(400);
      expect((await fetch(`${base}/api/preferences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "light", extra: true }) })).status).toBe(400);
      expect((await fetch(`${base}/api/preferences`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1025) })).status).toBe(413);
      expect((await fetch(`${base}/api/preferences`, { method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json" }, body: JSON.stringify({ theme: "light" }) })).status).toBe(403);
      expect(JSON.stringify(store.read())).toBe(before);
    } finally { await server.stop(); }
  });
  test("authenticated profile writes enforce capabilities, owner identity, revision and source read-only", async () => {
    const { root, assets, store } = setup();
    const capabilities = async () => [{ model: "gpt-6.1-sol", thinking: ["medium", "high"] }];
    const server = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token, getProfileCapabilities: capabilities });
    const base = `http://127.0.0.1:${server.port}/s/${token}/api/execution-profile`;
    const write = (changes: Record<string, unknown> = {}) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run_id: "run", actor: { role: "main", thread_id: "main-thread" }, request_id: "profile-request", expected_revision: 0, payload: { target_type: "run", execution_profile: { model: "gpt-6.1-sol", thinking: "high" } }, ...changes }) });
    try {
      expect((await (await fetch(base)).json() as any).capabilities).toEqual(await capabilities());
      expect((await write({ payload: { target_type: "run", execution_profile: { model: "invalid", thinking: "high" } } })).status).toBe(400);
      expect((await write({ actor: { role: "main", thread_id: "stranger" } })).status).toBe(403);
      expect((await write({ run_id: "another-run" })).status).toBe(400);
      expect((await write()).status).toBe(200);
      expect(store.read().config.execution_profile).toEqual({ model: "gpt-6.1-sol", thinking: "high" });
      expect((await write({ request_id: "stale-profile" })).status).toBe(409);
    } finally { await server.stop(); }
    const source = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token, readOnly: true, getProfileCapabilities: capabilities });
    try {
      const response = await fetch(`http://127.0.0.1:${source.port}/s/${token}/api/execution-profile`, { method: "POST", body: "{}" });
      expect(response.status).toBe(403);
    } finally { await source.stop(); }
  });

});


test("authenticated loopback edits replace claims, emit revisions and freeze on native identity", async () => {
  const { root, assets, store } = setup();
  store.update((raw) => {
    raw.groups = [{ id: "g", title: "Group", agent_thread_id: "group-thread", state: "active", parent_branch: null, parent_pr: null, cut_sha: null, current_sha: null, merge_sha: null, requirements_path: null }];
    raw.tasks = ["a", "b"].map((id) => ({ id, title: id, kind: "coordination", group_id: "g", thread_id: null, state: "planned", atoms: [{ id: `atom-${id}`, title: id, status: "planned" }], owned_surfaces: [], base_sha: null, pr: null, requirements_path: null, started_at: null, finished_at: null, blocker: null, assignment_history: [] }));
    raw.plans[0].atoms = ["a", "b"].map((id) => ({ id: `atom-${id}`, title: id, task_id: id, purpose: "fixture task", output: "fixture output" }));
    raw.plans[0].nodes = ["a", "b"].map((id) => ({ id: `node-${id}`, kind: "task", ref_id: id, group_id: "g", label: id, estimate_minutes: 30, estimate_basis: "fixture estimate", estimate_confidence: "medium" }));
  });
  const mutate = (command: string, payload: Record<string, unknown>) => store.update((raw) => apply(raw, command, { run_id: "run", actor: { role: "main", thread_id: "main-thread" }, request_id: crypto.randomUUID(), expected_revision: raw.revision, payload }));
  mutate("plan-approve", { plan_id: "plan", approval_id: "approved", authorized_actions: ["dispatch"], authorized_action_ids: [] });
  mutate("dispatch-claim", { task_id: "a", operation_id: "old-claim" });
  const server = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token, getProfileCapabilities: async () => [{ model: "gpt-6.1-sol", thinking: ["medium", "high"] }] });
  const base = `http://127.0.0.1:${server.port}/s/${token}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = (await fetch(`${base}/api/events`)).body!.getReader();
    await reader.read();
    const update = () => fetch(`${base}/api/execution-profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run_id: "run", actor: { role: "main", thread_id: "main-thread" }, request_id: crypto.randomUUID(), expected_revision: store.read().revision, payload: { target_type: "task", target_id: "a", execution_profile: { model: "gpt-6.1-sol", thinking: "high" } } }) });
    expect((await update()).status).toBe(200);
    const changed = validateLedger(store.read());
    expect(changed.operations.find((op) => op.id === "old-claim")?.status).toBe("failed");
    expect(changed.events.some((event) => event.type === "dispatch_claim_replaced")).toBe(true);
    const streamRevision = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE revision missing")), 2000))]);
    expect(new TextDecoder().decode(streamRevision.value)).toContain('event: revision');
    mutate("dispatch-claim", { task_id: "a", operation_id: "new-claim" });
    mutate("dispatch-bind-request", { operation_id: "new-claim", native_request_id: "native-loopback" });
    expect((await update()).status).toBe(409);
    const view = await (await fetch(`${base}/api/view`)).json() as any;
    expect(view.view.tasks.find((task: any) => task.id === "a").profile_freeze_reason).toContain("须先对账");
    expect(view.view.tasks.find((task: any) => task.id === "b").effective_execution_profile).toEqual({ model: "gpt-6.1-sol", thinking: "medium" });
  } finally { await reader?.cancel(); await server.stop(); }
});

test("resource details inherit dashboard authorization and reject unbound targets", async () => {
  const { root, assets, store } = setup();
  const before = JSON.stringify(store.read());
  const server = await startDashboard({ root, assetsDir: assets, runId: "run", port: 0, token });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/s/invalid/api/resource-details?kind=task&id=other`)).status).toBe(404);
    expect((await fetch(`${base}/s/${token}/api/resource-details?kind=task&id=other`)).status).toBe(404);
    expect((await fetch(`${base}/s/${token}/api/resource-details?kind=task&id=other&url=https://evil.test`)).status).toBe(400);
    expect((await fetch(`${base}/s/${token}/api/resource-details?kind=group&id=other`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/s/${token}/api/resource-details?kind=task&id=other`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect(JSON.stringify(store.read())).toBe(before);
  } finally { await server.stop(); }
});
