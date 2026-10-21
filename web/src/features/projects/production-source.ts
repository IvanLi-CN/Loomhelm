import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { TaskRelationshipPage, TaskStatus } from "@loomhelm/protocol";

import type { TaskState, TaskView } from "@/demo/types";
import type {
  ProjectDraft,
  ProjectTaskSource,
  TaskDraft,
  TaskRecord,
  TaskUpdate,
  WriteResult
} from "@/features/tasks/types";

import { createPublishedProjectTaskApi, mapProject, mapTask } from "./api";

interface ProductionSourceOptions {
  client?: GeneratedApiClient;
  canWrite: boolean;
  isReadOnly?: boolean;
  taskViews?: Record<string, TaskView>;
  setTaskView?: (scope: string, view: TaskView) => void;
}

interface TaskQueryData {
  items: readonly import("@loomhelm/protocol").Task[];
  relationships: Readonly<Record<string, TaskRelationshipPage>>;
}

interface DesiredRelations {
  parentSpecified: boolean;
  parentTaskId?: string;
  dependenciesSpecified: boolean;
  dependsOn?: readonly string[];
}

function denied<T>(): Promise<WriteResult<T>> {
  return Promise.resolve({ ok: false, code: "readonly", message: "当前身份或权限为只读，写入动作没有执行。" });
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
  if (error instanceof ApiClientError) {
    const code = error.status === 401 || error.status === 403 ? "readonly" : error.status === 409 ? "blocked" : "invalid";
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

function taskStatus(state: TaskState | undefined): TaskStatus | undefined {
  if (!state) return undefined;
  return state === "待办" ? "todo" : state === "进行中" ? "in_progress" : state === "阻塞" ? "blocked" : state === "完成" ? "done" : "cancelled";
}

async function syncTaskRelations(
  api: ReturnType<typeof createPublishedProjectTaskApi>,
  queryClient: ReturnType<typeof useQueryClient>,
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
  await queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] });
}

