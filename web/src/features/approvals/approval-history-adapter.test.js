import { describe, expect, test } from "bun:test";
import { ApiClientError } from "@loomhelm/api-client";

import { ApprovalHistoryClientAdapter } from "./approval-history-adapter";

function approval(id, revision = 1, overrides = {}) {
  return {
    context: { command: "printf ok", cwd: "/workspace" },
    id,
    kind: "command",
    requested_at: `2026-10-27T00:00:0${revision}Z`,
    revision,
    run_id: "run-1",
    status: "pending",
    summary: "Run a harmless command",
    ...overrides,
  };
}

describe("approval history adapter", () => {
  test("resumes a multi-page history before the cached final page", async () => {
    const calls = [];
    const adapter = new ApprovalHistoryClientAdapter({
      listRunApprovals: async (request) => {
        calls.push(request);
        if (calls.length === 1) return { has_more: true, items: [approval("approval-1")], next_cursor: " cursor-1 " };
        if (calls.length === 2) return { has_more: false, items: [approval("approval-2")] };
        return { has_more: false, items: [approval("approval-2", 1, { status: "approved" }), approval("approval-3")] };
      },
    });

    await expect(adapter.readApprovals("run-1")).resolves.toMatchObject([{ id: "approval-1" }, { id: "approval-2" }]);
    await expect(adapter.readApprovals("run-1")).resolves.toMatchObject([{ id: "approval-1" }, { id: "approval-2", status: "approved" }, { id: "approval-3" }]);
    expect(calls).toEqual([
      { run_id: "run-1", limit: 200 },
      { run_id: "run-1", after_cursor: " cursor-1 ", limit: 200 },
      { run_id: "run-1", after_cursor: " cursor-1 ", limit: 200 },
    ]);
  });

  test("refreshes from the first page after an expired resume cursor", async () => {
    let calls = 0;
    const adapter = new ApprovalHistoryClientAdapter({
      listRunApprovals: async (request) => {
        calls += 1;
        if (calls === 1) return { has_more: true, items: [approval("approval-1")], next_cursor: " cursor-1 " };
        if (calls === 2) throw new ApiClientError(409, { code: "cursor_expired" });
        return { has_more: false, items: [approval("approval-1", 1, { status: "denied" })] };
      },
    });

    await adapter.readApprovals("run-1");
    await expect(adapter.readApprovals("run-1")).resolves.toMatchObject([{ id: "approval-1", status: "denied" }]);
  });
});
