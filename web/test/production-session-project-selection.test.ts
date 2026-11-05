import { ApiClientError } from "@loomhelm/api-client";
import { describe, expect, test } from "bun:test";

import { normalizeProjectSelection, shouldPreserveProjectSelection, shouldRetainSessionCreationIntent } from "../src/features/conversations/ProductionConversationWorkspace";
import { listAllSessions } from "../src/features/conversations/session-list";

describe("production session project selection", () => {
  test("falls back to a projectless session when the source is loading or unavailable", () => {
    expect(normalizeProjectSelection("project-a", undefined, [])).toBe("__none__");
  });

  test("keeps a selected project while the authorized source still contains it", () => {
    expect(normalizeProjectSelection("project-a", undefined, [{ id: "project-a", name: "A" }])).toBe("project-a");
  });

  test("does not rewrite a fixed task project", () => {
    expect(normalizeProjectSelection("project-a", "project-a", [])).toBe("project-a");
  });

  test("preserves an uncertain project-scoped intent while projects reload", () => {
    expect(normalizeProjectSelection("project-a", undefined, [], true)).toBe("project-a");
  });

  test("preserves a project selection while a creation request is pending", () => {
    expect(shouldPreserveProjectSelection(true, false)).toBe(true);
    expect(normalizeProjectSelection("project-a", undefined, [], shouldPreserveProjectSelection(true, false))).toBe("project-a");
  });

  test("retains an uncertain creation intent when its original Host is no longer authorized", () => {
    expect(shouldRetainSessionCreationIntent(true, new ApiClientError(403, { code: "forbidden" }))).toBe(true);
    expect(shouldRetainSessionCreationIntent(false, new ApiClientError(403, { code: "forbidden" }))).toBe(false);
  });

  test("retains a creation intent when local persistence fails after the Session response", () => {
    expect(shouldRetainSessionCreationIntent(false, new Error("local draft persistence failed"))).toBe(true);
  });

  test("reads every authorized Session page", async () => {
    const cursors: Array<string | undefined> = [];
    const session = (id: string) => ({
      created_at: "2026-11-05T00:00:00Z",
      external_thread_ref: `thread-${id}`,
      id,
      path: "new" as const,
      state: "active" as const,
      updated_at: "2026-11-05T00:00:00Z"
    });
    const sessions = await listAllSessions({
      listSessions: async ({ after_cursor }) => {
        cursors.push(after_cursor);
        if (!after_cursor) return { has_more: true, items: [session("one")], next_cursor: "cursor-1" };
        return { has_more: false, items: [session("two")] };
      }
    });

    expect(sessions.map((item) => item.id)).toEqual(["one", "two"]);
    expect(cursors).toEqual([undefined, "cursor-1"]);
  });

  test("fails closed when Session pagination does not advance", async () => {
    await expect(listAllSessions({
      listSessions: async () => ({ has_more: true, items: [], next_cursor: "same" })
    })).rejects.toThrow("sessions pagination did not return a new cursor");
  });
});
