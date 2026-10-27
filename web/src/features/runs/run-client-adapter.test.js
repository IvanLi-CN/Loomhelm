import { describe, expect, test } from "bun:test";

import { RunClientAdapter } from "./run-client-adapter";

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function event(overrides = {}) {
  return {
    cursor: "cursor-1",
    event_id: "event-1",
    occurred_at: "2026-10-27T00:00:00Z",
    payload: { text: "hello" },
    run_id: "run-1",
    sequence: 1,
    session_id: "session-1",
    source: "app-server",
    type: "message.delta",
    ...overrides,
  };
}

function ack(command_id, state = "succeeded") {
  return {
    ack: {
      command_id,
      deduplicated: false,
      received_at: "2026-10-27T00:00:01Z",
      state,
    },
  };
}

const subscription = { id: "run-panel", sessionId: "session-1", runId: "run-1" };

describe("run client adapter", () => {
  test("sends a persisted opaque cursor and retains its verified sequence baseline", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async () => ack("unused"),
      listRunEvents: async (request) => {
        calls.push(request);
        return { events: [event({ cursor: "cursor-1", sequence: 1 })], has_more: false, next_cursor: "cursor-1" };
      },
    });

    adapter.selectSession("session-1");
    expect(adapter.seedRecoveryCursor(subscription, { cursor: "persisted-cursor-2", sequence: 2 })).toBe(true);
    expect(adapter.seedRecoveryCursor(subscription, { cursor: "older-cursor", sequence: 1 })).toBe(false);
    const result = await adapter.readRunEvents(subscription, { limit: 50 });

    expect(calls).toEqual([{ run_id: "run-1", after_cursor: "persisted-cursor-2", limit: 50 }]);
    expect(result).toMatchObject({ state: "received", request: { baselineSequence: 2 }, stream: { cursor: "persisted-cursor-2", cursorSequence: 2 } });
    expect(adapter.getRecoveryCursorBaseline(subscription)).toEqual({ cursor: "persisted-cursor-2", sequence: 2 });
  });

  test("does not advance a subscription baseline from a foreign page", async () => {
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({
        events: [event({ session_id: "other-session", cursor: "foreign-cursor", sequence: 3 })],
        has_more: true,
        next_cursor: "foreign-cursor",
      }),
    });

    adapter.selectSession("session-1");
    adapter.seedRecoveryCursor(subscription, { cursor: "persisted-cursor-2", sequence: 2 });
    const result = await adapter.readRunEvents(subscription);

    expect(result).toMatchObject({ state: "unknown", reason: "foreign_response" });
    expect(adapter.getRecoveryCursorBaseline(subscription)).toEqual({ cursor: "persisted-cursor-2", sequence: 2 });
  });

  test("fences a late event page after switching sessions", async () => {
    const pending = deferred();
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => pending.promise,
    });

    adapter.selectSession("session-1");
    const read = adapter.readRunEvents(subscription);
    adapter.selectSession("session-2");
    pending.resolve({ events: [event({ sequence: 3, cursor: "cursor-3" })], has_more: false, next_cursor: "cursor-3" });

    await expect(read).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });
    expect(adapter.getStreamState(subscription)).toBeUndefined();
  });

  test("guards duplicate submit clicks and does not call the client while offline", async () => {
    const submit = deferred();
    const calls = { submit: [], interrupt: [] };
    const adapter = new RunClientAdapter({
      submitRun: async (request) => {
        calls.submit.push(request);
        return submit.promise;
      },
      interruptRun: async (request) => {
        calls.interrupt.push(request);
        return ack(request.body.command_id);
      },
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-1", prompt: "run this" };

    adapter.selectSession("session-1");
    const first = adapter.submitRun("session-1", body);
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "pending", reason: "duplicate" });
    expect(calls.submit).toHaveLength(1);

    adapter.selectSession("session-2");
    submit.resolve(ack("command-1"));
    await expect(first).resolves.toMatchObject({ state: "unknown", reason: "stale_response" });

    const offline = await adapter.interruptRun("session-2", "run-2", { command_id: "command-2" }, { connection: "offline" });
    expect(offline).toMatchObject({ state: "unknown", reason: "offline" });
    expect(calls.interrupt).toHaveLength(0);
  });
});
