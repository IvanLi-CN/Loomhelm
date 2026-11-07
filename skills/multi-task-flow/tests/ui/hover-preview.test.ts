import { beforeEach, describe, expect, test } from "bun:test";
import { getByText } from "@testing-library/dom";
import { createHoverController } from "../../web/hover-controller";
import { createHoverPreviewBridge } from "../../web/hover-preview";
import { renderGroupPreview, renderTaskOutput, renderTaskPreview } from "../../web/preview-content";
import { formatDuration } from "../../web/time";
import { DEFAULT_VIEW_STATE } from "../../web/view-state";

beforeEach(() => {
  document.body.replaceChildren();
});

describe("dashboard hover preview DOM", () => {
  test("keeps the preview open when the pointer crosses from the target into it", async () => {
    const target = document.createElement("button");
    const preview = document.createElement("aside");
    const events: string[] = [];
    const bridge = createHoverPreviewBridge(preview, () => events.push("hide"), 10);
    bridge.bindTarget(target, () => events.push("show"));

    target.dispatchEvent(new Event("pointerenter"));
    target.dispatchEvent(new Event("pointerleave"));
    preview.dispatchEvent(new Event("pointerenter"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual(["show"]);
    bridge.dispose();
  });

  test("releases old targets before a refreshed card list is bound", () => {
    const target = document.createElement("button");
    const preview = document.createElement("aside");
    const events: string[] = [];
    const bridge = createHoverPreviewBridge(preview, () => events.push("hide"));
    bridge.bindTarget(target, () => events.push("old"));
    bridge.resetTargets();
    target.dispatchEvent(new Event("pointerenter"));
    expect(events).toEqual([]);
    bridge.dispose();
  });

  test("cancels a pending preview when the pointer leaves the target", async () => {
    const target = document.createElement("button");
    const preview = document.createElement("aside");
    const events: string[] = [];
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    const bridge = createHoverPreviewBridge(preview, () => events.push("hide"), 10);
    bridge.bindTarget(target, () => {
      showTimer = setTimeout(() => events.push("show"), 20);
    }, () => {
      if (showTimer) clearTimeout(showTimer);
      showTimer = null;
    });

    target.dispatchEvent(new Event("pointerenter"));
    target.dispatchEvent(new Event("pointerleave"));
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(events).toEqual(["hide"]);
    bridge.dispose();
  });

  test("cancels the production hover controller timer when the target is left", async () => {
    const target = document.createElement("button");
    const preview = document.createElement("aside");
    const details = document.createElement("aside");
    const bridge = createHoverPreviewBridge(preview, () => undefined);
    preview.hidden = true;
    document.body.append(target, preview, details);
    const controller = createHoverController({
      element: <T extends HTMLElement>(id: string) => (id === "hover-preview" ? preview : details) as T,
      getData: () => null,
      getViewState: () => DEFAULT_VIEW_STATE,
      getSelected: () => ({ task: null, group: null }),
      getKeyboardSelection: () => false,
      getBridge: () => bridge,
      getAnyHover: () => true,
      getAnyFinePointer: () => true,
      getDetailPanelViewport: () => false,
      taskPreview: () => document.createElement("div"),
      groupPreview: () => document.createElement("div"),
      updateDetailsSurface: () => undefined,
      focusSelectedObject: () => undefined,
    });

    controller.bindHoverTarget(target, document.createElement("div"));
    target.dispatchEvent(new Event("pointerenter"));
    target.dispatchEvent(new Event("pointerleave"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(preview.hidden).toBe(true);
    bridge.dispose();
  });

  test("wide cards retain ordinary hover while resource targets suppress and restore it", async () => {
    const card = document.createElement("article"), ordinary = document.createElement("span"), resource = document.createElement("button"), preview = document.createElement("aside");
    resource.dataset.resourceTrigger = "conversation";
    card.append(ordinary, resource); document.body.append(card, preview); preview.hidden = true;
    const bridge = createHoverPreviewBridge(preview, () => undefined);
    const controller = createHoverController({
      element: <T extends HTMLElement>() => preview as T, getData: () => null,
      getViewState: () => DEFAULT_VIEW_STATE, getSelected: () => ({ task: null, group: null }),
      getKeyboardSelection: () => false, getBridge: () => bridge, getAnyHover: () => true,
      getAnyFinePointer: () => true, getDetailPanelViewport: () => true,
      taskPreview: () => document.createElement("div"), groupPreview: () => document.createElement("div"),
      updateDetailsSurface: () => undefined, focusSelectedObject: () => undefined,
    });
    controller.bindHoverTarget(card, document.createElement("div"));
    const over = (target: Element, from: Element | null) => target.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true, relatedTarget: from }));
    over(resource, null); card.dispatchEvent(new window.PointerEvent("pointerenter"));
    await new Promise(r => setTimeout(r, 280)); expect(preview.hidden).toBe(true);
    over(ordinary, resource); await new Promise(r => setTimeout(r, 280)); expect(preview.hidden).toBe(false);
    over(resource, ordinary); await new Promise(r => setTimeout(r, 200)); expect(preview.hidden).toBe(true);
    over(ordinary, resource); await new Promise(r => setTimeout(r, 280)); expect(preview.hidden).toBe(false);
    bridge.dispose();
  });

  test("renders the facts that make a task preview useful", () => {
    const preview = renderTaskPreview({
      title: "账本持久化与并发锁",
      state: "执行中",
      kind: "开发",
      group: "第一组：账本与调度",
      startedAt: "2026-10-31 09:00",
      finishedAt: "未知",
      duration: "2小时15分",
      blocker: null,
      executionGroups: "第一组：账本与调度、第二组：页面与验收",
    });

    expect(getByText(preview, "第一组：账本与调度")).toBeTruthy();
    expect(getByText(preview, "持续时间")).toBeTruthy();
    expect(getByText(preview, "2小时15分")).toBeTruthy();
    expect(getByText(preview, "第一组：账本与调度、第二组：页面与验收")).toBeTruthy();
    expect(preview.querySelector(".agent-output-text, [data-output-task-id], .hover-preview-output")).toBeNull();
  });

  test("formats completed and running durations from recorded timestamps", () => {
    expect(formatDuration("2026-10-31T09:00:00.000Z", "2026-10-31T11:15:00.000Z")).toBe("2小时15分");
    expect(formatDuration("2026-10-31T09:00:00.000Z", null, Date.parse("2026-10-31T11:15:00.000Z"))).toBe("2小时15分");
  });

  test("renders group facts without reducing the group to a status label", () => {
    const preview = renderGroupPreview({
      title: "第二组：页面与验收",
      state: "进行中",
      atomProgress: "2/5 · 创建父 PR",
      duration: "6小时",
      conversation: "已创建",
      parentPr: "已关联",
    });

    expect(getByText(preview, "原子任务进度")).toBeTruthy();
    expect(getByText(preview, "2/5 · 创建父 PR")).toBeTruthy();
    expect(getByText(preview, "6小时")).toBeTruthy();
    expect(getByText(preview, "父 PR")).toBeTruthy();
  });

  test("uses a distinct empty state when no Agent output exists", () => {
    const empty = renderTaskOutput(null);
    const output = renderTaskOutput("已完成依赖校验，等待下一步调度。");
    const preview = renderTaskPreview({ title: "待开始任务", state: "待开始", kind: "验证", group: "第二组", startedAt: "未知", finishedAt: "未知", duration: "未知", blocker: null });

    expect(empty.textContent).toBe("");
    expect(empty.classList.contains("is-empty")).toBe(true);
    expect(empty.dataset.emptyLabel).toBe("尚无 Agent 输出");
    expect(getByText(output, "已完成依赖校验，等待下一步调度。")).toBeTruthy();
    expect(preview.textContent).not.toContain("尚无 Agent 输出");
    expect(preview.querySelector(".task-card-output, .hover-preview-output")).toBeNull();
  });
});
