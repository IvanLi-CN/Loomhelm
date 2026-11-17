import { beforeEach, expect, test } from "bun:test";
import { renderDetailStatus } from "../../web/detail-status";

beforeEach(() => {
  document.body.innerHTML = "";
});
test("renders one icon and two explanation rows with all source states", () => {
  const status = renderDetailStatus({
    kind: "group",
    state: "active",
    label: "执行中",
    runtime: { status: "ready", blockers: [] },
    dispatch: "blocked",
  });
  document.body.append(status);
  expect(status.querySelectorAll("[data-lucide]").length).toBe(1);
  expect(status.querySelector("[data-lucide]")?.getAttribute("data-lucide")).toBe("loader-circle");
  const rows = status.querySelector(".detail-status-explanation")!.children;
  expect(rows.length).toBe(2);
  expect(rows[0]!.textContent).toBe("交付单元状态：执行中");
  expect(rows[1]!.textContent).toBe("运行就绪：就绪 · 调度状态：不可调度");
  status.querySelector("button")!.dispatchEvent(new window.FocusEvent("focus"));
  expect(status.querySelector(".dependency-tooltip.is-open")).not.toBeNull();
});
test("invalid tuples and future enums use a question mark and preserve raw data", () => {
  for (const state of ["closed", "future-state"]) {
    const status = renderDetailStatus({
      kind: "group",
      state,
      label: state,
      runtime: { status: "ready", blockers: [] },
      dispatch: "ready",
    });
    expect(status.querySelectorAll("[data-lucide]").length).toBe(1);
    expect(status.querySelector("[data-lucide]")?.getAttribute("data-lucide")).toBe("circle-help");
    expect(status.querySelector(".detail-status-explanation")?.textContent).toContain(state);
    expect(status.querySelector(".detail-status-explanation")?.textContent).toContain("可调度");
    expect(status.querySelector("button")?.getAttribute("aria-label")).toContain("状态待确认");
  }
});

test("retains raw business state alongside a coordinator observation", () => {
  const status = renderDetailStatus({
    kind: "group",
    state: "active",
    visualState: "blocked",
    label: "阻塞",
    runtime: { status: "ready", blockers: [] },
    dispatch: "ready",
  });
  expect(status.querySelector(".detail-status-explanation")?.textContent).toContain(
    "阻塞（业务：进行中）",
  );
  expect(status.querySelector(".detail-status-trigger")?.getAttribute("data-presentation")).toBe(
    "blocked",
  );
});