export function usePublishedProjectTaskSource({ client, canWrite, isReadOnly = !canWrite, taskViews = {}, setTaskView }: ProductionSourceOptions): ProjectTaskSource {
  const api = useMemo(() => createPublishedProjectTaskApi(client), [client]);
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ["loomhelm", "projects"],
    queryFn: () => api.listProjects({ limit: 100 })
  });
  const tasksQuery = useQuery<TaskQueryData>({
    queryKey: ["loomhelm", "tasks", "all"],
    queryFn: async () => {
      // Fetch the authorized global set so project views can retain visible cross-project relation nodes.
      const response = await api.listTasks({ limit: 200 });
      const entries = await Promise.all(response.items.map(async (task) => [task.id, await api.getTaskRelationships({ task_id: task.id })] as const));
      return {
        items: response.items,
        relationships: Object.fromEntries(entries)
      };
    }
  });
  const createProjectMutation = useMutation({
    mutationFn: (draft: ProjectDraft) => api.createProject({ body: { name: draft.name.trim(), description: draft.summary.trim() || undefined } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["loomhelm", "projects"] })
  });
  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId: targetProjectId, draft }: { projectId: string; draft: ProjectDraft }) => api.updateProject({ project_id: targetProjectId, body: { name: draft.name.trim() || undefined, description: draft.summary.trim() || undefined } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["loomhelm", "projects"] })
  });
  const deleteProjectMutation = useMutation({
    mutationFn: (targetProjectId: string) => api.deleteProject({ project_id: targetProjectId }),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["loomhelm", "projects"] }),
      queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] })
    ])
  });
  const createTaskMutation = useMutation({
    mutationFn: (draft: TaskDraft) => api.createTask({ body: { title: draft.title.trim(), goal: draft.goal.trim(), project_id: draft.projectId, status: taskStatus(draft.state) } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] })
  });
  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, update }: { taskId: string; update: TaskUpdate }) => api.updateTask({ task_id: taskId, body: { title: update.title, goal: update.goal, status: taskStatus(update.state) } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] })
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask({ task_id: taskId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] })
  });

  const projects = useMemo(() => projectsQuery.data?.items.map(mapProject) ?? [], [projectsQuery.data]);
  const relationshipsByTaskId = tasksQuery.data?.relationships ?? {};
  const tasks = useMemo(() => tasksQuery.data?.items.map((task) => mapTask(task, relationshipsByTaskId[task.id])) ?? [], [relationshipsByTaskId, tasksQuery.data?.items]);
  const getProject = useMemo(() => (id: string | undefined) => projects.find((project) => project.id === id), [projects]);
  const getTask = useMemo(() => (id: string | undefined) => tasks.find((task) => task.id === id), [tasks]);

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

    const createProject = (draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => canWrite
      ? createProjectMutation.mutateAsync(draft).then((response) => success(mapProject(response.project))).catch((error: unknown) => failure("创建项目", error))
      : denied();
    const updateProject = (targetProjectId: string, draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => canWrite
      ? updateProjectMutation.mutateAsync({ projectId: targetProjectId, draft }).then((response) => success(mapProject(response.project))).catch((error: unknown) => failure("更新项目", error))
      : denied();
    const deleteProject = (targetProjectId: string): Promise<WriteResult<null>> => canWrite
      ? deleteProjectMutation.mutateAsync(targetProjectId).then(() => success(null)).catch((error: unknown) => failure("删除项目", error))
      : denied();
    const createTask = async (draft: TaskDraft): Promise<WriteResult<TaskRecord>> => {
      if (!canWrite) return denied();
      try {
        const response = await createTaskMutation.mutateAsync(draft);
        await syncTaskRelations(api, queryClient, relationshipsByTaskId, response.task.id, {
          parentSpecified: true,
          parentTaskId: draft.parentId,
          dependenciesSpecified: true,
          dependsOn: draft.dependsOn ?? []
        });
        return { ok: true, value: { ...mapTask(response.task), parentId: draft.parentId, dependsOn: [...new Set(draft.dependsOn ?? [])] } };
      } catch (error) {
        return failure("创建任务", error);
      }
    };
    const updateTask = async (taskId: string, update: TaskUpdate): Promise<WriteResult<TaskRecord>> => {
      if (!canWrite) return denied();
      try {
        const response = await updateTaskMutation.mutateAsync({ taskId, update });
        if (update.parentId !== undefined || update.dependsOn !== undefined) {
          await syncTaskRelations(api, queryClient, relationshipsByTaskId, taskId, {
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
        return failure("更新任务", error);
      }
    };
    const deleteTask = (taskId: string): Promise<WriteResult<null>> => canWrite
      ? deleteTaskMutation.mutateAsync(taskId).then(() => success(null)).catch((error: unknown) => failure("删除任务", error))
      : denied();
    const setTaskParent = (taskId: string, parentTaskId?: string): Promise<WriteResult<null>> => canWrite
      ? syncTaskRelations(api, queryClient, relationshipsByTaskId, taskId, { parentSpecified: true, parentTaskId, dependenciesSpecified: false }).then(() => success(null)).catch((error: unknown) => failure("更新父任务", error))
      : denied();
    const addTaskDependency = (taskId: string, prerequisiteTaskId: string): Promise<WriteResult<null>> => canWrite
      ? api.addTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }).then(async () => { await queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] }); return success(null); }).catch((error: unknown) => failure("添加前置任务", error))
      : denied();
    const removeTaskDependency = (taskId: string, prerequisiteTaskId: string): Promise<WriteResult<null>> => canWrite
      ? api.removeTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }).then(async () => { await queryClient.invalidateQueries({ queryKey: ["loomhelm", "tasks"] }); return success(null); }).catch((error: unknown) => failure("移除前置任务", error))
      : denied();

    return {
      projects,
      tasks,
      status: projectsQuery.isPending || tasksQuery.isPending ? "loading" : projectsQuery.isError || tasksQuery.isError ? "error" : "ready",
      canWrite,
      isReadOnly,
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
      notice: projectsQuery.isError || tasksQuery.isError ? "项目、任务或关系读取失败；页面保持 fail-closed。" : undefined
    } satisfies ProjectTaskSource;
  }, [api, canWrite, createProjectMutation, createTaskMutation, deleteProjectMutation, deleteTaskMutation, getProject, getTask, isReadOnly, projects, projectsQuery.isError, projectsQuery.isPending, queryClient, relationshipsByTaskId, setTaskView, taskViews, tasks, tasksQuery.isError, tasksQuery.isPending, updateProjectMutation, updateTaskMutation]);
}
