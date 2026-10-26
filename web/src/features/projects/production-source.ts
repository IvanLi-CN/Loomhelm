import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiClientConfigurationError, ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Project, ProjectMember, Task, TaskRelationshipPage, TaskStatus, UpdateProjectRequest, UpdateTaskRequest } from "@loomhelm/protocol";

import type { TaskState, TaskView } from "@/demo/types";
import {
  projectWriteBlockReason,
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
  lockScope?: string;
  identityMismatch?: boolean;
  volatile?: boolean;
  projectId?: string;
  taskId?: string;
}

export function mergeMutationNoticeChanges(
  current: readonly MutationNotice[],
  added: readonly MutationNotice[],
  removed: readonly string[],
  removedNotices: readonly MutationNotice[] = []
): readonly MutationNotice[] {
  const notices = new Map(current.map((notice) => [notice.id, notice] as const));
  const removedById = new Map(removedNotices.map((notice) => [notice.id, notice] as const));
  removed.forEach((id) => {
    const currentNotice = notices.get(id);
    const removedNotice = removedById.get(id);
    if (currentNotice?.volatile && (!removedNotice || !sameMutationNoticeContent(currentNotice, removedNotice))) return;
    notices.delete(id);
  });
  added.forEach((notice) => {
    const currentNotice = notices.get(notice.id);
    if (currentNotice?.volatile && !sameMutationNoticeContent(currentNotice, notice)) return;
    notices.set(notice.id, notice);
  });
  return [...notices.values()];
}

function sameMutationNoticeContent(left: MutationNotice, right: MutationNotice): boolean {
  return left.id === right.id
    && left.message === right.message
    && left.kind === right.kind
    && left.lockScope === right.lockScope
    && left.identityMismatch === right.identityMismatch
    && left.projectId === right.projectId
    && left.taskId === right.taskId;
}

export function mergePersistedMutationNotices(
  current: readonly MutationNotice[],
  persisted: readonly MutationNotice[],
  preserveMissingVolatile = true
): readonly MutationNotice[] {
  const persistedById = new Map(persisted.map((notice) => [notice.id, notice] as const));
  const volatile = current.filter((notice) => {
    const stored = persistedById.get(notice.id);
    return Boolean(notice.volatile && ((preserveMissingVolatile && !stored) || (stored && !sameMutationNoticeContent(notice, stored))));
  });
  const volatileIds = new Set(volatile.map((notice) => notice.id));
  return [...persisted.filter((notice) => !volatileIds.has(notice.id)), ...volatile];
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
  const lockScope = typeof notice.lockScope === "string" ? notice.lockScope : undefined;
  const identityMismatch = notice.identityMismatch === true;
  const volatile = notice.volatile === true;
  const projectId = typeof notice.projectId === "string" ? notice.projectId : undefined;
  const taskId = typeof notice.taskId === "string" ? notice.taskId : undefined;
  return typeof notice.id === "string" && typeof notice.message === "string" ? { id: notice.id, message: notice.message, ...(kind ? { kind } : {}), ...(lockScope ? { lockScope } : {}), ...(identityMismatch ? { identityMismatch } : {}), ...(volatile ? { volatile } : {}), ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) } : undefined;
}

