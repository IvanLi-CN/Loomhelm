import { describe, expect, test } from "bun:test";

import { ApiClientConfigurationError, ApiClientError } from "@loomhelm/api-client";
import { QueryClient } from "@tanstack/react-query";

import {
  canAcknowledgePendingCreationNotice,
  isAmbiguousWriteError,
  isCompleteProjectTaskQuery,
  createClientResourceId,
  filterTaskRelationships,
  filterTasksToVisibleProjects,
  getSharedMutationRefreshScopeState,
  hasIncompleteProjectTaskRead,
  isTaskCreationNotice,
  markMutationRefreshScopes,
  mergeMutationNoticeChanges,
  mergePersistedMutationNoticeState,
  mergePersistedMutationNotices,
  mutationNoticeContentToken,
  reconcileKnownTaskCreationNotice,
  readMutationNoticesFromStorage,
  readMutationNoticeStateFromStorage,
  mutationNoticeScopes,
  mutationNoticeRemovalScopes,
  mutationWriteAdmission,
  projectTaskQueryKeys,
  readProjectMemberships,
  readTaskRelationships,
  relationWriteBlockReason,
  releaseMutationRefreshScopes,
  stableBlockedWriteMessage,
  syncTaskRelations,
  toProjectUpdateRequest,
  toTaskUpdateRequest
} from "../src/features/projects/production-source";
import { editableProjectSummary } from "../src/features/projects/ProjectForm";
import { reconcileTaskFormState } from "../src/features/tasks/TaskForm";
import { wouldCreateDependencyCycle } from "../src/features/tasks/demo-store";
import { calculateTaskRelationChanges, taskWriteBlockReason, type TaskRecord } from "../src/features/tasks/types";
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

