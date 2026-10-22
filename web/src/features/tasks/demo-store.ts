import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useOptionalDemoRuntime } from "@/demo/context";
import { taskStates, type DemoFixtures, type TaskState, type TaskView } from "@/demo/types";

import type {
  ProjectDraft,
  ProjectPermissionSnapshot,
  ProjectRecord,
  ProjectTaskSource,
  TaskDraft,
  TaskRecord,
  TaskUpdate,
  WriteResult
} from "./types";

interface DemoTaskStoreSnapshot {
  projects: ProjectRecord[];
  tasks: TaskRecord[];
}

const emptySnapshot: DemoTaskStoreSnapshot = { projects: [], tasks: [] };
let snapshot = emptySnapshot;
let scopeKey = "";
let seededFixtures: DemoFixtures | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function nowLabel(): string {
  return "刚刚";
}

function fromFixtures(fixtures: DemoFixtures): DemoTaskStoreSnapshot {
  const conversationCounts = new Map<string, number>();
  fixtures.conversations.forEach((conversation) => {
    if (conversation.projectId) {
      conversationCounts.set(conversation.projectId, (conversationCounts.get(conversation.projectId) ?? 0) + 1);
    }
  });

  return {
    projects: fixtures.projects.map((project) => ({
      id: project.id,
      name: project.name,
      summary: project.summary,
      updatedAt: nowLabel(),
      conversationCount: conversationCounts.get(project.id) ?? 0
    })),
    tasks: fixtures.tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] }))
  };
}

function ensureSeeded(key: string, fixtures: DemoFixtures): boolean {
  if (scopeKey === key && seededFixtures === fixtures) return false;
  const next = fromFixtures(fixtures);
  scopeKey = key;
  seededFixtures = fixtures;
  if (JSON.stringify(snapshot) === JSON.stringify(next)) return false;
  snapshot = next;
  return true;
}

function fail<T>(code: "readonly" | "blocked" | "unsupported" | "invalid", message: string): WriteResult<T> {
  return { ok: false, code, message };
}

function nextId(prefix: string, ids: readonly string[]): string {
  let index = ids.length + 1;
  while (ids.includes(`${prefix}${String(index).padStart(2, "0")}`)) index += 1;
  return `${prefix}${String(index).padStart(2, "0")}`;
}

function updateSnapshot(next: DemoTaskStoreSnapshot): void {
  snapshot = next;
  emit();
}

function canWrite(canWriteValue: boolean): WriteResult<never> | null {
  return canWriteValue ? null : fail("readonly", "当前演示身份或连接状态为只读，写入动作没有执行。");
}

function canManageProject(canManageProjects: boolean): WriteResult<never> | null {
  return canManageProjects ? null : fail("readonly", "当前身份可以操作任务，但不能管理项目或成员。");
}

function hasTask(taskId: string): boolean {
  return snapshot.tasks.some((task) => task.id === taskId);
}

function parentIdsFor(task: TaskRecord): string[] {
  return task.parentIds ?? (task.parentId ? [task.parentId] : []);
}

function wouldCreateCycle(taskId: string, parentIds: readonly string[]): boolean {
  const visit = (current: string, path: ReadonlySet<string>): boolean => {
    if (current === taskId || path.has(current)) return true;
    const parentTask = snapshot.tasks.find((task) => task.id === current);
    if (!parentTask) return false;
    const nextPath = new Set(path);
    nextPath.add(current);
    return parentIdsFor(parentTask).some((parentId) => visit(parentId, nextPath));
  };
  return parentIds.some((parentId) => visit(parentId, new Set()));
}

