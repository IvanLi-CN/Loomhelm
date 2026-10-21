import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiClientConfigurationError, ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Project, ProjectMember, Task, TaskRelationshipPage, TaskStatus } from "@loomhelm/protocol";

import type { TaskState, TaskView } from "@/demo/types";
import type {
  ProjectDraft,
  ProjectPermissionSnapshot,
  ProjectTaskSource,
  TaskDraft,
  TaskRecord,
  TaskUpdate,
  WriteResult
} from "@/features/tasks/types";

import { createPublishedProjectTaskApi, mapProject, mapTask, permissionsForProjectMember, type ProjectMemberPermissions, type PublishedProjectTaskApi } from "./api";

export interface ProductionSourceOptions {
  client?: GeneratedApiClient;
  enabled?: boolean;
  canCreateProjects: boolean;
  principalId?: string;
  taskViews?: Record<string, TaskView>;
  setTaskView?: (scope: string, view: TaskView) => void;
}

interface TaskQueryData {
  items: readonly Task[];
  relationships: Readonly<Record<string, TaskRelationshipPage>>;
}

export const PROJECT_PAGE_LIMIT = 100;
export const TASK_PAGE_LIMIT = 200;

interface CursorPage<Item> {
  has_more: boolean;
  items: readonly Item[];
  next_cursor?: string;
}

export async function readAllCursorPages<Item>(
  resource: string,
  readPage: (afterCursor?: string) => Promise<CursorPage<Item>>,
  limit: number
): Promise<readonly Item[]> {
  if (limit <= 0) throw new Error(`${resource} pagination limit must be positive.`);
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let afterCursor: string | undefined;

  for (;;) {
    const page = await readPage(afterCursor);
    items.push(...page.items);
    if (!page.has_more) return items;
    const nextCursor = page.next_cursor;
    if (!nextCursor || nextCursor.trim().length === 0 || seenCursors.has(nextCursor)) {
      throw new Error(`${resource} pagination did not return a new cursor for the next page.`);
    }
    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }
}

export function listAllProjects(api: Pick<PublishedProjectTaskApi, "listProjects">): Promise<readonly Project[]> {
  return readAllCursorPages("projects", (after_cursor) => api.listProjects({ after_cursor, limit: PROJECT_PAGE_LIMIT }), PROJECT_PAGE_LIMIT);
}

export function listAllTasks(api: Pick<PublishedProjectTaskApi, "listTasks">): Promise<readonly Task[]> {
  return readAllCursorPages("tasks", (after_cursor) => api.listTasks({ after_cursor, limit: TASK_PAGE_LIMIT }), TASK_PAGE_LIMIT);
}

interface DesiredRelations {
  parentSpecified: boolean;
  parentTaskId?: string;
  dependenciesSpecified: boolean;
  dependsOn?: readonly string[];
}

export const projectTaskQueryKeys = {
  projects: (principalId: string) => ["loomhelm", principalId, "projects"] as const,
  memberships: (principalId: string, projectIds: readonly string[]) => ["loomhelm", principalId, "memberships", [...projectIds].sort()] as const,
  tasks: (principalId: string) => ["loomhelm", principalId, "tasks", "all"] as const,
  taskRelationships: (principalId: string, taskId: string) => ["loomhelm", principalId, "tasks", "relationships", taskId] as const
};

export function isProjectTaskQueryForPrincipal(query: { queryKey: readonly unknown[] }, principalId: string): boolean {
  return query.queryKey[0] === "loomhelm" && query.queryKey[1] === principalId;
}

const emptyProjectPermissions: ProjectPermissionSnapshot = {
  role: null,
  canWrite: false,
  canManageProjects: false,
  isReadOnly: true
};

function denied<T>(message = "当前身份或权限为只读，写入动作没有执行。"): Promise<WriteResult<T>> {
  return Promise.resolve({ ok: false, code: "readonly", message });
}

function success<T>(value: T): WriteResult<T> {
  return { ok: true, value };
}

function bodyMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (typeof record.details === "string") return record.details;
  if (record.details && typeof record.details === "object") return JSON.stringify(record.details);
  return undefined;
}

function failure<T>(operation: string, error: unknown): WriteResult<T> {
  if (error instanceof ApiClientConfigurationError) {
    return { ok: false, code: "csrf", message: `${operation}失败：${error.message}` };
  }
  if (error instanceof ApiClientError) {
    const code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "readonly" : error.status === 409 ? "blocked" : "invalid";
    const detail = bodyMessage(error.body);
    return {
      ok: false,
      code,
      message: detail ? `${operation}失败：${detail}` : `${operation}失败（HTTP ${error.status}）。`,
      status: error.status,
      body: error.body
    };
  }
  return { ok: false, code: "invalid", message: error instanceof Error ? `${operation}失败：${error.message}` : `${operation}失败。` };
}

