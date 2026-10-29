import { describe, expect, test } from "bun:test";
import { ApiClientError } from "@loomhelm/api-client";

import { SessionRunHistoryClientAdapter } from "./session-run-history-adapter";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function run(id, overrides = {}) {
  return {
    created_at: "2026-10-27T00:00:00Z",
    id,
    session_id: "session-1",
    status: "completed",
    ...overrides,
  };
}

describe("session run history adapter", () => {
  test("pages through the authorized session history and preserves the opaque cursor", async () => {
    const calls = [];
    const adapter = new SessionRunHistoryClientAdapter({
      listSessionRuns: async (request) => {
        calls.push(request);
        return calls.length === 1
          ? { has_more: true, items: [run("run-1")], next_cursor: " cursor-1 " }
          : { has_more: false, items: [run("run-2", { created_at: "2026-10-27T00:00:01Z" })] };
      },
    });

    adapter.selectSession("session-1");
    await expect(adapter.readRuns("session-1")).resolves.toMatchObject({ state: "received", runs: [{ id: "run-1" }, { id: "run-2" }] });
    expect(calls).toEqual([
      { session_id: "session-1", limit: 200 },
      { session_id: "session-1", after_cursor: " cursor-1 ", limit: 200 },
    ]);
  });

  test("coalesces the first read and fences it after a session switch", async () => {
    const pending = deferred();
    const adapter = new SessionRunHistoryClientAdapter({
      listSessionRuns: () => pending.promise,
    });

    adapter.selectSession("session-1");
    const first = adapter.readRuns("session-1");
    const duplicate = adapter.readRuns("session-1");
    adapter.selectSession("session-2");
    pending.resolve({ has_more: false, items: [run("run-1")] });

    await expect(first).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });
    await expect(duplicate).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });
  });

  test("refreshes a single page without replaying an unbounded history", async () => {
    const calls = [];
    const adapter = new SessionRunHistoryClientAdapter({
      listSessionRuns: async (request) => {
        calls.push(request);
        return { has_more: false, items: [run(["run-1", "run-2", "run-3"][calls.length - 1])] };
      },
    });

    adapter.selectSession("session-1");
    await expect(adapter.readRuns("session-1")).resolves.toMatchObject({ runs: [{ id: "run-1" }] });
    await expect(adapter.readRuns("session-1")).resolves.toMatchObject({ runs: [{ id: "run-2" }] });
    await expect(adapter.readRuns("session-1", { forceRefresh: true })).resolves.toMatchObject({ runs: [{ id: "run-3" }] });
    expect(calls).toEqual([
      { session_id: "session-1", limit: 200 },
      { session_id: "session-1", limit: 200 },
      { session_id: "session-1", limit: 200 },
    ]);
  });

  test("resumes a multi-page history before the final cached page", async () => {
    const calls = [];
    const adapter = new SessionRunHistoryClientAdapter({
      listSessionRuns: async (request) => {
        calls.push(request);
        if (calls.length === 1) return { has_more: true, items: [run("run-1")], next_cursor: " cursor-1 " };
        if (calls.length === 2) return { has_more: false, items: [run("run-2") ] };
        return { has_more: false, items: [run("run-2"), run("run-3") ] };
      },
    });

    adapter.selectSession("session-1");
    await adapter.readRuns("session-1");
    await expect(adapter.readRuns("session-1")).resolves.toMatchObject({ runs: [{ id: "run-1" }, { id: "run-2" }, { id: "run-3" }] });
    expect(calls).toEqual([
      { session_id: "session-1", limit: 200 },
      { session_id: "session-1", after_cursor: " cursor-1 ", limit: 200 },
      { session_id: "session-1", after_cursor: " cursor-1 ", limit: 200 },
    ]);
  });

  test("rejects a page that crosses the requested session boundary", async () => {
    const adapter = new SessionRunHistoryClientAdapter({
      listSessionRuns: async () => ({ has_more: false, items: [run("foreign", { session_id: "session-2" })] }),
    });

    adapter.selectSession("session-1");
    await expect(adapter.readRuns("session-1")).resolves.toMatchObject({ state: "unknown", reason: "foreign_response" });
  });

  test("rejects a page without the required pagination flag", async () => {
    const adapter = new SessionRunHistoryClientAdapter({
      listSessionRuns: async () => ({ items: [run("run-1")] }),
    });

    adapter.selectSession("session-1");
    await expect(adapter.readRuns("session-1")).resolves.toMatchObject({ state: "unknown", reason: "invalid_response" });
  });

  test("preserves forbidden and missing-session failures", async () => {
    for (const [status, reason] of [[403, "forbidden"], [404, "not_found"]]) {
      const adapter = new SessionRunHistoryClientAdapter({
        listSessionRuns: async () => {
          throw new ApiClientError(status, { code: reason });
        },
      });

      adapter.selectSession(`session-${status}`);
      await expect(adapter.readRuns(`session-${status}`)).resolves.toMatchObject({ state: "unknown", reason });
    }
  });
});
