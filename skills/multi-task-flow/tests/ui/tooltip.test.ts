import { beforeEach, expect, test } from "bun:test";
import { attachTooltip, installTextTooltips } from "../../web/tooltip";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const trigger = document.createElement("button");
  const outside = document.createElement("button");
  const content = document.createElement("div");
  content.textContent = "依赖状态";
  const tooltip = attachTooltip(trigger, content, "查看依赖");
  document.body.replaceChildren(trigger, tooltip, outside);
  return { trigger, tooltip, outside };
}
function pointer(target: HTMLElement, type: string, x = 0, y = 0, pointerType = "touch") {
  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerType, clientX: x, clientY: y }));
}
beforeEach(() => { document.body.replaceChildren(); });

test("focus opens immediately; Escape closes only the tooltip and outside click closes it", () => {
  const { trigger, tooltip, outside } = fixture();
  trigger.focus();
  expect(tooltip.hidden).toBe(false);
  expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
  const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  trigger.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(tooltip.hidden).toBe(true);
  outside.focus();
  trigger.focus();
  pointer(outside, "pointerdown", 0, 0, "mouse");
  expect(tooltip.hidden).toBe(true);
});

test("hover respects its delay and blur dismisses a focus tooltip", async () => {
  const { trigger, tooltip, outside } = fixture();
  pointer(trigger, "pointerenter", 0, 0, "mouse");
  expect(tooltip.hidden).toBe(true);
  await pause(280);
  expect(tooltip.hidden).toBe(false);
  trigger.focus();
  outside.focus();
  await pause(10);
  expect(tooltip.hidden).toBe(true);
});

test("long press opens after 500ms; movement and release cancel pending presses", async () => {
  const { trigger, tooltip } = fixture();
  pointer(trigger, "pointerdown", 10, 10);
  await pause(540);
  expect(tooltip.hidden).toBe(false);
  pointer(trigger, "pointerup");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  pointer(trigger, "pointerdown", 10, 10);
  pointer(trigger, "pointermove", 21, 10);
  await pause(540);
  expect(tooltip.hidden).toBe(true);
  pointer(trigger, "pointerdown", 10, 10);
  pointer(trigger, "pointerup", 10, 10);
  trigger.focus();
  await pause(540);
  expect(tooltip.hidden).toBe(true);
});


test("project text tooltips preserve control IDs and cover disabled and dynamically replaced controls", async () => {
  const button = document.createElement("button"); button.id = "zoom-in"; button.className = "icon-button"; button.dataset.tooltip = "放大";
  document.body.append(button);
  const dispose = installTextTooltips();
  try {
    expect(button.id).toBe("zoom-in");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    button.focus();
    expect(document.querySelector(".control-tooltip.is-open")?.textContent).toBe("放大");
    button.dataset.tooltip = "更新后的说明";
    await pause(10);
    expect(document.querySelector(".control-tooltip.is-open")?.textContent).toBe("更新后的说明");
    const disabled = document.createElement("button"); disabled.disabled = true; disabled.className = "icon-button"; disabled.dataset.tooltip = "PR 尚未创建";
    button.replaceWith(disabled); await pause(10);
    expect(document.querySelectorAll(".control-tooltip").length).toBe(1);
    pointer(disabled, "pointerenter", 0, 0, "mouse"); await pause(280);
    expect(document.querySelector(".control-tooltip.is-open")?.textContent).toBe("PR 尚未创建");
    expect(document.querySelector("[title]")).toBeNull();
  } finally { dispose(); }
});


test("plain text never gains a tooltip even if it carries a legacy hint", async () => {
  const output = document.createElement("p"); output.dataset.tooltip = "Agent answer";
  const title = document.createElement("span"); title.dataset.tooltip = "Task title";
  const progress = document.createElement("span"); progress.dataset.tooltip = "1/2";
  const selection = document.createElement("button"); selection.dataset.tooltip = "Select task";
  document.body.append(output, title, progress, selection);
  const dispose = installTextTooltips();
  try {
    output.dataset.tooltip = "Updated answer";
    await pause(10);
    expect(document.querySelector(".control-tooltip")).toBeNull();
    for (const node of [output, title, progress, selection]) {
      expect(node.hasAttribute("aria-describedby")).toBe(false);
      expect(node.classList.contains("dependency-tooltip-anchor")).toBe(false);
    }
  } finally { dispose(); }
});

test("keeps the explicit brand mark hint", () => {
  document.body.innerHTML = '<a class="brand-mark" data-tooltip="全部编排运行" aria-label="全部编排运行"></a>';
  const dispose = installTextTooltips();

  expect(document.querySelector(".control-tooltip")?.textContent).toBe("全部编排运行");

  dispose();
});
