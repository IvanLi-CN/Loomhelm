import { beforeEach, expect, test } from "bun:test";
import { initialOutput, paintOutput, OutputSnapshots, refreshOutputNodes } from "../../web/agent-output";
import { renderTaskPreview, renderTaskOutput } from "../../web/preview-content";
const available = (text: string) => ({ ...initialOutput("thread"), state: "available" as const, text, stale: false });
beforeEach(() => document.body.replaceChildren());
test("keeps pure text safe and preserves detail whitespace while summaries normalize it", () => {
  const value = "  line 1\n\n<script>unsafe</script>\nline 3  ";
  const summary = renderTaskOutput(null, available(value), "a");
  const detail = document.createElement("div"); paintOutput(detail, available(value), true);
  expect(summary.textContent).toBe("line 1 <script>unsafe</script> line 3");
  expect(detail.textContent).toBe(value);
  expect(detail.querySelector("script")).toBeNull();
});
test("distinguishes all empty states and keeps the unavailable warning outside clamped text", () => {
  const node = document.createElement("p");
  for (const [output, label] of [[initialOutput(null), "尚未创建任务对话"], [{ ...initialOutput("thread"), state: "empty" as const }, "尚无 Agent 输出"], [initialOutput("thread"), "Agent 输出暂时不可用"]] as const) {
    paintOutput(node, output); expect(node.dataset.emptyLabel).toBe(label); expect(node.classList.contains("is-empty")).toBe(true);
  }
  paintOutput(node, { ...available("cached"), state: "unavailable", stale: true });
  expect(node.querySelector(".agent-output-warning")?.textContent).toContain("暂时不可用");
  expect(node.querySelector(".agent-output-text .agent-output-warning")).toBeNull();
});
test("updates output regions while keeping task previews free of messages and preserving focus", () => {
  const button = document.createElement("button"); document.body.append(button);
  const card = renderTaskOutput(null, available("old"), "a");
  const hover = renderTaskPreview({ title: "task", state: "执行中", kind: "开发", group: "g", startedAt: "未知", finishedAt: "未知", duration: "26分", blocker: null });
  const detail = document.createElement("div"); detail.dataset.outputTaskId = "a"; detail.dataset.outputFull = "true";
  document.body.append(card, hover, detail); button.focus();
  const before = locationSafe();
  refreshOutputNodes(document, [{ id: "a", latest_agent_output: available("new\nanswer") }]);
  expect(card.textContent).toBe("new answer"); expect(hover.querySelector("[data-output-task-id]")).toBeNull(); expect(detail.textContent).toBe("new\nanswer");
  expect(document.activeElement).toBe(button); expect(locationSafe()).toBe(before);
  const text = card.firstChild; refreshOutputNodes(document, [{ id: "a", latest_agent_output: available("new\nanswer") }]); expect(card.firstChild).toBe(text);
});
function locationSafe() { return window.location.href; }
test("refreshes a detached hover preview with the current projection before opening", () => {
  const detached = document.createElement("div"); detached.append(renderTaskOutput(null, available("old"), "a"));
  refreshOutputNodes(detached, [{ id: "a", latest_agent_output: available("latest progress") }]);
  expect(detached.textContent).toBe("latest progress");
});
test("rejects older revisions and retired server instances after reconnect", () => {
  const store = new OutputSnapshots();
  const snapshot = (epoch: string, revision: number) => ({ output_epoch: epoch, output_revision: revision, outputs: { a: available(String(revision)) } });
  expect(store.accept(snapshot("first", 10))?.output_revision).toBe(10);
  expect(store.accept(snapshot("first", 2))?.output_revision).toBe(10);
  expect(store.accept(snapshot("restarted", 1))?.output_revision).toBe(1);
  expect(store.accept(snapshot("first", 100))?.output_epoch).toBe("restarted");
});
test("keeps a new SSE epoch when a GET from before the transition arrives late", () => {
  const snapshot = (epoch: string, revision: number, text: string) => ({ output_epoch: epoch, output_revision: revision, outputs: { a: available(text) } });
  for (const requestEpoch of [null, "previous-server"]) {
    const store = new OutputSnapshots();
    if (requestEpoch) store.accept(snapshot(requestEpoch, 10, "previous answer"));
    store.accept(snapshot("new-server", 1, "new answer"));
    // The old GET's epoch can be unseen, including on the first page load.
    const result = store.accept(snapshot("unseen-old-server", 100, "old answer"), requestEpoch);
    expect(result?.output_epoch).toBe("new-server");
    expect(result?.outputs.a?.text).toBe("new answer");
    expect(store.accept(snapshot("new-server", 2, "newer answer"))?.outputs.a?.text).toBe("newer answer");
  }
});
test("allows same-epoch catch-up and a restart first discovered by a fresh GET", () => {
  const store = new OutputSnapshots();
  const snapshot = (epoch: string, revision: number) => ({ output_epoch: epoch, output_revision: revision, outputs: { a: available(`${epoch}:${revision}`) } });
  store.accept(snapshot("first", 1), null);
  store.accept(snapshot("first", 2));
  expect(store.accept(snapshot("first", 3), null)?.output_revision).toBe(3);
  expect(store.accept(snapshot("next", 1), "first")?.output_epoch).toBe("next");
  expect(store.accept(snapshot("first", 100))?.output_epoch).toBe("next");
});


test("output summaries, full messages and empty states have no text tooltip", () => {
  for (const projection of [available("answer"), initialOutput(null), initialOutput("thread")]) {
    const summary = renderTaskOutput(null, projection, "a");
    const detail = document.createElement("div"); paintOutput(detail, projection, true);
    for (const node of [summary, detail]) {
      expect(node.hasAttribute("data-tooltip")).toBe(false);
      expect(node.hasAttribute("title")).toBe(false);
      expect(node.hasAttribute("aria-label")).toBe(true);
    }
    paintOutput(summary, available("streamed update"));
    expect(summary.hasAttribute("data-tooltip")).toBe(false);
  }
  expect(renderTaskOutput("legacy output").hasAttribute("data-tooltip")).toBe(false);
});
