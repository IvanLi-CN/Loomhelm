import { describe, expect, test } from "bun:test";

import { ApiClientError, type AuthenticatedApiClient } from "@loomhelm/api-client";

import {
  createAuthenticatedProductionAssembly,
  createProductionAuthFailureAssembly,
  createUnauthenticatedProductionAssembly
} from "../src/app/providers";
import { readAllCursorPages } from "../src/features/projects/production-source";

const client = {} as AuthenticatedApiClient;

describe("production browser assembly", () => {
  test("uses the bootstrapped browser principal for the production scope", () => {
    const assembly = createAuthenticatedProductionAssembly(client, { user_id: "user/browser", csrf_protection: "same_origin" });

    expect(assembly.auth).toEqual({ status: "authenticated", principalId: "user/browser", workspaceId: "default" });
    expect(assembly.permissions).toEqual({ canWrite: true, canManageProjects: true, isReadOnly: false });
  });

  test("treats only 401 as session loss; a 403 remains an authentication error", () => {
    expect(createProductionAuthFailureAssembly(client, new ApiClientError(401, { code: "unauthorized" })).auth.status).toBe("unauthenticated");
    expect(createProductionAuthFailureAssembly(client, new ApiClientError(403, { code: "forbidden" })).auth.status).toBe("error");
  });

  test("clears write permissions after logout state is committed", () => {
    const assembly = createUnauthenticatedProductionAssembly(client, "已退出当前浏览器会话。");

    expect(assembly.auth).toEqual({ status: "unauthenticated", message: "已退出当前浏览器会话。" });
    expect(assembly.permissions).toEqual({ canWrite: false, canManageProjects: false, isReadOnly: true });
  });
});

describe("cursor pagination", () => {
  test("reads every page and forwards the returned cursor", async () => {
    const cursors: Array<string | undefined> = [];
    const items = await readAllCursorPages("projects", async (afterCursor) => {
      cursors.push(afterCursor);
      if (!afterCursor) return { items: ["project-1"], has_more: true, next_cursor: "cursor-1" };
      if (afterCursor === "cursor-1") return { items: ["project-2"], has_more: true, next_cursor: "cursor-2" };
      return { items: ["project-3"], has_more: false };
    }, 100);

    expect(items).toEqual(["project-1", "project-2", "project-3"]);
    expect(cursors).toEqual([undefined, "cursor-1", "cursor-2"]);
  });

  test("fails closed when a server claims another page without advancing the cursor", async () => {
    await expect(readAllCursorPages("tasks", async () => ({ items: ["task-1"], has_more: true, next_cursor: "same" }), 200)).rejects.toThrow("tasks pagination did not return a new cursor");
  });
});
