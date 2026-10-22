import { describe, expect, test } from "bun:test";

import { ApiClientConfigurationError, ApiClientError } from "@loomhelm/api-client";

import {
  isAmbiguousWriteError,
  projectTaskQueryKeys,
  readProjectMemberships,
  readTaskRelationships,
  relationWriteBlockReason,
  syncTaskRelations,
  toProjectUpdateRequest,
  toTaskUpdateRequest
} from "../src/features/projects/production-source";
import { editableProjectSummary } from "../src/features/projects/ProjectForm";
import { wouldCreateDependencyCycle } from "../src/features/tasks/demo-store";
import { calculateTaskRelationChanges, type TaskRecord } from "../src/features/tasks/types";
import type { Task } from "@loomhelm/protocol";

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

  test("keeps display-only project summaries out of the editable form", () => {
    expect(editableProjectSummary({ id: "project-1", name: "Project", summary: "暂无项目简介", updatedAt: "now", conversationCount: 0 })).toBe("");
    expect(editableProjectSummary({ id: "project-1", name: "Project", summary: "Description", description: "Description", updatedAt: "now", conversationCount: 0 })).toBe("Description");
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
      removeParentIds: ["parent-2"],
      addDependencyIds: ["dependency-1"],
      removeDependencyIds: ["dependency-2"]
    });

    expect(calls).toEqual(["add-parent:task-1:parent-1", "remove-parent:task-1:parent-2", "add-dependency:task-1:dependency-1", "remove-dependency:task-1:dependency-2"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("添加前置任务 dependency-1");
    expect(invalidations).toEqual([projectTaskQueryKeys.tasks("user-1", 3)]);
  });

  test("keeps successful project memberships when one scoped read fails", async () => {
    const result = await readProjectMemberships({
      listProjectMembers: async ({ project_id }) => {
        if (project_id === "project-denied") throw new Error("forbidden");
        return { items: [{ created_at: "now", project_id, role: "operator", user_id: "user-1" }] };
      }
    }, ["project-ok", "project-denied"]);

    expect(result.items["project-ok"]).toHaveLength(1);
    expect(result.items["project-denied"]).toBeUndefined();
    expect(result.failures).toHaveLength(1);
  });

  test("hides a project whose membership read is no longer authorized", async () => {
    const result = await readProjectMemberships({
      listProjectMembers: async ({ project_id }) => {
        if (project_id === "project-revoked") throw new ApiClientError(403, { code: "unauthorized" });
        return { items: [{ created_at: "now", project_id, role: "operator", user_id: "user-1" }] };
      }
    }, ["project-ok", "project-revoked"]);

    expect(result.items["project-ok"]).toHaveLength(1);
    expect(result.deniedProjectIds).toEqual(["project-revoked"]);
    expect(result.failures).toEqual([]);
  });

  test("keeps task data when one relationship read fails", async () => {
    const tasks = [
      { created_at: "now", goal: "one", id: "task-1", project_id: "project-1", status: "todo", title: "Task one", updated_at: "now" },
      { created_at: "now", goal: "two", id: "task-2", project_id: "project-1", status: "todo", title: "Task two", updated_at: "now" }
    ] as const satisfies readonly Task[];
    const result = await readTaskRelationships({
      getTaskRelationships: async ({ task_id }) => {
        if (task_id === "task-2") throw new Error("relationship unavailable");
        return { children: [], dependents: [], parents: [], prerequisites: [] };
      }
    }, tasks);

    expect(result.items).toHaveLength(2);
    expect(result.relationships["task-1"]).toBeDefined();
    expect(result.relationships["task-2"]).toBeUndefined();
    expect(result.failures).toHaveLength(1);
  });

  test("hides a task whose relationship read is no longer authorized", async () => {
    const tasks = [
      { created_at: "now", goal: "one", id: "task-ok", project_id: "project-1", status: "todo", title: "Task one", updated_at: "now" },
      { created_at: "now", goal: "two", id: "task-revoked", project_id: "project-1", status: "todo", title: "Task two", updated_at: "now" }
    ] as const satisfies readonly Task[];
    const result = await readTaskRelationships({
      getTaskRelationships: async ({ task_id }) => {
        if (task_id === "task-revoked") throw new ApiClientError(404, { code: "unauthorized" });
        return { children: [], dependents: [], parents: [], prerequisites: [] };
      }
    }, tasks);

    expect(result.items).toHaveLength(2);
    expect(result.deniedTaskIds).toEqual(["task-revoked"]);
    expect(result.failures).toEqual([]);
  });

  test("fails closed when either relation endpoint is not writable", () => {
    const tasks = new Map([
      ["task-1", task("task-1")],
      ["task-2", { ...task("task-2"), projectId: "project-2" }]
    ]);
    const reason = relationWriteBlockReason(
      "task-1",
      { addDependencyIds: ["task-2"] },
      (id) => tasks.get(id ?? ""),
      (projectId) => ({ role: projectId === "project-1" ? "operator" : "viewer", canWrite: projectId === "project-1", canManageProjects: false, isReadOnly: projectId !== "project-1" })
    );

    expect(reason).toContain("所属项目为只读");
  });

  test("rejects dependency cycles in the demo relation validator", () => {
    const tasks = [task("task-a", ["task-b"]), task("task-b", ["task-c"]), task("task-c")];

    expect(wouldCreateDependencyCycle("task-c", ["task-a"], tasks)).toBe(true);
    expect(wouldCreateDependencyCycle("task-c", ["task-b"], tasks)).toBe(true);
    expect(wouldCreateDependencyCycle("task-a", ["task-c"], tasks)).toBe(false);
  });
});
