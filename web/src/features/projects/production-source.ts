import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiClientConfigurationError, ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Project, ProjectMember, Task, TaskRelationshipPage, TaskStatus, UpdateProjectRequest, UpdateTaskRequest } from "@loomhelm/protocol";

import type { TaskState, TaskView } from "@/demo/types";
import {
  taskWriteBlockReason,
  type ProjectDraft,
  type ProjectPermissionSnapshot,
  type ProjectRecord,
  type ProjectTaskSource,
  type RelationWriteFailure,
  type RelationWriteMetadata,
  type TaskDraft,
  type TaskRelationChanges,
  type TaskRecord,
  type TaskUpdate,
  type WriteResult
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

export interface MembershipQueryData {
  items: Readonly<Record<string, readonly ProjectMember[]>>;
  deniedProjectIds: readonly string[];
  failures: readonly string[];
}

export interface TaskQueryData {
  items: readonly Task[];
  relationships: Readonly<Record<string, TaskRelationshipPage>>;
  deniedTaskIds: readonly string[];
  failures: readonly string[];
}

export interface MutationNotice {
  id: string;
  message: string;
  kind?: "creation" | "in-flight" | "reconciliation";
}

export function mergeMutationNoticeChanges(
  current: readonly MutationNotice[],
  added: readonly MutationNotice[],
  removed: readonly string[]
): readonly MutationNotice[] {
  const notices = new Map(current.map((notice) => [notice.id, notice] as const));
  removed.forEach((id) => notices.delete(id));
  added.forEach((notice) => notices.set(notice.id, notice));
  return [...notices.values()];
}

const MUTATION_NOTICE_STORAGE_PREFIX = "loomhelm.project-task.mutation-notice.v2";
const MUTATION_NOTICE_CHANNEL = "loomhelm-project-task-mutation-notices";

function mutationNoticeStoragePrefix(principalId: string): string {
  return `${MUTATION_NOTICE_STORAGE_PREFIX}.${encodeURIComponent(principalId)}.`;
}

function mutationNoticeStorageKey(principalId: string, id: string): string {
  return `${mutationNoticeStoragePrefix(principalId)}${encodeURIComponent(id)}`;
}

function parseMutationNotice(value: unknown): MutationNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notice = value as Partial<MutationNotice>;
  const kind = notice.kind === "creation" || notice.kind === "in-flight" || notice.kind === "reconciliation" ? notice.kind : undefined;
  return typeof notice.id === "string" && typeof notice.message === "string" ? { id: notice.id, message: notice.message, ...(kind ? { kind } : {}) } : undefined;
}

function readMutationNoticesFromStorage(storage: Storage | undefined, prefix: string): readonly MutationNotice[] {
  if (!storage) return [];
  const notices: MutationNotice[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const notice = parseMutationNotice(JSON.parse(storage.getItem(key) ?? "null"));
      if (notice) notices.push(notice);
    }
  } catch {
    // A blocked or partially readable storage still yields any notices read before the failure.
  }
  return notices;
}

function getBrowserStorage(name: "localStorage" | "sessionStorage"): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window[name];
  } catch {
    return undefined;
  }
}

function readPersistedMutationNotices(principalId: string): readonly MutationNotice[] {
  if (typeof window === "undefined") return [];
  const prefix = mutationNoticeStoragePrefix(principalId);
  return mergeMutationNoticeChanges(
    readMutationNoticesFromStorage(getBrowserStorage("localStorage"), prefix),
    readMutationNoticesFromStorage(getBrowserStorage("sessionStorage"), prefix),
    []
  );
}

function publishMutationNoticeChanges(principalId: string, added: readonly MutationNotice[], removed: readonly string[]): void {
  if (typeof window === "undefined") return;
  const storages = [getBrowserStorage("localStorage"), getBrowserStorage("sessionStorage")].filter((storage): storage is Storage => Boolean(storage));
  for (const storage of storages) {
    try {
      removed.forEach((id) => storage.removeItem(mutationNoticeStorageKey(principalId, id)));
      added.forEach((notice) => storage.setItem(mutationNoticeStorageKey(principalId, notice.id), JSON.stringify(notice)));
      break;
    } catch {
      // sessionStorage preserves same-tab reloads when localStorage is blocked.
    }
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(MUTATION_NOTICE_CHANNEL);
    channel.postMessage({ principalId, added, removed });
    channel.close();
  }
}

function isPendingProjectCreationNotice(id: string): boolean {
  return id === "project:create" || id.startsWith("project:create:");
}

function isPendingTaskCreationNotice(id: string): boolean {
  return id === "task:create" || id.startsWith("task:create:");
}

function isInFlightMutationNotice(notice: MutationNotice): boolean {
  return notice.kind === "in-flight";
}

