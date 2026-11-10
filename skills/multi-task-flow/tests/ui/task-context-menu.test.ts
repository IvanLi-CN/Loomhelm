import { afterEach, expect, test } from "bun:test";
import { installTaskContextMenu, taskPRs, taskUrl } from "../../web/task-context-menu";
import { parseViewerTarget } from "../../scripts/service-pages";
import type { Task, View } from "../../web/model";
import { parseViewState } from "../../web/view-state";
const task = { id: "C2", title: "完整任务标题", thread_id: "thread-123", pr: { url: "https://github.com/example/repo/pull/1" } } as Task;
const view = { tasks: [task], follow_prs: [{ origin_task_id: "C2", pr: { url: "https://github.com/example/repo/pull/2" } }] } as View;
let controller: ReturnType<typeof installTaskContextMenu> | undefined;
afterEach(() => { controller?.destroy(); document.body.replaceChildren(); });
function setup(value = view, reject = false) {
  controller?.destroy(); document.body.replaceChildren();
  const copied: string[] = [];
  document.body.innerHTML = '<div class="task-card" data-context-task="C2"><button>任务</button></div>';
  controller = installTaskContextMenu({ getData: () => value, writeText: async text => { if (reject) throw Error("denied"); copied.push(text); } });
  const target = document.querySelector<HTMLElement>("[data-context-task]")!;
  const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  target.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); return copied;
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".task-context-menu button")].find(item => item.textContent === text)!;
test("task URL drops credentials, history and filters; restores task details", () => {
  const url = new URL(taskUrl("http://user:secret@localhost:12000/runs/run-a/?plan=old&q=hidden&group=other&zoom=2&ticket=secret#token", "C2"));
  expect(url.pathname).toBe("/runs/run-a/"); expect([...url.searchParams.keys()]).toEqual(["selected", "detail"]); expect(url.username + url.password + url.hash).toBe("");
  const state = parseViewState(url.search); expect(state.selected).toEqual({ kind: "task", id: "C2" }); expect(state.detail).toBe(true); expect(state.plan).toBeNull(); expect(state.query).toBe("");
});
test("five copy actions use full title, raw ID and canonical conversation URL", async () => {
  let copied = setup(); expect(document.querySelectorAll('.task-context-menu > [role=menuitem]')).toHaveLength(5);
  button("复制任务名").click(); await Promise.resolve(); expect(copied).toEqual([task.title]);
  copied = setup(); button("复制任务 ID").click(); await Promise.resolve(); expect(copied).toEqual(["C2"]);
  copied = setup(); button("复制对话链接").click(); await Promise.resolve(); expect(copied).toEqual(["codex://threads/thread-123"]);
});
test("multiple PRs require explicit selection", async () => {
  const copied = setup(); button("复制 PR 链接 ›").click(); expect(copied).toEqual([]); expect(document.querySelectorAll('.task-context-submenu button')).toHaveLength(2);
  button("https://github.com/example/repo/pull/2").click(); await Promise.resolve(); expect(copied).toEqual(["https://github.com/example/repo/pull/2"]);
  expect(taskPRs(task, { ...view, follow_prs: [...view.follow_prs, { origin_task_id: "C2", pr: task.pr! }] } as View)).toHaveLength(2);
});
test("missing resource actions are disabled, copy rejection is visible", async () => {
  setup({ ...view, tasks: [{ ...task, thread_id: null, pr: null }], follow_prs: [] }); expect(document.querySelectorAll('[aria-disabled=true]')).toHaveLength(2); expect(document.querySelector('.task-context-menu')?.textContent).toContain("尚未绑定对话");
  setup(view, true); button("复制任务名").click(); await Promise.resolve(); await Promise.resolve(); expect(document.querySelector('[role=status]')?.textContent).toContain("复制失败");
});
test("keyboard opening, navigation and Escape; blank space retains native menu", () => {
  setup(); controller!.close(); const target = document.querySelector('button')!; target.focus();
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })); expect(document.activeElement?.textContent).toBe("复制任务名");
  document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); expect(document.activeElement?.textContent).toBe("复制任务 ID");
  document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); expect(document.querySelector('.task-context-menu')).toBeNull();
  const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }); document.body.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
});
test("authentication redirects only accept same-service run links and legal view state", () => {
  expect(parseViewerTarget('/runs/run-a/?selected=task%3AC2&detail=1&q=hidden', 'http://localhost', { allowHome: false })?.target).toBe('/runs/run-a/?selected=task%3AC2&detail=1&q=hidden');
  for (const value of ['https://evil.test/runs/run-a/?selected=task:C2', '//evil.test/runs/run-a/?selected=task:C2', '/login?selected=task:C2', '/runs/run-a/../', '/runs/%2e%2e/', '/runs\\run-a/', '/runs/run-a/?selected=other:C2', '/runs/run-a/?selected=task:<script>', 'http://user:pass@localhost/runs/run-a/?selected=task:C2', '/runs/run-a/?ticket=secret', '/runs/run-a/?selected=task:C2&selected=task:C3', '/runs/run-a/?q=%0d%0aLocation:%20https://evil.test']) expect(parseViewerTarget(value, 'http://localhost', { allowHome: false })).toBeNull();
});
