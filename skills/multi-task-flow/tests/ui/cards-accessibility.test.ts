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
