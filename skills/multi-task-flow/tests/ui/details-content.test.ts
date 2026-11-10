import { beforeEach, describe, expect, test } from "bun:test";
import { createDetailContent } from "../../web/details-content";
import type { Group, View } from "../../web/model";
import { planStateSeverity, renderPlanInfoContent, renderPlanState } from "../../web/status-row";

beforeEach(() => {
  document.body.innerHTML = `<div id="details-summary"></div><div id="details-content"></div>`;
});

describe("dashboard details content", () => {
  test("group details and previews use only group execution times", () => {
    const group = { id: "core", title: "核心", state: "closed", agent_thread_id: null, parent_pr: { url: null }, started_at: "2026-01-01T10:00:00Z", finished_at: "2026-01-01T10:30:00Z" } as Group;
    const view = { groups: [group], tasks: [{ id: "task", title: "贡献任务", group_id: "core", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T08:00:00Z" }], actual_intervals: [{ task_id: "task", group_id: "core", start: "2026-01-01T00:00:00Z", end: "2026-01-01T08:00:00Z" }] } as unknown as View;
    const details = createDetailContent({ getData: () => view, labels: {}, labelTask: () => "", time: () => "", safeExternal: () => null });
    const duration = (preview: HTMLElement) => [...preview.querySelectorAll(".hover-preview-row")].find(row => row.querySelector(".hover-preview-label")?.textContent === "持续时间")?.querySelector(".hover-preview-value")?.textContent;
    details.showGroup(group);
    expect(document.querySelector(".detail-duration")?.textContent).toBe("30分");
    expect(document.querySelector("#details-content")?.textContent).toContain("历史执行任务贡献任务");
    expect(duration(details.groupPreview(group))).toBe("30分");
    group.started_at = null; group.finished_at = null;
    details.showGroup(group);
    expect(document.querySelector(".detail-duration")?.textContent).toBe("未知");
    expect(duration(details.groupPreview(group))).toBe("未知");
  });
  test("keeps the summary outside the scroll body and preserves only the same object's reading position", () => {
    const group = { id: "same", title: "交付单元", state: "closed", parent_pr: { url: null } } as Group;
    const view = { groups: [group], tasks: [], actual_intervals: [] } as unknown as View;
    const details = createDetailContent({ getData: () => view, labels: {}, labelTask: () => "", time: () => "", safeExternal: () => null });
    const body = document.getElementById("details-content")!;
    details.showGroup(group);
    expect(body.querySelector(".detail-title")).toBeNull();
    expect(document.querySelector("#details-summary .detail-title")?.textContent).toBe(group.title);
    body.scrollTop = 180;
    details.showGroup({ ...group, title: "更新后的交付单元" });
    expect(body.scrollTop).toBe(180);
    details.showGroup({ ...group, id: "other" });
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 90;
    details.clearDetails();
    expect(body.scrollTop).toBe(0);
    expect(document.getElementById("details-summary")?.textContent).toBe("");
  });

  test("keeps an explicit empty state when selection is invalid or absent", () => {
    const details = createDetailContent({
      getData: () => null,
      labels: {},
      labelTask: () => "",
      time: () => "",
      safeExternal: () => null,
    });

    const empty = details.clearDetails();

    expect(empty.className).toBe("details-empty");
    expect(empty.querySelector("strong")?.textContent).toBe("选择交付单元或任务");
    expect(empty.textContent).toContain("查看依赖、运行时间和原生会话链接");
  });

  test("renders proposal, approval, scheduling, and runtime readiness separately", () => {
    const container = document.createElement("section");
    document.body.append(container);
    renderPlanState(container, {
      active_plan_id: "plan",
      execution_plan_id: "plan",
      lifecycle: "approved",
      approval_pending: false,
      proposal: { status: "complete", issues: [] },
      approval: { status: "approved", approval_id: "owner-approval" },
      scheduling: {
        status: "blocked",
        blockers: [{ code: "COORDINATOR_NOT_BOUND", group_id: "group", message: "普通交付单元尚未绑定交付协调者。", resource: { kind: "conversation", status: "not_created", target_id: "group" } }],
      },
      runtime_readiness: {
        status: "blocked",
        blockers: [{ code: "COORDINATOR_NOT_BOUND", group_id: "group", message: "普通交付单元尚未绑定交付协调者。", resource: { kind: "conversation", status: "not_created", target_id: "group" } }],
      },
    });

    expect(container.querySelectorAll("[data-plan-state-key]")).toHaveLength(4);
    expect(container.querySelector('[data-plan-state-key="proposal"]')?.textContent).toContain("Complete");
    expect(container.querySelector('[data-plan-state-key="approval"]')?.textContent).toContain("Approved");
    expect(container.querySelector('[data-plan-state-key="scheduling"]')?.textContent).toContain("Not schedulable");
    expect(container.querySelector('[data-plan-state-key="runtime"]')?.textContent).toContain("尚未创建");
  });

  test("hides healthy status space and keeps the same facts available in plan info", () => {
    const healthy = {
      active_plan_id: "plan",
      execution_plan_id: "plan",
      lifecycle: "approved",
      approval_pending: false,
      proposal: { status: "complete" as const, issues: [] },
      approval: { status: "approved" as const, approval_id: "owner-approval" },
      scheduling: { status: "eligible" as const, blockers: [] },
      runtime_readiness: { status: "ready" as const, blockers: [] },
    };
    const state = document.createElement("section");
    const info = document.createElement("section");
    document.body.append(state, info);
    renderPlanState(state, healthy);
    renderPlanInfoContent(info, {
      orchestration: { id: "run", repository: { owner: "example", name: "repo", host: "github.com" }, revision: 4, updated_at: "2026-01-01T00:00:00Z", display_timezone: "UTC", max_running_tasks: 1, conversation_links_verified: true },
      groups: [],
      tasks: [],
      selected_plan_id: "plan",
      execution_phase: "planning",
      plan_state: healthy,
    });

    expect(planStateSeverity(healthy)).toBe("ok");
    expect(state.hidden).toBe(true);
    expect(state.childElementCount).toBe(0);
    expect(info.textContent).toContain("example / repo");
    expect(info.textContent).toContain("当前没有待处理问题。");
  });

  test("puts blocked runtime facts in the plan info problem section", () => {
    const blocked = {
      active_plan_id: "plan",
      execution_plan_id: "plan",
      lifecycle: "approved",
      approval_pending: false,
      proposal: { status: "complete" as const, issues: [] },
      approval: { status: "approved" as const, approval_id: "owner-approval" },
      scheduling: { status: "blocked" as const, blockers: [{ code: "COORDINATOR_NOT_BOUND", group_id: "group", message: "普通交付单元尚未绑定交付协调者。", resource: { kind: "conversation" as const, status: "not_created" as const, target_id: "group" } }] },
      runtime_readiness: { status: "blocked" as const, blockers: [{ code: "COORDINATOR_NOT_BOUND", group_id: "group", message: "普通交付单元尚未绑定交付协调者。", resource: { kind: "conversation" as const, status: "not_created" as const, target_id: "group" } }] },
    };
    const info = document.createElement("section");
    renderPlanInfoContent(info, {
      orchestration: { id: "run", repository: { owner: "example", name: "repo", host: "github.com" }, revision: 4, updated_at: "2026-01-01T00:00:00Z", display_timezone: "UTC", max_running_tasks: 1, conversation_links_verified: true },
      groups: [{ id: "group", title: "交付单元", state: "running", agent_thread_id: null, parent_pr: { url: null }, requirements_path: null }],
      tasks: [],
      selected_plan_id: "plan",
      execution_phase: "planning",
      plan_state: blocked,
    });

    expect(planStateSeverity(blocked)).toBe("blocked");
    expect(info.querySelectorAll(".plan-info-issues li")).toHaveLength(1);
    expect(info.textContent).toContain("资源：尚未创建");
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
    });

    const profileDetails = createDetailContent({ getData: () => view, labels: {}, labelTask: () => "任务", time: () => "未知", safeExternal: () => null, profileContext: () => ({ capabilities: [{ model: "gpt-6.1-sol", thinking: ["medium", "high"] }], update: async () => {} }) });
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
    const body = document.getElementById("details-content")!;
    body.scrollTop = 200;
    details.showTask(view.tasks[0]!);
    expect(body.scrollTop).toBe(200);
    details.showGroup({ ...view.groups[0]!, id: view.tasks[0]!.id });
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 80;
    details.showTask(view.tasks[0]!);
    expect(body.scrollTop).toBe(0);

    let retries = 0;
    Object.assign(view.tasks[0]!, { state: "agent_idle", thread_id: "thread-task", conversation_resource: { id: "conversation-task", kind: "conversation", target: "thread-task", status: "archive_failed", evidence_ref: "archive-error", error: "archive refused", last_attempt_at: "2026-01-01T00:00:00.000Z", operation_id: "archive-1" } });
    const archiveDetails = createDetailContent({ getData: () => view, labels: {}, labelTask: () => "执行中", time: () => "未知", safeExternal: () => null, groupRange: () => ({ start: null, end: null }), archiveConversation: () => { retries++; } });
    Object.assign(view.tasks[0]!, { latest_agent_output: { observed_at: "2026-01-01T00:00:00Z", turn_id: "older-public-turn", runtime_turn_id: "latest-runtime-turn", agent_state: "idle", state: "empty", stale: false } });
    archiveDetails.showTask(view.tasks[0]!);
    expect(document.getElementById("details-content")?.textContent).toContain("观察 Turnlatest-runtime-turn");
    expect(document.getElementById("details-content")?.textContent).not.toContain("older-public-turn");
    expect(document.getElementById("details-content")?.textContent).toContain("archive refused");
    expect(document.querySelector(".archive-action")).toBeNull();
    Object.assign(view.tasks[0]!, { state: "closed", conversation_archive: { eligible: true, reason: null }, latest_agent_output: { thread_id: "thread-task", agent_state: "idle", stale: false } });
    archiveDetails.showTask(view.tasks[0]!);
    (document.querySelector(".archive-action") as HTMLButtonElement).click();
    expect(retries).toBe(1);
    const conversation = document.querySelector(".detail-conversation")!;
    expect(conversation.querySelector("a")?.textContent).toBe("打开对话");
    expect(conversation.querySelector(".archive-action")?.textContent).toBe("重试归档");
    for (const label of ["对话归档", "归档说明", "归档操作", "最近归档尝试", "归档证据"])
      expect([...document.querySelectorAll(".detail-label")].some(node => node.textContent === label)).toBe(false);
    Object.assign(view.tasks[0]!, { conversation_resource: null });
    archiveDetails.showTask(view.tasks[0]!);
    expect(document.querySelector(".detail-conversation .archive-action")?.textContent).toBe("归档");
    expect(document.querySelector(".detail-conversation-notice")).toBeNull();
    expect(document.getElementById("details-content")?.textContent).not.toContain("对话归档尚未完成");

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
