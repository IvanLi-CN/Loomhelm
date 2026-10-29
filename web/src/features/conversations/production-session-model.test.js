import { describe, expect, test } from "bun:test";

import {
  applyRunEvent,
  approvalContextFromApproval,
  connectionFromSessionState,
  eventToConversationMessage,
  runFromCommandAck,
  taskStatusFromState,
  toSessionContextModel
} from "./production-session-model";

const session = {
  created_at: "2026-10-27T00:00:00Z",
  external_thread_ref: "host-thread-1",
  id: "session-1",
  path: "existing_active",
  state: "active",
  updated_at: "2026-10-27T00:00:01Z"
};

function event(overrides = {}) {
  return {
    cursor: "cursor-1",
    event_id: "event-1",
    occurred_at: "2026-10-27T00:00:02Z",
    payload: { text: "hello" },
    run_id: "run-1",
    sequence: 1,
    session_id: "session-1",
    source: "app-server",
    type: "message.delta",
    ...overrides
  };
}

describe("production session model", () => {
  test("maps task state labels to the protocol status vocabulary", () => {
    expect(taskStatusFromState("待办")).toBe("todo");
    expect(taskStatusFromState("进行中")).toBe("in_progress");
    expect(taskStatusFromState("阻塞")).toBe("blocked");
    expect(taskStatusFromState("完成")).toBe("done");
    expect(taskStatusFromState("取消")).toBe("cancelled");
    expect(taskStatusFromState("unexpected")).toBe("todo");
  });

  test("keeps the task session context and Host thread identity explicit", () => {
    const context = toSessionContextModel(session, {
      conversationTitle: "核对执行候选",
      projectName: "Loomhelm",
      task: { goal: "核对事实", id: "LH-30", state: "进行中", title: "候选版本" }
    });
    expect(context).toMatchObject({
      conversationTitle: "核对执行候选",
      projectName: "Loomhelm",
      session,
      task: { id: "LH-30", status: "in_progress" }
    });
  });

  test("turns a command acknowledgement into a pending run without claiming completion", () => {
    const run = runFromCommandAck(session, {
      command_id: "command-1",
      deduplicated: false,
      event_cursor: "cursor-1",
      received_at: "2026-10-27T00:00:03Z",
      run_id: "run-1",
      state: "succeeded"
    });
    expect(run).toMatchObject({ command_id: "command-1", id: "run-1", status: "pending" });
  });

  test("does not infer a terminal Run from a command acknowledgement", () => {
    expect(runFromCommandAck(session, {
      command_id: "command-rejected",
      deduplicated: false,
      received_at: "2026-10-27T00:00:03Z",
      run_id: "run-rejected",
      state: "rejected"
    })).toMatchObject({ id: "run-rejected", status: "pending" });
  });

  test("reduces terminal and approval events without inferring from transport", () => {
    const pending = runFromCommandAck(session, {
      command_id: "command-1",
      deduplicated: false,
      received_at: "2026-10-27T00:00:03Z",
      run_id: "run-1",
      state: "accepted"
    });
    expect(pending).toBeDefined();
    const running = applyRunEvent(pending, event({ event_id: "started", type: "run.started", payload: {} }));
    const waiting = applyRunEvent(running, event({ event_id: "approval", type: "approval.requested", payload: {} }));
    const resumed = applyRunEvent(waiting, event({ event_id: "approval-resolved", type: "approval.resolved", payload: {} }));
    const completed = applyRunEvent(waiting, event({ event_id: "completed", type: "run.completed", payload: {} }));
    expect(running.status).toBe("running");
    expect(waiting.status).toBe("waiting_approval");
    expect(resumed.status).toBe("running");
    expect(completed).toMatchObject({ finished_at: "2026-10-27T00:00:02Z", status: "completed" });
  });

  test("defensively renders message, tool, and unknown payloads", () => {
    expect(eventToConversationMessage(event())).toMatchObject({ author: "Codex", content: "hello", kind: "message", role: "assistant" });
    expect(eventToConversationMessage(event({ event_id: "tool", payload: {}, type: "item.completed" }))).toMatchObject({ kind: "tool", content: "已接收事件：item.completed" });
    expect(eventToConversationMessage(event({ event_id: "unknown", payload: {}, type: "unknown" }))).toMatchObject({ kind: "unknown", content: "已接收事件：unknown" });
  });

  test("falls back to approval summary while preserving safe context fields", () => {
    expect(approvalContextFromApproval({
      context: { directory: "/workspace/loomhelm", impact: "writes a report" },
      id: "approval-1",
      kind: "shell",
      requested_at: "2026-10-27T00:00:00Z",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Run the requested command"
    })).toEqual({ complete: false, command: "Run the requested command", directory: "/workspace/loomhelm", impact: "writes a report" });

    expect(approvalContextFromApproval({
      context: { command: "codex inspect --workspace /workspace/loomhelm" },
      id: "approval-2",
      kind: "shell",
      requested_at: "2026-10-27T00:00:00Z",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Inspect the requested workspace"
    })).toMatchObject({ complete: true, command: "codex inspect --workspace /workspace/loomhelm" });
  });

  test("maps session lifecycle states to control connection availability", () => {
    expect(connectionFromSessionState("active")).toBe("online");
    expect(connectionFromSessionState("reconciling")).toBe("reconnecting");
    expect(connectionFromSessionState("disconnected")).toBe("offline");
  });
});
