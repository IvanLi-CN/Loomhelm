import { expect, test } from "bun:test";
import { PRDetailsCache, summarizeChecks } from "../scripts/pr-details";
const repo = { host: "github.com", owner: "owner", name: "repo" };
const url = "https://github.com/owner/repo/pull/42";
test("PR cache deduplicates flights, throttles manual refresh and preserves stale success", async () => {
  let now = 100_000, calls = 0, fail = false;
  const cache = new PRDetailsCache(async args => {
    calls++; expect(args).toEqual(["pr", "view", "42", "--repo", "github.com/owner/repo", "--json", "number,title,url,state,mergedAt,mergeable,statusCheckRollup"]);
    await Promise.resolve();
    if (fail) throw new Error("private failure text");
    return JSON.stringify({ number: 42, title: "PR title", url, state: "MERGED", mergedAt: "2026-11-07T00:00:00Z", mergeable: "UNKNOWN", statusCheckRollup: [{ name: "checks", conclusion: "SUCCESS" }] });
  }, () => now);
  const [a, b] = await Promise.all([cache.read(repo, url), cache.read(repo, url)]);
  expect(calls).toBe(1); expect(a).toEqual(b); expect(a.data?.state).toBe("MERGED");
  await cache.read(repo, url, true); expect(calls).toBe(1);
  now += 31_000; fail = true;
  const stale = await cache.read(repo, url, true); expect(stale.data?.title).toBe("PR title"); expect(stale.stale).toBe(true); expect(stale.error).not.toContain("private");
});
test("PR identity rejects foreign repositories and URL syntax before spawning", async () => {
  let calls = 0; const cache = new PRDetailsCache(async () => { calls++; return "{}"; });
  for (const bad of ["https://github.com/other/repo/pull/42", "https://evil.test/owner/repo/pull/42", url + "?repo=other", "https://user:pass@github.com/owner/repo/pull/42", "http://github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/-1"]) await expect(cache.read(repo, bad)).rejects.toThrow();
  expect(calls).toBe(0);
});
test("CI summary distinguishes absence, uncertainty, pending and non-success terminal checks", () => {
  expect(summarizeChecks(null)).toBe("未知"); expect(summarizeChecks([])).toBe("未配置");
  for (const state of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "FAILURE"]) expect(summarizeChecks([{ conclusion: state }])).toBe("失败");
  expect(summarizeChecks([{ state: "PENDING" }])).toBe("运行中");
  expect(summarizeChecks([{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }])).toBe("成功");
  expect(summarizeChecks([{ conclusion: "NEW_STATE" }])).toBe("未知");
});
