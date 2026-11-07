import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEW_STATE, canonicalViewUrl, hasValidTabParam, parseViewState, replaceViewStateOn, restoreViewState, restoreViewStateForNavigation, serializeViewState, sanitizeViewState } from "../web/view-state";

describe("shareable dashboard view state", () => {
  test("omits defaults and round-trips non-default context", () => {
    const state = parseViewState("?tab=actual&layout=grid&q=merge&group=dashboard&state=running&kind=contribution&plan=plan-2&selected=task%3Atask-1&detail=1&zoom=1.4&plannedStart=2026-01-01T00%3A00%3A00.000Z&plannedEnd=2026-01-02T00%3A00%3A00.000Z");
    const sanitized = sanitizeViewState(state, { groups: new Set(["dashboard"]), states: new Set(["running"]), kinds: new Set(["contribution"]), plans: new Set(["plan-2"]), tasks: new Set(["task-1"]) });
    const encoded = serializeViewState(sanitized, "plan-1");
    expect(encoded).toContain("tab=actual");
    expect(encoded).toContain("layout=grid");
    expect(encoded).toContain("selected=task%3Atask-1");
    expect(encoded).not.toContain("zoom=");
    expect(serializeViewState(DEFAULT_VIEW_STATE)).toBe("");
    expect(serializeViewState({ ...DEFAULT_VIEW_STATE, tab: "graph" }, null, "actual")).toBe("tab=graph");
    expect(serializeViewState({ ...DEFAULT_VIEW_STATE, tab: "actual" }, null, "actual")).toBe("");
    expect(parseViewState(`?${encoded}`, { groups: new Set(["dashboard"]), states: new Set(["running"]), kinds: new Set(["contribution"]), plans: new Set(["plan-2"]), tasks: new Set(["task-1"]) })).toEqual({ ...sanitized, zoom: DEFAULT_VIEW_STATE.zoom });
  });

  test("ignores invalid ids and keeps selection independent of filters", () => {
    const state = parseViewState("?layout=invalid&group=missing&plan=old&selected=task:missing&detail=1&zoom=9", { groups: new Set(["dashboard"]), plans: new Set(["plan-1"]), tasks: new Set(["task-1"]) });
    expect(state.group).toBe("");
    expect(state.plan).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.zoom).toBe(DEFAULT_VIEW_STATE.zoom);
    expect(state.layout).toBe("grid");
    const valid = parseViewState("?q=dashboard&selected=task:task-1&detail=1", { tasks: new Set(["task-1"]) });
    expect(valid.selected).toEqual({ kind: "task", id: "task-1" });
    expect(valid.detail).toBe(true);
  });

  test("rewrites the URL from the allowlisted view state only", () => {
    const url = canonicalViewUrl("http://user:pass@localhost/dashboard?token=secret&task_data=private#fragment", { ...DEFAULT_VIEW_STATE, query: "deploy" });
    const parsed = new URL(url);
    expect(parsed.search).toBe("?q=deploy");
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.hash).toBe("");
  });

  test("does not expose graph zoom in shareable URLs", () => {
    const url = canonicalViewUrl("http://localhost/dashboard", { ...DEFAULT_VIEW_STATE, zoom: 1.88 });
    expect(new URL(url).search).toBe("");
  });

  test("restores the execution default when the canonical URL omits tab", () => {
    expect(restoreViewState("?q=deploy", {}, "execution").tab).toBe("actual");
    expect(restoreViewState("?tab=graph&q=deploy", {}, "execution").tab).toBe("graph");
    expect(hasValidTabParam("?tab=invalid")).toBe(false);
    expect(restoreViewState("?tab=invalid&q=deploy", {}, "execution").tab).toBe("actual");
  });

  test("keeps navigation state before data hydration and writes only through replaceState", () => {
    const restored = restoreViewStateForNavigation("?selected=task%3Atask-1&group=dashboard&plan=plan-1", {}, "execution");
    expect(restored.hasExplicitTab).toBe(false);
    expect(restored.state.tab).toBe("actual");
    expect(restored.state.selected).toEqual({ kind: "task", id: "task-1" });
    expect(restored.state.group).toBe("dashboard");
    expect(restored.state.plan).toBe("plan-1");

    const calls: Array<{ url: string | URL | null | undefined }> = [];
    const history = { replaceState: (_data: unknown, _title: string, url?: string | URL | null) => calls.push({ url }) };
    const written = replaceViewStateOn(history, "http://localhost/dashboard?token=secret", { ...DEFAULT_VIEW_STATE, query: "deploy" });
    expect(written).toBe("http://localhost/dashboard?q=deploy");
    expect(calls).toEqual([{ url: written }]);
  });

  test("rejects inverted timeline windows as unknown", () => {
    const state = parseViewState("?plannedStart=2026-01-02T00%3A00%3A00.000Z&plannedEnd=2026-01-01T00%3A00%3A00.000Z&actualStart=2026-01-01T00%3A00%3A00.000Z");
    expect(state.plannedStart).toBeNull();
    expect(state.plannedEnd).toBeNull();
    expect(state.actualStart).toBeNull();
    expect(state.actualEnd).toBeNull();
  });

  test("rejects timeline windows beyond the supported date span as unknown", () => {
    const state = parseViewState("?plannedStart=-010000-01-01T00%3A00%3A00.000Z&plannedEnd=%2B030000-01-01T00%3A00%3A00.000Z");
    expect(state.plannedStart).toBeNull();
    expect(state.plannedEnd).toBeNull();
  });
});

test("single delivery unit defaults to grid while explicit layouts survive URL round trips", () => {
  const single = { groups: new Set(["unit"]) };
  expect(parseViewState("", single).layout).toBe("grid");
  expect(parseViewState("?layout=invalid", single).layout).toBe("grid");
  expect(parseViewState("", { groups: new Set(["a", "b"]) }).layout).toBe("board");
  expect(parseViewState("", { groups: new Set() }).layout).toBe("board");
  for (const layout of ["board", "grid"] as const) {
    const state = parseViewState(`?layout=${layout}`, single);
    const query = serializeViewState(state, null, "graph", "grid");
    expect(parseViewState(query, single).layout).toBe(layout);
    expect(restoreViewStateForNavigation(query, single, "execution").state.layout).toBe(layout);
  }
});
