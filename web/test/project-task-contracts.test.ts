import { describe, expect, test } from "bun:test";

import { ApiClientConfigurationError, ApiClientError } from "@loomhelm/api-client";

import {
  isAmbiguousWriteError,
  projectTaskQueryKeys,
  syncTaskRelations,
  toProjectUpdateRequest,
  toTaskUpdateRequest
} from "../src/features/projects/production-source";
import { wouldCreateDependencyCycle } from "../src/features/tasks/demo-store";
import { calculateTaskRelationChanges, type TaskRecord } from "../src/features/tasks/types";

function task(id: string, dependsOn: string[] = []): TaskRecord {
  return {
    id,
    title: id,
    goal: "goal",
    projectId: "project-1",
    state: "待办",
    execution: null,
    dependsOn,
    updated: "now"
  };
}

describe("project/task write contracts", () => {
  test("calculates only explicit relation edge changes", () => {
    expect(calculateTaskRelationChanges(["parent-1", "parent-2"], ["parent-2", "parent-3"], ["task-1"], ["task-1", "task-2"])).toEqual({
      addParentIds: ["parent-3"],
      removeParentIds: ["parent-1"],
      addDependencyIds: ["task-2"]
    });
    expect(calculateTaskRelationChanges(["parent-1"], ["parent-1"], [], [])).toBeUndefined();
  });

  test("keeps relation changes out of the task PATCH body", () => {
    expect(toTaskUpdateRequest({ title: "  New title ", goal: " New goal ", state: "进行中", relationChanges: { addDependencyIds: ["task-2"] } })).toEqual({
      title: "New title",
      goal: "New goal",
      status: "in_progress"
    });
  });

  test("does not write a display-only project description placeholder", () => {
    expect(toProjectUpdateRequest({ id: "project-1", name: "Project", summary: "暂无项目简介", updatedAt: "now", conversationCount: 0 }, { name: "Project", summary: "" })).toEqual({});
    expect(toProjectUpdateRequest({ id: "project-1", name: "Project", summary: "Description", description: "Description", updatedAt: "now", conversationCount: 0 }, { name: "Project", summary: "" })).toEqual({ description: "" });
  });

  test("separates ambiguous transport errors from scoped denials", () => {
    expect(isAmbiguousWriteError(new ApiClientError(503, { code: "server_error" }))).toBe(true);
    expect(isAmbiguousWriteError(new ApiClientError(403, { code: "forbidden" }))).toBe(false);
    expect(isAmbiguousWriteError(new ApiClientConfigurationError("missing session"))).toBe(false);
  });

  test("separates cache generations after session invalidation", () => {
    expect(projectTaskQueryKeys.projects("user-1", 1)).not.toEqual(projectTaskQueryKeys.projects("user-1", 2));
    expect(projectTaskQueryKeys.tasks("user-1", 1)).not.toEqual(projectTaskQueryKeys.tasks("user-1", 2));
  });

  test("writes each relation edge independently and reports partial failure", async () => {
    const calls: string[] = [];
    const invalidations: readonly unknown[][] = [];
    const api = {
      addTaskParent: async ({ task_id, parent_task_id }: { task_id: string; parent_task_id: string }) => {
        calls.push(`add-parent:${task_id}:${parent_task_id}`);
      },
      removeTaskParent: async ({ task_id, parent_task_id }: { task_id: string; parent_task_id: string }) => {
        calls.push(`remove-parent:${task_id}:${parent_task_id}`);
      },
      addTaskDependency: async ({ task_id, prerequisite_task_id }: { task_id: string; prerequisite_task_id: string }) => {
        calls.push(`add-dependency:${task_id}:${prerequisite_task_id}`);
        throw new Error("relation denied");
      },
      removeTaskDependency: async ({ task_id, prerequisite_task_id }: { task_id: string; prerequisite_task_id: string }) => {
        calls.push(`remove-dependency:${task_id}:${prerequisite_task_id}`);
      }
    };
    const queryClient = {
      invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        invalidations.push(queryKey);
      }
    };

    const result = await syncTaskRelations(api, queryClient as never, "user-1", 3, "task-1", {
      addParentIds: ["parent-1"],
      addDependencyIds: ["dependency-1"]
    });

    expect(calls).toEqual(["add-parent:task-1:parent-1", "add-dependency:task-1:dependency-1"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("添加前置任务 dependency-1");
    expect(invalidations).toEqual([projectTaskQueryKeys.tasks("user-1", 3)]);
  });

  test("rejects dependency cycles in the demo relation validator", () => {
    const tasks = [task("task-a", ["task-b"]), task("task-b", ["task-c"]), task("task-c")];

    expect(wouldCreateDependencyCycle("task-c", ["task-a"], tasks)).toBe(true);
    expect(wouldCreateDependencyCycle("task-c", ["task-b"], tasks)).toBe(true);
    expect(wouldCreateDependencyCycle("task-a", ["task-c"], tasks)).toBe(false);
  });
});
