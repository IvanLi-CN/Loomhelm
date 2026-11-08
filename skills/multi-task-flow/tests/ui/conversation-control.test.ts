import { test, expect, afterEach } from "bun:test";
import { hasArchiveAction, renderConversationControl } from "../../web/conversation-control";
import { createIdleArchiveExample } from "../../examples/orchestration-viewer";
import type { Task } from "../../web/model";

afterEach(() => document.body.replaceChildren());

function fixture(status: string) {
  const task = createIdleArchiveExample().ledger.tasks.find(task => task.id === "model")!;
  return { ...task, conversation_archive: { eligible: true, reason: null }, latest_agent_output: { thread_id: task.thread_id, agent_state: "idle", stale: false }, conversation_resource: { id: "r", status, kind: "conversation", target: task.thread_id, evidence_ref: null } } as Task;
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
  for (const [status, label, badge] of [["archive_failed", "重试归档", "!"], ["archive_unknown", "归档对账", "?"]]) {
    const control = renderConversationControl(fixture(status!), () => {});
    document.body.replaceChildren(control);
    control.querySelector("button")!.focus();
    expect(control.querySelector<HTMLElement>('[role="dialog"]')!.hidden).toBe(false);
    expect(control.querySelector(".archive-action")?.textContent).toBe(label);
    expect(control.querySelector(".conversation-status-badge")?.textContent).toBe(badge);
    expect(control.querySelector("[title]")).toBeNull();
  }
});


test("first archive needs eligibility and current idle evidence, not an existing resource", () => {
  const task = fixture("pending");
  task.conversation_resource = null;
  expect(hasArchiveAction(task)).toBe(true);
  expect(renderConversationControl(task, () => {}).querySelector(".archive-action")?.textContent).toBe("归档");
  task.latest_agent_output!.stale = true;
  expect(hasArchiveAction(task)).toBe(false);
  task.latest_agent_output!.stale = false;
  task.latest_agent_output!.agent_state = "active";
  expect(hasArchiveAction(task)).toBe(false);
  task.latest_agent_output!.agent_state = "idle";
  task.conversation_archive!.eligible = false;
  expect(hasArchiveAction(task)).toBe(false);
});

test("ineligible failure hides retry; unknown and closed retain recovery", () => {
  for (const status of ["archive_failed", "archive_unknown", "closed", "unarchive_failed", "unarchive_unknown"]) {
    const task = fixture(status);
    task.conversation_archive!.eligible = false;
    const control = renderConversationControl(task, () => {});
    expect(control.querySelector(".archive-action") !== null).toBe(status !== "archive_failed");
    expect(control.textContent).toContain(status === "archive_failed" ? "对话归档失败" : status === "archive_unknown" ? "对话归档结果未知" : "取消归档");
  }
});

test("read-only views disable available actions", () => {
  const control = renderConversationControl(fixture("closed"), () => {}, true);
  expect(control.querySelector<HTMLButtonElement>(".archive-action")!.disabled).toBe(true);
});