function isPermissionError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  const body = error.body;
  return Boolean(body && typeof body === "object" && "code" in body && (body as { code?: unknown }).code === "unauthorized");
}

function taskStatus(state: TaskState | undefined): TaskStatus | undefined {
  if (!state) return undefined;
  return state === "待办" ? "todo" : state === "进行中" ? "in_progress" : state === "阻塞" ? "blocked" : state === "完成" ? "done" : "cancelled";
}

async function syncTaskRelations(
  api: ReturnType<typeof createPublishedProjectTaskApi>,
  queryClient: ReturnType<typeof useQueryClient>,
  principalId: string,
  relationshipsByTaskId: Readonly<Record<string, TaskRelationshipPage>>,
  taskId: string,
  desired: DesiredRelations
): Promise<void> {
  const current = relationshipsByTaskId[taskId] ?? await api.getTaskRelationships({ task_id: taskId });
  const currentParents = current.parents.map((relationship) => relationship.parent_task_id);
  const currentDependencies = current.prerequisites.map((relationship) => relationship.prerequisite_task_id);
  const writes: Promise<void>[] = [];

  if (desired.parentSpecified) {
    writes.push(...currentParents.filter((parentId) => parentId !== desired.parentTaskId).map((parentTaskId) => api.removeTaskParent({ task_id: taskId, parent_task_id: parentTaskId })));
    if (desired.parentTaskId && !currentParents.includes(desired.parentTaskId)) {
      writes.push(api.addTaskParent({ task_id: taskId, parent_task_id: desired.parentTaskId }));
    }
  }

  if (desired.dependenciesSpecified) {
    const nextDependencies = [...new Set(desired.dependsOn ?? [])];
    writes.push(...currentDependencies.filter((dependencyId) => !nextDependencies.includes(dependencyId)).map((prerequisiteTaskId) => api.removeTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId })));
    writes.push(...nextDependencies.filter((dependencyId) => !currentDependencies.includes(dependencyId)).map((prerequisiteTaskId) => api.addTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId })));
  }

  await Promise.all(writes);
  await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(principalId) });
}

