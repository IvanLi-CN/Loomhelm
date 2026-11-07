import { beforeEach, describe, expect, test } from "bun:test";
import { createDetailContent } from "../../web/details-content";

beforeEach(() => {
  document.body.innerHTML = `<div id="details-content"></div>`;
});

describe("dashboard details content", () => {
  test("keeps an explicit empty state when selection is invalid or absent", () => {
    const details = createDetailContent({
      getData: () => null,
      labels: {},
      labelTask: () => "",
      time: () => "",
      safeExternal: () => null,
      groupRange: () => ({ start: null, end: null }),
    });

    const empty = details.clearDetails();

    expect(empty.className).toBe("details-empty");
    expect(empty.querySelector("strong")?.textContent).toBe("选择交付单元或任务");
    expect(empty.textContent).toContain("查看依赖、运行时间和原生会话链接");
  });

  test("removes empty-state layout from a selected task", () => {
    const view = {
      orchestration: { id: "run", repository: { owner: "example", name: "repo", host: "github.com" }, revision: 1, updated_at: "2026-01-01T00:00:00.000Z", display_timezone: "UTC", max_running_tasks: 1, conversation_links_verified: true },
      groups: [{ id: "core", title: "核心", state: "running", agent_thread_id: null, parent_pr: { url: null }, requirements_path: null }],
      tasks: [{ id: "task", title: "任务", group_id: "core", kind: "contribution", state: "running", is_ready: false, blocker: null, thread_id: null, pr: { url: null }, requirements_path: null, started_at: "2026-01-01T00:00:00.000Z", finished_at: null, latest_output: null }],
      plans: [], selected_plan_id: "", follow_prs: [],
      nodes: [
        { id: "parent-merge", kind: "milestone", ref_id: "core", group_id: "core", planned_group_id: "core", label: "父 PR 合并" },
        { id: "task-node", kind: "task", ref_id: "task", group_id: "core", planned_group_id: "core", label: "任务" },
      ],
      edges: [{ id: "edge-merge-task", from_node_id: "parent-merge", to_node_id: "task-node", requires: "merged" }], planned_intervals: [], actual_intervals: [], actual_milestones: [], warnings: [],
    };
    const details = createDetailContent({
      getData: () => view,
      labels: { running: "执行中" },
      labelTask: () => "执行中",
      time: () => "未知",
      safeExternal: () => null,
      groupRange: () => ({ start: null, end: null }),
    });

    const profileDetails = createDetailContent({ getData: () => view, labels: {}, labelTask: () => "任务", time: () => "未知", safeExternal: () => null, groupRange: () => ({ start: null, end: null }), profileContext: () => ({ capabilities: [{ model: "gpt-6.1-sol", thinking: ["medium", "high"] }], update: async () => {} }) });
    profileDetails.showTask(view.tasks[0]!);
    expect(document.querySelectorAll(".execution-profile-editor")).toHaveLength(1);
    expect(document.querySelector('select[aria-label="运行默认模型"]')).toBeNull();
    expect(document.querySelector('input[type="range"]')).not.toBeNull();

    expect(document.getElementById("details-content")?.className).toBe("");
    const content = document.getElementById("details-content")?.textContent ?? "";
    expect(content).toContain("任务");
    expect(content).toContain("贡献 contribution");
    expect(content).not.toContain("选择交付单元或任务");
    expect(content).toContain("父 PR 合并");
    expect(content).toContain("父 PR 已合并 merged");
    expect(content).toContain("edge-merge-task");

    let retries = 0;
    Object.assign(view.tasks[0]!, { agent_idle: true, thread_id: "thread-task", conversation_resource: { id: "conversation-task", kind: "conversation", target: "thread-task", status: "archive_failed", evidence_ref: "archive-error", error: "archive refused", last_attempt_at: "2026-01-01T00:00:00.000Z", operation_id: "archive-1" } });
    const archiveDetails = createDetailContent({ getData: () => view, labels: {}, labelTask: () => "执行中", time: () => "未知", safeExternal: () => null, groupRange: () => ({ start: null, end: null }), archiveConversation: () => { retries++; } });
    archiveDetails.showTask(view.tasks[0]!);
    expect(document.getElementById("details-content")?.textContent).toContain("archive refused");
    (document.querySelector(".detail-action") as HTMLButtonElement).click();
    expect(retries).toBe(1);
  });

  test("renders path provenance and hidden plan boundaries without flattening conditions", () => {
    const view = {
      orchestration: { id: "run", repository: { owner: "example", name: "repo", host: "github.com" }, revision: 1, updated_at: "2026-01-01T00:00:00.000Z", display_timezone: "UTC", max_running_tasks: 1, conversation_links_verified: true },
      groups: [{ id: "core", title: "核心", state: "running", agent_thread_id: null, parent_pr: { url: null }, requirements_path: null }],
      tasks: [{ id: "task", title: "任务", group_id: "core", kind: "contribution", state: "running", is_ready: false, blocker: null, thread_id: null, pr: { url: null }, requirements_path: null, started_at: null, finished_at: null, latest_output: null }],
      plans: [], selected_plan_id: "", follow_prs: [],
      nodes: [
        { id: "entry", kind: "main_start", ref_id: null, group_id: null, planned_group_id: null, label: "主任务开始" },
        { id: "task-node", kind: "task", ref_id: "task", group_id: "core", planned_group_id: "core", label: "任务" },
        { id: "hidden-a", kind: "group_start", ref_id: "core", group_id: "core", planned_group_id: "core", label: "组开始" },
        { id: "hidden-b", kind: "group_start", ref_id: "core", group_id: "core", planned_group_id: "core", label: "另一个组开始" },
      ],
      edges: [
        { id: "entry-task", from_node_id: "entry", to_node_id: "task-node", requires: "completed" },
        { id: "a-task", from_node_id: "hidden-a", to_node_id: "task-node", requires: "integrated" },
        { id: "b-task", from_node_id: "hidden-b", to_node_id: "task-node", requires: "merged" },
      ], planned_intervals: [], actual_intervals: [], actual_milestones: [], warnings: [],
    };
    const details = createDetailContent({
      getData: () => view,
      labels: { running: "执行中" },
      labelTask: () => "执行中",
      time: () => "未知",
      safeExternal: () => null,
      groupRange: () => ({ start: null, end: null }),
    });

    details.showTask(view.tasks[0]!);

    const content = document.getElementById("details-content")?.textContent ?? "";
    expect(content).toContain("计划入口");
    expect(content).toContain("路径1：");
    expect(content).toContain("任务已完成 completed");
    expect(content).toContain("子 PR 已集成 integrated");
    expect(content).toContain("父 PR 已合并 merged");
    expect(content).toContain("entry-task");
    expect(content).toContain("a-task");
    expect(content).toContain("b-task");
    const trigger = document.querySelector<HTMLButtonElement>(".dependency-tooltip-trigger");
    const tooltip = trigger ? document.getElementById(trigger.getAttribute("aria-describedby") ?? "") : null;
    expect(trigger?.textContent).toBe("查看 1 项依赖");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toContain("计划入口");
  });
});