function createMutationNoticeId(kind: "project" | "task"): string {
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:create:${suffix}`;
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

export async function readProjectMemberships(
  api: Pick<PublishedProjectTaskApi, "listProjectMembers">,
  projectIds: readonly string[]
): Promise<MembershipQueryData> {
  const results = await Promise.allSettled(projectIds.map(async (projectId) => ({
    projectId,
    members: (await api.listProjectMembers({ project_id: projectId })).items
  })));
  const items: Record<string, readonly ProjectMember[]> = {};
  const deniedProjectIds: string[] = [];
  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items[result.value.projectId] = result.value.members;
    } else if (isPermissionError(result.reason)) {
      deniedProjectIds.push(projectIds[index] ?? "");
    } else {
      failures.push(failureMessage(`读取项目 ${projectIds[index] ?? "未知项目"} 的成员`, result.reason));
    }
  });
  return { items, deniedProjectIds: deniedProjectIds.filter(Boolean), failures };
}

export async function readTaskRelationships(
  api: Pick<PublishedProjectTaskApi, "getTaskRelationships">,
  tasks: readonly Task[]
): Promise<TaskQueryData> {
  const results = await Promise.allSettled(tasks.map(async (task) => ({
    taskId: task.id,
    relationships: await api.getTaskRelationships({ task_id: task.id })
  })));
  const relationships: Record<string, TaskRelationshipPage> = {};
  const deniedTaskIds: string[] = [];
  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      relationships[result.value.taskId] = result.value.relationships;
    } else if (isPermissionError(result.reason)) {
      deniedTaskIds.push(tasks[index]?.id ?? "");
    } else {
      failures.push(failureMessage(`读取任务 ${tasks[index]?.id ?? "未知任务"} 的关系`, result.reason));
    }
  });
  return { items: tasks, relationships, deniedTaskIds: deniedTaskIds.filter(Boolean), failures };
}

export function filterTaskRelationships(page: TaskRelationshipPage, visibleTaskIds: ReadonlySet<string>): TaskRelationshipPage {
  return {
    ...page,
    parents: page.parents.filter((relationship) => visibleTaskIds.has(relationship.parent_task_id)),
    children: page.children.filter((relationship) => visibleTaskIds.has(relationship.child_task_id)),
    prerequisites: page.prerequisites.filter((relationship) => visibleTaskIds.has(relationship.prerequisite_task_id)),
    dependents: page.dependents.filter((relationship) => visibleTaskIds.has(relationship.dependent_task_id))
  };
}

export function filterTasksToVisibleProjects(items: readonly Task[], visibleProjectIds: ReadonlySet<string>, deniedTaskIds: ReadonlySet<string> = new Set()): readonly Task[] {
  return items.filter((task) => visibleProjectIds.has(task.project_id) && !deniedTaskIds.has(task.id));
}

export const projectTaskQueryKeys = {
  projects: (principalId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "projects"] as const,
  memberships: (principalId: string, projectIds: readonly string[], sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "memberships", [...projectIds].sort()] as const,
  tasks: (principalId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "tasks", "all"] as const,
  taskRelationships: (principalId: string, taskId: string, sessionGeneration = 0) => ["loomhelm", principalId, sessionGeneration, "tasks", "relationships", taskId] as const,
  mutationNotice: (principalId: string) => ["loomhelm", principalId, "mutation-notice"] as const
};

export function isProjectTaskQueryForPrincipal(query: { queryKey: readonly unknown[] }, principalId: string): boolean {
  return query.queryKey[0] === "loomhelm" && query.queryKey[1] === principalId;
}

export function hasIncompleteProjectTaskRead(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const read = data as { failures?: readonly unknown[]; deniedProjectIds?: readonly unknown[]; deniedTaskIds?: readonly unknown[] };
  return Boolean(read.failures?.length || read.deniedProjectIds?.length || read.deniedTaskIds?.length);
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

function blocked<T>(message: string): WriteResult<T> {
  return { ok: false, code: "blocked", message, reconcile: true };
}

function success<T>(value: T, warning?: string, reconcile = false, relation?: RelationWriteMetadata): WriteResult<T> {
  if (warning) return { ok: true, value, warning, reconcile, relation };
  return relation ? { ok: true, value, relation } : { ok: true, value };
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

export function stableBlockedWriteMessage(operation: string): string | undefined {
  if (operation === "删除任务") return "任务仍有关系、对话或执行事实，受保护删除已阻止。";
  if (operation === "删除项目") return "项目仍保留任务、对话或执行事实，受保护删除已阻止。";
  return undefined;
}

function failure<T>(operation: string, error: unknown): WriteResult<T> {
  if (error instanceof ApiClientConfigurationError) {
    return { ok: false, code: "csrf", message: `${operation}失败：${error.message}` };
  }
  if (error instanceof ApiClientError) {
    const code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "readonly" : error.status === 409 ? "blocked" : "invalid";
    const detail = error.status === 409 ? stableBlockedWriteMessage(operation) ?? bodyMessage(error.body) : bodyMessage(error.body);
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
  failures: readonly RelationWriteFailure[];
  applied?: TaskRelationChanges;
}

function relationTargetIds(changes: TaskRelationChanges): readonly string[] {
  return [...new Set([
    ...(changes.addParentIds ?? []),
    ...(changes.removeParentIds ?? []),
    ...(changes.addDependencyIds ?? []),
    ...(changes.removeDependencyIds ?? [])
  ])];
}

export function relationWriteBlockReason(
  taskId: string,
  changes: TaskRelationChanges,
  getTask: (id: string | undefined) => TaskRecord | undefined,
  getProjectPermissions: (projectId: string | undefined) => ProjectMemberPermissions
): string | undefined {
  for (const relatedTaskId of relationTargetIds(changes)) {
    if (relatedTaskId === taskId) continue;
    const relatedTask = getTask(relatedTaskId);
    if (!relatedTask) return `关系目标 ${relatedTaskId} 当前不可见，关系写入没有执行。`;
    if (taskWriteBlockReason(relatedTask)) return `关系目标 ${relatedTaskId} 尚未完成关系核对，关系写入没有执行。`;
    if (!getProjectPermissions(relatedTask.projectId).canWrite) {
      return `关系目标 ${relatedTaskId} 所属项目为只读，关系写入没有执行。`;
    }
  }
  return undefined;
}

export async function syncTaskRelations(
  api: Pick<PublishedProjectTaskApi, "addTaskParent" | "removeTaskParent" | "addTaskDependency" | "removeTaskDependency">,
  queryClient: ReturnType<typeof useQueryClient>,
  principalId: string,
  sessionGeneration: number,
  taskId: string,
  changes: TaskRelationChanges
): Promise<RelationSyncResult> {
  const writes: Array<{ label: string; run: () => Promise<void>; field: keyof TaskRelationChanges; id: string }> = [];
  const addParentIds = [...new Set(changes.addParentIds ?? [])].filter((id) => id !== taskId);
  const removeParentIds = [...new Set(changes.removeParentIds ?? [])].filter((id) => id !== taskId);
  const addDependencyIds = [...new Set(changes.addDependencyIds ?? [])].filter((id) => id !== taskId);
  const removeDependencyIds = [...new Set(changes.removeDependencyIds ?? [])].filter((id) => id !== taskId);
  writes.push(...addParentIds.map((parentTaskId) => ({ field: "addParentIds" as const, id: parentTaskId, label: "添加父任务 " + parentTaskId, run: () => api.addTaskParent({ task_id: taskId, parent_task_id: parentTaskId }) })));
  writes.push(...removeParentIds.map((parentTaskId) => ({ field: "removeParentIds" as const, id: parentTaskId, label: "移除父任务 " + parentTaskId, run: () => api.removeTaskParent({ task_id: taskId, parent_task_id: parentTaskId }) })));
  writes.push(...addDependencyIds.map((prerequisiteTaskId) => ({ field: "addDependencyIds" as const, id: prerequisiteTaskId, label: "添加前置任务 " + prerequisiteTaskId, run: () => api.addTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }) })));
  writes.push(...removeDependencyIds.map((prerequisiteTaskId) => ({ field: "removeDependencyIds" as const, id: prerequisiteTaskId, label: "移除前置任务 " + prerequisiteTaskId, run: () => api.removeTaskDependency({ task_id: taskId, prerequisite_task_id: prerequisiteTaskId }) })));

  const results = await Promise.allSettled(writes.map((write) => write.run()));
  await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(principalId, sessionGeneration) });
  const applied = {
    addParentIds: [] as string[],
    removeParentIds: [] as string[],
    addDependencyIds: [] as string[],
    removeDependencyIds: [] as string[]
  };
  const failures: RelationWriteFailure[] = [];
  results.forEach((result, index) => {
    const write = writes[index];
    if (!write) return;
    if (result.status === "fulfilled") {
      applied[write.field].push(write.id);
    } else {
      const classified = isAmbiguousWriteError(result.reason) ? ambiguousFailure<null>(write.label, result.reason) : failure<null>(write.label, result.reason);
      if (!classified.ok) failures.push({ ...classified, label: write.label });
    }
  });
  const appliedChanges: TaskRelationChanges = {
    addParentIds: applied.addParentIds.length ? applied.addParentIds : undefined,
    removeParentIds: applied.removeParentIds.length ? applied.removeParentIds : undefined,
    addDependencyIds: applied.addDependencyIds.length ? applied.addDependencyIds : undefined,
    removeDependencyIds: applied.removeDependencyIds.length ? applied.removeDependencyIds : undefined
  };
  const hasAppliedChanges = Object.values(applied).some((values) => values.length > 0);
  return {
    failures,
    applied: hasAppliedChanges ? appliedChanges : undefined
  };
}

const PROJECT_TASK_REFRESH_INTERVAL_MS = 30_000;

export function usePublishedProjectTaskSource({ client, enabled = true, canCreateProjects, principalId, sessionGeneration = 0, taskViews = {}, setTaskView }: ProductionSourceOptions): ProjectTaskSource {
  const api = useMemo(() => createPublishedProjectTaskApi(client), [client]);
  const queryClient = useQueryClient();
  const subjectId = principalId ?? "anonymous";
  const sessionIdentityRef = useRef({ principalId: subjectId, sessionGeneration });
  sessionIdentityRef.current = { principalId: subjectId, sessionGeneration };
  const isCurrentSession = useCallback(() => sessionIdentityRef.current.principalId === subjectId && sessionIdentityRef.current.sessionGeneration === sessionGeneration, [sessionGeneration, subjectId]);
  const queryEnabled = enabled && Boolean(principalId);
  const projectsQuery = useQuery({
    queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration),
    queryFn: () => listAllProjects(api),
    enabled: queryEnabled,
    refetchInterval: PROJECT_TASK_REFRESH_INTERVAL_MS
  });
  const projectIds = useMemo(() => [...new Set(projectsQuery.isSuccess ? projectsQuery.data.map((project) => project.id) : [])].sort(), [projectsQuery.data, projectsQuery.isSuccess]);
  const invalidatePermissionScope = useCallback(async (includeProjects: boolean) => {
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.memberships(subjectId, projectIds, sessionGeneration) }),
      queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
    ];
    if (includeProjects) invalidations.push(queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration) }));
    await Promise.all(invalidations);
  }, [projectIds, queryClient, sessionGeneration, subjectId]);
  const membershipsQuery = useQuery<MembershipQueryData>({
    queryKey: projectTaskQueryKeys.memberships(subjectId, projectIds, sessionGeneration),
    queryFn: () => readProjectMemberships(api, projectIds),
    enabled: queryEnabled && projectsQuery.isSuccess,
    refetchInterval: PROJECT_TASK_REFRESH_INTERVAL_MS
  });
  const tasksQuery = useQuery<TaskQueryData>({
    queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration),
    queryFn: async () => {
      // Fetch the authorized global set so project views can retain visible cross-project relation nodes.
      const items = await listAllTasks(api);
      return readTaskRelationships(api, items);
    },
    enabled: queryEnabled && projectsQuery.isSuccess && membershipsQuery.isSuccess,
    refetchInterval: PROJECT_TASK_REFRESH_INTERVAL_MS
  });

  const deniedProjectIds = membershipsQuery.isSuccess ? membershipsQuery.data.deniedProjectIds : [];
  const deniedTaskIds = tasksQuery.isSuccess ? tasksQuery.data.deniedTaskIds : [];
  const deniedProjectKey = deniedProjectIds.join("\u0000");
  const deniedTaskKey = deniedTaskIds.join("\u0000");
  const lastDeniedProjectKey = useRef("");
  const lastDeniedTaskKey = useRef("");
  useEffect(() => {
    if (!deniedProjectKey) {
      lastDeniedProjectKey.current = "";
      return;
    }
    if (deniedProjectKey === lastDeniedProjectKey.current) return;
    lastDeniedProjectKey.current = deniedProjectKey;
    void queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.projects(subjectId, sessionGeneration) });
  }, [deniedProjectKey, queryClient, sessionGeneration, subjectId]);
  useEffect(() => {
    if (!deniedTaskKey) {
      lastDeniedTaskKey.current = "";
      return;
    }
    if (deniedTaskKey === lastDeniedTaskKey.current) return;
    lastDeniedTaskKey.current = deniedTaskKey;
    void queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) });
  }, [deniedTaskKey, queryClient, sessionGeneration, subjectId]);

  const mutationNoticeKey = useMemo(() => projectTaskQueryKeys.mutationNotice(subjectId), [subjectId]);
  const mutationNoticeStoragePrefixValue = useMemo(() => mutationNoticeStoragePrefix(subjectId), [subjectId]);
  const mutationNoticeQuery = useQuery<readonly MutationNotice[]>({
    queryKey: mutationNoticeKey,
    queryFn: async () => readPersistedMutationNotices(subjectId),
    enabled: queryEnabled,
    initialData: () => readPersistedMutationNotices(subjectId),
    staleTime: Infinity,
    gcTime: Infinity
  });
  useEffect(() => {
    if (!queryEnabled || typeof window === "undefined") return;
    const apply = (notices: readonly MutationNotice[]) => queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, notices);
    const handleStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith(mutationNoticeStoragePrefixValue)) return;
      apply(readPersistedMutationNotices(subjectId));
    };
    const handleBroadcast = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object") return;
      const signal = event.data as { principalId?: unknown; added?: unknown; removed?: unknown };
      if (signal.principalId !== subjectId) return;
      const current = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
      const removed = Array.isArray(signal.removed) ? signal.removed.filter((id): id is string => typeof id === "string") : [];
      const added = Array.isArray(signal.added) ? signal.added.map(parseMutationNotice).filter((notice): notice is MutationNotice => Boolean(notice)) : [];
      apply(mergeMutationNoticeChanges(current, added, removed));
    };
    let channel: BroadcastChannel | undefined;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(MUTATION_NOTICE_CHANNEL);
      channel.addEventListener("message", handleBroadcast);
    }
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      channel?.removeEventListener("message", handleBroadcast);
      channel?.close();
    };
  }, [mutationNoticeKey, mutationNoticeStoragePrefixValue, queryClient, queryEnabled, subjectId]);
  const updateMutationNotices = useCallback((update: (current: readonly MutationNotice[]) => readonly MutationNotice[]) => {
    const current = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
    const next = update(current);
    const currentById = new Map(current.map((notice) => [notice.id, notice] as const));
    const nextById = new Map(next.map((notice) => [notice.id, notice] as const));
    const removed = [...currentById.keys()].filter((id) => !nextById.has(id));
    const added = [...nextById.values()].filter((notice) => {
      const previous = currentById.get(notice.id);
      return previous?.message !== notice.message || previous?.kind !== notice.kind;
    });
    queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, next);
    if (added.length || removed.length) publishMutationNoticeChanges(subjectId, added, removed);
  }, [mutationNoticeKey, queryClient, subjectId]);
  const recordMutationNotice = useCallback((id: string, message: string, kind: MutationNotice["kind"] = "reconciliation") => {
    updateMutationNotices((current) => [
      ...current.filter((notice) => notice.id !== id),
      { id, message, kind }
    ]);
  }, [updateMutationNotices]);
  const clearMutationNotice = useCallback((id: string) => {
    updateMutationNotices((current) => current.filter((notice) => notice.id !== id));
  }, [updateMutationNotices]);
  const reconciliationNoticeByTaskId = useMemo(() => new Map(
    mutationNoticeQuery.data
      .filter((notice) => notice.id.startsWith("task:") && !isPendingTaskCreationNotice(notice.id))
      .map((notice) => [notice.id.slice("task:".length), notice.message] as const)
  ), [mutationNoticeQuery.data]);
  const pendingProjectCreation = mutationNoticeQuery.data.some((notice) => isPendingProjectCreationNotice(notice.id));
  const pendingTaskCreation = mutationNoticeQuery.data.some((notice) => isPendingTaskCreationNotice(notice.id));

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
    mutationFn: (draft: TaskDraft) => api.createTask({ body: { title: draft.title.trim(), goal: draft.goal.trim(), project_id: draft.projectId, status: taskStatus(draft.state) } })
  });
  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, update }: { taskId: string; update: TaskUpdate }) => api.updateTask({ task_id: taskId, body: toTaskUpdateRequest(update) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask({ task_id: taskId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) })
  });

  const projects = useMemo(() => {
    const denied = new Set(deniedProjectIds);
    return projectsQuery.isSuccess ? projectsQuery.data.filter((project) => !denied.has(project.id)).map(mapProject) : [];
  }, [deniedProjectIds, projectsQuery.data, projectsQuery.isSuccess]);
  const visibleProjectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);
  const visibleTaskItems = useMemo(() => tasksQuery.isSuccess
    ? filterTasksToVisibleProjects(tasksQuery.data.items, visibleProjectIds, new Set(deniedTaskIds))
    : [], [deniedTaskIds, tasksQuery.data, tasksQuery.isSuccess, visibleProjectIds]);
  const visibleTaskIds = useMemo(() => new Set(visibleTaskItems.map((task) => task.id)), [visibleTaskItems]);
  const relationshipsByTaskId = useMemo(() => {
    if (!tasksQuery.isSuccess) return {};
    return Object.fromEntries(Object.entries(tasksQuery.data.relationships)
      .filter(([taskId]) => visibleTaskIds.has(taskId))
      .map(([taskId, relationships]) => [taskId, filterTaskRelationships(relationships, visibleTaskIds)]));
  }, [tasksQuery.data, tasksQuery.isSuccess, visibleTaskIds]);
  const tasks = useMemo(() => {
    return visibleTaskItems.map((task) => {
        const mapped = mapTask(task, relationshipsByTaskId[task.id]);
        const reconciliationNotice = reconciliationNoticeByTaskId.get(task.id);
        return reconciliationNotice ? { ...mapped, relationshipsConfirmed: false, reconciliationNotice } : mapped;
      });
  }, [reconciliationNoticeByTaskId, relationshipsByTaskId, visibleTaskItems]);
  const getProject = useMemo(() => (id: string | undefined) => projects.find((project) => project.id === id), [projects]);
  const getTask = useMemo(() => (id: string | undefined) => tasks.find((task) => task.id === id), [tasks]);
  const getProjectPermissions = useMemo(() => (projectId: string | undefined): ProjectMemberPermissions => {
    if (!projectId || !membershipsQuery.isSuccess) return emptyProjectPermissions;
    if (deniedProjectIds.includes(projectId)) return emptyProjectPermissions;
    return permissionsForProjectMember(membershipsQuery.data.items[projectId] ?? [], principalId);
  }, [deniedProjectIds, membershipsQuery.data, membershipsQuery.isSuccess, principalId]);
  const relationMutationsInFlight = useRef(new Set<string>());
  const [relationMutationsPending, setRelationMutationsPending] = useState<ReadonlySet<string>>(() => new Set());
  const setRelationMutationPending = useCallback((taskId: string, pending: boolean) => {
    setRelationMutationsPending((current) => {
      const next = new Set(current);
      if (pending) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);
  const permissionChanged = deniedProjectIds.length > 0 || deniedTaskIds.length > 0;
  const queryPending = projectsQuery.isPending
    || (projectsQuery.isSuccess && membershipsQuery.isPending)
    || (membershipsQuery.isSuccess && tasksQuery.isPending);
  const queryError = projectsQuery.isError || membershipsQuery.isError || tasksQuery.isError;
  const projectWriteReady = projectsQuery.isSuccess && membershipsQuery.isSuccess && !projectsQuery.isError && !membershipsQuery.isError;
  const partialReadFailures = useMemo(() => [
    ...(membershipsQuery.isSuccess ? membershipsQuery.data.failures : []),
    ...(tasksQuery.isSuccess ? tasksQuery.data.failures : [])
  ], [membershipsQuery.data, membershipsQuery.isSuccess, tasksQuery.data, tasksQuery.isSuccess]);
  const readNotice = !enabled || !principalId
    ? "当前认证装配尚未就绪，页面不会请求受保护数据。"
    : queryError
      ? "部分项目、成员、任务或关系读取失败；未确认的数据已隐藏，未受影响的项目范围仍按权限工作。"
      : partialReadFailures.length
        ? `部分项目成员或任务关系读取失败；未受影响的范围仍可继续使用：${partialReadFailures.join("；")}`
        : deniedProjectIds.length || deniedTaskIds.length
          ? `部分项目或任务权限已收紧；受影响的资源和关系已隐藏，未受影响的范围仍可继续使用。`
        : undefined;

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
      if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
      if (!canCreateProjects || !projectWriteReady) return denied("当前身份或连接状态不能确认项目写入范围，项目写入没有执行。");
      const createNoticeId = createMutationNoticeId("project");
      try {
        const response = await createProjectMutation.mutateAsync(draft);
        clearMutationNotice(createNoticeId);
        return success(mapProject(response.project));
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(true);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<ReturnType<typeof mapProject>>("创建项目", error) : handleFailure<ReturnType<typeof mapProject>>("创建项目", error);
        if (!result.ok && result.reconcile) recordMutationNotice(createNoticeId, result.message, "creation");
        return !result.ok && result.reconcile ? { ...result, noticeId: createNoticeId } : result;
      }
    };
    const updateProject = async (targetProjectId: string, draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
      if (!getProjectPermissions(targetProjectId).canManageProjects) return denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
      const current = getProject(targetProjectId);
      const body = toProjectUpdateRequest(current, draft);
      if (!Object.keys(body).length && current) return success(current);
      try {
        const response = await updateProjectMutation.mutateAsync({ projectId: targetProjectId, draft, current });
        clearMutationNotice(`project:${targetProjectId}`);
        return success(mapProject(response.project));
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(true);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<ReturnType<typeof mapProject>>("更新项目", error) : handleFailure<ReturnType<typeof mapProject>>("更新项目", error);
        if (!result.ok && result.reconcile) recordMutationNotice(`project:${targetProjectId}`, result.message);
        return result;
      }
    };
    const deleteProject = async (targetProjectId: string): Promise<WriteResult<null>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
      if (!getProjectPermissions(targetProjectId).canManageProjects) return denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
      try {
        await deleteProjectMutation.mutateAsync(targetProjectId);
        clearMutationNotice(`project:${targetProjectId}`);
        return success(null);
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(true);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<null>("删除项目", error) : handleFailure<null>("删除项目", error);
        if (!result.ok && result.reconcile) recordMutationNotice(`project:${targetProjectId}`, result.message);
        return result;
      }
    };
    const createTask = async (draft: TaskDraft): Promise<WriteResult<TaskRecord>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
      if (!getProjectPermissions(draft.projectId).canWrite) return denied();
      const createNoticeId = createMutationNoticeId("task");
      const relationChanges: TaskRelationChanges = {
        addParentIds: [...new Set(draft.parentIds ?? (draft.parentId ? [draft.parentId] : []))],
        addDependencyIds: [...new Set(draft.dependsOn ?? [])]
      };
      const relationBlock = relationWriteBlockReason("", relationChanges, getTask, getProjectPermissions);
      if (relationBlock) return denied(relationBlock);
      const hasRelationChanges = Boolean(relationChanges.addParentIds?.length || relationChanges.addDependencyIds?.length);
      let createdTaskId: string | undefined;
      try {
        const response = await createTaskMutation.mutateAsync(draft);
        createdTaskId = response.task.id;
        const taskNoticeId = `task:${response.task.id}`;
        if (hasRelationChanges) {
          relationMutationsInFlight.current.add(response.task.id);
          setRelationMutationPending(response.task.id, true);
          recordMutationNotice(taskNoticeId, "任务已创建，关系写入正在进行，请等待本次操作完成。", "in-flight");
        }
        if (hasRelationChanges && !isCurrentSession()) {
          const value = mapTask(response.task);
          const warning = "任务已创建，但登录身份已变化，关系写入没有继续；请重新登录后核对。";
          recordMutationNotice(taskNoticeId, warning, "reconciliation");
          return { ...success(value, warning, true), noticeId: taskNoticeId };
        }
        const relationResult = relationChanges.addParentIds?.length || relationChanges.addDependencyIds?.length
          ? await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, response.task.id, relationChanges)
          : { failures: [], applied: undefined };
        const value = mapTask(response.task);
        if (relationResult.failures.length) {
          if (relationResult.failures.some((item) => item.status === 401 || item.status === 403 || item.status === 404)) await invalidatePermissionScope(false);
          const warning = "任务已创建，但部分关系未保存：" + relationResult.failures.map((item) => item.message).join("；") + "。请刷新后核对。";
          recordMutationNotice(taskNoticeId, warning, "reconciliation");
          return success(value, warning, true, { failures: relationResult.failures, applied: relationResult.applied });
        }
        if (!hasRelationChanges) await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) });
        clearMutationNotice(createNoticeId);
        clearMutationNotice(taskNoticeId);
        return success(value);
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(false);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<TaskRecord>("创建任务", error) : handleFailure<TaskRecord>("创建任务", error);
        if (createdTaskId && hasRelationChanges && !result.ok) {
          recordMutationNotice(`task:${createdTaskId}`, `任务已创建，但关系写入结果待确认：${result.message}请刷新后核对。`, "reconciliation");
          return { ...result, noticeId: `task:${createdTaskId}` };
        } else if (!result.ok && result.reconcile) {
          recordMutationNotice(createNoticeId, result.message, "creation");
          return { ...result, noticeId: createNoticeId };
        }
        return result;
      } finally {
        if (createdTaskId && relationMutationsInFlight.current.has(createdTaskId)) {
          relationMutationsInFlight.current.delete(createdTaskId);
          setRelationMutationPending(createdTaskId, false);
        }
      }
    };
    const updateTask = async (taskId: string, update: TaskUpdate): Promise<WriteResult<TaskRecord>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
      const existingTask = getTask(taskId);
      const reconciliationBlock = taskWriteBlockReason(existingTask);
      if (reconciliationBlock) return blocked(reconciliationBlock);
      const taskProjectId = existingTask?.projectId;
      if (!getProjectPermissions(taskProjectId).canWrite) return denied();
      if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
      const relationChanges = update.relationChanges;
      const hasRelationChanges = Boolean(relationChanges && Object.keys(relationChanges).length);
      if (hasRelationChanges && relationChanges) {
        const relationBlock = relationWriteBlockReason(taskId, relationChanges, getTask, getProjectPermissions);
        if (relationBlock) return denied(relationBlock);
        if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
        relationMutationsInFlight.current.add(taskId);
        setRelationMutationPending(taskId, true);
        recordMutationNotice(`task:${taskId}`, "任务关系写入正在进行，请等待本次操作完成。", "in-flight");
      }
      try {
        const body = toTaskUpdateRequest(update);
        const response = Object.keys(body).length ? await updateTaskMutation.mutateAsync({ taskId, update }) : undefined;
        const value = response ? mapTask(response.task, relationshipsByTaskId[taskId]) : existingTask;
        if (!value) return handleFailure("更新任务", new Error("任务上下文不可用。"));
        if (hasRelationChanges && relationChanges) {
          if (!isCurrentSession()) {
            const warning = "任务已更新，但登录身份已变化，关系写入没有继续；请重新登录后核对。";
            recordMutationNotice(`task:${taskId}`, warning, "reconciliation");
            return { ...success(value, warning, true), noticeId: `task:${taskId}` };
          }
          const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, relationChanges);
          if (relationResult.failures.length) {
            if (relationResult.failures.some((item) => item.status === 401 || item.status === 403 || item.status === 404)) await invalidatePermissionScope(false);
            const warning = "任务已更新，但部分关系未保存：" + relationResult.failures.map((item) => item.message).join("；") + "。请刷新后核对。";
            recordMutationNotice(`task:${taskId}`, warning, "reconciliation");
            return success(value, warning, true, { failures: relationResult.failures, applied: relationResult.applied });
          }
        }
        clearMutationNotice(`task:${taskId}`);
        return success(value);
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(false);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<TaskRecord>("更新任务", error) : handleFailure<TaskRecord>("更新任务", error);
        if (!result.ok && result.reconcile) recordMutationNotice(`task:${taskId}`, result.message, "reconciliation");
        else if (hasRelationChanges) clearMutationNotice(`task:${taskId}`);
        return result;
      } finally {
        if (hasRelationChanges) {
          relationMutationsInFlight.current.delete(taskId);
          setRelationMutationPending(taskId, false);
        }
      }
    };
    const deleteTask = async (taskId: string): Promise<WriteResult<null>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
      const task = getTask(taskId);
      const reconciliationBlock = taskWriteBlockReason(task);
      if (reconciliationBlock) return blocked(reconciliationBlock);
      if (!getProjectPermissions(task?.projectId).canWrite) return denied();
      if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
      try {
        await deleteTaskMutation.mutateAsync(taskId);
        clearMutationNotice(`task:${taskId}`);
        return success(null);
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(false);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<null>("删除任务", error) : handleFailure<null>("删除任务", error);
        if (!result.ok && result.reconcile) recordMutationNotice(`task:${taskId}`, result.message);
        return result;
      }
    };
    const changeTaskRelations = async (taskId: string, changes: TaskRelationChanges): Promise<WriteResult<null>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，关系写入没有执行。");
      const task = getTask(taskId);
      const reconciliationBlock = taskWriteBlockReason(task);
      if (reconciliationBlock) return blocked(reconciliationBlock);
      if (!getProjectPermissions(task?.projectId).canWrite) return denied();
      if (!Object.keys(changes).length) return success(null);
      const relationBlock = relationWriteBlockReason(taskId, changes, getTask, getProjectPermissions);
      if (relationBlock) return denied(relationBlock);
      if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
      try {
        relationMutationsInFlight.current.add(taskId);
        setRelationMutationPending(taskId, true);
        recordMutationNotice(`task:${taskId}`, "任务关系写入正在进行，请等待本次操作完成。", "in-flight");
        if (!isCurrentSession()) {
          const warning = "登录身份已变化，任务关系写入没有继续；请重新登录后核对。";
          recordMutationNotice(`task:${taskId}`, warning, "reconciliation");
          return { ...success(null, warning, true), noticeId: `task:${taskId}` };
        }
        const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, changes);
        if (relationResult.failures.length) {
          if (relationResult.failures.some((item) => item.status === 401 || item.status === 403 || item.status === 404)) await invalidatePermissionScope(false);
          const warning = "任务关系仅部分保存：" + relationResult.failures.map((item) => item.message).join("；") + "。请刷新后核对。";
          recordMutationNotice(`task:${taskId}`, warning, "reconciliation");
          return success(null, warning, true, { failures: relationResult.failures, applied: relationResult.applied });
        }
        clearMutationNotice(`task:${taskId}`);
        return success(null);
      } catch (error) {
        if (isPermissionError(error)) await invalidatePermissionScope(false);
        const result = isAmbiguousWriteError(error) ? ambiguousFailure<null>("更新任务关系", error) : handleFailure<null>("更新任务关系", error);
        if (!result.ok && result.reconcile) recordMutationNotice(`task:${taskId}`, result.message, "reconciliation");
        else clearMutationNotice(`task:${taskId}`);
        return result;
      } finally {
        relationMutationsInFlight.current.delete(taskId);
        setRelationMutationPending(taskId, false);
      }
    };
    const refresh = async (): Promise<void> => {
      const predicate = (query: { queryKey: readonly unknown[] }) => isProjectTaskQueryForPrincipal(query, subjectId) && query.queryKey[2] === sessionGeneration;
      await queryClient.refetchQueries({ predicate });
      const refreshedQueries = queryClient.getQueryCache().findAll({ predicate });
      const failedQuery = refreshedQueries.find((query) => query.state.status === "error");
      const incompleteQuery = refreshedQueries.find((query) => hasIncompleteProjectTaskRead(query.state.data));
      if (failedQuery || incompleteQuery) throw new Error("项目、任务或关系列表刷新不完整，待确认结果仍然保留。");
      updateMutationNotices((notices) => notices.filter((notice) => isPendingProjectCreationNotice(notice.id) || isPendingTaskCreationNotice(notice.id) || isInFlightMutationNotice(notice)));
    };

    return {
      projects,
      tasks,
      status: !enabled || !principalId ? "unauthenticated" : queryPending ? "loading" : queryError ? "error" : "ready",
      pendingProjectCreation,
      pendingTaskCreation,
      acknowledgePendingProjectCreation: (noticeId: string) => updateMutationNotices((notices) => notices.filter((notice) => notice.id !== noticeId)),
      acknowledgePendingTaskCreation: (noticeId: string) => updateMutationNotices((notices) => notices.filter((notice) => notice.id !== noticeId)),
      isTaskRelationWritePending: (taskId: string) => relationMutationsPending.has(taskId),
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
      notice: [readNotice, ...mutationNoticeQuery.data.map((notice) => notice.message)].filter(Boolean).join(" ") || undefined
    } satisfies ProjectTaskSource;
  }, [api, canCreateProjects, clearMutationNotice, createProjectMutation, createTaskMutation, deleteProjectMutation, deleteTaskMutation, enabled, getProject, getProjectPermissions, getTask, handleFailure, invalidatePermissionScope, isCurrentSession, mutationNoticeKey, mutationNoticeQuery.data, pendingProjectCreation, pendingTaskCreation, permissionChanged, principalId, projectWriteReady, projects, queryError, queryPending, queryClient, readNotice, recordMutationNotice, relationshipsByTaskId, relationMutationsPending, sessionGeneration, setRelationMutationPending, setTaskView, subjectId, taskViews, tasks, updateMutationNotices, updateProjectMutation, updateTaskMutation]);
}