export function usePublishedProjectTaskSource({ client, enabled = true, canCreateProjects, principalId, taskViews = {}, setTaskView }: ProductionSourceOptions): ProjectTaskSource {
  const api = useMemo(() => createPublishedProjectTaskApi(client), [client]);
  const queryClient = useQueryClient();
  const subjectId = principalId ?? "anonymous";
  const [accessRevoked, setAccessRevoked] = useState(false);
  const revokedPrincipalRef = useRef<string | undefined>(undefined);
  const queryEnabled = enabled && Boolean(principalId) && !accessRevoked;
  const projectsQuery = useQuery({
    queryKey: projectTaskQueryKeys.projects(subjectId),
    queryFn: () => listAllProjects(api),
    enabled: queryEnabled
  });
  const projectPermissionError = isPermissionError(projectsQuery.error);
  const projectIds = useMemo(() => [...new Set(projectsQuery.data?.map((project) => project.id) ?? [])].sort(), [projectsQuery.data]);
  const membershipsQuery = useQuery<Readonly<Record<string, readonly ProjectMember[]>>>({
    queryKey: projectTaskQueryKeys.memberships(subjectId, projectIds),
    queryFn: async () => {
      const entries = await Promise.all(projectIds.map(async (projectId) => {
        const response = await api.listProjectMembers({ project_id: projectId });
        return [projectId, response.items] as const;
      }));
      return Object.fromEntries(entries);
    },
    enabled: queryEnabled && projectsQuery.isSuccess && !projectPermissionError
  });
  const membershipPermissionError = isPermissionError(membershipsQuery.error);
  const tasksQuery = useQuery<TaskQueryData>({
    queryKey: projectTaskQueryKeys.tasks(subjectId),
    queryFn: async () => {
      // Fetch the authorized global set so project views can retain visible cross-project relation nodes.
      const items = await listAllTasks(api);
      const entries = await Promise.all(items.map(async (task) => [task.id, await api.getTaskRelationships({ task_id: task.id })] as const));
      return {
        items,
        relationships: Object.fromEntries(entries)
      };
    },
    enabled: queryEnabled && projectsQuery.isSuccess && membershipsQuery.isSuccess && !projectPermissionError && !membershipPermissionError
  });
  const taskPermissionError = isPermissionError(tasksQuery.error);
  const permissionChanged = projectPermissionError || membershipPermissionError || taskPermissionError;
  const revokeSubjectAccess = useCallback(() => {
    if (!principalId || revokedPrincipalRef.current === principalId) return;
    revokedPrincipalRef.current = principalId;
    setAccessRevoked(true);
    void queryClient.cancelQueries({ predicate: (query) => isProjectTaskQueryForPrincipal(query, principalId) }).then(() => {
      queryClient.removeQueries({ predicate: (query) => isProjectTaskQueryForPrincipal(query, principalId) });
    });
  }, [principalId, queryClient]);

  useEffect(() => {
    if (!enabled || !principalId) {
      revokedPrincipalRef.current = undefined;
      setAccessRevoked(false);
      return;
    }
    if (permissionChanged) revokeSubjectAccess();
  }, [enabled, permissionChanged, principalId, revokeSubjectAccess]);

  const handleFailure = useCallback(<T,>(operation: string, error: unknown): WriteResult<T> => {
    if (isPermissionError(error)) revokeSubjectAccess();
    return failure<T>(operation, error);
  }, [revokeSubjectAccess]);

  const createProjectMutation = useMutation({
    mutationFn: (draft: ProjectDraft) => api.createProject({ body: { name: draft.name.trim(), description: draft.summary.trim() || undefined } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId) })
  });
  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId: targetProjectId, draft }: { projectId: string; draft: ProjectDraft }) => api.updateProject({ project_id: targetProjectId, body: { name: draft.name.trim() || undefined, description: draft.summary.trim() || undefined } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId) })
  });
  const deleteProjectMutation = useMutation({
    mutationFn: (targetProjectId: string) => api.deleteProject({ project_id: targetProjectId }),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId) }),
      queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId) })
    ])
  });
  const createTaskMutation = useMutation({
    mutationFn: (draft: TaskDraft) => api.createTask({ body: { title: draft.title.trim(), goal: draft.goal.trim(), project_id: draft.projectId, status: taskStatus(draft.state) } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId) })
  });
  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, update }: { taskId: string; update: TaskUpdate }) => api.updateTask({ task_id: taskId, body: { title: update.title, goal: update.goal, status: taskStatus(update.state) } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId) })
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask({ task_id: taskId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId) })
  });

  const projects = useMemo(() => accessRevoked || permissionChanged ? [] : projectsQuery.data?.map(mapProject) ?? [], [accessRevoked, permissionChanged, projectsQuery.data]);
  const relationshipsByTaskId = tasksQuery.data?.relationships ?? {};
  const tasks = useMemo(() => accessRevoked || permissionChanged ? [] : tasksQuery.data?.items.map((task) => mapTask(task, relationshipsByTaskId[task.id])) ?? [], [accessRevoked, permissionChanged, relationshipsByTaskId, tasksQuery.data?.items]);
  const getProject = useMemo(() => (id: string | undefined) => projects.find((project) => project.id === id), [projects]);
  const getTask = useMemo(() => (id: string | undefined) => tasks.find((task) => task.id === id), [tasks]);
  const getProjectPermissions = useMemo(() => (projectId: string | undefined): ProjectMemberPermissions => {
    if (!projectId || accessRevoked || permissionChanged || !membershipsQuery.data) return emptyProjectPermissions;
    return permissionsForProjectMember(membershipsQuery.data[projectId] ?? [], principalId);
  }, [accessRevoked, membershipsQuery.data, permissionChanged, principalId]);
  const queryPending = projectsQuery.isPending || membershipsQuery.isPending || tasksQuery.isPending;
  const queryError = projectsQuery.isError || membershipsQuery.isError || tasksQuery.isError;

  return useMemo(() => {
    const getTasksForScope = (targetProjectId?: string) => {
      if (!targetProjectId) return tasks;
      const local = tasks.filter((task) => task.projectId === targetProjectId);
      const related = new Set(local.flatMap((task) => {
        const relationships = relationshipsByTaskId[task.id];
        return [
          ...relationships?.parents.map((relationship) => relationship.parent_task_id) ?? [],
          ...relationships?.children.map((relationship) => relationship.child_task_id) ?? [],
          ...relationships?.prerequisites.map((relationship) => relationship.prerequisite_task_id) ?? [],
          ...relationships?.dependents.map((relationship) => relationship.dependent_task_id) ?? []
        ];
      }));
      return tasks.filter((task) => task.projectId === targetProjectId || related.has(task.id));
    };

    const createProject = (draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => canCreateProjects
      ? createProjectMutation.mutateAsync(draft).then((response) => success(mapProject(response.project))).catch((error: unknown) => handleFailure("创建项目", error))
      : denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
    const updateProject = (targetProjectId: string, draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => getProjectPermissions(targetProjectId).canManageProjects
      ? updateProjectMutation.mutateAsync({ projectId: targetProjectId, draft }).then((response) => success(mapProject(response.project))).catch((error: unknown) => handleFailure("更新项目", error))
      : denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
    const deleteProject = (targetProjectId: string): Promise<WriteResult<null>> => getProjectPermissions(targetProjectId).canManageProjects
      ? deleteProjectMutation.mutateAsync(targetProjectId).then(() => success(null)).catch((error: unknown) => handleFailure("删除项目", error))
      : denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
    const createTask = async (draft: TaskDraft): Promise<WriteResult<TaskRecord>> => {
      if (!getProjectPermissions(draft.projectId).canWrite) return denied();
      try {
        const response = await createTaskMutation.mutateAsync(draft);
        await syncTaskRelations(api, queryClient, subjectId, relationshipsByTaskId, response.task.id, {
          parentSpecified: true,
          parentTaskId: draft.parentId,
          dependenciesSpecified: true,
          dependsOn: draft.dependsOn ?? []
        });
        return { ok: true, value: { ...mapTask(response.task), parentId: draft.parentId, dependsOn: [...new Set(draft.dependsOn ?? [])] } };
      } catch (error) {
        return handleFailure("创建任务", error);
      }
    };
    const updateTask = async (taskId: string, update: TaskUpdate): Promise<WriteResult<TaskRecord>> => {
      const taskProjectId = getTask(taskId)?.projectId;
      if (!getProjectPermissions(taskProjectId).canWrite) return denied();
      try {
        const response = await updateTaskMutation.mutateAsync({ taskId, update });
        if (update.parentId !== undefined || update.dependsOn !== undefined) {
          await syncTaskRelations(api, queryClient, subjectId, relationshipsByTaskId, taskId, {
            parentSpecified: update.parentId !== undefined,
            parentTaskId: update.parentId || undefined,
            dependenciesSpecified: update.dependsOn !== undefined,
            dependsOn: update.dependsOn
          });
        }
        const current = mapTask(response.task, relationshipsByTaskId[taskId]);
        return {
          ok: true,
          value: {
            ...current,
            ...(update.parentId !== undefined ? { parentId: update.parentId || undefined } : {}),
            ...(update.dependsOn !== undefined ? { dependsOn: [...new Set(update.dependsOn)] } : {})
          }
        };
      } catch (error) {
        return handleFailure("更新任务", error);
      }
    };
    const deleteTask = (taskId: string): Promise<WriteResult<null>> => getProjectPermissions(getTask(taskId)?.projectId).canWrite
      ? deleteTaskMutation.mutateAsync(taskId).then(() => success(null)).catch((error: unknown) => handleFailure("删除任务", error))
      : denied();
    const setTaskParent = (taskId: string, parentTaskId?: string): Promise<WriteResult<null>> => getProjectPermissions(getTask(taskId)?.projectId).canWrite
      ? syncTaskRelations(api, queryClient, subjectId, relationshipsByTaskId, taskId, { parentSpecified: true, parentTaskId, dependenciesSpecified: false }).then(() => success(null)).catch((error: unknown) => handleFailure("更新父任务", error))
      : denied();
    const addTaskDependency = (taskId: string, prerequisiteTaskId: string): Promise<WriteResult<null>> => getProjectPermissions(getTask(taskId)?.projectId).canWrite
      ? api.addTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }).then(async () => { await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId) }); return success(null); }).catch((error: unknown) => handleFailure("添加前置任务", error))
      : denied();
    const removeTaskDependency = (taskId: string, prerequisiteTaskId: string): Promise<WriteResult<null>> => getProjectPermissions(getTask(taskId)?.projectId).canWrite
      ? api.removeTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }).then(async () => { await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId) }); return success(null); }).catch((error: unknown) => handleFailure("移除前置任务", error))
      : denied();

    return {
      projects,
      tasks,
      status: !enabled || !principalId ? "unauthenticated" : accessRevoked || permissionChanged ? "permission-changed" : queryPending ? "loading" : queryError ? "error" : "ready",
      canCreateProjects,
      getProjectPermissions,
      getProject,
      getTask,
      getTasksForScope,
      getTaskView: (scope: string) => taskViews[scope] ?? "list",
      setTaskView: (scope: string, view: TaskView) => setTaskView?.(scope, view),
      createProject,
      updateProject,
      deleteProject,
      createTask,
      updateTask,
      deleteTask,
      setTaskParent,
      addTaskDependency,
      removeTaskDependency,
      notice: !enabled || !principalId ? "当前认证装配尚未就绪，页面不会请求受保护数据。" : accessRevoked || permissionChanged ? "登录状态或项目权限发生变化；当前主体的受保护数据已清除，请重新验证后刷新。" : queryError ? "项目、成员、任务或关系读取失败；页面保持 fail-closed。" : undefined
    } satisfies ProjectTaskSource;
  }, [accessRevoked, api, canCreateProjects, createProjectMutation, createTaskMutation, deleteProjectMutation, deleteTaskMutation, enabled, getProject, getProjectPermissions, getTask, handleFailure, permissionChanged, principalId, projects, queryError, queryPending, queryClient, relationshipsByTaskId, setTaskView, subjectId, taskViews, tasks, updateProjectMutation, updateTaskMutation]);
}
