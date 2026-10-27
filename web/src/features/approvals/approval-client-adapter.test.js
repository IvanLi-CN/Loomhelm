import { describe, expect, test } from "bun:test";

import { ApprovalClientAdapter } from "./approval-client-adapter";

function approval(overrides = {}) {
  return {
    id: "approval-1",
    kind: "shell",
    requested_at: "2026-10-27T00:00:00Z",
    revision: 3,
    run_id: "run-1",
    status: "pending",
    summary: "Run the requested command",
    ...overrides,
  };
}

describe("approval client adapter", () => {
  test("sends the generated approval request with the current revision and maps accepted to pending", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        return {
          ack: {
            command_id: request.body.command_id,
            deduplicated: false,
            received_at: "2026-10-27T00:00:01Z",
            state: "accepted",
          },
        };
      },
    });

    adapter.selectSession("session-1");
    const result = await adapter.resolve({ sessionId: "session-1", approval: approval(), commandId: "command-approve-1", decision: "approve" });

    expect(calls).toEqual([{
      approval_id: "approval-1",
      run_id: "run-1",
      body: { command_id: "command-approve-1", decision: "approve", revision: 3 },
    }]);
    expect(result).toMatchObject({ state: "pending", commandId: "command-approve-1", ack: { state: "accepted" } });
  });

  test("does not call resolveApproval for a processed approval or during reconnect", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        return { ack: { command_id: request.body.command_id, deduplicated: false, received_at: "2026-10-27T00:00:01Z", state: "succeeded" } };
      },
    });

    adapter.selectSession("session-1");
    const processed = await adapter.resolve({ sessionId: "session-1", approval: approval({ status: "approved" }), commandId: "command-processed", decision: "deny" });
    const reconnecting = await adapter.resolve({ sessionId: "session-1", approval: approval(), commandId: "command-reconnecting", decision: "approve" }, { connection: "reconnecting" });

    expect(processed).toMatchObject({ state: "unknown", reason: "not_actionable" });
    expect(reconnecting).toMatchObject({ state: "unknown", reason: "reconnecting" });
    expect(calls).toHaveLength(0);
  });
});
