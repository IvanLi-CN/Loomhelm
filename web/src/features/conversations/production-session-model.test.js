import { describe, expect, test } from "bun:test";

import {
  applyRunEvent,
  applyApprovalResolutionEvents,
  approvalContextFromApproval,
  connectionFromSessionState,
  eventToConversationMessage,
  initialRunCommandId,
  isDefiniteInitialRunFailure,
  isSessionAccessFailure,
  mergeConversationMessages,
  runFromHistory,
  runFromCommandAck,
  runFromRecoveredIdentity,
  sessionReadFailureMessage,
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

  test("distinguishes inaccessible sessions from uncertain transport failures", () => {
    expect(isSessionAccessFailure("forbidden")).toBe(true);
    expect(isSessionAccessFailure("not_found")).toBe(true);
    expect(isSessionAccessFailure("transport")).toBe(false);
    expect(sessionReadFailureMessage("forbidden")).toContain("无权");
    expect(sessionReadFailureMessage("not_found")).toContain("不可访问");
    expect(sessionReadFailureMessage("transport", true)).toContain("已保留已观察事实");
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

  test("rejects blank Run identities from command acknowledgements", () => {
    expect(runFromCommandAck(session, {
      command_id: "command-blank-run",
      deduplicated: false,
      received_at: "2026-10-27T00:00:03Z",
      run_id: "   ",
      state: "accepted"
    })).toBeUndefined();
  });

  test("derives the server-owned command identity for the initial Run", () => {
    expect(initialRunCommandId("session-1")).toBe("session-1:initial");
  });

  test("only treats a matching failed initial acknowledgement as definite", () => {
    expect(isDefiniteInitialRunFailure({ command_id: "session-1:initial", state: "failed" }, "session-1:initial")).toBe(true);
    expect(isDefiniteInitialRunFailure({ command_id: "other-command", state: "failed" }, "session-1:initial")).toBe(false);
  });

  test("preserves a rejected command acknowledgement as a failed Run", () => {
    expect(runFromCommandAck(session, {
      command_id: "command-rejected",
      deduplicated: false,
      received_at: "2026-10-27T00:00:03Z",
      run_id: "run-rejected",
      state: "rejected"
    })).toMatchObject({ id: "run-rejected", status: "failed" });
  });

  test("keeps a recovered Run identity unknown until an event verifies it", () => {
    expect(runFromRecoveredIdentity(session, "run-recovered")).toMatchObject({ id: "run-recovered", session_id: "session-1", status: "unknown" });
  });

  test("restores durable Run facts without trusting the persisted status", () => {
    expect(runFromHistory(session, {
      command_id: "command-history",
      created_at: "2026-10-27T00:00:04Z",
      finished_at: "2026-10-27T00:00:06Z",
      id: "run-history",
      last_cursor: "cursor-history",
      session_id: "foreign-session",
      started_at: "2026-10-27T00:00:05Z",
      status: "completed"
    })).toEqual({
      command_id: "command-history",
      created_at: "2026-10-27T00:00:04Z",
      finished_at: "2026-10-27T00:00:06Z",
      id: "run-history",
      last_cursor: "cursor-history",
      session_id: "session-1",
      started_at: "2026-10-27T00:00:05Z",
      status: "unknown"
    });
  });

  test("does not resume a Run from one approval resolution event", () => {
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
    expect(resumed.status).toBe("waiting_approval");
    expect(applyRunEvent(resumed, event({ event_id: "resumed", type: "run.started", payload: {} })).status).toBe("running");
    expect(completed).toMatchObject({ finished_at: "2026-10-27T00:00:02Z", status: "completed" });
  });

  test("defensively renders message, tool, and unknown payloads", () => {
    expect(eventToConversationMessage(event())).toMatchObject({ author: "Codex", content: "hello", kind: "message", role: "assistant" });
    expect(eventToConversationMessage(event({ payload: { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "nested hello" } } }))).toMatchObject({ content: "nested hello" });
    expect(eventToConversationMessage(event({ event_id: "tool", payload: {}, type: "item.completed" }))).toMatchObject({ kind: "tool", content: "已接收事件：item.completed" });
    expect(eventToConversationMessage(event({ event_id: "known-item", payload: { params: { item: { command: "printf ok", type: "commandExecution" } } }, type: "item.completed" }))).toMatchObject({ detail: expect.stringContaining('"command": "printf ok"'), kind: "tool" });
    expect(eventToConversationMessage(event({ event_id: "agent-completed", payload: { params: { item: { id: "item-agent", text: "final answer", type: "agentMessage" } } }, type: "item.completed" }))).toMatchObject({ content: "final answer", id: "session-1:run-1:item:item-agent", kind: "message", role: "assistant" });
    expect(eventToConversationMessage(event({ event_id: "unknown", payload: {}, type: "unknown" }))).toMatchObject({ kind: "unknown", content: "已接收事件：unknown" });
    expect(eventToConversationMessage(event({ event_id: "unknown-item", payload: { params: { item: { type: "futureContent", value: "preserve-me" } } }, type: "item.completed" }))).toMatchObject({ kind: "unknown" });
  });

  test("renders a structured userMessage item as a user message", () => {
    const message = eventToConversationMessage(event({
      event_id: "user-completed",
      payload: { params: { item: { content: [{ text: "run exactly" }, { text: " now" }], id: "item-user", type: "userMessage" } } },
      type: "item.completed"
    }));
    expect(message).toMatchObject({ author: "你", content: "run exactly now", id: "session-1:run-1:item:item-user", kind: "message", role: "user" });
  });

  test("keeps raw payload and metadata inspectable for unknown events", () => {
    const message = eventToConversationMessage(event({ event_id: "unknown-raw", payload: { futureField: true }, type: "unknown" }));
    expect(message.detail).toContain('"event_id": "unknown-raw"');
    expect(message.detail).toContain('"futureField": true');

    const unknownItem = eventToConversationMessage(event({ event_id: "unknown-item-raw", payload: { params: { item: { type: "futureContent", value: "preserve-me" } } }, type: "item.completed" }));
    expect(unknownItem.detail).toContain('"value": "preserve-me"');
  });

  test("reconciles streamed agent text with the authoritative completed item", () => {
    const delta = eventToConversationMessage(event({ event_id: "agent-delta", payload: { params: { delta: "partial ", itemId: "item-agent" } }, type: "message.delta" }));
    const final = eventToConversationMessage(event({ event_id: "agent-completed", payload: { params: { item: { id: "item-agent", text: "final answer", type: "agentMessage" } } }, sequence: 2, type: "item.completed" }));
    const merged = mergeConversationMessages([], [delta, final]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ content: "final answer", eventType: "item.completed", kind: "message" });
  });

  test("reorders late message deltas by event sequence", () => {
    const high = eventToConversationMessage(event({ event_id: "agent-delta-high", payload: { params: { delta: "second ", itemId: "item-agent" } }, sequence: 3, type: "message.delta" }));
    const low = eventToConversationMessage(event({ event_id: "agent-delta-low", payload: { params: { delta: "first ", itemId: "item-agent" } }, sequence: 2, type: "message.delta" }));
    const merged = mergeConversationMessages(mergeConversationMessages([], [high]), [low]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ content: "first second ", sequence: 3 });
  });

  test("correlates approval resolutions through the durable requested-event identity", () => {
    const approvals = [{
      context: { command: "printf ok", cwd: "/workspace" },
      id: "approval-1",
      kind: "command",
      requested_at: "2026-10-27T00:00:00Z",
      requested_event_id: "approval-requested-event",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Run a harmless command"
    }];
    const requested = event({ event_id: "approval-requested-event", payload: { id: 42 }, type: "approval.requested" });
    const resolved = event({ event_id: "approval-resolved-event", payload: { params: { requestId: 42, resolution: "accept" } }, type: "approval.resolved" });
    expect(applyApprovalResolutionEvents(approvals, [requested, resolved], [resolved])).toMatchObject({ matched: true, unresolved: false, approvals: [{ status: "approved" }] });

    const oldRevision = { ...approvals[0], requested_event_id: "approval-requested-old" };
    const newRevision = { ...approvals[0], requested_event_id: "approval-requested-new", revision: 2 };
    const oldRequested = event({ event_id: "approval-requested-old", payload: { id: 42 }, sequence: 1, type: "approval.requested" });
    const oldResolved = event({ event_id: "approval-resolved-old", payload: { params: { requestId: 42, resolution: "accept" } }, sequence: 2, type: "approval.resolved" });
    const newRequested = event({ event_id: "approval-requested-new", payload: { id: 42 }, sequence: 3, type: "approval.requested" });
    expect(applyApprovalResolutionEvents([oldRevision, newRevision], [oldRequested, oldResolved, newRequested], [oldResolved])).toMatchObject({
      matched: true,
      unresolved: false,
      approvals: [{ id: "approval-1", status: "approved" }, { id: "approval-1", revision: 2, status: "pending" }]
    });

    const numericApproval = { ...approvals[0], id: "approval-numeric", requested_event_id: "approval-requested-numeric" };
    const stringApproval = { ...approvals[0], id: "approval-string", requested_event_id: "approval-requested-string", revision: 2 };
    const numericRequested = event({ event_id: "approval-requested-numeric", payload: { id: 42 }, sequence: 1, type: "approval.requested" });
    const stringRequested = event({ event_id: "approval-requested-string", payload: { id: "42" }, sequence: 2, type: "approval.requested" });
    const numericResolved = event({ event_id: "approval-resolved-numeric", payload: { params: { requestId: 42, resolution: "accept" } }, sequence: 3, type: "approval.resolved" });
    expect(applyApprovalResolutionEvents([numericApproval, stringApproval], [numericRequested, stringRequested, numericResolved], [numericResolved])).toMatchObject({
      matched: true,
      unresolved: false,
      approvals: [{ id: "approval-numeric", status: "approved" }, { id: "approval-string", status: "pending" }]
    });
  });

  test("keeps message identities distinct across runs in one session", () => {
    expect(eventToConversationMessage(event({ run_id: "run-1" })).id).not.toBe(eventToConversationMessage(event({ run_id: "run-2" })).id);
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
    })).toMatchObject({ complete: false, command: "codex inspect --workspace /workspace/loomhelm" });

    expect(approvalContextFromApproval({
      context: { command: "codex inspect --workspace /workspace/loomhelm", cwd: "/workspace/loomhelm" },
      id: "approval-3",
      kind: "command",
      requested_at: "2026-10-27T00:00:00Z",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Inspect the requested workspace"
    })).toMatchObject({ complete: true, command: "codex inspect --workspace /workspace/loomhelm", directory: "/workspace/loomhelm" });

    expect(approvalContextFromApproval({
      context: { grantRoot: "/workspace/loomhelm", reason: "A file change is ready for review" },
      id: "approval-4",
      kind: "file_change",
      requested_at: "2026-10-27T00:00:00Z",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Review file changes"
    })).toMatchObject({ complete: true, command: "Review file changes", directory: "/workspace/loomhelm", impact: "A file change is ready for review" });

    expect(approvalContextFromApproval({
      context: { scope: "workspace", reason: "A file change is ready for review" },
      id: "approval-5",
      kind: "file_change",
      requested_at: "2026-10-27T00:00:00Z",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Review file changes"
    })).toMatchObject({ complete: true, command: "Review file changes", impact: "A file change is ready for review", scope: "workspace" });

    for (const context of [{ command: "apply changes", path: "/workspace/loomhelm/report.md", reason: "A file change is ready for review" }, { command: "apply changes", cwd: "/workspace/loomhelm", reason: "A file change is ready for review" }, { command: "apply changes", workdir: "/workspace/loomhelm", reason: "A file change is ready for review" }]) {
      expect(approvalContextFromApproval({
        context,
        id: `approval-6-${context.path ?? context.cwd ?? context.workdir}`,
        kind: "file_change",
        requested_at: "2026-10-27T00:00:00Z",
        revision: 1,
        run_id: "run-1",
        status: "pending",
        summary: "Review file changes"
      })).toMatchObject({ complete: false });
    }
  });

  test("preserves unknown approval context instead of hiding fields", () => {
    const context = approvalContextFromApproval({
      context: { command: "codex inspect", scope: "workspace", payload: { write: true } },
      id: "approval-unknown-context",
      kind: "shell",
      requested_at: "2026-10-27T00:00:00Z",
      revision: 1,
      run_id: "run-1",
      status: "pending",
      summary: "Inspect the requested workspace"
    });
    expect(context.complete).toBe(false);
    expect(context.rawContext).toContain('"scope": "workspace"');
    expect(context.rawContext).toContain('"write": true');
  });

  test("maps session lifecycle states to control connection availability", () => {
    expect(connectionFromSessionState("active")).toBe("online");
    expect(connectionFromSessionState("reconciling")).toBe("reconnecting");
    expect(connectionFromSessionState("disconnected")).toBe("offline");
    expect(connectionFromSessionState("unsupported")).toBe("offline");
  });
});
