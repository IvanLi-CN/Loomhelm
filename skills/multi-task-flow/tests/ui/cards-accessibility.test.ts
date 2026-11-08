import { describe, expect, test } from "bun:test";
import { selectionAriaLabel } from "../../web/cards";
import { groupExecutionVisualState } from "../../web/labels";

describe("dashboard card accessibility", () => {
  test("includes the visual status in the semantic selection name", () => {
    const labels = { running: "执行中", ready: "就绪" };
    expect(selectionAriaLabel("任务", "部署并验证运行环境", "running", labels)).toBe("选择任务：部署并验证运行环境，状态：执行中");
    expect(selectionAriaLabel("交付单元", "第二组：页面与验收", "ready", labels)).toBe("选择交付单元：第二组：页面与验收，状态：就绪");
  });

  test("overlays explicit coordination execution while preserving closed state", () => {
    expect(groupExecutionVisualState("merged", "waiting")).toBe("waiting");
    expect(groupExecutionVisualState("merged", "running")).toBe("running");
    expect(groupExecutionVisualState("closed", "waiting")).toBe("closed");
  });
});

test("synthetic task and unit conversations never expose native links", async () => {
  const { createCardRenderer } = await import("../../web/cards");
  const { createDetailContent } = await import("../../web/details-content");
  const { createSingleDeliveryUnitLedger } = await import("../../examples/single-delivery-unit/ledger");
  const { buildView } = await import("../../scripts/view");
  const view = buildView(createSingleDeliveryUnitLedger()) as import("../../web/model").View;
  document.body.innerHTML = '<div id="task-list"></div><div id="group-list"></div><div id="details-summary"></div><div id="details-content"></div>';
  const common = { getData: () => view, labels: {}, safeExternal: () => null };
  let layout: "grid" | "board" = "grid";
  const cards = createCardRenderer({ ...common, getLayout: () => layout, getSelectedTask: () => null, getSelectedGroup: () => null, selectTask: () => {}, selectGroup: () => {}, setKeyboardSelection: () => {}, updateTaskLayoutControls: () => {}, bindTaskHover: () => {}, bindGroupHover: () => {} });
  const details = createDetailContent({ ...common, labelTask: () => "", time: () => "" });
  for (const mode of ["grid", "board"] as const) {
    layout = mode; cards.renderList(view.tasks); cards.renderGroups();
    expect(document.querySelectorAll('a[href^="codex:"]')).toHaveLength(0);
    expect(document.querySelector(".task-card-title[data-tooltip], .task-card-output[data-tooltip], .task-column-count[data-tooltip], [data-resource-trigger][data-tooltip]")).toBeNull();
    expect(document.querySelectorAll('button[aria-label="示例对话（Mock）"][aria-disabled="true"][data-resource-trigger="conversation"]').length).toBeGreaterThan(0);
  }
  details.showTask(view.tasks[0]!);
  expect(document.getElementById("details-content")!.textContent).toContain("示例对话（Mock）");
  expect(document.querySelectorAll('a[href^="codex:"]')).toHaveLength(0);
  details.showGroup(view.groups[0]!);
  expect(document.getElementById("details-content")!.textContent).toContain("示例对话（Mock）");
  expect(document.querySelectorAll('a[href^="codex:"]')).toHaveLength(0);
});

test("grid and board groups expose time details from their own execution facts", async () => {
  const { createCardRenderer } = await import("../../web/cards");
  const { createSingleDeliveryUnitLedger } = await import("../../examples/single-delivery-unit/ledger");
  const { buildView } = await import("../../scripts/view");
  const view = buildView(createSingleDeliveryUnitLedger()) as import("../../web/model").View;
  const group = view.groups[0]!;
  group.started_at = "2026-11-05T01:00:00Z";
  group.finished_at = "2026-11-05T07:00:00Z";
  view.tasks[0]!.started_at = "2026-11-05T02:00:00Z";
  view.tasks[0]!.finished_at = "2026-11-05T03:00:00Z";
  document.body.innerHTML = '<div id="task-list"></div><div id="group-list"></div>';
  let layout: "grid" | "board" = "grid";
  const cards = createCardRenderer({ getData: () => view, labels: {}, safeExternal: () => null, getLayout: () => layout, getSelectedTask: () => null, getSelectedGroup: () => null, selectTask: () => {}, selectGroup: () => {}, setKeyboardSelection: () => {}, updateTaskLayoutControls: () => {}, bindTaskHover: () => {}, bindGroupHover: () => {} });
  for (const mode of ["grid", "board"] as const) {
    layout = mode; cards.renderList(view.tasks); cards.renderGroups();
    const surface = document.querySelector(mode === "grid" ? `#group-list [data-group-id="${group.id}"]` : `#task-list > [data-group-id="${group.id}"] > .task-column-heading`)!;
    for (const type of ["conversation", "pr", "time"]) expect(surface.querySelectorAll(`[data-resource-trigger="${type}"]`)).toHaveLength(1);
    const time = surface.querySelector<HTMLButtonElement>('[data-resource-trigger="time"]')!;
    expect(time.textContent).toBe("6小时");
    time.focus();
    expect(document.querySelector('.resource-popover[data-resource="time"]')?.textContent).toContain("6小时");
    expect(time.getAttribute("aria-expanded")).toBe("true");
    time.blur();
  }
  group.started_at = null; group.finished_at = null;
  cards.renderList(view.tasks);
  const missing = document.querySelector<HTMLButtonElement>(`#task-list > [data-group-id="${group.id}"] > .task-column-heading [data-resource-trigger="time"]`)!;
  expect(missing.textContent).toBe("未知");
  expect(missing.dataset.durationStart).toBe("");
  missing.focus();
  expect(document.querySelector('.resource-popover[data-resource="time"]')?.textContent).toContain("开始时间不可用");
  expect(document.querySelector('.resource-popover[data-resource="time"] .resource-badge')?.textContent).toBe("时间未知");
});
