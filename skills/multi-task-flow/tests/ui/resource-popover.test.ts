import { afterEach, expect, test } from "bun:test";
import { attachResourcePopover, closeResourcePopover, refreshResourcePopover, timingText, type ResourceSource } from "../../web/resource-popover";
import type { View } from "../../web/model";
const view = { nodes: [{ id: "n", kind: "task", ref_id: "task" }], planned_intervals: [{ node_id: "n", start: "2026-11-07T00:00:00Z", end: "2026-11-07T00:10:00Z" }] } as View;
const source = (): ResourceSource => ({ kind: "task", id: "task", thread: "thread", start: "2026-11-07T00:00:00Z", end: "2026-11-07T00:15:00Z", view, output: () => ({ state: "available", text: "<unsafe>\nFull response", thread_title: "真实标题", thread_id: "thread", turn_id: "turn", message_id: "message", phase: "commentary", message_status: "in_progress", observed_at: null, stale: false }) });
afterEach(() => { closeResourcePopover(); document.body.replaceChildren(); });
test("interactive dialog supports keyboard entry and Escape without reopening or copying the response", async () => {
  const trigger = document.createElement("button"); document.body.append(trigger); attachResourcePopover(trigger, "conversation", source());
  trigger.focus();
  const panel = document.querySelector<HTMLElement>(".resource-popover")!;
  expect(panel.getAttribute("role")).toBe("dialog"); expect(panel.textContent).toContain("真实标题"); expect(panel.querySelector("unsafe")).toBeNull();
  expect([...panel.querySelectorAll("button")].map(b => b.textContent)).toEqual(["复制对话 ID", "复制标题"]);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  expect(panel.contains(document.activeElement)).toBe(true);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(trigger.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(trigger); expect(document.querySelector(".resource-popover")).toBeNull();
});
test("stream refresh preserves response scroll and switches to the latest message", () => {
  const s = source(); let output = s.output()!; s.output = () => output;
  const trigger = document.createElement("button"); document.body.append(trigger); attachResourcePopover(trigger, "conversation", s); trigger.focus();
  const body = document.querySelector<HTMLElement>(".resource-body")!; body.scrollTop = 120;
  output = { ...output, text: "new streamed message" }; refreshResourcePopover();
  expect(body.textContent).toContain("new streamed message"); expect(body.scrollTop).toBe(120);
  trigger.remove(); refreshResourcePopover(); expect(document.querySelector(".resource-popover")).toBeNull();
});
test("elapsed budget includes the entire recorded duration and rejects nonpositive schedules", () => {
  expect(timingText(source())).toContain("已用150%，超出50%");
  const s = source(); s.view = { ...view, planned_intervals: [] }; expect(timingText(s)).toContain("用时占比：不可用");
  s.start = null; expect(timingText(s)).not.toContain("150%");
});
test("a new trigger replaces the previous dialog", () => {
  const a = document.createElement("button"), b = document.createElement("button"); document.body.append(a, b);
  attachResourcePopover(a, "conversation", source()); attachResourcePopover(b, "time", source()); a.focus(); b.focus();
  expect(a.getAttribute("aria-expanded")).toBe("false"); expect(document.querySelectorAll(".resource-popover")).toHaveLength(1);
});

test("hover allows entering the dialog across the gap and closes after leaving both", async () => {
  const trigger = document.createElement("button"); document.body.append(trigger); attachResourcePopover(trigger, "conversation", source());
  trigger.dispatchEvent(new window.PointerEvent("pointerenter", { pointerType: "mouse" }));
  await new Promise(r => setTimeout(r, 270));
  const panel = document.querySelector<HTMLElement>(".resource-popover")!;
  trigger.dispatchEvent(new window.PointerEvent("pointerleave", { pointerType: "mouse" })); panel.dispatchEvent(new window.PointerEvent("pointerenter", { pointerType: "mouse" }));
  await new Promise(r => setTimeout(r, 200)); expect(panel.isConnected).toBe(true);
  panel.dispatchEvent(new window.PointerEvent("pointerleave", { pointerType: "mouse" }));
  await new Promise(r => setTimeout(r, 200)); expect(panel.isConnected).toBe(false);
});

test("copy controls write only their own identity value", async () => {
  const writes: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  try {
    const trigger = document.createElement("button"); document.body.append(trigger); attachResourcePopover(trigger, "conversation", source()); trigger.focus();
    const buttons = document.querySelectorAll<HTMLButtonElement>(".resource-popover button"); buttons[0]!.click(); buttons[1]!.click(); await Promise.resolve();
    expect(writes).toEqual(["thread", "真实标题"]); expect(buttons[0]!.textContent).toBe("已复制");
  } finally {
    if (clipboard) Object.defineProperty(window.navigator, "clipboard", clipboard); else Reflect.deleteProperty(window.navigator, "clipboard");
    if (previous) Object.defineProperty(globalThis, "navigator", previous); else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("failed PR transport exposes retry without losing its trigger", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network unavailable"); }) as typeof fetch;
  try {
    const trigger = document.createElement("button"); document.body.append(trigger); attachResourcePopover(trigger, "pr", source()); trigger.focus();
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector('.resource-body')?.textContent).toContain("读取失败");
    expect(document.querySelector<HTMLButtonElement>('button[data-retry]')?.textContent).toBe("重试");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  } finally { globalThis.fetch = original; }
});
