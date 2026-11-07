import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoLedger, createPlanningDemoLedger } from "../examples/orchestration-viewer/ledger";
import { startDashboard } from "../scripts/server";
import { LedgerStore } from "../scripts/store";
import { actualIntervals, buildView } from "../scripts/view";
import { conversationUrl } from "../web/links";

describe("dashboard example", () => {
  test("the planning preview does not fabricate execution facts", () => {
    const ledger = createPlanningDemoLedger(Date.parse("2026-10-31T00:00:00.000Z"));
    const view = buildView(ledger) as { execution_phase: string; planned_intervals: unknown[]; actual_intervals: unknown[] };
    expect(view.execution_phase).toBe("planning");
    expect(ledger.events.filter((event) => event.type === "task_started")).toHaveLength(0);
    expect(ledger.tasks.every((task) => task.state === "planned" && task.started_at === null && task.finished_at === null)).toBe(true);
    expect(view.planned_intervals.length).toBeGreaterThan(0);
    expect(view.actual_intervals).toEqual([]);
  });

  test("uses distinct UUID-shaped Codex conversation addresses", () => {
    const ledger = createDemoLedger();
    const ids = [ledger.control.owner_thread_id, ...ledger.groups.map((group) => group.agent_thread_id), ...ledger.tasks.map((task) => task.thread_id)].filter((id): id is string => id !== null);
    const verification = JSON.parse(readFileSync(join(import.meta.dir, "..", "examples", "orchestration-viewer", "link-verification.json"), "utf8")) as { results: { thread_id: string; navigated: boolean }[] };
    expect(new Set(ids).size).toBe(ids.length);
    expect(verification.results).toHaveLength(ids.length);
    expect(new Set(verification.results.filter((result) => result.navigated).map((result) => result.thread_id))).toEqual(new Set(ids));
    for (const id of ids) {
      const url = new URL(conversationUrl(id));
      expect(url.protocol).toBe("codex:");
      expect(url.hostname).toBe("threads");
      expect(url.pathname).toMatch(/^\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
  test("uses same-document native conversation links like the working dashboard", () => {
    expect(conversationUrl("01a18bf3-feb7-7d52-98b3-dc25f8549f69")).toBe("codex://threads/01a18bf3-feb7-7d52-98b3-dc25f8549f69");
    expect(conversationUrl(" 01a18bf3-feb7-7d52-98b3-dc25f8549f69 ")).toBe("codex://threads/01a18bf3-feb7-7d52-98b3-dc25f8549f69");
  });
  test("keeps the cut history and post-merge work in the right groups", () => {
    const ledger = createDemoLedger(Date.parse("2026-10-31T00:00:00.000Z"));
    const view = buildView(ledger);
    const intervals = actualIntervals(ledger).filter((interval) => interval.task_id === "dashboard-ui");
    expect(intervals.map((interval) => interval.group_id)).toEqual(["core", "dashboard"]);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]!.end).toBe(intervals[1]!.start);
    expect(ledger.tasks.filter((task) => ["release", "deploy", "verify"].includes(task.id)).map((task) => task.group_id)).toEqual(["core", "core", "core"]);
    expect(ledger.follow_prs).toHaveLength(1);
    expect(ledger.follow_prs[0]!.origin_group_id).toBe("core");
    expect((view.orchestration as { conversation_links_verified: boolean }).conversation_links_verified).toBe(true);
    expect(ledger.events.find((event) => event.type === "link_verification")?.data.evidence_ref).toBe("examples/orchestration-viewer/link-verification.json");
    expect(ledger.tasks.every((task) => task.atoms.length > 0)).toBe(true);
  });

  test("observed starts respect dependencies and the running limit", () => {
    const reference = Date.parse("2026-10-31T00:00:00.000Z");
    const ledger = createDemoLedger(reference);
    const task = (id: string) => ledger.tasks.find((item) => item.id === id)!;
    expect(Date.parse(task("scheduler").started_at!)).toBeGreaterThanOrEqual(Date.parse(task("model").finished_at!));
    expect(Date.parse(task("scheduler").started_at!)).toBeGreaterThanOrEqual(Date.parse(task("ledger").finished_at!));
    expect(Date.parse(task("release").started_at!)).toBeGreaterThanOrEqual(Date.parse(ledger.facts.find((fact) => fact.id === "parent-merged")!.observed_at));
    expect(Date.parse(task("deploy").started_at!)).toBeGreaterThanOrEqual(Date.parse(task("release").finished_at!));
    const changes = actualIntervals(ledger).filter((interval) => interval.state === "running").flatMap((interval) => [
      { at: Date.parse(interval.start), delta: 1 },
      { at: interval.end ? Date.parse(interval.end) : reference, delta: -1 },
    ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
    let running = 0;
    for (const change of changes) { running += change.delta; expect(running).toBeLessThanOrEqual(ledger.config.max_running_tasks); }
    expect(running).toBe(0);
  });

  test("uses the approved Chinese-first display titles without changing machine identity", () => {
    const ledger = createDemoLedger();
    expect(ledger.tasks.map((task) => ({ id: task.id, kind: task.kind, title: task.title }))).toEqual([
      { id: "model", kind: "contribution", title: "依赖模型与任务图" },
      { id: "ledger", kind: "contribution", title: "账本持久化与并发控制" },
      { id: "scheduler", kind: "contribution", title: "调度与 PR 合并协调" },
      { id: "release", kind: "release", title: "核心能力版本发布" },
      { id: "deploy", kind: "deployment", title: "运行环境部署与验证" },
      { id: "verify", kind: "verification", title: "发布后核心能力验证" },
      { id: "dashboard-ui", kind: "contribution", title: "依赖图与甘特图交互验证" },
      { id: "server", kind: "contribution", title: "只读视图服务与实时更新" },
      { id: "integration", kind: "contribution", title: "动态切割端到端验证" },
      { id: "acceptance", kind: "verification", title: "页面验收与发布核对" },
    ]);
  });

  test("serves the registered example requirements without exposing other files", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "orchestration-demo-docs-"));
    const ledger = createDemoLedger(Date.parse("2026-10-31T00:00:00.000Z"));
    const store = new LedgerStore(root, ledger.orchestration_id);
    store.create(ledger);
    cpSync(join(import.meta.dir, "..", "examples", "orchestration-viewer", "requirements"), join(store.runPath, "requirements"), { recursive: true });
    const assetsDir = join(root, "assets"); mkdirSync(assetsDir);
    const server = await startDashboard({ root, runId: ledger.orchestration_id, port: 0, assetsDir, demoFrame: true });
    try {
      const base = `http://127.0.0.1:${server.port}/s/${server.token}/`;
      const view = await (await fetch(`${base}api/view`)).json() as { view: { tasks: { id: string }[] } };
      expect(view.view.tasks).toHaveLength(ledger.tasks.length);
      expect(view.view).not.toHaveProperty("is_demo");
      for (const item of [...ledger.groups, ...ledger.tasks]) {
        const type = ledger.groups.some((group) => group.id === item.id) ? "group" : "task";
        const response = await fetch(`${base}api/document/${type}-${item.id}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(item.title);
      }
      expect((await fetch(`${base}api/document/task-unknown`)).status).toBe(404);
    } finally { await server.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});

test("idle/archive example is synthetic and supports real archive reconciliation", async () => {
  const { createIdleArchiveExample } = await import("../examples/orchestration-viewer");
  const { retryConversationArchive } = await import("../scripts/conversation-archive");
  const example = createIdleArchiveExample();
  expect(example.ledger.tasks.find(t => t.id === "dashboard-ui")?.state).toBe("agent_idle");
  expect(example.ledger.tasks.every(t => !t.thread_id || t.thread_id.startsWith("example-thread-"))).toBe(true);
  const connection = await example.dashboard.connectObserver(() => {}, () => {});
  const thread = example.ledger.tasks.find(t => t.id === "dashboard-ui")!.thread_id;
  expect(await connection.request("thread/read", {threadId: thread})).toMatchObject({thread: {status: {type: "idle"}}});
  const root = mkdtempSync(join(realpathSync(tmpdir()), "idle-archive-example-test-"));
  try {
    const store = new LedgerStore(root, example.ledger.orchestration_id); store.create(example.ledger);
    for (const taskId of ["model", "ledger"]) {
      const state = store.read().tasks.find((t: any) => t.id === taskId).state;
      expect((await retryConversationArchive(store, taskId, example.dashboard.archiveProvider)).status).toBe("closed");
      expect(store.read().tasks.find((t: any) => t.id === taskId).state).toBe(state);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
