import { describe, expect, test } from "bun:test";

import { buildLegacySessionCreationIntentKey, buildSessionCreationIntentKey, hasSessionCreationIntentConflict } from "../src/features/conversations/session-creation-identity";

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

  test("shares one durable intent across the workbench and new-session routes", () => {
    const request = {
      browserContext: "tab-a",
      conversationTitle: "新建独立会话",
      principalId: "user-1",
      projectId: "project-1",
      taskId: "task-1"
    };

    expect(buildSessionCreationIntentKey({ ...request, pathname: "/" })).toBe(buildSessionCreationIntentKey({ ...request, pathname: "/conversations/new" }));
  });

  test("retains the old path-scoped key shape for cross-version recovery", () => {
    const request = {
      browserContext: "tab-a",
      conversationTitle: "新建独立会话",
      principalId: "user-1",
      projectId: "project-1",
      taskId: "task-1"
    };

    expect(buildLegacySessionCreationIntentKey({ ...request, pathname: "/" })).not.toBe(buildLegacySessionCreationIntentKey({ ...request, pathname: "/conversations/new" }));
    expect(buildLegacySessionCreationIntentKey({ ...request, pathname: "/conversations/new" })).not.toBe(buildSessionCreationIntentKey({ ...request, pathname: "/conversations/new" }));
  });

  test("detects divergent command identities across compatibility keys", () => {
    expect(hasSessionCreationIntentConflict([
      { commandId: "session-a", fingerprint: "request-a" },
      { commandId: "session-a", fingerprint: "request-a" }
    ])).toBe(false);
    expect(hasSessionCreationIntentConflict([
      { commandId: "session-a", fingerprint: "request-a" },
      { commandId: "session-b", fingerprint: "request-b" }
    ])).toBe(true);
  });
});