function parseSerializedMutationNotice(value: string | null): MutationNotice | undefined {
  if (!value) return undefined;
  try {
    return parseMutationNotice(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export interface MutationNoticeStorageRead {
  available: boolean;
  shared: boolean;
  notices: readonly MutationNotice[];
}

export function mutationNoticeContentToken(notices: readonly MutationNotice[]): string {
  return JSON.stringify(notices
    .map((notice) => ({
      id: notice.id,
      message: notice.message,
      kind: notice.kind ?? null,
      lockScope: notice.lockScope ?? null,
      identityMismatch: notice.identityMismatch === true,
      volatile: notice.volatile === true,
      projectId: notice.projectId ?? null,
      taskId: notice.taskId ?? null
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export function mergePersistedMutationNoticeState(
  current: readonly MutationNotice[],
  state: MutationNoticeStorageRead,
  confirmedRemovedNotices: readonly MutationNotice[] = []
): readonly MutationNotice[] {
  if (!state.available) return mergeMutationNoticeChanges(current, state.notices, []);
  const merged = mergePersistedMutationNotices(current, state.notices, true);
  if (!confirmedRemovedNotices.length) return merged;
  return mergeMutationNoticeChanges(merged, [], confirmedRemovedNotices.map((notice) => notice.id), confirmedRemovedNotices);
}

interface MutationNoticeUpdateResult {
  applied: boolean;
  persisted: boolean;
}

export function readMutationNoticesFromStorage(storage: Storage | undefined, prefix: string): MutationNoticeStorageRead {
  if (!storage) return { available: false, shared: false, notices: [] };
  const notices: MutationNotice[] = [];
  let invalid = false;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const serialized = storage.getItem(key);
      if (serialized === null) {
        invalid = true;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        invalid = true;
        continue;
      }
      const notice = parseMutationNotice(parsed);
      if (notice) notices.push(notice);
      else invalid = true;
    }
    return { available: !invalid, shared: false, notices };
  } catch {
    return { available: false, shared: false, notices };
  }
}

function getBrowserStorage(name: "localStorage" | "sessionStorage"): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window[name];
  } catch {
    return undefined;
  }
}

function mergeKnownMutationNotices(...groups: readonly (readonly MutationNotice[])[]): readonly MutationNotice[] {
  const notices = new Map<string, MutationNotice>();
  groups.flat().forEach((notice) => notices.set(notice.id, notice));
  return [...notices.values()];
}

export function readMutationNoticeStateFromStorage(
  sharedStorage: Storage | undefined,
  tabStorage: Storage | undefined,
  prefix: string
): MutationNoticeStorageRead {
  const local = readMutationNoticesFromStorage(sharedStorage, prefix);
  if (local.available) return { ...local, shared: true };
  const session = readMutationNoticesFromStorage(tabStorage, prefix);
  return {
    available: false,
    shared: false,
    notices: mergeKnownMutationNotices(local.notices, session.notices)
  };
}

function readPersistedMutationNoticeState(principalId: string): MutationNoticeStorageRead {
  if (typeof window === "undefined") return { available: false, shared: false, notices: [] };
  return readMutationNoticeStateFromStorage(
    getBrowserStorage("localStorage"),
    getBrowserStorage("sessionStorage"),
    mutationNoticeStoragePrefix(principalId)
  );
}

function readPersistedMutationNotices(principalId: string): readonly MutationNotice[] {
  return readPersistedMutationNoticeState(principalId).notices;
}

function publishMutationNoticeChanges(principalId: string, added: readonly MutationNotice[], removed: readonly string[], removedNotices: readonly MutationNotice[] = []): boolean {
  if (typeof window === "undefined") return true;
  const sharedStorage = getBrowserStorage("localStorage");
  let persisted = false;
  if (sharedStorage) {
    try {
      removed.forEach((id) => sharedStorage.removeItem(mutationNoticeStorageKey(principalId, id)));
      added.forEach((notice) => sharedStorage.setItem(mutationNoticeStorageKey(principalId, notice.id), JSON.stringify(notice)));
      persisted = true;
    } catch {
      persisted = false;
    }
  }
  const signalAdded = persisted ? added : added.map((notice) => ({ ...notice, volatile: true }));
  const signalRemoved = persisted ? removed : [];
  const sessionStorage = getBrowserStorage("sessionStorage");
  if (sessionStorage) {
    try {
      if (persisted) removed.forEach((id) => sessionStorage.removeItem(mutationNoticeStorageKey(principalId, id)));
      signalAdded.forEach((notice) => sessionStorage.setItem(mutationNoticeStorageKey(principalId, notice.id), JSON.stringify(notice)));
    } catch {
      // localStorage is the shared source of truth; sessionStorage is best effort.
    }
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(MUTATION_NOTICE_CHANNEL);
    channel.postMessage({ principalId, added: signalAdded, removed: signalRemoved, removedNotices });
    channel.close();
  }
  return persisted;
}

function isPendingProjectCreationNotice(notice: Pick<MutationNotice, "id" | "projectId">): boolean {
  return !notice.projectId && (notice.id === "project:create" || notice.id.startsWith("project:create:"));
}

function isPendingTaskCreationNotice(notice: Pick<MutationNotice, "id" | "taskId">): boolean {
  return !notice.taskId && (notice.id === "task:create" || notice.id.startsWith("task:create:"));
}

function isInFlightMutationNotice(notice: MutationNotice): boolean {
  return notice.kind === "in-flight";
}

function createMutationNoticeId(kind: "project" | "task"): string {
  const suffix = createMutationNoticeSuffix();
  return `${kind}:create:${suffix}`;
}

function createMutationNoticeSuffix(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createTaskMutationNoticeId(taskId: string): string {
  return `task:${taskId}:mutation:${createMutationNoticeSuffix()}`;
}

function createProjectMutationNoticeId(projectId: string): string {
  return `project:${projectId}:mutation:${createMutationNoticeSuffix()}`;
}

function mutationNoticeTaskId(notice: MutationNotice): string | undefined {
  if (notice.taskId) return notice.taskId;
  if (notice.id.startsWith("task:") && !isPendingTaskCreationNotice(notice)) return notice.id.slice("task:".length);
  return undefined;
}

function mutationNoticeProjectId(notice: MutationNotice): string | undefined {
  if (notice.projectId) return notice.projectId;
  if (notice.id.startsWith("project:") && !isPendingProjectCreationNotice(notice)) return notice.id.slice("project:".length);
  return undefined;
}

function mutationNoticeScope(notice: MutationNotice): string | undefined {
  if (notice.lockScope) return notice.lockScope;
  if (isPendingProjectCreationNotice(notice)) return "project:create";
  if (isPendingTaskCreationNotice(notice)) return "task:create";
  const projectId = mutationNoticeProjectId(notice);
  if (projectId) return `project:${projectId}`;
  const taskId = mutationNoticeTaskId(notice);
  if (taskId) return `task:${taskId}`;
  return undefined;
}

export function mutationNoticeScopes(notice: MutationNotice): readonly string[] {
  const projectId = mutationNoticeProjectId(notice);
  const taskId = mutationNoticeTaskId(notice);
  return [...new Set([
    mutationNoticeScope(notice),
    projectId ? `project:${projectId}` : undefined,
    taskId ? `task:${taskId}` : undefined
  ].filter((scope): scope is string => Boolean(scope)))];
}

export function mutationNoticeRemovalScopes(current: readonly MutationNotice[], removed: readonly string[]): readonly string[] {
  const removedIds = new Set(removed);
  return [...new Set(current.filter((notice) => removedIds.has(notice.id)).flatMap(mutationNoticeScopes))];
}

export function markMutationRefreshScopes(
  barriers: Map<string, number>,
  scopes: readonly string[],
  nextRevision: number
): { revisions: ReadonlyMap<string, number>; nextRevision: number } {
  let revision = nextRevision;
  const revisions = new Map<string, number>();
  for (const scope of new Set(scopes)) {
    revision += 1;
    barriers.set(scope, revision);
    revisions.set(scope, revision);
  }
  return { revisions, nextRevision: revision };
}

export function releaseMutationRefreshScopes(barriers: Map<string, number>, revisions: ReadonlyMap<string, number>): void {
  for (const [scope, revision] of revisions) {
    if (barriers.get(scope) === revision) barriers.delete(scope);
  }
}

export function createClientResourceId(kind: "project" | "task"): string | undefined {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) return undefined;
  const bytes = new Uint8Array(16);
  try {
    cryptoApi.getRandomValues(bytes);
  } catch {
    return undefined;
  }
  const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${kind}_${suffix}`;
}

interface BrowserMutationLocks {
  request<T>(name: string, options: { mode: "exclusive"; ifAvailable?: boolean }, callback: (lock: unknown | null) => Promise<T>): Promise<T>;
  query: () => Promise<{ held: readonly { name?: string | null }[]; pending: readonly { name?: string | null }[] }>;
}

function browserMutationLocks(): BrowserMutationLocks | undefined {
  if (typeof navigator === "undefined") return undefined;
  const locks = (navigator as Navigator & {
    locks?: {
      request?: BrowserMutationLocks["request"];
      query?: BrowserMutationLocks["query"];
    };
  }).locks;
  if (!locks?.request || !locks.query) return undefined;
  return locks as BrowserMutationLocks;
}

function browserMutationLockName(principalId: string, scope: string): string {
  return `loomhelm:${encodeURIComponent(principalId)}:mutation:${scope}`;
}

async function withAvailableBrowserMutationLock<T>(principalId: string, scope: string, fallback: T, operation: () => Promise<T>, ifAvailable = true): Promise<T> {
  const locks = browserMutationLocks();
  if (!locks) return fallback;
  try {
    return await locks.request(browserMutationLockName(principalId, scope), { mode: "exclusive", ifAvailable }, async (lock) => lock ? operation() : fallback);
  } catch {
    return fallback;
  }
}

async function runWithBrowserMutationLock<T>(principalId: string, scope: string, operation: () => Promise<WriteResult<T>>, ifAvailable = true): Promise<WriteResult<T>> {
  if (!browserMutationLocks()) return blockedWithoutReconcile("当前浏览器不支持跨标签写入协调，写入没有执行。");
  return withAvailableBrowserMutationLock(principalId, scope, blockedWithoutReconcile("同一写入正在其他标签页处理中，请刷新核对后再试。"), operation, ifAvailable);
}

async function runWithTaskMutationLocks<T>(principalId: string, taskId: string, operation: () => Promise<WriteResult<T>>): Promise<WriteResult<T>> {
  return runWithBrowserMutationLock(principalId, "task:create", () => runWithBrowserMutationLock(principalId, `task:${taskId}`, operation));
}

function hasPersistedMutationBarrier(principalId: string, scope: string): boolean {
  if (typeof window === "undefined") return false;
  const state = readPersistedMutationNoticeState(principalId);
  return !state.available || state.notices.some((notice) => mutationNoticeScopes(notice).includes(scope));
}

export const PROJECT_PAGE_LIMIT = 100;
export const TASK_PAGE_LIMIT = 200;

interface CursorPage<Item> {
  has_more: boolean;
  items: readonly Item[];
  next_cursor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isProject(value: unknown): value is Project {
  return isRecord(value)
    && typeof value.created_at === "string"
    && (value.description === undefined || typeof value.description === "string")
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.updated_at === "string";
}

function isTask(value: unknown): value is Task {
  return isRecord(value)
    && typeof value.created_at === "string"
    && typeof value.goal === "string"
    && typeof value.id === "string"
    && typeof value.project_id === "string"
    && (value.session_id === undefined || typeof value.session_id === "string")
    && (value.status === "todo" || value.status === "in_progress" || value.status === "blocked" || value.status === "done" || value.status === "cancelled")
    && typeof value.title === "string"
    && typeof value.updated_at === "string";
}

function isProjectMember(value: unknown): value is ProjectMember {
  return isRecord(value)
    && typeof value.created_at === "string"
    && typeof value.project_id === "string"
    && (value.role === "viewer" || value.role === "operator" || value.role === "owner")
    && typeof value.user_id === "string";
}

function isProjectMemberForProject(value: unknown, projectId: string): value is ProjectMember {
  return isProjectMember(value) && value.project_id === projectId;
}

function isTaskContainment(value: unknown): boolean {
  return isRecord(value)
    && typeof value.child_task_id === "string"
    && typeof value.created_at === "string"
    && value.kind === "parent_child"
    && typeof value.parent_task_id === "string";
}

function isTaskDependency(value: unknown): boolean {
  return isRecord(value)
    && typeof value.created_at === "string"
    && typeof value.dependent_task_id === "string"
    && value.kind === "prerequisite"
    && typeof value.prerequisite_task_id === "string";
}

function isTaskRelationshipPage(value: unknown, taskId?: string): value is TaskRelationshipPage {
  if (!isRecord(value)) return false;
  return Array.isArray(value.parents)
    && value.parents.every((relationship) => isTaskContainment(relationship) && (taskId === undefined || relationship.child_task_id === taskId))
    && Array.isArray(value.children)
    && value.children.every((relationship) => isTaskContainment(relationship) && (taskId === undefined || relationship.parent_task_id === taskId))
    && Array.isArray(value.prerequisites)
    && value.prerequisites.every((relationship) => isTaskDependency(relationship) && (taskId === undefined || relationship.dependent_task_id === taskId))
    && Array.isArray(value.dependents)
    && value.dependents.every((relationship) => isTaskDependency(relationship) && (taskId === undefined || relationship.prerequisite_task_id === taskId));
}

function isCursorPage<Item>(value: unknown, isItem: (item: unknown) => item is Item): value is CursorPage<Item> {
  if (!value || typeof value !== "object") return false;
  const page = value as { has_more?: unknown; items?: unknown; next_cursor?: unknown };
  return typeof page.has_more === "boolean"
    && Array.isArray(page.items)
    && page.items.every(isItem)
    && (page.next_cursor === undefined || typeof page.next_cursor === "string");
}

export async function readAllCursorPages<Item>(
  resource: string,
  readPage: (afterCursor?: string) => Promise<CursorPage<Item>>,
  limit: number,
  isItem: (item: unknown) => item is Item
): Promise<readonly Item[]> {
  if (limit <= 0) throw new Error(`${resource} pagination limit must be positive.`);
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let afterCursor: string | undefined;

  for (;;) {
    const page = await readPage(afterCursor);
    if (!isCursorPage<Item>(page, isItem)) throw new Error(`${resource} pagination response is incomplete.`);
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
  return readAllCursorPages("projects", (after_cursor) => api.listProjects({ after_cursor, limit: PROJECT_PAGE_LIMIT }), PROJECT_PAGE_LIMIT, isProject);
}

export function listAllTasks(api: Pick<PublishedProjectTaskApi, "listTasks">): Promise<readonly Task[]> {
  return readAllCursorPages("tasks", (after_cursor) => api.listTasks({ after_cursor, limit: TASK_PAGE_LIMIT }), TASK_PAGE_LIMIT, isTask);
}

export async function readProjectMemberships(
  api: Pick<PublishedProjectTaskApi, "listProjectMembers">,
  projectIds: readonly string[]
): Promise<MembershipQueryData> {
  const results = await Promise.allSettled(projectIds.map(async (projectId) => {
    const response = await api.listProjectMembers({ project_id: projectId });
    if (!response || typeof response !== "object" || !Array.isArray(response.items) || !response.items.every((member) => isProjectMemberForProject(member, projectId))) throw new Error("项目成员响应不完整。");
    return { projectId, members: response.items };
  }));
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
  const results = await Promise.allSettled(tasks.map(async (task) => {
    const relationships = await api.getTaskRelationships({ task_id: task.id });
    if (!isTaskRelationshipPage(relationships, task.id)) throw new Error("任务关系响应不完整或关系端点与任务不匹配。");
    return { taskId: task.id, relationships };
  }));
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

export function hasIncompleteProjectTaskRead(data: unknown, expectedProjectIds: readonly string[] = [], expectedTaskIds: readonly string[] = []): boolean {
  if (!data || typeof data !== "object") return true;
  const read = data as {
    failures?: readonly unknown[];
    deniedProjectIds?: readonly unknown[];
    deniedTaskIds?: readonly unknown[];
    items?: unknown;
    relationships?: unknown;
  };
  if (read.failures?.length || read.deniedProjectIds?.length || read.deniedTaskIds?.length) return true;
  if (expectedProjectIds.length > 0) {
    if (!read.items || typeof read.items !== "object" || Array.isArray(read.items)) return true;
    const items = read.items as Record<string, unknown>;
    if (expectedProjectIds.some((projectId) => !Object.prototype.hasOwnProperty.call(items, projectId) || !Array.isArray(items[projectId]) || !items[projectId].every((member) => isProjectMemberForProject(member, projectId)))) return true;
  }
  if (expectedTaskIds.length > 0) {
    if (!Array.isArray(read.items) || !read.items.every(isTask) || !read.relationships || typeof read.relationships !== "object" || Array.isArray(read.relationships)) return true;
    const taskIds = new Set(read.items.map((item) => item.id));
    const relationships = read.relationships as Record<string, unknown>;
    if (expectedTaskIds.some((taskId) => !taskIds.has(taskId) || !Object.prototype.hasOwnProperty.call(relationships, taskId) || !isTaskRelationshipPage(relationships[taskId], taskId))) return true;
  }
  return false;
}

export interface ProjectTaskRefreshQuerySnapshot {
  state: {
    status: string;
    fetchStatus: string;
    data: unknown;
  };
}

export function isCompleteProjectTaskQuery(query: ProjectTaskRefreshQuerySnapshot | undefined, complete: boolean): boolean {
  return Boolean(query
    && query.state.status === "success"
    && query.state.fetchStatus === "idle"
    && query.state.data !== undefined
    && complete);
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

function blockedWithoutReconcile<T>(message: string): WriteResult<T> {
  return { ok: false, code: "blocked", message, reconcile: false };
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
  useLayoutEffect(() => {
    sessionIdentityRef.current = { principalId: subjectId, sessionGeneration };
  }, [sessionGeneration, subjectId]);
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
  const remoteRefreshScopesRef = useRef(new Map<string, number>());
  const remoteRefreshRevisionRef = useRef(0);
  useLayoutEffect(() => {
    remoteRefreshScopesRef.current.clear();
  }, [sessionGeneration, subjectId]);
  const mutationNoticeQuery = useQuery<readonly MutationNotice[]>({
    queryKey: mutationNoticeKey,
    queryFn: async () => readPersistedMutationNotices(subjectId),
    enabled: queryEnabled,
    initialData: () => readPersistedMutationNotices(subjectId),
    staleTime: Infinity,
    gcTime: Infinity
  });
  const refreshProjectTaskQueries = useCallback(async () => {
    const projectsKey = projectTaskQueryKeys.projects(subjectId, sessionGeneration);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: projectsKey, exact: true }),
      queryClient.cancelQueries({ queryKey: ["loomhelm", subjectId, sessionGeneration, "memberships"] }),
      queryClient.cancelQueries({ queryKey: ["loomhelm", subjectId, sessionGeneration, "tasks"] })
    ]);
    if (!isCurrentSession()) throw new Error("登录身份已变化，刷新结果不能应用。");
    const refreshedProjects = await queryClient.fetchQuery<readonly Project[]>({
      queryKey: projectsKey,
      queryFn: () => listAllProjects(api),
      staleTime: 0,
      retry: false
    });
    if (!Array.isArray(refreshedProjects)) throw new Error("项目列表刷新不完整，待确认结果仍然保留。");
    if (!isCurrentSession()) throw new Error("登录身份已变化，刷新结果不能应用。");

    const refreshedProjectIds = [...new Set(refreshedProjects.map((project) => project.id))].sort();
    const membershipsKey = projectTaskQueryKeys.memberships(subjectId, refreshedProjectIds, sessionGeneration);
    const refreshedMemberships = await queryClient.fetchQuery<MembershipQueryData>({
      queryKey: membershipsKey,
      queryFn: () => readProjectMemberships(api, refreshedProjectIds),
      staleTime: 0,
      retry: false
    });
    if (!isCurrentSession()) throw new Error("登录身份已变化，刷新结果不能应用。");
    const tasksKey = projectTaskQueryKeys.tasks(subjectId, sessionGeneration);
    const refreshedTasks = await queryClient.fetchQuery<TaskQueryData>({
      queryKey: tasksKey,
      queryFn: async () => {
        const items = await listAllTasks(api);
        return readTaskRelationships(api, items);
      },
      staleTime: 0,
      retry: false
    });
    if (!isCurrentSession()) throw new Error("登录身份已变化，刷新结果不能应用。");
    const expectedTaskIds = refreshedTasks.items.map((task) => task.id);
    const refreshedQueries = [projectsKey, membershipsKey, tasksKey].map((queryKey) => queryClient.getQueryCache().find({ queryKey, exact: true }));
    const [projectsQuery, membershipsQuery, tasksQuery] = refreshedQueries;
    if (!isCompleteProjectTaskQuery(projectsQuery, true)
      || !isCompleteProjectTaskQuery(membershipsQuery, !hasIncompleteProjectTaskRead(refreshedMemberships, refreshedProjectIds))
      || !isCompleteProjectTaskQuery(tasksQuery, !hasIncompleteProjectTaskRead(refreshedTasks, [], expectedTaskIds))) {
      throw new Error("项目、成员、任务或关系列表刷新不完整，待确认结果仍然保留。");
    }
    return { projects: refreshedProjects, memberships: refreshedMemberships, tasks: refreshedTasks };
  }, [api, isCurrentSession, queryClient, sessionGeneration, subjectId]);
  useEffect(() => {
    if (!queryEnabled || typeof window === "undefined") return;
    const apply = (state: MutationNoticeStorageRead, preserveVolatile = false) => {
      if (!preserveVolatile) {
        queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, state.notices);
        return;
      }
      const current = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
      queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, mergePersistedMutationNoticeState(current, state));
    };
    const refreshAfterRemoteRemoval = async (removedNotices: readonly MutationNotice[], removedIds: readonly string[]) => {
      const scopes = mutationNoticeRemovalScopes(removedNotices, removedIds);
      if (!scopes.length) return;
      const marked = markMutationRefreshScopes(remoteRefreshScopesRef.current, scopes, remoteRefreshRevisionRef.current);
      remoteRefreshRevisionRef.current = marked.nextRevision;
      let refreshed = false;
      try {
        await refreshProjectTaskQueries();
        const persistedState = readPersistedMutationNoticeState(subjectId);
        if (!persistedState.available) throw new Error("待确认状态无法读取，刷新结果不能解除写入屏障。");
        queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, (current = []) => mergePersistedMutationNoticeState(current, persistedState, removedNotices));
        refreshed = true;
      } catch {
        // Keep the existing notice and refreshing barrier so a failed read cannot unlock a stale write.
      } finally {
        if (refreshed) releaseMutationRefreshScopes(remoteRefreshScopesRef.current, marked.revisions);
      }
    };
    apply(readPersistedMutationNoticeState(subjectId), true);
    const handleStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith(mutationNoticeStoragePrefixValue)) return;
      const removedNotice = event.newValue === null ? parseSerializedMutationNotice(event.oldValue) : undefined;
      if (removedNotice) {
        const current = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
        const persisted = readPersistedMutationNoticeState(subjectId);
        if (!persisted.available) {
          queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, mergeMutationNoticeChanges(current, persisted.notices, []));
          void refreshAfterRemoteRemoval([removedNotice], [removedNotice.id]);
          return;
        }
        queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, mergeMutationNoticeChanges(current, persisted.notices, [removedNotice.id], [removedNotice]));
        void refreshAfterRemoteRemoval([removedNotice], [removedNotice.id]);
        return;
      }
      apply(readPersistedMutationNoticeState(subjectId), true);
    };
    const handleBroadcast = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object") return;
      const signal = event.data as { principalId?: unknown; added?: unknown; removed?: unknown; removedNotices?: unknown };
      if (signal.principalId !== subjectId) return;
      const current = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
      const removed = Array.isArray(signal.removed) ? signal.removed.filter((id): id is string => typeof id === "string") : [];
      const removedNotices = Array.isArray(signal.removedNotices) ? signal.removedNotices.map(parseMutationNotice).filter((notice): notice is MutationNotice => Boolean(notice)) : [];
      const added = Array.isArray(signal.added) ? signal.added.map(parseMutationNotice).filter((notice): notice is MutationNotice => Boolean(notice)) : [];
      if (removed.length) {
        const persisted = readPersistedMutationNoticeState(subjectId);
        if (!persisted.available) {
          queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, mergeMutationNoticeChanges(current, [...persisted.notices, ...added], []));
          void refreshAfterRemoteRemoval([...current, ...removedNotices, ...persisted.notices], removed);
          return;
        }
        queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, mergeMutationNoticeChanges(current, added, removed, removedNotices));
        void refreshAfterRemoteRemoval([...current, ...removedNotices], removed);
        return;
      }
      apply({ available: false, shared: false, notices: mergeMutationNoticeChanges(current, added, []) });
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
  }, [mutationNoticeKey, mutationNoticeStoragePrefixValue, queryClient, queryEnabled, refreshProjectTaskQueries, remoteRefreshScopesRef, subjectId]);
  const applyMutationNoticeUpdate = useCallback((update: (current: readonly MutationNotice[]) => readonly MutationNotice[], allowLocalFallback = false): MutationNoticeUpdateResult => {
    const current = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
    const next = update(current);
    const currentById = new Map(current.map((notice) => [notice.id, notice] as const));
    const nextById = new Map(next.map((notice) => [notice.id, notice] as const));
    const removed = [...currentById.keys()].filter((id) => !nextById.has(id));
    const added = [...nextById.values()].filter((notice) => {
      const previous = currentById.get(notice.id);
      return previous?.message !== notice.message || previous?.kind !== notice.kind || previous?.lockScope !== notice.lockScope || previous?.identityMismatch !== notice.identityMismatch || previous?.volatile !== notice.volatile || previous?.projectId !== notice.projectId || previous?.taskId !== notice.taskId;
    });
    if (added.length || removed.length) {
      const removedNotices = removed.map((id) => currentById.get(id)).filter((notice): notice is MutationNotice => Boolean(notice));
      const persisted = publishMutationNoticeChanges(subjectId, added, removed, removedNotices);
      if (!persisted && !allowLocalFallback) return { applied: false, persisted: false };
      const localNext = persisted ? next : next.map((notice) => added.some((addedNotice) => addedNotice.id === notice.id) ? { ...notice, volatile: true } : notice);
      queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, localNext);
      return { applied: true, persisted };
    }
    queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, next);
    return { applied: true, persisted: true };
  }, [mutationNoticeKey, queryClient, subjectId]);
  const updateMutationNotices = useCallback((update: (current: readonly MutationNotice[]) => readonly MutationNotice[]) => applyMutationNoticeUpdate(update).persisted, [applyMutationNoticeUpdate]);
  const writeMutationNotice = useCallback((id: string, message: string, kind: MutationNotice["kind"] = "reconciliation", taskId?: string, projectId?: string, lockScope?: string, allowLocalFallback = false, identityMismatch = false): MutationNoticeUpdateResult => {
    return applyMutationNoticeUpdate((current) => {
      const previous = current.find((notice) => notice.id === id);
      const retainedLockScope = lockScope ?? previous?.lockScope;
      return [
        ...current.filter((notice) => notice.id !== id),
        { id, message, kind, ...(retainedLockScope ? { lockScope: retainedLockScope } : {}), ...(identityMismatch || previous?.identityMismatch ? { identityMismatch: true } : {}), ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) }
      ];
    }, allowLocalFallback);
  }, [applyMutationNoticeUpdate]);
  const recordMutationNotice = useCallback((id: string, message: string, kind: MutationNotice["kind"] = "reconciliation", taskId?: string, projectId?: string, lockScope?: string) => writeMutationNotice(id, message, kind, taskId, projectId, lockScope).persisted, [writeMutationNotice]);
  const recordMutationNoticeWithFallback = useCallback((id: string, message: string, kind: MutationNotice["kind"] = "reconciliation", taskId?: string, projectId?: string, lockScope?: string, identityMismatch = false) => writeMutationNotice(id, message, kind, taskId, projectId, lockScope, true, identityMismatch), [writeMutationNotice]);
  const clearMutationNotice = useCallback((id: string) => {
    return updateMutationNotices((current) => current.filter((notice) => notice.id !== id));
  }, [updateMutationNotices]);
  const clearTaskMutationNotices = useCallback((taskId: string) => {
    return updateMutationNotices((current) => current.filter((notice) => mutationNoticeTaskId(notice) !== taskId));
  }, [updateMutationNotices]);
  const clearProjectMutationNotices = useCallback((projectId: string) => {
    return updateMutationNotices((current) => current.filter((notice) => mutationNoticeProjectId(notice) !== projectId));
  }, [updateMutationNotices]);
  const reconciliationNoticeByTaskId = useMemo(() => {
    const messages = new Map<string, string[]>();
    mutationNoticeQuery.data.forEach((notice) => {
      const taskId = mutationNoticeTaskId(notice);
      if (!taskId) return;
      const current = messages.get(taskId) ?? [];
      current.push(notice.message);
      messages.set(taskId, current);
    });
    return new Map([...messages.entries()].map(([taskId, values]) => [taskId, values.join("；")] as const));
  }, [mutationNoticeQuery.data]);
  const reconciliationNoticeByProjectId = useMemo(() => {
    const messages = new Map<string, string[]>();
    mutationNoticeQuery.data.forEach((notice) => {
      const projectId = mutationNoticeProjectId(notice);
      if (!projectId) return;
      const current = messages.get(projectId) ?? [];
      current.push(notice.message);
      messages.set(projectId, current);
    });
    return new Map([...messages.entries()].map(([projectId, values]) => [projectId, values.join("；")] as const));
  }, [mutationNoticeQuery.data]);
  const pendingProjectCreationNotice = mutationNoticeQuery.data.find((notice) => mutationNoticeScope(notice) === "project:create");
  const pendingTaskCreationNotice = mutationNoticeQuery.data.find((notice) => mutationNoticeScope(notice) === "task:create");
  const pendingProjectCreation = Boolean(pendingProjectCreationNotice);
  const pendingTaskCreation = Boolean(pendingTaskCreationNotice);
  const pendingProjectCreationResourceId = pendingProjectCreationNotice?.projectId;
  const pendingTaskCreationResourceId = pendingTaskCreationNotice?.taskId;
  const pendingProjectCreationNoticeId = mutationNoticeQuery.data.find((notice) => isPendingProjectCreationNotice(notice))?.id;
  const pendingTaskCreationNoticeId = mutationNoticeQuery.data.find((notice) => isPendingTaskCreationNotice(notice))?.id;

  const handleFailure = useCallback(<T,>(operation: string, error: unknown): WriteResult<T> => failure<T>(operation, error), []);

  const createProjectMutation = useMutation({
    mutationFn: ({ draft, projectId }: { draft: ProjectDraft; projectId: string }) => api.createProject({ body: { id: projectId, name: draft.name.trim(), description: draft.summary.trim() || undefined } }),
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
    mutationFn: ({ draft, taskId }: { draft: TaskDraft; taskId: string }) => api.createTask({ body: { id: taskId, title: draft.title.trim(), goal: draft.goal.trim(), project_id: draft.projectId, status: taskStatus(draft.state) } })
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
    return projectsQuery.isSuccess ? projectsQuery.data
      .filter((project) => !denied.has(project.id))
      .map((project) => {
        const mapped = mapProject(project);
        const reconciliationNotice = reconciliationNoticeByProjectId.get(project.id);
        return reconciliationNotice ? { ...mapped, reconciliationNotice } : mapped;
      }) : [];
  }, [deniedProjectIds, projectsQuery.data, projectsQuery.isSuccess, reconciliationNoticeByProjectId]);
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

    const mutationPersistenceFailure = <T,>(operation: string, noticeId?: string): WriteResult<T> => ({
      ...blocked(`${operation}的确认状态无法保存，写入没有执行。`),
      ...(noticeId ? { noticeId } : {})
    });
    const beginMutation = <T,>(noticeId: string, message: string, taskId?: string, projectId?: string, lockScope?: string): WriteResult<T> | undefined => recordMutationNotice(noticeId, message, "in-flight", taskId, projectId, lockScope) ? undefined : mutationPersistenceFailure("本次写入");
    const finishMutation = <T,>(noticeId: string, value: T, operation: string): WriteResult<T> => clearMutationNotice(noticeId)
      ? success(value)
      : { ...success(value, `${operation}已完成，但结果确认状态无法保存；请刷新后核对。`, true), noticeId };
    const clearFailedMutation = <T,>(noticeId: string, result: WriteResult<T>, operation: string): WriteResult<T> => clearMutationNotice(noticeId)
      ? result
      : blocked(`${operation}失败，但结果确认状态无法保存；请刷新后核对。`);
    const mutationBarrier = <T,>(scope: string, operation: string): WriteResult<T> | undefined => {
      if (remoteRefreshScopesRef.current.has(scope)) return blocked(`${operation}已有结果待确认，请先刷新并核对后再试。`);
      if (hasPersistedMutationBarrier(subjectId, scope)) return blocked(`${operation}的待确认状态无法读取或尚未核对，写入没有执行。请先刷新并核对后再试。`);
      return undefined;
    };
    const relationMutationBarrier = <T,>(taskId: string, changes: TaskRelationChanges, operation: string): WriteResult<T> | undefined => {
      const endpointIds = [...new Set([taskId, ...relationTargetIds(changes)].filter(Boolean))];
      for (const endpointId of endpointIds) {
        const barrier = mutationBarrier<T>(`task:${endpointId}`, operation);
        if (barrier) return blocked(`任务 ${endpointId} 的关系结果待确认，${operation}没有执行。`);
      }
      return undefined;
    };

    const createProject = async (draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
      const barrier = mutationBarrier<ReturnType<typeof mapProject>>("project:create", "项目创建");
      if (barrier) return barrier;
      if (!canCreateProjects || !projectWriteReady) return denied("当前身份或连接状态不能确认项目写入范围，项目写入没有执行。");
      return runWithBrowserMutationLock(subjectId, "project:create", async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
        const barrier = mutationBarrier<ReturnType<typeof mapProject>>("project:create", "项目创建");
        if (barrier) return barrier;
        const createNoticeId = createMutationNoticeId("project");
        const projectId = createClientResourceId("project");
        if (!projectId) return blocked("无法生成项目确认身份，项目写入没有执行。");
        const blockedResult = beginMutation<ReturnType<typeof mapProject>>(createNoticeId, "项目创建正在进行，请等待本次操作完成。", undefined, projectId, "project:create");
        if (blockedResult) return blockedResult;
        try {
          const response = await createProjectMutation.mutateAsync({ draft, projectId });
          if (response.project.id !== projectId) {
            const message = "服务端未返回预选项目身份，写入结果待确认；请刷新后核对。";
            const notice = recordMutationNoticeWithFallback(createNoticeId, message, "reconciliation", undefined, projectId, "project:create", true);
            if (!notice.applied || !notice.persisted) return mutationPersistenceFailure("项目创建", createNoticeId);
            return { ...blocked<ReturnType<typeof mapProject>>(message), noticeId: createNoticeId };
          }
          const value = mapProject(response.project);
          const notice = recordMutationNoticeWithFallback(createNoticeId, "项目已创建，正在确认本次写入。", "in-flight", undefined, projectId, "project:create");
          if (!notice.applied) return { ...success(value, "项目已创建，但确认状态无法保存；请刷新后核对，切勿重复提交。", true), noticeId: createNoticeId };
          return finishMutation(createNoticeId, value, "项目创建");
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(true);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<ReturnType<typeof mapProject>>("创建项目", error) : handleFailure<ReturnType<typeof mapProject>>("创建项目", error);
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(createNoticeId, result.message, "creation", undefined, projectId, "project:create")) return mutationPersistenceFailure("项目创建");
            return { ...result, noticeId: createNoticeId };
          }
          return clearFailedMutation(createNoticeId, result, "项目创建");
        }
      });
    };
    const updateProject = async (targetProjectId: string, draft: ProjectDraft): Promise<WriteResult<ReturnType<typeof mapProject>>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
      const barrier = mutationBarrier<ReturnType<typeof mapProject>>(`project:${targetProjectId}`, "项目更新");
      if (barrier) return barrier;
      if (!getProjectPermissions(targetProjectId).canManageProjects) return denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
      const current = getProject(targetProjectId);
      const body = toProjectUpdateRequest(current, draft);
      if (!Object.keys(body).length && current) return success(current);
      return runWithBrowserMutationLock(subjectId, `project:${targetProjectId}`, async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
        const barrier = mutationBarrier<ReturnType<typeof mapProject>>(`project:${targetProjectId}`, "项目更新");
        if (barrier) return barrier;
        const operationNoticeId = createProjectMutationNoticeId(targetProjectId);
        const blockedResult = beginMutation<ReturnType<typeof mapProject>>(operationNoticeId, "项目更新正在进行，请等待本次操作完成。", undefined, targetProjectId, `project:${targetProjectId}`);
        if (blockedResult) return blockedResult;
        try {
          const response = await updateProjectMutation.mutateAsync({ projectId: targetProjectId, draft, current });
          return finishMutation(operationNoticeId, mapProject(response.project), "项目更新");
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(true);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<ReturnType<typeof mapProject>>("更新项目", error) : handleFailure<ReturnType<typeof mapProject>>("更新项目", error);
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(operationNoticeId, result.message, "reconciliation", undefined, targetProjectId)) return mutationPersistenceFailure("项目更新");
            return { ...result, noticeId: operationNoticeId };
          }
          return clearFailedMutation(operationNoticeId, result, "项目更新");
        }
      });
    };
    const deleteProject = async (targetProjectId: string): Promise<WriteResult<null>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
      const barrier = mutationBarrier<null>(`project:${targetProjectId}`, "项目删除");
      if (barrier) return barrier;
      if (!getProjectPermissions(targetProjectId).canManageProjects) return denied("当前身份或权限不能管理项目或成员，项目写入没有执行。");
      return runWithBrowserMutationLock(subjectId, `project:${targetProjectId}`, async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，项目写入没有执行。");
        const barrier = mutationBarrier<null>(`project:${targetProjectId}`, "项目删除");
        if (barrier) return barrier;
        const operationNoticeId = createProjectMutationNoticeId(targetProjectId);
        const blockedResult = beginMutation<null>(operationNoticeId, "项目删除正在进行，请等待本次操作完成。", undefined, targetProjectId, `project:${targetProjectId}`);
        if (blockedResult) return blockedResult;
        try {
          await deleteProjectMutation.mutateAsync(targetProjectId);
          return finishMutation(operationNoticeId, null, "项目删除");
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(true);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<null>("删除项目", error) : handleFailure<null>("删除项目", error);
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(operationNoticeId, result.message, "reconciliation", undefined, targetProjectId)) return mutationPersistenceFailure("项目删除");
            return { ...result, noticeId: operationNoticeId };
          }
          return clearFailedMutation(operationNoticeId, result, "项目删除");
        }
      });
    };
    const createTask = async (draft: TaskDraft): Promise<WriteResult<TaskRecord>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
      const barrier = mutationBarrier<TaskRecord>("task:create", "任务创建");
      if (barrier) return barrier;
      if (!getProjectPermissions(draft.projectId).canWrite) return denied();
      const relationChanges: TaskRelationChanges = {
        addParentIds: [...new Set(draft.parentIds ?? (draft.parentId ? [draft.parentId] : []))],
        addDependencyIds: [...new Set(draft.dependsOn ?? [])]
      };
      const relationBlock = relationWriteBlockReason("", relationChanges, getTask, getProjectPermissions);
      if (relationBlock) return denied(relationBlock);
      const relationBarrier = relationMutationBarrier<TaskRecord>("", relationChanges, "任务关系写入");
      if (relationBarrier) return relationBarrier;
      return runWithBrowserMutationLock(subjectId, "task:create", async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
        const barrier = mutationBarrier<TaskRecord>("task:create", "任务创建");
        if (barrier) return barrier;
        const relationBarrier = relationMutationBarrier<TaskRecord>("", relationChanges, "任务关系写入");
        if (relationBarrier) return relationBarrier;
        const createNoticeId = createMutationNoticeId("task");
        const taskId = createClientResourceId("task");
        if (!taskId) return blocked("无法生成任务确认身份，任务写入没有执行。");
        const blockedResult = beginMutation<TaskRecord>(createNoticeId, "任务创建正在进行，请等待本次操作完成。", taskId, undefined, "task:create");
        if (blockedResult) return blockedResult;
        const hasRelationChanges = Boolean(relationChanges.addParentIds?.length || relationChanges.addDependencyIds?.length);
        let createdTaskId: string | undefined;
        let createdTaskValue: TaskRecord | undefined;
        const createdTaskPersistenceFailure = (message: string): WriteResult<TaskRecord> => createdTaskValue
          ? { ...success(createdTaskValue, `${message}确认状态无法保存；请刷新后核对，切勿重复提交。`, true), noticeId: createNoticeId }
          : mutationPersistenceFailure("任务创建", createNoticeId);
        try {
          const response = await createTaskMutation.mutateAsync({ draft, taskId });
          if (response.task.id !== taskId) {
            const message = "服务端未返回预选任务身份，写入结果待确认；请刷新后核对。";
            const notice = recordMutationNoticeWithFallback(createNoticeId, message, "reconciliation", taskId, undefined, "task:create", true);
            if (!notice.applied || !notice.persisted) return mutationPersistenceFailure("任务创建", createNoticeId);
            return { ...blocked<TaskRecord>(message), noticeId: createNoticeId };
          }
          createdTaskId = taskId;
          const value = mapTask(response.task);
          createdTaskValue = value;
          const notice = recordMutationNoticeWithFallback(createNoticeId, hasRelationChanges ? "任务已创建，关系写入正在进行，请等待本次操作完成。" : "任务已创建，正在确认本次写入。", "in-flight", taskId, undefined, "task:create");
          if (!notice.applied) return createdTaskPersistenceFailure("任务已创建，但确认状态无法保存；");
          const completeCreatedTask = async (): Promise<WriteResult<TaskRecord>> => {
            if (hasRelationChanges) {
              const relationBlock = relationWriteBlockReason("", relationChanges, getTask, getProjectPermissions);
              const relationBarrier = relationMutationBarrier<TaskRecord>("", relationChanges, "任务关系写入");
              if (relationBlock || relationBarrier) {
                const warning = relationBlock ?? (relationBarrier && !relationBarrier.ok ? relationBarrier.message : undefined) ?? "关系写入结果待确认。";
                const notice = recordMutationNoticeWithFallback(createNoticeId, warning, "reconciliation", taskId, undefined, `task:${taskId}`);
                if (!notice.applied || !notice.persisted) return createdTaskPersistenceFailure(warning);
                return { ...blocked<TaskRecord>(`${warning}请刷新后核对。`), reconcile: true, noticeId: createNoticeId };
              }
              relationMutationsInFlight.current.add(response.task.id);
              setRelationMutationPending(response.task.id, true);
              if (!isCurrentSession()) {
                const warning = "任务已创建，但登录身份已变化，关系写入没有继续；请重新登录后核对。";
                const notice = recordMutationNoticeWithFallback(createNoticeId, warning, "reconciliation", taskId, undefined, `task:${taskId}`);
                if (!notice.applied || !notice.persisted) return createdTaskPersistenceFailure(warning);
                return { ...success(value, warning, true), noticeId: createNoticeId };
              }
              const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, relationChanges);
              if (relationResult.failures.length) {
                if (relationResult.failures.some((item) => item.status === 401 || item.status === 403 || item.status === 404)) await invalidatePermissionScope(false);
                const warning = "任务已创建，但部分关系未保存：" + relationResult.failures.map((item) => item.message).join("；") + "。请刷新后核对。";
                const notice = recordMutationNoticeWithFallback(createNoticeId, warning, "reconciliation", taskId, undefined, `task:${taskId}`);
                if (!notice.applied || !notice.persisted) return createdTaskPersistenceFailure(warning);
                return { ...success(value, warning, true, { failures: relationResult.failures, applied: relationResult.applied }), noticeId: createNoticeId };
              }
            } else {
              await queryClient.invalidateQueries({ queryKey: projectTaskQueryKeys.tasks(subjectId, sessionGeneration) });
            }
            return finishMutation(createNoticeId, value, "任务创建");
          };
          if (!hasRelationChanges) return completeCreatedTask();
          const relationResult = await runWithBrowserMutationLock(subjectId, `task:${response.task.id}`, completeCreatedTask, false);
          return !relationResult.ok && relationResult.code === "blocked"
            ? { ...relationResult, reconcile: true, noticeId: createNoticeId }
            : relationResult;
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(false);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<TaskRecord>("创建任务", error) : handleFailure<TaskRecord>("创建任务", error);
          if (createdTaskId) {
            const resultMessage = result.ok ? result.warning ?? "后续写入没有完成。" : result.message;
            const message = `任务已创建，但后续写入结果待确认：${resultMessage}请刷新后核对。`;
            const notice = recordMutationNoticeWithFallback(createNoticeId, message, "reconciliation", createdTaskId, undefined, `task:${createdTaskId}`);
            if (!notice.applied || !notice.persisted) return createdTaskPersistenceFailure(message);
            return { ...result, noticeId: createNoticeId };
          }
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(createNoticeId, result.message, "creation", taskId, undefined, "task:create")) return mutationPersistenceFailure("任务创建");
            return { ...result, noticeId: createNoticeId };
          }
          return clearFailedMutation(createNoticeId, result, "任务创建");
        } finally {
          if (createdTaskId && relationMutationsInFlight.current.has(createdTaskId)) {
            relationMutationsInFlight.current.delete(createdTaskId);
            setRelationMutationPending(createdTaskId, false);
          }
        }
      });
    };
    const updateTask = async (taskId: string, update: TaskUpdate): Promise<WriteResult<TaskRecord>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
      const barrier = mutationBarrier<TaskRecord>(`task:${taskId}`, "任务更新");
      if (barrier) return barrier;
      const existingTask = getTask(taskId);
      const reconciliationBlock = taskWriteBlockReason(existingTask);
      if (reconciliationBlock) return blocked(reconciliationBlock);
      if (!getProjectPermissions(existingTask?.projectId).canWrite) return denied();
      const relationChanges = update.relationChanges;
      const hasRelationChanges = Boolean(relationChanges && Object.keys(relationChanges).length);
      const body = toTaskUpdateRequest(update);
      const operationNoticeId = Object.keys(body).length || hasRelationChanges ? createTaskMutationNoticeId(taskId) : undefined;
      if (!operationNoticeId) return existingTask ? success(existingTask) : handleFailure("更新任务", new Error("任务上下文不可用。"));
      if (hasRelationChanges && relationChanges) {
        const relationBlock = relationWriteBlockReason(taskId, relationChanges, getTask, getProjectPermissions);
        if (relationBlock) return denied(relationBlock);
        const relationBarrier = relationMutationBarrier<TaskRecord>(taskId, relationChanges, "任务关系写入");
        if (relationBarrier) return relationBarrier;
      }
      return runWithTaskMutationLocks(subjectId, taskId, async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
        const barrier = mutationBarrier<TaskRecord>(`task:${taskId}`, "任务更新");
        if (barrier) return barrier;
        if (hasRelationChanges && relationChanges) {
          const relationBlock = relationWriteBlockReason(taskId, relationChanges, getTask, getProjectPermissions);
          if (relationBlock) return denied(relationBlock);
          const relationBarrier = relationMutationBarrier<TaskRecord>(taskId, relationChanges, "任务关系写入");
          if (relationBarrier) return relationBarrier;
        }
        if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
        const blockedResult = beginMutation<TaskRecord>(operationNoticeId, hasRelationChanges ? "任务关系写入正在进行，请等待本次操作完成。" : "任务更新正在进行，请等待本次操作完成。", taskId, undefined, `task:${taskId}`);
        if (blockedResult) return blockedResult;
        if (hasRelationChanges) {
          relationMutationsInFlight.current.add(taskId);
          setRelationMutationPending(taskId, true);
        }
        try {
          const response = Object.keys(body).length ? await updateTaskMutation.mutateAsync({ taskId, update }) : undefined;
          const value = response ? mapTask(response.task, relationshipsByTaskId[taskId]) : existingTask;
          if (!value) return clearFailedMutation(operationNoticeId, handleFailure("更新任务", new Error("任务上下文不可用。")), "任务更新");
          if (hasRelationChanges && relationChanges) {
            if (!isCurrentSession()) {
              const warning = "任务已更新，但登录身份已变化，关系写入没有继续；请重新登录后核对。";
              if (!recordMutationNotice(operationNoticeId, warning, "reconciliation", taskId)) return mutationPersistenceFailure("任务关系写入");
              return { ...success(value, warning, true), noticeId: operationNoticeId };
            }
            const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, relationChanges);
            if (relationResult.failures.length) {
              if (relationResult.failures.some((item) => item.status === 401 || item.status === 403 || item.status === 404)) await invalidatePermissionScope(false);
              const warning = "任务已更新，但部分关系未保存：" + relationResult.failures.map((item) => item.message).join("；") + "。请刷新后核对。";
              if (!recordMutationNotice(operationNoticeId, warning, "reconciliation", taskId)) return mutationPersistenceFailure("任务关系写入");
              return { ...success(value, warning, true, { failures: relationResult.failures, applied: relationResult.applied }), noticeId: operationNoticeId };
            }
          }
          return finishMutation(operationNoticeId, value, "任务更新");
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(false);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<TaskRecord>("更新任务", error) : handleFailure<TaskRecord>("更新任务", error);
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(operationNoticeId, result.message, "reconciliation", taskId)) return mutationPersistenceFailure("任务更新");
            return { ...result, noticeId: operationNoticeId };
          }
          return clearFailedMutation(operationNoticeId, result, "任务更新");
        } finally {
          if (hasRelationChanges) {
            relationMutationsInFlight.current.delete(taskId);
            setRelationMutationPending(taskId, false);
          }
        }
      });
    };
    const deleteTask = async (taskId: string): Promise<WriteResult<null>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
      const barrier = mutationBarrier<null>(`task:${taskId}`, "任务删除");
      if (barrier) return barrier;
      const task = getTask(taskId);
      const reconciliationBlock = taskWriteBlockReason(task);
      if (reconciliationBlock) return blocked(reconciliationBlock);
      if (!getProjectPermissions(task?.projectId).canWrite) return denied();
      return runWithTaskMutationLocks(subjectId, taskId, async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，任务写入没有执行。");
        const barrier = mutationBarrier<null>(`task:${taskId}`, "任务删除");
        if (barrier) return barrier;
        if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
        const operationNoticeId = createTaskMutationNoticeId(taskId);
        const blockedResult = beginMutation<null>(operationNoticeId, "任务删除正在进行，请等待本次操作完成。", taskId, undefined, `task:${taskId}`);
        if (blockedResult) return blockedResult;
        try {
          await deleteTaskMutation.mutateAsync(taskId);
          return finishMutation(operationNoticeId, null, "任务删除");
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(false);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<null>("删除任务", error) : handleFailure<null>("删除任务", error);
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(operationNoticeId, result.message, "reconciliation", taskId)) return mutationPersistenceFailure("任务删除");
            return { ...result, noticeId: operationNoticeId };
          }
          return clearFailedMutation(operationNoticeId, result, "任务删除");
        }
      });
    };
    const changeTaskRelations = async (taskId: string, changes: TaskRelationChanges): Promise<WriteResult<null>> => {
      if (!isCurrentSession()) return blocked("登录身份已变化，关系写入没有执行。");
      const barrier = mutationBarrier<null>(`task:${taskId}`, "任务关系写入");
      if (barrier) return barrier;
      const task = getTask(taskId);
      const reconciliationBlock = taskWriteBlockReason(task);
      if (reconciliationBlock) return blocked(reconciliationBlock);
      if (!getProjectPermissions(task?.projectId).canWrite) return denied();
      if (!Object.keys(changes).length) return success(null);
      const relationBlock = relationWriteBlockReason(taskId, changes, getTask, getProjectPermissions);
      if (relationBlock) return denied(relationBlock);
      const relationBarrier = relationMutationBarrier<null>(taskId, changes, "任务关系写入");
      if (relationBarrier) return relationBarrier;
      return runWithTaskMutationLocks(subjectId, taskId, async () => {
        if (!isCurrentSession()) return blocked("登录身份已变化，关系写入没有执行。");
        const barrier = mutationBarrier<null>(`task:${taskId}`, "任务关系写入");
        if (barrier) return barrier;
        const relationBlock = relationWriteBlockReason(taskId, changes, getTask, getProjectPermissions);
        if (relationBlock) return denied(relationBlock);
        const relationBarrier = relationMutationBarrier<null>(taskId, changes, "任务关系写入");
        if (relationBarrier) return relationBarrier;
        if (relationMutationsInFlight.current.has(taskId)) return denied("任务关系写入正在进行，请等待本次操作完成。");
        const operationNoticeId = createTaskMutationNoticeId(taskId);
        const blockedResult = beginMutation<null>(operationNoticeId, "任务关系写入正在进行，请等待本次操作完成。", taskId, undefined, `task:${taskId}`);
        if (blockedResult) return blockedResult;
        relationMutationsInFlight.current.add(taskId);
        setRelationMutationPending(taskId, true);
        try {
          if (!isCurrentSession()) {
            const warning = "登录身份已变化，任务关系写入没有继续；请重新登录后核对。";
            if (!recordMutationNotice(operationNoticeId, warning, "reconciliation", taskId)) return mutationPersistenceFailure("任务关系写入");
            return { ...success(null, warning, true), noticeId: operationNoticeId };
          }
          const relationResult = await syncTaskRelations(api, queryClient, subjectId, sessionGeneration, taskId, changes);
          if (relationResult.failures.length) {
            if (relationResult.failures.some((item) => item.status === 401 || item.status === 403 || item.status === 404)) await invalidatePermissionScope(false);
            const warning = "任务关系仅部分保存：" + relationResult.failures.map((item) => item.message).join("；") + "。请刷新后核对。";
            if (!recordMutationNotice(operationNoticeId, warning, "reconciliation", taskId)) return mutationPersistenceFailure("任务关系写入");
            return { ...success(null, warning, true, { failures: relationResult.failures, applied: relationResult.applied }), noticeId: operationNoticeId };
          }
          return finishMutation(operationNoticeId, null, "任务关系写入");
        } catch (error) {
          if (isPermissionError(error)) await invalidatePermissionScope(false);
          const result = isAmbiguousWriteError(error) ? ambiguousFailure<null>("更新任务关系", error) : handleFailure<null>("更新任务关系", error);
          if (!result.ok && result.reconcile) {
            if (!recordMutationNotice(operationNoticeId, result.message, "reconciliation", taskId)) return mutationPersistenceFailure("任务关系写入");
            return { ...result, noticeId: operationNoticeId };
          }
          return clearFailedMutation(operationNoticeId, result, "任务关系写入");
        } finally {
          relationMutationsInFlight.current.delete(taskId);
          setRelationMutationPending(taskId, false);
        }
      });
    };
    const refresh = async (): Promise<void> => {
      const remoteRefreshScopes = new Map(remoteRefreshScopesRef.current);
      await refreshProjectTaskQueries();
      const persistedState = readPersistedMutationNoticeState(subjectId);
      const currentNotices = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
      if (!persistedState.available) throw new Error("待确认状态无法读取，刷新结果不能解除写入屏障。");
      if (persistedState.available) {
        queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, () => mergePersistedMutationNoticeState(currentNotices, persistedState));
      }
      const notices = queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
      for (const notice of notices) {
        if (!isInFlightMutationNotice(notice)) continue;
        const scope = mutationNoticeScope(notice);
        if (!scope) continue;
        const taskId = mutationNoticeTaskId(notice);
        const pendingCreation = isPendingProjectCreationNotice(notice) || isPendingTaskCreationNotice(notice);
        const message = taskId
          ? "任务写入结果待确认；完整刷新已完成，请确认当前状态后解除阻塞。"
          : pendingCreation
            ? "创建结果待确认；完整刷新已完成，请确认列表中没有本次写入后再解除阻塞。"
            : "项目写入结果待确认；完整刷新已完成，请确认当前状态后解除阻塞。";
        const result = await withAvailableBrowserMutationLock(subjectId, scope, "busy" as const, async () => {
          const persistedState = readPersistedMutationNoticeState(subjectId);
          const persistedNotices = mergePersistedMutationNotices(
            queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [],
            persistedState.notices,
            true
          );
          queryClient.setQueryData<readonly MutationNotice[]>(mutationNoticeKey, persistedNotices);
          const persistedNotice = persistedNotices.find((currentNotice) => currentNotice.id === notice.id);
          if (!persistedNotice
            || persistedNotice.kind !== "in-flight"
            || persistedNotice.message !== notice.message
            || persistedNotice.lockScope !== notice.lockScope
            || persistedNotice.projectId !== notice.projectId
            || persistedNotice.taskId !== notice.taskId) return "unchanged" as const;
          const persisted = updateMutationNotices((current) => current.map((currentNotice) => {
            const unchanged = currentNotice.id !== notice.id
              || currentNotice.kind !== "in-flight"
              || currentNotice.message !== notice.message
              || currentNotice.lockScope !== notice.lockScope
              || currentNotice.projectId !== notice.projectId
              || currentNotice.taskId !== notice.taskId;
            return unchanged ? currentNotice : { ...currentNotice, kind: pendingCreation ? "creation" as const : "reconciliation" as const, message };
          }));
          return persisted ? "converted" as const : "failed" as const;
        });
        if (result === "failed") throw new Error("写入结果确认状态无法保存，待确认结果仍然保留。");
      }
      releaseMutationRefreshScopes(remoteRefreshScopesRef.current, remoteRefreshScopes);
    };

    const currentMutationNotices = (): readonly MutationNotice[] => queryClient.getQueryData<readonly MutationNotice[]>(mutationNoticeKey) ?? [];
    const taskReconciliationNotices = (taskId: string): readonly MutationNotice[] => currentMutationNotices().filter((notice) => mutationNoticeTaskId(notice) === taskId);
    const projectReconciliationNotices = (projectId: string): readonly MutationNotice[] => currentMutationNotices().filter((notice) => mutationNoticeProjectId(notice) === projectId);
    const getTaskReconciliationToken = (taskId: string): string | undefined => {
      const notices = taskReconciliationNotices(taskId);
      return notices.length ? mutationNoticeContentToken(notices) : undefined;
    };
    const getProjectReconciliationToken = (projectId: string): string | undefined => {
      const notices = projectReconciliationNotices(projectId);
      return notices.length ? mutationNoticeContentToken(notices) : undefined;
    };
    const isTaskReconciliationReady = (taskId: string, expectedToken?: string): boolean => {
      const notices = taskReconciliationNotices(taskId);
      return notices.length > 0
        && (expectedToken === undefined || mutationNoticeContentToken(notices) === expectedToken)
        && notices.every((notice) => notice.kind !== "in-flight" && (!notice.identityMismatch || tasks.some((task) => task.id === taskId)));
    };
    const isProjectReconciliationReady = (projectId: string, expectedToken?: string): boolean => {
      const notices = projectReconciliationNotices(projectId);
      return notices.length > 0
        && (expectedToken === undefined || mutationNoticeContentToken(notices) === expectedToken)
        && notices.every((notice) => notice.kind !== "in-flight" && (!notice.identityMismatch || projects.some((project) => project.id === projectId)));
    };
    const isPendingProjectCreationReady = (noticeId: string): boolean => currentMutationNotices().some((notice) => notice.id === noticeId && isPendingProjectCreationNotice(notice) && notice.kind === "creation");
    const isPendingTaskCreationReady = (noticeId: string): boolean => currentMutationNotices().some((notice) => notice.id === noticeId && isPendingTaskCreationNotice(notice) && notice.kind === "creation");
    const acknowledgePendingNotice = (noticeId: string, pending: (notice: MutationNotice) => boolean): boolean => {
      let found = false;
      const persisted = updateMutationNotices((notices) => {
        found = notices.some((notice) => notice.id === noticeId && pending(notice) && notice.kind === "creation");
        return found ? notices.filter((notice) => notice.id !== noticeId) : notices;
      });
      return found && persisted;
    };

    return {
      projects,
      tasks,
      status: !enabled || !principalId ? "unauthenticated" : queryPending ? "loading" : queryError ? "error" : "ready",
      pendingProjectCreation,
      pendingTaskCreation,
      pendingProjectCreationResourceId,
      pendingTaskCreationResourceId,
      pendingProjectCreationNoticeId,
      pendingTaskCreationNoticeId,
      isPendingProjectCreationReady,
      isPendingTaskCreationReady,
      acknowledgePendingProjectCreation: (noticeId: string) => acknowledgePendingNotice(noticeId, isPendingProjectCreationNotice),
      acknowledgePendingTaskCreation: (noticeId: string) => acknowledgePendingNotice(noticeId, isPendingTaskCreationNotice),
      getTaskReconciliationToken,
      acknowledgeTaskReconciliation: (taskId: string, expectedToken?: string) => isTaskReconciliationReady(taskId, expectedToken) && clearTaskMutationNotices(taskId),
      isTaskReconciliationReady,
      getProjectReconciliationToken,
      acknowledgeProjectReconciliation: (projectId: string, expectedToken?: string) => isProjectReconciliationReady(projectId, expectedToken) && clearProjectMutationNotices(projectId),
      isProjectReconciliationReady,
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
  }, [api, canCreateProjects, clearMutationNotice, clearProjectMutationNotices, clearTaskMutationNotices, createProjectMutation, createTaskMutation, deleteProjectMutation, deleteTaskMutation, enabled, getProject, getProjectPermissions, getTask, handleFailure, invalidatePermissionScope, isCurrentSession, mutationNoticeKey, mutationNoticeQuery.data, pendingProjectCreation, pendingProjectCreationNoticeId, pendingProjectCreationResourceId, pendingTaskCreation, pendingTaskCreationNoticeId, pendingTaskCreationResourceId, permissionChanged, principalId, projectWriteReady, projects, queryError, queryPending, queryClient, readNotice, recordMutationNotice, recordMutationNoticeWithFallback, refreshProjectTaskQueries, relationshipsByTaskId, relationMutationsPending, remoteRefreshScopesRef, sessionGeneration, setRelationMutationPending, setTaskView, subjectId, taskViews, tasks, updateMutationNotices, updateProjectMutation, updateTaskMutation]);
}
