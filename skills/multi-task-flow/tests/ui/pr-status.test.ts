import { expect, test } from "bun:test";
import { bindPRStatus, publishPRStatus } from "../../web/pr-status";
import type { PRSnapshot } from "../../lib/pr-details";

test("PR icons distinguish merge and CI states and share one request per URL", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const url = "https://github.com/example/repo/pull/985";
  const snapshot: PRSnapshot = { data: { number: 985, title: "PR", url, state: "MERGED", mergedAt: null, mergeable: "UNKNOWN", ci: "成功", checks: [] }, observed_at: null, stale: false, loading: false, error: null };
  globalThis.fetch = (async () => { calls++; return Response.json(snapshot); }) as typeof fetch;
  const a = document.createElement("a"), b = document.createElement("a");
  a.setAttribute("aria-label", "打开任务 PR"); b.setAttribute("aria-label", "打开交付单元 PR"); document.body.append(a, b);
  try {
    bindPRStatus(a, "task", "one", url); bindPRStatus(b, "group", "two", url);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1); expect(a.dataset.prState).toBe("MERGED"); expect(b.dataset.ciState).toBe("成功");
    expect(a.getAttribute("aria-label")).toContain("已合并 · CI 成功");
    publishPRStatus(url, { ...snapshot, data: { ...snapshot.data!, ci: "失败" } }); expect(a.dataset.ciState).toBe("失败");
    publishPRStatus(url, { ...snapshot, data: { ...snapshot.data!, ci: "运行中" } }); expect(b.dataset.ciState).toBe("运行中");
    a.remove(); publishPRStatus(url, snapshot); expect(b.dataset.ciState).toBe("成功");
  } finally { globalThis.fetch = original; a.remove(); b.remove(); }
});

test("an older card response cannot overwrite a newer popover publication", async () => {
  const original = globalThis.fetch;
  const url = "https://github.com/example/repo/pull/986";
  let resolve!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as typeof fetch;
  const trigger = document.createElement("a"); document.body.append(trigger);
  const latest: PRSnapshot = { data: { number: 986, title: "PR", url, state: "MERGED", mergedAt: null, mergeable: "UNKNOWN", ci: "成功", checks: [] }, observed_at: "2026-11-07T01:00:00Z", stale: false, loading: false, error: null };
  try {
    bindPRStatus(trigger, "task", "one", url);
    publishPRStatus(url, latest);
    resolve(Response.json({ ...latest, observed_at: null, data: { ...latest.data!, state: "OPEN", ci: "失败" } }));
    await new Promise(done => setTimeout(done, 0));
    expect(trigger.dataset.prState).toBe("MERGED"); expect(trigger.dataset.ciState).toBe("成功");
    const next = document.createElement("a"); document.body.append(next);
    bindPRStatus(next, "group", "two", url);
    expect(next.dataset.prState).toBe("MERGED"); next.remove();
  } finally { globalThis.fetch = original; trigger.remove(); }
});

test("out-of-order timestamped PR publications retain the newer observed result", () => {
  const url = "https://github.com/example/repo/pull/987";
  const snapshot: PRSnapshot = { data: { number: 987, title: "PR", url, state: "MERGED", mergedAt: null, mergeable: "UNKNOWN", ci: "成功", checks: [] }, observed_at: "2026-11-07T02:00:00Z", stale: false, loading: false, error: null };
  publishPRStatus(url, snapshot);
  const trigger = document.createElement("a"); document.body.append(trigger);
  try {
    bindPRStatus(trigger, "task", "one", url);
    publishPRStatus(url, { ...snapshot, observed_at: "2026-11-07T01:00:00Z", data: { ...snapshot.data!, state: "OPEN", ci: "失败" } });
    expect(trigger.dataset.prState).toBe("MERGED"); expect(trigger.dataset.ciState).toBe("成功");
  } finally { trigger.remove(); }
});
