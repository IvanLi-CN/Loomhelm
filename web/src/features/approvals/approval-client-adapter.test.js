import { describe, expect, test } from "bun:test";
import { ApiClientError } from "@loomhelm/api-client";

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
            run_id: "run-1",
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

  test("keeps a response-lost approval uncertain until explicit resolution", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        throw new Error("response lost");
      },
    });
    const input = { sessionId: "session-1", approval: approval(), commandId: "command-approval-1", decision: "approve" };

    adapter.selectSession("session-1");
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "transport" });
    await expect(adapter.resolve({ ...input, commandId: "command-approval-2" })).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertain("approval-1", 3, "run-1", "command-approval-1")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("keeps a mismatched approval acknowledgement uncertain until explicit resolution", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        return { ack: { command_id: "different-command", deduplicated: false, received_at: "2026-10-27T00:00:01Z", state: "succeeded" } };
      },
    });
    const input = { sessionId: "session-1", approval: approval(), commandId: "command-approval-1", decision: "approve" };

    adapter.selectSession("session-1");
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertain("approval-1", 3, "run-1", "command-approval-1")).toBe(true);
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    expect(calls).toHaveLength(2);
  });

  test("keeps an approval acknowledgement for another Run uncertain", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        return { ack: { command_id: request.body.command_id, deduplicated: false, received_at: "2026-10-27T00:00:01Z", run_id: "run-2", state: "accepted" } };
      },
    });
    const input = { sessionId: "session-1", approval: approval(), commandId: "command-approval-run-mismatch", decision: "approve" };

    adapter.selectSession("session-1");
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertain("approval-1", 3, "run-1", input.commandId)).toBe(true);
  });

  test("keeps an approval acknowledgement without a Run identity uncertain", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        return { ack: { command_id: request.body.command_id, deduplicated: false, received_at: "2026-10-27T00:00:01Z", state: "accepted" } };
      },
    });
    const input = { sessionId: "session-1", approval: approval(), commandId: "command-approval-run-missing", decision: "approve" };

    adapter.selectSession("session-1");
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "mismatched_response" });
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "unknown", reason: "unknown" });
    expect(calls).toHaveLength(1);
    expect(adapter.resolveUncertain("approval-1", 3, "run-1", input.commandId)).toBe(true);
  });

  test("releases an approval command after a definite API rejection", async () => {
    const calls = [];
    const adapter = new ApprovalClientAdapter({
      resolveApproval: async (request) => {
        calls.push(request);
        throw new ApiClientError(409, { code: "conflict" });
      }
    });
    const input = { sessionId: "session-1", approval: approval(), commandId: "command-approval-rejected", decision: "approve" };

    adapter.selectSession("session-1");
    await expect(adapter.resolve(input)).resolves.toMatchObject({ state: "failed" });
    await expect(adapter.resolve({ ...input, commandId: "command-approval-rejected-2" })).resolves.toMatchObject({ state: "failed" });
    expect(calls).toHaveLength(2);
  });
});
