import { describe, expect, test } from "bun:test";

import {
  advanceRecoveryCursor,
  applyEvent,
  applyEventPage,
  createEventStreamState,
  createRecoveryCursorState,
  getRecoveryCursor,
  rememberRecoveryCursor,
} from "./event-stream-model";
import { createControlOperationGuard, getControlGate } from "./control-operation-model";

function event(overrides = {}) {
  return {
    cursor: "cursor-1",
    event_id: "event-1",
    occurred_at: "2026-10-25T00:00:00Z",
    payload: { text: "hello" },
    run_id: "run-1",
    sequence: 1,
    session_id: "session-1",
    source: "app-server",
    type: "message.delta",
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    command_id: "command-1",
    issued_at: "2026-10-25T00:00:00Z",
    kind: "run.interrupt",
    payload: {},
    run_id: "run-1",
    session_id: "session-1",
    ...overrides,
  };
}

function ack(overrides = {}) {
  return {
    command_id: "command-1",
    deduplicated: false,
    received_at: "2026-10-25T00:00:01Z",
    state: "succeeded",
    ...overrides,
  };
}

describe("event stream identity and recovery", () => {
  test("isolates event identity by session and run while deduplicating repeats", () => {
    const runOne = createEventStreamState({ sessionId: "session-1", runId: "run-1" });
    const runTwo = createEventStreamState({ sessionId: "session-1", runId: "run-2" });

    const first = applyEvent(runOne, event());
    const duplicate = applyEvent(first.state, event());
    const otherRun = applyEvent(runTwo, event({ run_id: "run-2" }));
    const otherSession = applyEvent(first.state, event({ session_id: "session-2" }));

    expect(first.result).toBe("accepted");
    expect(duplicate.result).toBe("duplicate");
    expect(otherRun.result).toBe("accepted");
    expect(otherSession.result).toBe("foreign");
    expect(first.state.events).toHaveLength(1);
    expect(otherRun.state.events).toHaveLength(1);
  });

  test("keeps same-session events from different runs distinct in a session stream", () => {
    const sessionStream = createEventStreamState({ sessionId: "session-1" });
    const first = applyEvent(sessionStream, event());
    const second = applyEvent(first.state, event({ event_id: "event-1", run_id: "run-2", cursor: "cursor-2", sequence: 2 }));

    expect(second.result).toBe("accepted");
    expect(second.state.events.map(({ run_id }) => run_id)).toEqual(["run-1", "run-2"]);
  });

  test("advances a stream cursor only for events in its own page", () => {
    const scope = { sessionId: "session-1", runId: "run-1" };
    const page = {
      events: [event({ event_id: "event-1" }), event({ event_id: "event-2", cursor: "cursor-2", sequence: 2 })],
      has_more: true,
      next_cursor: "cursor-2",
    };
    const applied = applyEventPage(createEventStreamState(scope), page);
    expect(applied.accepted).toBe(2);
    expect(applied.state.cursor).toBe("cursor-2");
    expect(applied.state.events.map(({ event_id }) => event_id)).toEqual(["event-1", "event-2"]);

    const foreignPage = applyEventPage(applied.state, {
      events: [event({ event_id: "event-3", session_id: "session-2" })],
      has_more: true,
      next_cursor: "foreign-cursor",
    });
    expect(foreignPage.foreign).toBe(1);
    expect(foreignPage.state.cursor).toBe("cursor-2");
  });

  test("keeps recovery cursors independent for subscriptions and streams", () => {
    const sessionSubscription = { id: "conversation", scope: { sessionId: "session-1" } };
    const runSubscription = { id: "conversation", scope: { sessionId: "session-1", runId: "run-1" } };
    let state = createRecoveryCursorState();
    state = rememberRecoveryCursor(state, sessionSubscription, "session-cursor");
    state = advanceRecoveryCursor(state, runSubscription, { events: [], has_more: false, next_cursor: "run-cursor" });

    expect(getRecoveryCursor(state, sessionSubscription)).toBe("session-cursor");
    expect(getRecoveryCursor(state, runSubscription)).toBe("run-cursor");
  });
});

describe("control availability and operation fencing", () => {
  test("blocks unavailable or uncertain controls without queueing or replaying", () => {
    for (const input of [{ connection: "offline" }, { connection: "reconnecting" }, { eventType: "unknown" }, { runStatus: "unknown" }]) {
      const gate = getControlGate(input);
      expect(gate.allowed).toBe(false);
      expect(gate.queue).toBe(false);
      expect(gate.replay).toBe(false);
    }
    expect(getControlGate({ connection: "online" }).allowed).toBe(true);
    expect(getControlGate({ readOnly: true }).blockReason).toBe("read_only");
  });

  test("guards duplicate operations and rejects late responses from an older session", () => {
    const guard = createControlOperationGuard();
    const first = guard.begin({ operationKey: "run.interrupt", command: command() });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;

    const duplicate = guard.begin({ operationKey: "run.interrupt", command: command({ command_id: "command-2" }) });
    expect(duplicate).toMatchObject({ accepted: false, reason: "duplicate" });

    expect(guard.acceptResponse(first.token, ack({ state: "executing" }))).toEqual({ accepted: true, state: "executing", inProgress: true });
    guard.activateSession("session-2");
    expect(guard.acceptResponse(first.token, ack())).toEqual({ accepted: false, reason: "stale" });

    const current = guard.begin({ operationKey: "run.interrupt", command: command({ command_id: "command-3", session_id: "session-2" }) });
    expect(current.accepted).toBe(true);
    if (!current.accepted) return;
    expect(guard.acceptResponse(current.token, ack({ command_id: "command-3" }))).toEqual({ accepted: true, state: "succeeded", inProgress: false });
  });

  test("does not admit an operation while the control gate is blocked", () => {
    const guard = createControlOperationGuard();
    const result = guard.begin({ operationKey: "run.interrupt", command: command() }, getControlGate({ connection: "offline" }));
    expect(result).toMatchObject({ accepted: false, reason: "blocked" });
  });
});
