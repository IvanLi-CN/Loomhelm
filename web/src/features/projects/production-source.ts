import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiClientConfigurationError, ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Project, ProjectMember, Task, TaskRelationshipPage, TaskStatus, UpdateProjectRequest, UpdateTaskRequest } from "@loomhelm/protocol";

import type { TaskState, TaskView } from "@/demo/types";
import type {
  ProjectDraft,
  ProjectPermissionSnapshot,
  ProjectRecord,
  ProjectTaskSource,
  TaskDraft,
  TaskRelationChanges,
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
  sessionGeneration?: number;
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

export const projectTaskQueryKeys = {
  projects: (principalId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "projects"] as const,
  memberships: (principalId: string, projectIds: readonly string[], sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "memberships", [...projectIds].sort()] as const,
  tasks: (principalId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "tasks", "all"] as const,
  taskRelationships: (principalId: string, taskId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "tasks", "relationships", taskId] as const,
  mutationNotice: (principalId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "mutation-notice"] as const
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

function success<T>(value: T, warning?: string): WriteResult<T> {
  return warning ? { ok: true, value, warning } : { ok: true, value };
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

export function isAmbiguousWriteError(error: unknown): boolean {
  if (error instanceof ApiClientConfigurationError) return false;
  if (error instanceof ApiClientError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return true;
}

function ambiguousFailure<T>(operation: string, error: unknown): WriteResult<T> {
  const detail = error instanceof ApiClientError ? bodyMessage(error.body) : error instanceof Error ? error.message : undefined;
  return {
    ok: false,
    code: "unknown",
    reconcile: true,
    message: operation + "结果待确认" + (detail ? "：" + detail : "") + "。请先到列表核对结果，不会自动重试。",
    status: error instanceof ApiClientError ? error.status : undefined,
    body: error instanceof ApiClientError ? error.body : undefined
  };
}

function failureMessage(operation: string, error: unknown): string {
  const result = failure<never>(operation, error);
  return result.ok ? `${operation}失败。` : result.message;
}

export function isPermissionError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 404) return true;
  const body = error.body;
  return Boolean(body && typeof body === "object" && "code" in body && (body as { code?: unknown }).code === "unauthorized");
}

function taskStatus(state: TaskState | undefined): TaskStatus | undefined {
  if (!state) return undefined;
  return state === "待办" ? "todo" : state === "进行中" ? "in_progress" : state === "阻塞" ? "blocked" : state === "完成" ? "done" : "cancelled";
}

export function toTaskUpdateRequest(update: TaskUpdate): UpdateTaskRequest {
  const body: UpdateTaskRequest = {};
  if (update.title !== undefined) body.title = update.title.trim();
  if (update.goal !== undefined) body.goal = update.goal.trim();
  if (update.state !== undefined) body.status = taskStatus(update.state);
  return body;
}

export function toProjectUpdateRequest(current: ProjectRecord | undefined, draft: ProjectDraft): UpdateProjectRequest {
  const body: UpdateProjectRequest = {};
  const name = draft.name.trim();
  const description = draft.summary.trim();
  if (!current || name !== current.name) body.name = name;
  const currentDescription = current?.description ?? (current?.summary === "暂无项目简介" ? "" : current?.summary ?? "");
  if (!current || description !== currentDescription) body.description = description;
  return body;
}

export interface RelationSyncResult {
  failures: readonly string[];
}

export async function syncTaskRelations(
  api: Pick<PublishedProjectTaskApi, "addTaskParent" | "removeTaskParent" | "addTaskDependency" | "removeTaskDependency">,
  queryClient: ReturnType<typeof useQueryClient>,
  principalId: string,
  sessionGeneration: number,
  taskId: string,
  changes: TaskRelationChanges
): Promise<RelationSyncResult> {
  const writes: Array<{ label: string; run: () => Promise<void> }> = [];
  const addParentIds = [...new Set(changes.addParentIds ?? [])].filter((id) => id !== taskId);
  const removeParentIds = [...new Set(changes.removeParentIds ?? [])].filter((id) => id !== taskId);
  const addDependencyIds = [...new Set(changes.addDependencyIds ?? [])].filter((id) => id !== taskId);
  const removeDependencyIds = [...new Set(changes.removeDependencyIds ?? [])].filter((id) => id !== taskId);
  writes.push(...addParentIds.map((parentTaskId) => ({ label: "添加父任务 " + parentTaskId, run: () => api.addTaskParent({ task_id: taskId, parent_task_id: parentTaskId }) })));
  writes.push(...removeParentIds.map((parentTaskId) => ({ label: "移除父任务 " + parentTaskId, run: () => api.removeTaskParent({ task_id: taskId, parent_task_id: parentTaskId }) })));
  writes.push(...addDependencyIds.map((prerequisiteTaskId) => ({ label: "添加前置任务 " + prerequisiteTaskId, run: () => api.addTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }) })));
  writes.push(...removeDependencyIds.map((prerequisiteTaskId) => ({ label: "移除前置任务 " + prerequisiteTaskId, run: () => api.removeTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }) })));

  const results = await Promise.allSettled(writes.map((write) => write.run()));
  await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(principalId, sessionGeneration) });
  return {
    failures: results.flatMap((result, index) => result.status === "rejected" ? [failureMessage(writes[index].label, result.reason)] : [])
  };
}

