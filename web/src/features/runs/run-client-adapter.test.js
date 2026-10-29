import { describe, expect, test } from "bun:test";
import { ApiClientError } from "@loomhelm/api-client";

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

function ack(command_id, state = "succeeded", run_id) {
  return {
    ack: {
      command_id,
      deduplicated: false,
      received_at: "2026-10-27T00:00:01Z",
      ...(run_id ? { run_id } : {}),
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

  test("accepts the first event page without a seeded cursor baseline", async () => {
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({ events: [event()], has_more: false, next_cursor: "cursor-1" })
    });

    adapter.selectSession("session-1");
    const result = await adapter.readRunEvents(subscription);

    expect(result).toMatchObject({ state: "received", stream: { cursor: "cursor-1", cursorSequence: 1 } });
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

  test("does not let a late page overwrite a newer seeded stream baseline", async () => {
    const pending = deferred();
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => pending.promise,
    });

    adapter.selectSession("session-1");
    adapter.seedRecoveryCursor(subscription, { cursor: "cursor-2", sequence: 2 });
    const read = adapter.readRunEvents(subscription);
    expect(adapter.seedRecoveryCursor(subscription, { cursor: "cursor-10", sequence: 10 })).toBe(true);
    pending.resolve({ events: [event({ event_id: "late-event", cursor: "cursor-3", sequence: 3 })], has_more: false, next_cursor: "cursor-3" });

    await expect(read).resolves.toMatchObject({ state: "unknown", reason: "stale_response", request: { baselineSequence: 2, baselineVersion: 1 } });
    expect(adapter.getStreamState(subscription)).toMatchObject({ cursor: "cursor-10", cursorSequence: 10 });
    expect(adapter.getRecoveryCursorBaseline(subscription)).toEqual({ cursor: "cursor-10", sequence: 10 });
  });

  test("preserves access failures when Run events are forbidden or missing", async () => {
    for (const [status, reason] of [[403, "forbidden"], [404, "not_found"]]) {
      const adapter = new RunClientAdapter({
        submitRun: async () => ack("unused"),
        interruptRun: async () => ack("unused"),
        listRunEvents: async () => {
          throw new ApiClientError(status, { code: reason });
        },
      });

      adapter.selectSession("session-1");
      await expect(adapter.readRunEvents(subscription)).resolves.toMatchObject({ state: "unknown", reason });
    }
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
    await expect(adapter.submitRun("session-2", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls.submit).toHaveLength(1);

    const offline = await adapter.interruptRun("session-2", "run-2", { command_id: "command-2" }, { connection: "offline" });
    expect(offline).toMatchObject({ state: "unknown", reason: "offline" });
    expect(calls.interrupt).toHaveLength(0);
  });

  test("keeps a response-lost interrupt uncertain until explicit resolution", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async (request) => {
        calls.push(request);
        throw new Error("response lost");
      },
      listRunEvents: async () => ({ events: [], has_more: false }),
    });

    adapter.selectSession("session-1");
    await expect(adapter.interruptRun("session-1", "run-1", { command_id: "command-interrupt-1" })).resolves.toMatchObject({ state: "unknown", reason: "transport" });
    await expect(adapter.interruptRun("session-1", "run-1", { command_id: "command-interrupt-2" })).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainInterrupt("run-1", "command-interrupt-1")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("keeps a response-lost submit uncertain until explicit resolution", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async (request) => {
        calls.push(request);
        throw new Error("response lost");
      },
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-submit-1", prompt: "run this" };

    adapter.selectSession("session-1");
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "transport" });
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainSubmit("command-submit-1")).toBe(true);
  });

  test("keeps a mismatched submit acknowledgement uncertain until explicit resolution", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async (request) => {
        calls.push(request);
        return ack("different-command");
      },
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-submit-1", prompt: "run this" };

    adapter.selectSession("session-1");
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainSubmit("command-submit-1")).toBe(true);
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    expect(calls).toHaveLength(2);
  });

  test("keeps a submit acknowledgement without a Run identity uncertain", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async (request) => {
        calls.push(request);
        return ack(request.body.command_id, "accepted");
      },
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-submit-run-missing", prompt: "run this" };

    adapter.selectSession("session-1");
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainSubmit(body.command_id)).toBe(true);
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    expect(calls).toHaveLength(2);
  });

  test("keeps a terminal submit acknowledgement with a blank Run identity uncertain", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async (request) => {
        calls.push(request);
        return { ack: { ...ack(request.body.command_id, "succeeded").ack, run_id: " " } };
      },
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-submit-terminal-run-missing", prompt: "run this" };

    adapter.selectSession("session-1");
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainSubmit(body.command_id)).toBe(true);
    await expect(adapter.submitRun("session-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    expect(calls).toHaveLength(2);
  });

  test("keeps an interrupt acknowledgement for another Run uncertain", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async (request) => {
        calls.push(request);
        return { ack: { ...ack(request.body.command_id).ack, run_id: "run-2", state: "accepted" } };
      },
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-interrupt-run-mismatch" };

    adapter.selectSession("session-1");
    await expect(adapter.interruptRun("session-1", "run-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.interruptRun("session-1", "run-1", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainInterrupt("run-1", body.command_id)).toBe(true);
  });

  test("keeps an interrupt acknowledgement without a Run identity uncertain", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async () => ack("unused"),
      interruptRun: async (request) => {
        calls.push(request);
        return ack(request.body.command_id, "accepted");
      },
      listRunEvents: async () => ({ events: [], has_more: false }),
    });
    const body = { command_id: "command-interrupt-run-missing" };

    adapter.selectSession("session-1");
    await expect(adapter.interruptRun("session-1", "run-1", body)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.interruptRun("session-1", "run-1", body)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertainInterrupt("run-1", body.command_id)).toBe(true);
  });

  test("releases a command after a definite API rejection", async () => {
    const calls = [];
    const adapter = new RunClientAdapter({
      submitRun: async (request) => {
        calls.push(request);
        throw new ApiClientError(403, { code: "unauthorized" });
      },
      interruptRun: async () => ack("unused"),
      listRunEvents: async () => ({ events: [], has_more: false })
    });

    adapter.selectSession("session-1");
    await expect(adapter.submitRun("session-1", { command_id: "command-rejected-1", prompt: "run this" })).resolves.toMatchObject({ state: "failed" });
    await expect(adapter.submitRun("session-1", { command_id: "command-rejected-2", prompt: "run this again" })).resolves.toMatchObject({ state: "failed" });
    expect(calls).toHaveLength(2);
  });
});
