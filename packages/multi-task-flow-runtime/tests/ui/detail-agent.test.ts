import { expect, mock, test } from "bun:test";
import { initialOutput, paintOutput } from "../../web/agent-output";
import { agentHeader } from "../../web/detail-agent";
import { conversationUrl } from "../../web/links";

test("conversation actions are two accessible icons beside the live Agent title", async () => {
  const pane = document.createElement("section");
  pane.className = "detail-pane-agent";
  const header = agentHeader("thread-1", "原始标题");
  const output = document.createElement("div");
  pane.append(header, output);
  expect(header.querySelectorAll(".detail-agent-icon-action")).toHaveLength(2);
  expect(header.querySelectorAll("[data-lucide]")).toHaveLength(2);
  expect(header.querySelector("a")?.getAttribute("href")).toBe(conversationUrl("thread-1"));
  expect(header.querySelector("a")?.getAttribute("aria-label")).toBe("打开对话");
  expect(header.textContent).not.toContain("thread-1");
  const copy = header.querySelector("button")!;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = mock(async (_id: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    copy.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("thread-1");
    expect(header.querySelector('[role="status"]')?.textContent).toBe("对话 ID 已复制");
    paintOutput(output, { ...initialOutput("thread-1"), thread_title: "更新标题" }, true);
    expect(header.querySelector("h3")?.textContent).toBe("Agent：更新标题");
    expect(header.querySelector("button")).toBe(copy);
    writeText.mockImplementation(async () => {
      throw new Error("denied");
    });
    copy.click();
    await Promise.resolve();
    expect(header.querySelector('[role="status"]')?.textContent).toContain(
      "复制失败，对话 ID：thread-1",
    );
    expect(header.querySelector('[role="status"]')?.classList.contains("sr-only")).toBe(false);
  } finally {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("an unlinked Agent has no conversation actions", () => {
  const header = agentHeader(null);
  expect(header.textContent).toBe("Agent：未关联");
  expect(header.querySelector("button, a")).toBeNull();
});
