import { test, expect, afterEach } from "bun:test";
import { renderConversationControl } from "../../web/conversation-control";
import { createIdleArchiveExample } from "../../examples/orchestration-viewer";
import type { Task } from "../../web/model";

afterEach(() => document.body.replaceChildren());

function fixture(status: string) {
  const task = createIdleArchiveExample().ledger.tasks.find(task => task.id === "model")!;
  return { ...task, conversation_resource: { id: "r", status, kind: "conversation", target: task.thread_id, evidence_ref: null } } as Task;
}
test("archive status keeps the chat bubble and click opens an actionable project popover", async () => {
  const calls: unknown[] = [];
  const control = renderConversationControl(fixture("closed"), async (...args) => { calls.push(args); });
  document.body.replaceChildren(control);
  const trigger = control.querySelector("button")!;
  expect(trigger.querySelector('[data-lucide="message-circle"]')).not.toBeNull();
  expect(control.querySelector(".conversation-status-badge")?.textContent).toBe("✓");
  trigger.click();
  const panel = control.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(panel.hidden).toBe(false);
  expect(panel.textContent).toContain("对话已归档");
  const action = panel.querySelector("button")!;
  expect(action.textContent).toBe("取消归档");
  action.click(); await Promise.resolve();
  expect(calls).toEqual([["model", "unarchive"]]);
});
test("failure and unknown show distinct explanations and archive-only recovery controls", () => {
  for (const [status, label, badge] of [["archive_failed", "重新归档", "!"], ["archive_unknown", "归档对账", "?"]]) {
    const control = renderConversationControl(fixture(status!), () => {});
    document.body.replaceChildren(control);
    control.querySelector("button")!.focus();
    expect(control.querySelector<HTMLElement>('[role="dialog"]')!.hidden).toBe(false);
    expect(control.querySelector(".archive-action")?.textContent).toBe(label);
    expect(control.querySelector(".conversation-status-badge")?.textContent).toBe(badge);
    expect(control.querySelector("[title]")).toBeNull();
  }
});
