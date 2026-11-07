import { describe, expect, test } from "bun:test";

import { codexQueryKeys, codexRouteKey, findBoundCodexConversation, isTopLevelCodexConversation, listAllCodexConversations, parseCodexRouteKey } from "../src/features/codex/source";
import type { CodexConversation } from "@loomhelm/protocol";

describe("conversation visibility routing", () => {
  test("keeps an imported Codex detail route source-scoped", () => {
    const routeKey = codexRouteKey("host/default", "thread:one");

    expect(routeKey).toBe("codex:host%2Fdefault:thread%3Aone");
    expect(parseCodexRouteKey(routeKey)).toEqual({ hostId: "host/default", threadId: "thread:one" });
    expect(parseCodexRouteKey("session-demo-u03")).toBeUndefined();
  });

  test("isolates Codex overview cache by principal and session generation", () => {
    const current = codexQueryKeys.overview("user/current", 4, "", false);

    expect(codexQueryKeys.overview("user/other", 4, "", false)).not.toEqual(current);
    expect(codexQueryKeys.overview("user/current", 5, "", false)).not.toEqual(current);
    expect(codexQueryKeys.overview("user/current", 4, "search", false)).not.toEqual(current);
  });

  test("loads every Codex page before exposing the overview", async () => {
    const calls: Array<{ after_cursor?: string; limit?: number }> = [];
    const client = {
      listCodexConversations: async (params: { after_cursor?: string; limit?: number }) => {
        calls.push(params);
        return params.after_cursor
          ? { as_of: "2026-11-07T00:00:00Z", has_more: false, items: [{ thread_id: "thread-2" } as CodexConversation], snapshot_state: "complete" as const }
          : { as_of: "2026-11-07T00:00:00Z", has_more: true, items: [{ thread_id: "thread-1" } as CodexConversation], next_cursor: "cursor-2", snapshot_state: "complete" as const };
      }
    };

    const response = await listAllCodexConversations(client, { limit: 1 });

    expect(calls).toEqual([{ limit: 1, after_cursor: undefined }, { limit: 1, after_cursor: "cursor-2" }]);
    expect(response.items.map((item) => item.thread_id)).toEqual(["thread-1", "thread-2"]);
    expect(response.has_more).toBe(false);
  });

  test("fails closed when Codex pagination returns a historical cursor", async () => {
    const client = {
      listCodexConversations: async (params: { after_cursor?: string; limit?: number }) => params.after_cursor
        ? { has_more: true, items: [], next_cursor: "cursor-1" }
        : { has_more: true, items: [], next_cursor: "cursor-1" }
    };

    await expect(listAllCodexConversations(client)).rejects.toThrow("分页游标未前进");
  });

  test("keeps only unbound main threads in the formal conversation index", () => {
    const base = { source_kind: "main", bound_task_id: undefined, bound_session_id: undefined } as CodexConversation;

    expect(isTopLevelCodexConversation(base)).toBe(true);
    expect(isTopLevelCodexConversation({ ...base, bound_task_id: "task-1" })).toBe(false);
    expect(isTopLevelCodexConversation({ ...base, bound_session_id: "session-1" })).toBe(false);
    expect(isTopLevelCodexConversation({ ...base, source_kind: "subagent" })).toBe(false);
  });

  test("finds the bound main Codex thread for a Session without exposing subagents", () => {
    const main = { source_kind: "main", bound_session_id: "session-1", thread_id: "main-thread" } as CodexConversation;
    const subagent = { source_kind: "subagent", bound_session_id: "session-1", thread_id: "subagent-thread" } as CodexConversation;

    expect(findBoundCodexConversation([subagent, main], "session-1")).toBe(main);
    expect(findBoundCodexConversation([main], "session-2")).toBeUndefined();
    expect(findBoundCodexConversation([main], undefined)).toBeUndefined();
  });
});
