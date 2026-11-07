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
  document.body.innerHTML = '<div id="task-list"></div><div id="group-list"></div><div id="details-content"></div>';
  const common = { getData: () => view, labels: {}, safeExternal: () => null, groupRange: () => ({ start: null, end: null }) };
  let layout: "grid" | "board" = "grid";
  const cards = createCardRenderer({ ...common, getLayout: () => layout, getSelectedTask: () => null, getSelectedGroup: () => null, selectTask: () => {}, selectGroup: () => {}, setKeyboardSelection: () => {}, updateTaskLayoutControls: () => {}, bindTaskHover: () => {}, bindGroupHover: () => {} });
  const details = createDetailContent({ ...common, labelTask: () => "", time: () => "" });
  for (const mode of ["grid", "board"] as const) {
    layout = mode; cards.renderList(view.tasks); cards.renderGroups();
    expect(document.querySelectorAll('a[href^="codex:"]')).toHaveLength(0);
    expect(document.querySelectorAll('button[aria-label="示例对话（Mock）"]:disabled').length).toBeGreaterThan(0);
  }
  details.showTask(view.tasks[0]!);
  expect(document.getElementById("details-content")!.textContent).toContain("示例对话（Mock）");
  expect(document.querySelectorAll('a[href^="codex:"]')).toHaveLength(0);
  details.showGroup(view.groups[0]!);
  expect(document.getElementById("details-content")!.textContent).toContain("示例对话（Mock）");
  expect(document.querySelectorAll('a[href^="codex:"]')).toHaveLength(0);
});