function protocolTask(id = "task-1"): Task {
  return {
    created_at: "now",
    goal: "goal",
    id,
    project_id: "project-1",
    status: "todo",
    title: id,
    updated_at: "now"
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

  test("refreshes the same task baseline without replaying applied edges or losing draft intent", () => {
    const previous = { title: "Old", goal: "Goal", projectId: "project-1", state: "待办" as const, parentIds: [], dependsOn: [] };
    const next = { title: "Saved", goal: "Goal", projectId: "project-1", state: "进行中" as const, parentIds: ["parent-1"], dependsOn: [] };
    const draft = { ...previous, title: "Saved", state: "进行中" as const, parentIds: ["parent-1", "parent-2"] };

    const reconciled = reconcileTaskFormState(previous, next, draft, true);

    expect(reconciled.baseline).toEqual(next);
    expect(reconciled.draft).toMatchObject({ title: "Saved", state: "进行中", parentIds: ["parent-1", "parent-2"] });
    expect(calculateTaskRelationChanges(reconciled.baseline.parentIds, reconciled.draft.parentIds, reconciled.baseline.dependsOn, reconciled.draft.dependsOn)).toEqual({ addParentIds: ["parent-2"] });

    const incomplete = reconcileTaskFormState(previous, { ...next, parentIds: [] }, draft, false);
    expect(incomplete.baseline.parentIds).toEqual([]);
    expect(incomplete.draft.parentIds).toEqual(["parent-1", "parent-2"]);
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
    expect(isAmbiguousWriteError(new ApiClientConfigurationError("response completed after invalidation", true))).toBe(true);
  });

  test("uses stable protected-delete feedback for conflict responses", () => {
    expect(stableBlockedWriteMessage("删除任务")).toBe("任务仍有关系、对话或执行事实，受保护删除已阻止。");
    expect(stableBlockedWriteMessage("删除项目")).toBe("项目仍保留任务、对话或执行事实，受保护删除已阻止。");
    expect(stableBlockedWriteMessage("更新任务")).toBeUndefined();
  });

  test("keeps the task write barrier scoped to an incompletely reconciled task", () => {
    expect(taskWriteBlockReason(undefined)).toBeUndefined();
    expect(taskWriteBlockReason({ relationshipsConfirmed: true })).toBeUndefined();
    expect(taskWriteBlockReason({ relationshipsConfirmed: false })).toContain("编辑、关系修改和删除已暂停");
    expect(taskWriteBlockReason({ relationshipsConfirmed: false, reconciliationNotice: "关系结果待确认。" })).toBe("关系结果待确认。");
  });

  test("separates cache generations after session invalidation", () => {
    expect(projectTaskQueryKeys.projects("user-1", 1)).not.toEqual(projectTaskQueryKeys.projects("user-1", 2));
    expect(projectTaskQueryKeys.tasks("user-1", 1)).not.toEqual(projectTaskQueryKeys.tasks("user-1", 2));
    expect(projectTaskQueryKeys.mutationNotice("user-1")).toEqual(["loomhelm", "user-1", "mutation-notice"]);
  });

  test("hides cached tasks whose projects are no longer visible", () => {
    const items = [
      { id: "task-visible", project_id: "project-visible" },
      { id: "task-revoked", project_id: "project-revoked" }
    ] as Task[];
    expect(filterTasksToVisibleProjects(items, new Set(["project-visible"]))).toEqual([items[0]]);
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
    expect(result.failures[0]?.message).toContain("添加前置任务 dependency-1");
    expect(result.failures[0]?.code).toBe("unknown");
    expect(result.applied).toEqual({
      addParentIds: ["parent-1"],
      removeParentIds: ["parent-2"],
      addDependencyIds: undefined,
      removeDependencyIds: ["dependency-2"]
    });
    expect(invalidations).toEqual([projectTaskQueryKeys.tasks("user-1", 3)]);
  });

  test("preserves scoped HTTP classification for relation failures", async () => {
    const result = await syncTaskRelations({
      addTaskParent: async () => { throw new ApiClientError(403, { code: "unauthorized" }); },
      removeTaskParent: async () => undefined,
      addTaskDependency: async () => undefined,
      removeTaskDependency: async () => undefined
    }, { invalidateQueries: async () => undefined } as never, "user-1", 1, "task-1", { addParentIds: ["parent-1"] });

    expect(result.failures[0]).toMatchObject({ code: "readonly", label: "添加父任务 parent-1", status: 403 });
  });

  test("filters relationship endpoints outside the readable task projection", () => {
    const page = {
      parents: [{ parent_task_id: "visible-parent", child_task_id: "task-1" }, { parent_task_id: "denied-parent", child_task_id: "task-1" }],
      children: [{ parent_task_id: "task-1", child_task_id: "visible-child" }, { parent_task_id: "task-1", child_task_id: "denied-child" }],
      prerequisites: [{ task_id: "task-1", prerequisite_task_id: "visible-dependency" }, { task_id: "task-1", prerequisite_task_id: "denied-dependency" }],
      dependents: [{ dependent_task_id: "visible-dependent", prerequisite_task_id: "task-1" }, { dependent_task_id: "denied-dependent", prerequisite_task_id: "task-1" }]
    };

    expect(filterTaskRelationships(page, new Set(["task-1", "visible-parent", "visible-child", "visible-dependency", "visible-dependent"]))).toEqual({
      parents: [{ parent_task_id: "visible-parent", child_task_id: "task-1" }],
      children: [{ parent_task_id: "task-1", child_task_id: "visible-child" }],
      prerequisites: [{ task_id: "task-1", prerequisite_task_id: "visible-dependency" }],
      dependents: [{ dependent_task_id: "visible-dependent", prerequisite_task_id: "task-1" }]
    });
  });

  test("treats partial or denied readback as incomplete confirmation", () => {
    expect(hasIncompleteProjectTaskRead({ failures: ["relation unavailable"] })).toBe(true);
    expect(hasIncompleteProjectTaskRead({ deniedTaskIds: ["task-revoked"] })).toBe(true);
    expect(hasIncompleteProjectTaskRead({ failures: [], deniedProjectIds: [], deniedTaskIds: [] })).toBe(false);
  });

  test("requires every expected membership and relationship read", () => {
    expect(hasIncompleteProjectTaskRead({ items: { "project-1": [] }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, ["project-1", "project-2"])).toBe(true);
    expect(hasIncompleteProjectTaskRead({ items: { "project-1": [null] }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, ["project-1"])).toBe(true);
    expect(hasIncompleteProjectTaskRead({ items: [protocolTask()], relationships: {}, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, [], ["task-1"])).toBe(true);
    expect(hasIncompleteProjectTaskRead({ items: [protocolTask()], relationships: { "task-1": {} }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, [], ["task-1"])).toBe(true);
    expect(hasIncompleteProjectTaskRead({ items: [protocolTask()], relationships: { "task-1": { parents: [], children: [], prerequisites: [], dependents: [] } }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, [], ["task-1"])).toBe(false);
    expect(hasIncompleteProjectTaskRead({ items: [protocolTask()], relationships: { "task-1": { parents: [null], children: [], prerequisites: [], dependents: [] } }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, [], ["task-1"])).toBe(true);
  });

  test("requires settled successful query state before clearing a refresh barrier", () => {
    expect(isCompleteProjectTaskQuery(undefined, true)).toBe(false);
    expect(isCompleteProjectTaskQuery({ state: { status: "pending", fetchStatus: "fetching", data: [] } }, true)).toBe(false);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "fetching", data: [] } }, true)).toBe(false);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "idle", data: undefined } }, true)).toBe(false);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "idle", data: [] } }, false)).toBe(false);
    expect(isCompleteProjectTaskQuery({ state: { status: "success", fetchStatus: "idle", data: [] } }, true)).toBe(true);
  });

  test("merges cross-tab mutation notice deltas without replacing unrelated barriers", () => {
    const first = { id: "task:one", message: "one" };
    const second = { id: "task:two", message: "two" };

    expect(mergeMutationNoticeChanges([], [first], [])).toEqual([first]);
    expect(mergeMutationNoticeChanges([first], [second], [])).toEqual([first, second]);
    expect(mergeMutationNoticeChanges([first, second], [], [first.id])).toEqual([second]);
  });

  test("does not let a stale same-ID signal replace or remove a newer volatile notice", () => {
    const persisted = { id: "task:one", message: "old", kind: "in-flight" as const, lockScope: "task:one" };
    const newer = { ...persisted, message: "new", kind: "reconciliation" as const, volatile: true };

    expect(mergeMutationNoticeChanges([newer], [persisted], [])).toEqual([newer]);
    expect(mergeMutationNoticeChanges([newer], [], [persisted.id], [persisted])).toEqual([newer]);
    expect(mergeMutationNoticeChanges([newer], [], [persisted.id])).toEqual([newer]);
    expect(mergeMutationNoticeChanges([persisted], [], [persisted.id], [persisted])).toEqual([]);
    expect(mergePersistedMutationNoticeState([newer], { available: true, shared: true, notices: [] })).toEqual([newer]);
    expect(mergePersistedMutationNoticeState([newer], { available: true, shared: true, notices: [] }, [persisted])).toEqual([newer]);
    expect(mergePersistedMutationNoticeState([persisted], { available: true, shared: true, notices: [] }, [persisted])).toEqual([]);
  });

  test("changes the reconciliation token when a newer notice arrives", () => {
    const first = [{ id: "task:one", message: "one", kind: "reconciliation" as const, taskId: "task-1" }];
    const second = [...first, { id: "task:two", message: "two", kind: "reconciliation" as const, taskId: "task-1" }];

    expect(mutationNoticeContentToken(first)).not.toBe(mutationNoticeContentToken(second));
    expect(mutationNoticeContentToken([...first].reverse())).toBe(mutationNoticeContentToken(first));
  });

  test("keeps an in-memory notice when persisted state is unavailable", () => {
    const notice = { id: "task:pending", message: "pending", kind: "reconciliation" as const };

    expect(mergePersistedMutationNoticeState([notice], { available: false, shared: false, notices: [] })).toEqual([notice]);
    expect(mergePersistedMutationNoticeState([notice], { available: true, shared: true, notices: [] })).toEqual([]);
  });

  test("releases only the revision that created a refresh barrier", () => {
    const barriers = new Map<string, number>();
    const first = markMutationRefreshScopes(barriers, ["task:one"], 0);
    const second = markMutationRefreshScopes(barriers, ["task:one"], first.nextRevision);

    releaseMutationRefreshScopes(barriers, first.revisions);
    expect(barriers.get("task:one")).toBe(second.revisions.get("task:one"));
    releaseMutationRefreshScopes(barriers, second.revisions);
    expect(barriers.has("task:one")).toBe(false);
  });

  test("shares remote refresh barriers across hook instances without crossing identities", () => {
    const queryClient = new QueryClient();
    const first = getSharedMutationRefreshScopeState(queryClient, "principal-a", 3);
    const marked = markMutationRefreshScopes(first.barriers, ["task:one"], first.nextRevision);
    first.nextRevision = marked.nextRevision;
    const remounted = getSharedMutationRefreshScopeState(queryClient, "principal-a", 3);
    const otherPrincipal = getSharedMutationRefreshScopeState(queryClient, "principal-b", 3);
    const newSession = getSharedMutationRefreshScopeState(queryClient, "principal-a", 4);
    const readable = { available: true, shared: true, notices: [] };

    expect(remounted).toBe(first);
    expect(mutationWriteAdmission("task:one", [], remounted.barriers, readable)).toBe("refreshing");
    expect(mutationWriteAdmission("task:one", [], otherPrincipal.barriers, readable)).toBeUndefined();
    expect(newSession).toBe(first);
    expect(mutationWriteAdmission("task:one", [], newSession.barriers, readable)).toBe("refreshing");
    const newer = markMutationRefreshScopes(newSession.barriers, ["task:one"], newSession.nextRevision);
    newSession.nextRevision = newer.nextRevision;
    releaseMutationRefreshScopes(newSession.barriers, marked.revisions);
    expect(newSession.barriers.get("task:one")).toBe(newer.revisions.get("task:one"));
    queryClient.clear();
  });

  test("does not acknowledge an ID-less creation notice and isolates same-principal QueryClients", () => {
    expect(canAcknowledgePendingCreationNotice(undefined)).toBe(false);
    expect(canAcknowledgePendingCreationNotice({})).toBe(false);
    expect(canAcknowledgePendingCreationNotice({ projectId: "project-1" })).toBe(true);
    expect(canAcknowledgePendingCreationNotice({ taskId: "task-1" })).toBe(true);

    const firstClient = new QueryClient();
    const secondClient = new QueryClient();
    const readable = { available: true, shared: true, notices: [] };
    const first = getSharedMutationRefreshScopeState(firstClient, "principal-a", 1);
    const second = getSharedMutationRefreshScopeState(secondClient, "principal-a", 1);
    const firstMarked = markMutationRefreshScopes(first.barriers, ["task:one"], first.nextRevision);
    const secondMarked = markMutationRefreshScopes(second.barriers, ["task:one"], second.nextRevision);
    first.nextRevision = firstMarked.nextRevision;
    second.nextRevision = secondMarked.nextRevision;

    expect(first).not.toBe(second);
    expect(mutationWriteAdmission("task:one", [], first.barriers, readable)).toBe("refreshing");
    expect(mutationWriteAdmission("task:one", [], second.barriers, readable)).toBe("refreshing");
    releaseMutationRefreshScopes(first.barriers, firstMarked.revisions);
    expect(mutationWriteAdmission("task:one", [], first.barriers, readable)).toBeUndefined();
    expect(mutationWriteAdmission("task:one", [], second.barriers, readable)).toBe("refreshing");
    releaseMutationRefreshScopes(second.barriers, secondMarked.revisions);
    expect(mutationWriteAdmission("task:one", [], second.barriers, readable)).toBeUndefined();
    firstClient.clear();
    secondClient.clear();
  });

  test("cancels an in-flight query before a complete refresh read starts", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let calls = 0;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = queryClient.fetchQuery({
      queryKey: ["refresh-proof"],
      queryFn: ({ signal }) => {
        calls += 1;
        firstStarted();
        return new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          void resolve;
        });
      }
    }).catch(() => undefined);

    await firstStartedPromise;
    await queryClient.cancelQueries({ queryKey: ["refresh-proof"], exact: true });
    await expect(queryClient.fetchQuery({ queryKey: ["refresh-proof"], queryFn: async () => { calls += 1; return "after"; }, staleTime: 0, retry: false })).resolves.toBe("after");
    await first;
    expect(calls).toBe(2);
    queryClient.clear();
  });

  test("creates browser resource IDs with the server-owned shape", () => {
    const projectId = createClientResourceId("project");
    const taskId = createClientResourceId("task");

    expect(projectId).toMatch(/^project_[0-9a-f]{32}$/);
    expect(taskId).toMatch(/^task_[0-9a-f]{32}$/);
  });

  test("refreshes only scopes affected by a remote mutation notice removal", () => {
    const current = [
      { id: "task:one", message: "one", taskId: "task-1", lockScope: "task:task-1" },
      { id: "task:two", message: "two", taskId: "task-2", lockScope: "task:task-2" },
      { id: "project:create:one", message: "project", lockScope: "project:create" }
    ];

    expect(mutationNoticeRemovalScopes(current, ["task:two", "project:create:one"])).toEqual(["task:task-2", "project:create"]);
  });

  test("keeps known creation resources blocked while their shared creation scope refreshes", () => {
    const notice = {
      id: "task:create:known",
      message: "task",
      taskId: "task_0123456789abcdef0123456789abcdef",
      lockScope: "task:create"
    };

    expect(mutationNoticeRemovalScopes([notice], [notice.id])).toEqual([
      "task:create",
      "task:task_0123456789abcdef0123456789abcdef"
    ]);
    expect(mutationNoticeScopes(notice)).toEqual([
      "task:create",
      "task:task_0123456789abcdef0123456789abcdef"
    ]);
  });

  test("preserves a newer volatile notice over a stale persisted version", () => {
    const persisted = { id: "task:create:one", message: "creating", kind: "in-flight" as const, lockScope: "task:create" };
    const volatile = { ...persisted, message: "task is ready for reconciliation", kind: "reconciliation" as const, lockScope: "task:one", taskId: "task-1", volatile: true };

    expect(mergePersistedMutationNotices([volatile], [persisted])).toEqual([volatile]);
    expect(mergePersistedMutationNotices([volatile], [], false)).toEqual([]);
    expect(mergePersistedMutationNotices([], [persisted])).toEqual([persisted]);
  });

  test("keeps a known task reconciliation notice out of the shared creation barrier", () => {
    const notice = {
      id: "task:create:one",
      message: "relation result pending",
      kind: "reconciliation" as const,
      taskId: "task-1",
      lockScope: "task:task-1"
    };

    expect(mutationNoticeScopes(notice)).toEqual(["task:task-1"]);
  });

  test("keeps a narrowed known task creation visible to the recovery form", () => {
    expect(isTaskCreationNotice({
      id: "task:create:one",
      taskId: "task-1",
      lockScope: "task:task-1"
    })).toBe(true);
    expect(isTaskCreationNotice({
      id: "task:task-1:mutation:one",
      taskId: "task-1",
      lockScope: "task:task-1"
    })).toBe(false);
  });

  test("narrows only an exact known task creation after complete readback", () => {
    const known = { id: "task:create:one", message: "task", kind: "creation" as const, taskId: "task-1", lockScope: "task:create" };
    const narrowed = reconcileKnownTaskCreationNotice(known, new Set(["task-1"]));
    expect(narrowed).toMatchObject({ kind: "reconciliation", taskId: "task-1", lockScope: "task:task-1" });
    expect(mutationNoticeScopes(narrowed)).toEqual(["task:task-1"]);

    const idLess = { id: "task:create:two", message: "task", kind: "creation" as const, lockScope: "task:create" };
    expect(reconcileKnownTaskCreationNotice(idLess, new Set(["task-1"]))).toEqual(idLess);
    const mismatched = { ...known, id: "task:create:three", identityMismatch: true };
    expect(reconcileKnownTaskCreationNotice(mismatched, new Set(["task-1"]))).toEqual(mismatched);
    expect(mutationWriteAdmission("task:create", [narrowed], { has: () => false }, { available: true, shared: true, notices: [] })).toBeUndefined();
    expect(mutationWriteAdmission("task:task-1", [narrowed], { has: () => false }, { available: true, shared: true, notices: [] })).toBe("notice");
  });

  test("fails closed when shared notice storage is malformed or unreadable", () => {
    const prefix = "loomhelm.notice.";
    const malformed = {
      length: 1,
      key: () => `${prefix}bad`,
      getItem: () => "{not-json"
    } as unknown as Storage;
    const emptyTab = {
      length: 0,
      key: () => null,
      getItem: () => null
    } as unknown as Storage;
    const unreadable = {
      length: 1,
      key: () => `${prefix}unreadable`,
      getItem: () => { throw new Error("storage blocked"); }
    } as unknown as Storage;
    const notice = { id: "task:task-1", message: "still pending", kind: "reconciliation" as const, taskId: "task-1", lockScope: "task:task-1" };
    const tabOnly = {
      length: 1,
      key: () => `${prefix}task-one`,
      getItem: () => JSON.stringify(notice)
    } as unknown as Storage;

    expect(readMutationNoticesFromStorage(malformed, prefix)).toMatchObject({ available: false, notices: [] });
    expect(readMutationNoticeStateFromStorage(malformed, emptyTab, prefix)).toMatchObject({ available: false, shared: false, notices: [] });
    expect(readMutationNoticeStateFromStorage(unreadable, tabOnly, prefix)).toMatchObject({ available: false, shared: false, notices: [notice] });
    expect(mergePersistedMutationNoticeState([notice], readMutationNoticeStateFromStorage(unreadable, emptyTab, prefix))).toEqual([notice]);
  });

  test("fails closed for modern mutation notices without explicit resource metadata", () => {
    const prefix = "loomhelm.notice.";
    const ambiguous = {
      id: "task:task-known:mutation:nonce",
      message: "任务结果待确认。",
      kind: "reconciliation"
    };
    const valid = {
      id: "task:task-known:mutation:valid",
      message: "另一个结果待确认。",
      kind: "reconciliation",
      taskId: "task-known",
      lockScope: "task:task-known"
    };
    const legacyMismatch = {
      id: "task:task-a",
      message: "身份不一致。",
      kind: "reconciliation",
      taskId: "task-b",
      lockScope: "task:task-b"
    };
    const storage = {
      length: 3,
      key: (index: number) => index === 0 ? `${prefix}ambiguous` : index === 1 ? `${prefix}legacy-mismatch` : `${prefix}valid`,
      getItem: (key: string) => key.endsWith("ambiguous") ? JSON.stringify(ambiguous) : key.endsWith("legacy-mismatch") ? JSON.stringify(legacyMismatch) : JSON.stringify(valid)
    } as unknown as Storage;

    const state = readMutationNoticesFromStorage(storage, prefix);

    expect(state).toMatchObject({ available: false, notices: [valid] });
    expect(mergePersistedMutationNoticeState([valid], state)).toEqual([valid]);
    expect(mutationWriteAdmission("task:task-known", [], new Map(), state)).toBe("storage");
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

  test("treats malformed membership responses as incomplete reads", async () => {
    const result = await readProjectMemberships({ listProjectMembers: async () => ({}) }, ["project-1"]);

    expect(result.items).toEqual({});
    expect(result.failures).toEqual(["读取项目 project-1 的成员失败：项目成员响应不完整。"]);
  });

  test("treats malformed membership and relationship elements as incomplete reads", async () => {
    const membership = await readProjectMemberships({ listProjectMembers: async () => ({ items: [null] } as never) }, ["project-1"]);
    const relationship = await readTaskRelationships({ getTaskRelationships: async () => ({ parents: [null], children: [], prerequisites: [], dependents: [] } as never) }, [protocolTask()]);

    expect(membership.items).toEqual({});
    expect(membership.failures).toEqual(["读取项目 project-1 的成员失败：项目成员响应不完整。"]);
    expect(relationship.relationships).toEqual({});
    expect(relationship.failures).toEqual(["读取任务 task-1 的关系失败：任务关系响应不完整或关系端点与任务不匹配。"]);
  });

  test("rejects membership rows that belong to another project", async () => {
    const foreignMember = { created_at: "now", project_id: "project-other", role: "operator", user_id: "user-1" };
    const membership = await readProjectMemberships({ listProjectMembers: async () => ({ items: [foreignMember] }) }, ["project-1"]);

    expect(membership.items).toEqual({});
    expect(membership.failures).toEqual(["读取项目 project-1 的成员失败：项目成员响应不完整。"]);
    expect(hasIncompleteProjectTaskRead({ items: { "project-1": [foreignMember] }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, ["project-1"])).toBe(true);
  });

  test("rejects relationship kinds and endpoints that do not describe the requested task", async () => {
    const task = protocolTask();
    const validCrossProjectPage = {
      parents: [{ kind: "parent_child", parent_task_id: "parent-project-2", child_task_id: task.id, created_at: "now" }],
      children: [],
      prerequisites: [],
      dependents: []
    };
    const valid = await readTaskRelationships({ getTaskRelationships: async () => validCrossProjectPage as never }, [task]);
    expect(valid.relationships[task.id]).toEqual(validCrossProjectPage);

    const invalidPages = [
      { parents: [{ kind: "wrong", parent_task_id: "parent-1", child_task_id: task.id, created_at: "now" }] },
      { children: [{ kind: "parent_child", parent_task_id: "foreign-task", child_task_id: "child-1", created_at: "now" }] },
      { prerequisites: [{ kind: "prerequisite", prerequisite_task_id: "dependency-1", dependent_task_id: "foreign-task", created_at: "now" }] },
      { dependents: [{ kind: "prerequisite", prerequisite_task_id: "foreign-task", dependent_task_id: "dependent-1", created_at: "now" }] }
    ] as const;

    for (const partialPage of invalidPages) {
      const page = { parents: [], children: [], prerequisites: [], dependents: [], ...partialPage };
      const relationship = await readTaskRelationships({ getTaskRelationships: async () => page as never }, [task]);
      expect(relationship.relationships).toEqual({});
      expect(relationship.failures).toEqual(["读取任务 task-1 的关系失败：任务关系响应不完整或关系端点与任务不匹配。"]);
      expect(hasIncompleteProjectTaskRead({ items: [task], relationships: { [task.id]: page }, failures: [], deniedProjectIds: [], deniedTaskIds: [] }, [], [task.id])).toBe(true);
    }
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

  test("treats malformed relationship responses as incomplete reads", async () => {
    const tasks = [{ created_at: "now", goal: "one", id: "task-1", project_id: "project-1", status: "todo", title: "Task one", updated_at: "now" }] as const satisfies readonly Task[];
    const result = await readTaskRelationships({ getTaskRelationships: async () => ({ parents: [], children: [] }) }, tasks);

    expect(result.relationships).toEqual({});
    expect(result.failures).toEqual(["读取任务 task-1 的关系失败：任务关系响应不完整或关系端点与任务不匹配。"]);
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

  test("does not write through an incompletely reconciled relation endpoint", () => {
    const tasks = new Map([
      ["task-1", task("task-1")],
      ["task-2", { ...task("task-2"), relationshipsConfirmed: false }]
    ]);
    const reason = relationWriteBlockReason(
      "task-1",
      { addDependencyIds: ["task-2"] },
      (id) => tasks.get(id ?? ""),
      () => ({ role: "operator", canWrite: true, canManageProjects: false, isReadOnly: false })
    );

    expect(reason).toContain("尚未完成关系核对");
  });

  test("rejects dependency cycles in the demo relation validator", () => {
    const tasks = [task("task-a", ["task-b"]), task("task-b", ["task-c"]), task("task-c")];

    expect(wouldCreateDependencyCycle("task-c", ["task-a"], tasks)).toBe(true);
    expect(wouldCreateDependencyCycle("task-c", ["task-b"], tasks)).toBe(true);
    expect(wouldCreateDependencyCycle("task-a", ["task-c"], tasks)).toBe(false);
  });
});
