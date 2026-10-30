import { describe, expect, test } from "bun:test";

import { buildSessionCreationIntentKey } from "../src/features/conversations/session-creation-identity";

describe("session creation identity", () => {
  test("keeps identical creation requests distinct across browser contexts", () => {
    const request = {
      conversationTitle: "新建独立会话",
      pathname: "/conversations/new",
      principalId: "user-1",
      projectId: "project-1",
      taskId: "task-1"
    };

    expect(buildSessionCreationIntentKey({ ...request, browserContext: "tab-a" })).not.toBe(buildSessionCreationIntentKey({ ...request, browserContext: "tab-b" }));
  });

  test("keeps a creation intent stable within one browser context", () => {
    const request = {
      browserContext: "tab-a",
      conversationTitle: "新建独立会话",
      pathname: "/conversations/new",
      principalId: "user-1",
      projectId: "project-1",
      taskId: "task-1"
    };

    expect(buildSessionCreationIntentKey(request)).toBe(buildSessionCreationIntentKey(request));
  });
});
