import { ApiClientError } from "@loomhelm/api-client";
import type { Task } from "@loomhelm/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { productionShellMountIdentity } from "../src/components/product/ProductShell";
import {
  filterTasksToVisibleProjects,
  getSharedMutationRefreshScopeState,
  isCompleteProjectTaskQuery,
  markMutationRefreshScopes,
  mergeMutationNoticeChanges,
  readTaskPage,
  releaseMutationRefreshScopes,
  resourceReadState,
  projectTaskQueryKeys
} from "../src/features/projects/production-source";

function task(id: string, projectId: string): Task {
  return {
    created_at: "2026-11-07T00:00:00Z",
    goal: `Goal for ${id}`,
    id,
    project_id: projectId,
    status: "todo",
    title: id,
    updated_at: "2026-11-07T00:00:00Z"
  };
}

describe("focus cache regression", () => {
  test("keeps the shell identity stable for same-principal recovery and changes it for invalidation", () => {
    expect(productionShellMountIdentity("principal-a")).toBe(productionShellMountIdentity("principal-a"));
    expect(productionShellMountIdentity("principal-a")).not.toBe(productionShellMountIdentity("principal-b"));
    expect(productionShellMountIdentity(undefined)).toBe("unauthenticated");
  });

  test("reuses the scoped query cache across list and graph reads for one subject", () => {
    const queryClient = new QueryClient();
    const listKey = projectTaskQueryKeys.taskList("principal-a", { projectId: "project-a", mode: "list" }, 4);
    const graphKey = projectTaskQueryKeys.taskList("principal-a", { projectId: "project-a", mode: "graph" }, 4);
    const cached = { items: [task("task-a", "project-a")] };

    queryClient.setQueryData(listKey, cached);

    expect(graphKey).toEqual(listKey);
    expect(queryClient.getQueryData(graphKey)).toBe(cached);
    expect(projectTaskQueryKeys.taskList("principal-a", { projectId: "project-a" }, 5)).not.toEqual(listKey);
    expect(projectTaskQueryKeys.taskList("principal-b", { projectId: "project-a" }, 4)).not.toEqual(listKey);
    queryClient.clear();
  });

  test("keeps usable data during stale or network reads while removing permission-revoked data", () => {
    const stale = resourceReadState({ status: "success", data: ["cached-task"], error: null, isFetching: true });
    const offline = resourceReadState({ status: "error", data: ["cached-task"], error: new Error("offline"), isFetching: false });
    const revoked = resourceReadState({ status: "error", data: ["revoked-task"], error: new ApiClientError(403, { code: "forbidden" }), isFetching: false });

    expect(stale).toMatchObject({ status: "success", data: ["cached-task"], isFetching: true, isStale: true });
    expect(offline).toMatchObject({ status: "error", data: ["cached-task"], isFetching: false, isStale: false });
    expect(revoked).toMatchObject({ status: "error", isFetching: false, isStale: false });
    expect(revoked.data).toBeUndefined();
    expect(filterTasksToVisibleProjects([task("visible", "project-a"), task("other", "project-b"), task("revoked", "project-a")], new Set(["project-a"]), new Set(["revoked"])).map((item) => item.id)).toEqual(["visible"]);
  });

  test("reads a scoped page and keeps reconciliation incomplete while a partial read is fetching", async () => {
    const requests: Array<{ project_id?: string; after_cursor?: string; limit?: number }> = [];
    const page = await readTaskPage({
      listTasks: async (params) => {
        requests.push(params);
        return { has_more: true, items: [task("task-a", "project-a")], next_cursor: "cursor-2" };
      }
    }, "project-a", undefined, 2);

    await readTaskPage({
      listTasks: async (params) => {
        requests.push(params);
        return { has_more: false, items: [task("task-b", "project-a")] };
      }
    }, "project-a", page.next_cursor, 2);

    expect(page.next_cursor).toBe("cursor-2");
    expect(requests).toEqual([
      { project_id: "project-a", limit: 2 },
      { project_id: "project-a", after_cursor: "cursor-2", limit: 2 }
    ]);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "idle", data: page } }, true)).toBe(true);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "fetching", data: page } }, true)).toBe(false);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "idle", data: page } }, false)).toBe(false);
  });

  test("merges request notices and refresh barriers without releasing a newer request", () => {
    const merged = mergeMutationNoticeChanges(
      [{ id: "local", message: "本地请求仍在处理" }],
      [{ id: "remote", message: "远端结果待确认" }, { id: "local", message: "本地请求仍在处理" }],
      []
    );
    expect(merged.map((notice) => notice.id)).toEqual(["local", "remote"]);

    const queryClient = new QueryClient();
    const state = getSharedMutationRefreshScopeState(queryClient, "principal-a", 1);
    expect(getSharedMutationRefreshScopeState(queryClient, "principal-a", 2)).toBe(state);
    expect(getSharedMutationRefreshScopeState(queryClient, "principal-b", 1)).not.toBe(state);

    const first = markMutationRefreshScopes(state.barriers, ["project:project-a", "project:project-a"], state.nextRevision);
    state.nextRevision = first.nextRevision;
    const second = markMutationRefreshScopes(state.barriers, ["project:project-a"], state.nextRevision);
    state.nextRevision = second.nextRevision;
    releaseMutationRefreshScopes(state.barriers, first.revisions);
    expect(state.barriers.get("project:project-a")).toBe(second.revisions.get("project:project-a"));
    releaseMutationRefreshScopes(state.barriers, second.revisions);
    expect(state.barriers.has("project:project-a")).toBe(false);
    queryClient.clear();
  });
});
