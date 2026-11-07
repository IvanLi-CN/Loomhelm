import { beforeEach, expect, test } from "bun:test";
import { attachTooltip } from "../../web/tooltip";

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