function createProject(draft: ProjectDraft, canManageProjects: boolean): WriteResult<ProjectRecord> {
  const blocked = canManageProject(canManageProjects);
  if (blocked) return blocked;
  const name = draft.name.trim();
  const summary = draft.summary.trim();
  if (!name || !summary) return fail("invalid", "项目名称和简介不能为空。");
  if (snapshot.projects.some((project) => project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return fail("invalid", "已有同名项目，请使用更明确的名称。");
  }
  const project: ProjectRecord = {
    id: `demo-project-${snapshot.projects.length + 1}`,
    name,
    summary,
    updatedAt: nowLabel(),
    conversationCount: 0
  };
  updateSnapshot({ ...snapshot, projects: [project, ...snapshot.projects] });
  return { ok: true, value: project };
}

function updateProject(projectId: string, draft: ProjectDraft, canManageProjects: boolean): WriteResult<ProjectRecord> {
  const blocked = canManageProject(canManageProjects);
  if (blocked) return blocked;
  const current = snapshot.projects.find((project) => project.id === projectId);
  const name = draft.name.trim();
  const summary = draft.summary.trim();
  if (!current) return fail("invalid", "项目已不存在或不在当前权限范围内。");
  if (!name || !summary) return fail("invalid", "项目名称和简介不能为空。");
  if (snapshot.projects.some((project) => project.id !== projectId && project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return fail("invalid", "已有同名项目，请使用更明确的名称。");
  }
  const project = { ...current, name, summary, updatedAt: nowLabel() };
  updateSnapshot({ ...snapshot, projects: snapshot.projects.map((item) => item.id === projectId ? project : item) });
  return { ok: true, value: project };
}

function deleteProject(projectId: string, canManageProjects: boolean): WriteResult<null> {
  const blocked = canManageProject(canManageProjects);
  if (blocked) return blocked;
  const project = snapshot.projects.find((item) => item.id === projectId);
  if (!project) return fail("invalid", "项目已不存在或不在当前权限范围内。");
  const taskCount = snapshot.tasks.filter((task) => task.projectId === projectId).length;
  if (taskCount > 0 || project.conversationCount > 0) {
    return fail("blocked", `项目仍保留 ${taskCount} 项任务或 ${project.conversationCount} 段对话，受保护删除已阻止。`);
  }
  updateSnapshot({ ...snapshot, projects: snapshot.projects.filter((item) => item.id !== projectId) });
  return { ok: true, value: null };
}

function createTask(draft: TaskDraft, writable: boolean): WriteResult<TaskRecord> {
  const blocked = canWrite(writable);
  if (blocked) return blocked;
  const title = draft.title.trim();
  const goal = draft.goal.trim();
  if (!title || !goal) return fail("invalid", "任务标题和目标说明不能为空。");
  if (!snapshot.projects.some((project) => project.id === draft.projectId)) return fail("invalid", "目标项目不在当前授权范围内。");
  const parentIds = [...new Set(draft.parentIds ?? (draft.parentId ? [draft.parentId] : []))].filter((id) => id !== "new-task");
  const parentId = parentIds[0];
  const dependsOn = [...new Set((draft.dependsOn ?? []).filter((id) => !parentIds.includes(id) && hasTask(id)))];
  if (parentIds.some((id) => !hasTask(id)) || wouldCreateCycle("new-task", parentIds)) return fail("invalid", "父任务无效，或会形成循环关系。");
  const task: TaskRecord = {
    id: nextId("DEMO-", snapshot.tasks.map((item) => item.id)),
    title,
    goal,
    projectId: draft.projectId,
    state: draft.state ?? "待办",
    execution: "未开始",
    parentId,
    parentIds,
    dependsOn,
    updated: nowLabel()
  };
  updateSnapshot({ ...snapshot, tasks: [task, ...snapshot.tasks] });
  return { ok: true, value: task };
}

function updateTask(taskId: string, update: TaskUpdate, writable: boolean): WriteResult<TaskRecord> {
  const blocked = canWrite(writable);
  if (blocked) return blocked;
  const current = snapshot.tasks.find((task) => task.id === taskId);
  if (!current) return fail("invalid", "任务已不存在或不在当前权限范围内。");
  const title = update.title?.trim() ?? current.title;
  const goal = update.goal?.trim() ?? current.goal;
  if (!title || !goal) return fail("invalid", "任务标题和目标说明不能为空。");
  const parentIds = update.parentIds === undefined
    ? update.parentId === undefined ? parentIdsFor(current) : update.parentId ? [update.parentId] : []
    : [...new Set(update.parentIds)];
  const parentId = parentIds[0];
  if (parentIds.some((id) => !hasTask(id)) || wouldCreateCycle(taskId, parentIds)) return fail("invalid", "父任务无效，或会形成循环关系。");
  const dependsOn = update.dependsOn === undefined
    ? current.dependsOn
    : [...new Set(update.dependsOn.filter((id) => id !== taskId && hasTask(id)))];
  const task: TaskRecord = { ...current, title, goal, state: update.state ?? current.state, parentId, parentIds, dependsOn, updated: nowLabel() };
  updateSnapshot({ ...snapshot, tasks: snapshot.tasks.map((item) => item.id === taskId ? task : item) });
  return { ok: true, value: task };
}

function setTaskParent(taskId: string, parentTaskId: string | undefined, writable: boolean): WriteResult<null> {
  const result = updateTask(taskId, { parentIds: parentTaskId ? [parentTaskId] : [] }, writable);
  return result.ok ? { ok: true, value: null } : result;
}

function setTaskParents(taskId: string, parentTaskIds: readonly string[], writable: boolean): WriteResult<null> {
  const result = updateTask(taskId, { parentIds: [...parentTaskIds] }, writable);
  return result.ok ? { ok: true, value: null } : result;
}

function addTaskDependency(taskId: string, prerequisiteTaskId: string, writable: boolean): WriteResult<null> {
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task) return fail("invalid", "任务已不存在或不在当前权限范围内。");
  if (task.dependsOn.includes(prerequisiteTaskId)) return { ok: true, value: null };
  const result = updateTask(taskId, { dependsOn: [...task.dependsOn, prerequisiteTaskId] }, writable);
  return result.ok ? { ok: true, value: null } : result;
}

function removeTaskDependency(taskId: string, prerequisiteTaskId: string, writable: boolean): WriteResult<null> {
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task) return fail("invalid", "任务已不存在或不在当前权限范围内。");
  if (!task.dependsOn.includes(prerequisiteTaskId)) return { ok: true, value: null };
  const result = updateTask(taskId, { dependsOn: task.dependsOn.filter((id) => id !== prerequisiteTaskId) }, writable);
  return result.ok ? { ok: true, value: null } : result;
}

