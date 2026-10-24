import { describe, expect, test } from "bun:test";

import { ApiClientError, type AuthenticatedApiClient } from "@loomhelm/api-client";
import { QueryClient } from "@tanstack/react-query";

import {
  clearPrincipalQueries,
  createAuthenticatedProductionAssembly,
  createProductionAuthFailureAssembly,
  createUnauthenticatedProductionAssembly
} from "../src/app/providers";
import { isPermissionError, readAllCursorPages } from "../src/features/projects/production-source";
import { mapTask } from "../src/features/projects/api";

const client = {} as AuthenticatedApiClient;

describe("production browser assembly", () => {
  test("cancels and removes queries for the previous browser principal", async () => {
    const client = new QueryClient();
    client.setQueryData(["loomhelm", "user/a", "projects"], ["old"]);
    client.setQueryData(["loomhelm", "user/b", "projects"], ["current"]);

    await clearPrincipalQueries(client, "user/a");

    expect(client.getQueryData(["loomhelm", "user/a", "projects"])).toBeUndefined();
    expect(client.getQueryData(["loomhelm", "user/b", "projects"])).toEqual(["current"]);
  });

  test("uses the bootstrapped browser principal for the production scope", () => {
    const assembly = createAuthenticatedProductionAssembly(client, { user_id: "user/browser", csrf_protection: "same_origin" });

    expect(assembly.auth).toEqual({ status: "authenticated", principalId: "user/browser", workspaceId: "default", sessionGeneration: 0 });
    expect(assembly.permissions).toEqual({ canWrite: true, canManageProjects: true, isReadOnly: false });
  });

  test("treats only 401 as session loss; a 403 remains an authentication error", () => {
    expect(createProductionAuthFailureAssembly(client, new ApiClientError(401, { code: "unauthorized" })).auth.status).toBe("unauthenticated");
    expect(createProductionAuthFailureAssembly(client, new ApiClientError(403, { code: "forbidden" })).auth.status).toBe("error");
  });

  test("clears write permissions after logout state is committed", () => {
    const assembly = createUnauthenticatedProductionAssembly(client, "已退出当前浏览器会话。");

    expect(assembly.auth).toEqual({ status: "unauthenticated", message: "已退出当前浏览器会话。", sessionGeneration: 0 });
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

describe("protected project/task reads", () => {
  test("treats concealed not-found responses as authorization changes", () => {
    expect(isPermissionError(new ApiClientError(404, { code: "not_found" }))).toBe(true);
    expect(isPermissionError(new ApiClientError(500, { code: "server_error" }))).toBe(false);
  });

  test("keeps all parent relationships and leaves execution unavailable until Run data exists", () => {
    const task = mapTask({ created_at: "created", goal: "goal", id: "task/1", project_id: "project/1", status: "todo", title: "Task", updated_at: "updated" }, {
      children: [],
      dependents: [],
      parents: [
        { child_task_id: "task/1", created_at: "", kind: "hierarchy", parent_task_id: "task/parent-1" },
        { child_task_id: "task/1", created_at: "", kind: "hierarchy", parent_task_id: "task/parent-2" }
      ],
      prerequisites: []
    });

    expect(task.parentId).toBe("task/parent-1");
    expect(task.parentIds).toEqual(["task/parent-1", "task/parent-2"]);
    expect(task.execution).toBeNull();
  });
});