const PROJECT_TASK_REFRESH_INTERVAL_MS = 30_000;

export function usePublishedProjectTaskSource({ client, enabled = true, canCreateProjects, principalId, sessionGeneration = 0, taskViews = {}, setTaskView }: ProductionSourceOptions): ProjectTaskSource {
  const api = useMemo(() => createPublishedProjectTaskApi(client), [client]);
  const queryClient = useQueryClient();
  const subjectId = principalId ?? "anonymous";
  const queryEnabled = enabled && Boolean(principalId);
  const projectsQuery = useQuery({
    queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration),
    queryFn: () => listAllProjects(api),
    enabled: queryEnabled,
    refetchInterval: PROJECT_TASK_REFRESH_INTERVAL_MS
  });
  const projectIds = useMemo(() => [...new Set(projectsQuery.isSuccess ? projectsQuery.data.map((project) => project.id) : [])].sort(), [projectsQuery.data, projectsQuery.isSuccess]);
  const membershipsQuery = useQuery<Readonly<Record<string, readonly ProjectMember[]>>>({
    queryKey: projectTaskQueryKeys.memberships(subjectId, projectIds, sessionGeneration),
    queryFn: async () => {
      const entries = await Promise.all(projectIds.map(async (projectId) => {
        const response = await api.listProjectMembers({ project_id: projectId });
        return [projectId, response.items] as const;
      }));
      return Object.fromEntries(entries);
    },
    enabled: queryEnabled && projectsQuery.isSuccess,
    refetchInterval: PROJECT_TASK_REFRESH_INTERVAL_MS
  });
  const tasksQuery = useQuery<TaskQueryData>({
    queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration),
    queryFn: async () => {
      // Fetch the authorized global set so project views can retain visible cross-project relation nodes.
      const items = await listAllTasks(api);
      const entries = await Promise.all(items.map(async (task) => [task.id, await api.getTaskRelationships({ task_id: task.id })] as const));
      return {
        items,
        relationships: Object.fromEntries(entries)
      };
    },
    enabled: queryEnabled && projectsQuery.isSuccess && membershipsQuery.isSuccess,
    refetchInterval: PROJECT_TASK_REFRESH_INTERVAL_MS
  });

  const mutationNoticeKey = projectTaskQueryKeys.mutationNotice(subjectId, sessionGeneration);
  const mutationNoticeQuery = useQuery<string | null>({
    queryKey: mutationNoticeKey,
    queryFn: async () => null,
    enabled: queryEnabled,
    staleTime: Infinity,
    gcTime: Infinity
  });
  const recordMutationNotice = useCallback((message: string) => {
    queryClient.setQueryData(mutationNoticeKey, message);
  }, [mutationNoticeKey, queryClient]);
  const clearMutationNotice = useCallback(() => {
    queryClient.setQueryData(mutationNoticeKey, null);
  }, [mutationNoticeKey, queryClient]);

  const handleFailure = useCallback(<T,>(operation: string, error: unknown): WriteResult<T> => failure<T>(operation, error), []);

  const createProjectMutation = useMutation({
    mutationFn: (draft: ProjectDraft) => api.createProject({ body: { name: draft.name.trim(), description: draft.summary.trim() || undefined } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration) })
  });
  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId: targetProjectId, draft, current }: { projectId: string; draft: ProjectDraft; current?: ProjectRecord }) => api.updateProject({ project_id: targetProjectId, body: toProjectUpdateRequest(current, draft) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration) })
  });
  const deleteProjectMutation = useMutation({
    mutationFn: (targetProjectId: string) => api.deleteProject({ project_id: targetProjectId }),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration) }),
      queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
    ])
  });
  const createTaskMutation = useMutation({
    mutationFn: (draft: TaskDraft) => api.createTask({ body: { title: draft.title.trim(), goal: draft.goal.trim(), project_id: draft.projectId, status: taskStatus(draft.state) } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
  });
  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, update }: { taskId: string; update: TaskUpdate }) => api.updateTask({ task_id: taskId, body: toTaskUpdateRequest(update) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask({ task_id: taskId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
  });

  const projects = useMemo(() => projectsQuery.isSuccess ? projectsQuery.data.map(mapProject) : [], [projectsQuery.data, projectsQuery.isSuccess]);
  const relationshipsByTaskId = tasksQuery.isSuccess ? tasksQuery.data.relationships : {};
  const tasks = useMemo(() => tasksQuery.isSuccess ? tasksQuery.data.items.map((task) => mapTask(task, relationshipsByTaskId[task.id])) : [], [relationshipsByTaskId, tasksQuery.data, tasksQuery.isSuccess]);
  const getProject = useMemo(() => (id: string | undefined) => projects.find((project) => project.id === id), [projects]);
  const getTask = useMemo(() => (id: string | undefined) => tasks.find((task) => task.id === id), [tasks]);
  const getProjectPermissions = useMemo(() => (projectId: string | undefined): ProjectMemberPermissions => {
    if (!projectId || !membershipsQuery.isSuccess) return emptyProjectPermissions;
    return permissionsForProjectMember(membershipsQuery.data[projectId] ?? [], principalId);
  }, [membershipsQuery.data, membershipsQuery.isSuccess, principalId]);
  const queryPending = projectsQuery.isPending
    || (projectsQuery.isSuccess && membershipsQuery.isPending)
    || (membershipsQuery.isSuccess && tasksQuery.isPending);
  const queryError = projectsQuery.isError || membershipsQuery.isError || tasksQuery.isError;
  const projectWriteReady = projectsQuery.isSuccess && membershipsQuery.isSuccess && !projectsQuery.isError && !membershipsQuery.isError;

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

    const createProject = async (draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => {
      if (!canCreateProjects || !projectWriteReady) return denied("当前身份或连接状态不能确认项目写入范围，项目写入没有执行。");
      try {
        const response = await createProjectMutation.mutateAsync(draft);
        clearMutationNotice();
        return success(mapProject(response.project));
      } catch (error) {
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<ReturnType<typeof mapProject>>("创建项目", error) : handleFailure<ReturnType<typeof mapProject>>("创建项目", error);
        if (!result.ok && result.reconcile) recordMutationNotice(result.message);
        return result;
      }
    };
    const updateProject = async (targetProjectId: string, draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => {
      if (!getProjectPermissions(targetProjectId).canManageProjects) return denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
      const current = getProject(targetProjectId);
      const body = toProjectUpdateRequest(current, draft);
      if (!Object.keys(body).length && current) return success(current);
      try {
        const response = await updateProjectMutation.mutateAsync({ projectId: targetProjectId, draft, current });
        clearMutationNotice();
        return success(mapProject(response.project));
      } catch (error) {
        return handleFailure("更新项目", error);
      }
    };
    const deleteProject = (targetProjectId: string): Promise<WriteResult<null>> => getProjectPermissions(targetProjectId).canManageProjects
      ? deleteProjectMutation.mutateAsync(targetProjectId).then(() => success(null)).catch((error: unknown) => handleFailure("删除项目", error))
      : denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
    const createTask = async (draft: TaskDraft): Promise<WriteResult<TaskRecord>> => {
      if (!getProjectPermissions(draft.projectId).canWrite) return denied();
      try {
        const response = await createTaskMutation.mutateAsync(draft);
        const parentIds = [...new Set(draft.parentIds ?? (draft.parentId ? [draft.parentId] : []))];
        const dependencyIds = [...new Set(draft.dependsOn ?? [])];
        const relationChanges: TaskRelationChanges = {
          addParentIds: parentIds,
          addDependencyIds: dependencyIds
        };
        const relationResult = parentIds.length || dependencyIds.length
          ? await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, response.task.id, relationChanges)
          : { failures: [] };
        const value = mapTask(response.task);
        if (relationResult.failures.length) {
          const warning = "任务已创建，但部分关系未保存：" + relationResult.failures.join("；") + "。请刷新后核对。";
          recordMutationNotice(warning);
          return success(value, warning);
        }
        clearMutationNotice();
        return success(value);
      } catch (error) {
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<TaskRecord>("创建任务", error) : handleFailure<TaskRecord>("创建任务", error);
        if (!result.ok && result.reconcile) recordMutationNotice(result.message);
        return result;
      }
    };
    const updateTask = async (taskId: string, update: TaskUpdate): Promise<WriteResult<TaskRecord>> => {
      const existingTask = getTask(taskId);
      const taskProjectId = existingTask?.projectId;
      if (!getProjectPermissions(taskProjectId).canWrite) return denied();
      try {
        const body = toTaskUpdateRequest(update);
        const response = Object.keys(body).length ? await updateTaskMutation.mutateAsync({ taskId, update }) : undefined;
        const value = response ? mapTask(response.task, relationshipsByTaskId[taskId]) : existingTask;
        if (!value) return handleFailure("更新任务", new Error("任务上下文不可用。"));
        if (update.relationChanges && Object.keys(update.relationChanges).length) {
          const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, update.relationChanges);
          if (relationResult.failures.length) {
            const warning = "任务已更新，但部分关系未保存：" + relationResult.failures.join("；") + "。请刷新后核对。";
            recordMutationNotice(warning);
            return success(value, warning);
          }
        }
        clearMutationNotice();
        return success(value);
      } catch (error) {
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<TaskRecord>("更新任务", error) : handleFailure<TaskRecord>("更新任务", error);
        if (!result.ok && result.reconcile) recordMutationNotice(result.message);
        return result;
      }
    };
    const deleteTask = (taskId: string): Promise<WriteResult<null>> => getProjectPermissions(getTask(taskId)?.projectId).canWrite
      ? deleteTaskMutation.mutateAsync(taskId).then(() => success(null)).catch((error: unknown) => handleFailure("删除任务", error))
      : denied();
    const changeTaskRelations = async (taskId: string, changes: TaskRelationChanges): Promise<WriteResult<null>> => {
      const task = getTask(taskId);
      if (!getProjectPermissions(task?.projectId).canWrite) return denied();
      if (!Object.keys(changes).length) return success(null);
      try {
        const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, changes);
        if (relationResult.failures.length) {
          const warning = "任务关系仅部分保存：" + relationResult.failures.join("；") + "。请刷新后核对。";
          recordMutationNotice(warning);
          return success(null, warning);
        }
        clearMutationNotice();
        return success(null);
      } catch (error) {
        return handleFailure("更新任务关系", error);
      }
    };
    const refresh = async (): Promise<void> => {
      await queryClient.refetchQueries({
        predicate: (query) => isProjectTaskQueryForPrincipal(query, subjectId) && query.queryKey[2] === sessionGeneration && query.queryKey[3] !== "mutation-notice"
      });
    };

    return {
      projects,
      tasks,
      status: !enabled || !principalId ? "unauthenticated" : queryPending ? "loading" : queryError ? "error" : "ready",
      canCreateProjects: canCreateProjects && projectWriteReady,
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
      changeTaskRelations,
      refresh,
      notice: mutationNoticeQuery.data ?? (!enabled || !principalId ? "当前认证装配尚未就绪，页面不会请求受保护数据。" : queryError ? "部分项目、成员、任务或关系读取失败；未确认的数据已隐藏，未受影响的项目范围仍按权限工作。" : undefined)
    } satisfies ProjectTaskSource;
  }, [api, canCreateProjects, clearMutationNotice, createProjectMutation, createTaskMutation, deleteProjectMutation, deleteTaskMutation, enabled, getProject, getProjectPermissions, getTask, handleFailure, mutationNoticeQuery.data, principalId, projectWriteReady, projects, queryError, queryPending, queryClient, recordMutationNotice, relationshipsByTaskId, sessionGeneration, setTaskView, subjectId, taskViews, tasks, updateProjectMutation, updateTaskMutation]);
}