function deleteTask(taskId: string, writable: boolean): WriteResult<null> {
  const blocked = canWrite(writable);
  if (blocked) return blocked;
  const task = snapshot.tasks.find((item) => item.id === taskId);
  if (!task) return fail("invalid", "任务已不存在或不在当前权限范围内。");
  if (task.conversationId || task.execution !== "未开始") {
    return fail("blocked", "任务已有对话或执行事实，受保护删除已阻止以保留历史结果。");
  }
  updateSnapshot({
    ...snapshot,
    tasks: snapshot.tasks
      .filter((item) => item.id !== taskId)
      .map((item) => ({
        ...item,
        parentId: item.parentId === taskId ? undefined : item.parentId,
        parentIds: parentIdsFor(item).filter((id) => id !== taskId),
        dependsOn: item.dependsOn.filter((id) => id !== taskId)
      }))
  });
  return { ok: true, value: null };
}

function sourceStatus(scene: string): ProjectTaskSource["status"] {
  if (scene === "loading") return "loading";
  if (scene === "error") return "error";
  if (scene === "permission-changed") return "permission-changed";
  return "ready";
}

export function useOptionalDemoProjectTaskSource(): ProjectTaskSource | null {
  const runtime = useOptionalDemoRuntime();
  const key = runtime ? `${runtime.scene}:${runtime.persona}:${runtime.dataMode}` : "none";

  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    if (runtime && ensureSeeded(key, runtime.fixtures)) emit();
  }, [key, runtime]);

  return useMemo(() => {
    if (!runtime) return null;
    const getProject = (projectId: string | undefined) => current.projects.find((project) => project.id === projectId);
    const getTask = (taskId: string | undefined) => current.tasks.find((task) => task.id === taskId);
    const getTasksForScope = (projectId?: string) => {
      if (!projectId) return current.tasks;
      const local = current.tasks.filter((task) => task.projectId === projectId);
      const related = new Set(local.flatMap((task) => [...parentIdsFor(task), ...task.dependsOn]));
      return current.tasks.filter((task) => task.projectId === projectId || related.has(task.id));
    };
    const getProjectPermissions = (_projectId: string | undefined): ProjectPermissionSnapshot => ({
      role: runtime.persona,
      canWrite: runtime.canWrite,
      canManageProjects: runtime.canManageProjects,
      isReadOnly: runtime.isReadOnly
    });
    return {
      projects: current.projects,
      tasks: current.tasks,
      status: sourceStatus(runtime.scene),
      notice: runtime.scene === "permission-changed" ? "权限范围已变化；关系只保留当前仍可见的任务。" : undefined,
      canCreateProjects: runtime.canManageProjects,
      getProjectPermissions,
      getProject,
      getTask,
      getTasksForScope,
      getTaskView: (scope: string) => runtime.taskViews[scope] ?? "list",
      setTaskView: runtime.setTaskView,
      createProject: async (draft: ProjectDraft) => createProject(draft, runtime.canManageProjects),
      updateProject: async (projectId: string, draft: ProjectDraft) => updateProject(projectId, draft, runtime.canManageProjects),
      deleteProject: async (projectId: string) => deleteProject(projectId, runtime.canManageProjects),
      createTask: async (draft: TaskDraft) => createTask(draft, runtime.canWrite),
      updateTask: async (taskId: string, update: TaskUpdate) => updateTask(taskId, update, runtime.canWrite),
      deleteTask: async (taskId: string) => deleteTask(taskId, runtime.canWrite),
      setTaskParent: async (taskId: string, parentTaskId?: string) => setTaskParent(taskId, parentTaskId, runtime.canWrite),
      setTaskParents: async (taskId: string, parentTaskIds: readonly string[]) => setTaskParents(taskId, parentTaskIds, runtime.canWrite),
      addTaskDependency: async (taskId: string, prerequisiteTaskId: string) => addTaskDependency(taskId, prerequisiteTaskId, runtime.canWrite),
      removeTaskDependency: async (taskId: string, prerequisiteTaskId: string) => removeTaskDependency(taskId, prerequisiteTaskId, runtime.canWrite)
    } satisfies ProjectTaskSource;
  }, [current, runtime]);
}
