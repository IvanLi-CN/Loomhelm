import { describe, expect, test } from "bun:test";

import { ApiClientError } from "@loomhelm/api-client";

import { SessionClientAdapter } from "./session-client-adapter";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function session(id) {
  return {
    created_at: "2026-10-27T00:00:00Z",
    external_thread_ref: `thread-${id}`,
    id,
    path: "new",
    state: "active",
    updated_at: "2026-10-27T00:00:00Z",
  };
}

describe("session client adapter", () => {
  test("calls the generated session read with the contract request shape", async () => {
    const calls = [];
    const adapter = new SessionClientAdapter({
      getSession: async (request) => {
        calls.push(request);
        return { session: session(request.session_id) };
      },
    });

    adapter.selectSession("session-1");
    const result = await adapter.readSession("session-1");

    expect(calls).toEqual([{ session_id: "session-1" }]);
    expect(result).toMatchObject({ state: "received", session: { id: "session-1" } });
  });

  test("coalesces duplicate reads and fences a response after session switching", async () => {
    const first = deferred();
    const second = deferred();
    const adapter = new SessionClientAdapter({
      getSession: (request) => request.session_id === "session-1" ? first.promise : second.promise,
    });

    adapter.selectSession("session-1");
    const firstRead = adapter.readSession("session-1");
    const duplicateRead = adapter.readSession("session-1");

    adapter.selectSession("session-2");
    const secondRead = adapter.readSession("session-2");
    first.reject(new Error("late transport failure"));
    second.resolve({ session: session("session-2") });

    await expect(firstRead).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });
    await expect(duplicateRead).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });
    await expect(secondRead).resolves.toMatchObject({ state: "received", session: { id: "session-2" } });
  });

  test("shares the first session response with a StrictMode-style remount", async () => {
    const first = deferred();
    const calls = [];
    const adapter = new SessionClientAdapter({
      getSession: (request) => {
        calls.push(request);
        return first.promise;
      },
    });

    adapter.selectSession("session-1");
    const firstRead = adapter.readSession("session-1");
    const remountedRead = adapter.readSession("session-1");
    first.resolve({ session: session("session-1") });

    await expect(firstRead).resolves.toMatchObject({ state: "received", session: { id: "session-1" } });
    await expect(remountedRead).resolves.toMatchObject({ state: "received", session: { id: "session-1" } });
    expect(calls).toEqual([{ session_id: "session-1" }]);
  });

  test("does not publish a session response for a different requested identity", async () => {
    const adapter = new SessionClientAdapter({
      getSession: async () => ({ session: session("foreign-session") }),
    });

    adapter.selectSession("session-1");
    await expect(adapter.readSession("session-1")).resolves.toMatchObject({ state: "unknown", reason: "foreign_response" });
  });

  test("preserves access failures when a session is forbidden or missing", async () => {
    for (const [status, reason] of [[403, "forbidden"], [404, "not_found"]]) {
      const adapter = new SessionClientAdapter({
        getSession: async () => {
          throw new ApiClientError(status, { code: reason });
        },
      });

      adapter.selectSession(`session-${status}`);
      await expect(adapter.readSession(`session-${status}`)).resolves.toMatchObject({ state: "unknown", reason });
    }
  });
});
