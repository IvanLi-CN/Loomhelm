import type { ProjectMemberRole } from "@loomhelm/protocol";
import type { TaskView } from "@/demo/types";
import type { ExecutionState, TaskState } from "@/demo/types";

export interface ProjectRecord {
  id: string;
  name: string;
  summary: string;
  description?: string;
  updatedAt: string;
  conversationCount: number;
  reconciliationNotice?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  goal: string;
  projectId: string;
  state: TaskState;
  execution: ExecutionState | null;
  conversationId?: string;
  parentId?: string;
  parentIds?: string[];
  dependsOn: string[];
  relationshipsConfirmed?: boolean;
  reconciliationNotice?: string;
  updated: string;
}

export type WriteFailureCode = "unauthenticated" | "csrf" | "readonly" | "blocked" | "unsupported" | "invalid" | "unknown";

export interface WriteFailure {
  ok: false;
  code: WriteFailureCode;
  message: string;
  status?: number;
  body?: unknown;
  reconcile?: boolean;
  noticeId?: string;
}

export interface RelationWriteFailure extends WriteFailure {
  label: string;
}

export interface RelationWriteMetadata {
  failures: readonly RelationWriteFailure[];
  applied?: TaskRelationChanges;
}

export type WriteResult<T> =
  | { ok: true; value: T; warning?: string; reconcile?: boolean; relation?: RelationWriteMetadata; noticeId?: string }
  | WriteFailure;

export type MutationResult<T> = Promise<WriteResult<T>>;

export const TASK_RECONCILIATION_BLOCK_MESSAGE = "任务关系尚未完成完整核对，当前任务的编辑、关系修改和删除已暂停。请手动刷新并完成核对。";
export const PROJECT_RECONCILIATION_BLOCK_MESSAGE = "项目写入结果尚未完成核对，当前项目编辑、删除和成员操作已暂停。请手动刷新并完成核对。";

export function taskWriteBlockReason(task: unknown): string | undefined {
  if (!task || typeof task !== "object") return undefined;
  const candidate = task as { relationshipsConfirmed?: unknown; reconciliationNotice?: unknown };
  if (candidate.relationshipsConfirmed !== false) return undefined;
  return typeof candidate.reconciliationNotice === "string" ? candidate.reconciliationNotice : TASK_RECONCILIATION_BLOCK_MESSAGE;
}

export function projectWriteBlockReason(project: unknown): string | undefined {
  if (!project || typeof project !== "object") return undefined;
  const candidate = project as { reconciliationNotice?: unknown };
  return typeof candidate.reconciliationNotice === "string" ? candidate.reconciliationNotice : undefined;
}

export interface ProjectPermissionSnapshot {
  role: ProjectMemberRole | null;
  canWrite: boolean;
  canManageProjects: boolean;
  isReadOnly: boolean;
}

export interface ProjectDraft {
  name: string;
  summary: string;
}

export interface TaskDraft {
  title: string;
  goal: string;
  projectId: string;
  state?: TaskState;
  parentId?: string;
  parentIds?: string[];
  dependsOn?: string[];
}

export interface TaskRelationChanges {
  addParentIds?: readonly string[];
  removeParentIds?: readonly string[];
  addDependencyIds?: readonly string[];
  removeDependencyIds?: readonly string[];
}

export interface TaskUpdate {
  title?: string;
  goal?: string;
  state?: TaskState;
  relationChanges?: TaskRelationChanges;
}

function relationDelta(initial: readonly string[], next: readonly string[]): { add: string[]; remove: string[] } {
  const initialSet = new Set(initial);
  const nextSet = new Set(next);
  return {
    add: [...nextSet].filter((id) => !initialSet.has(id)),
    remove: [...initialSet].filter((id) => !nextSet.has(id))
  };
}

export function calculateTaskRelationChanges(
  initialParentIds: readonly string[],
  nextParentIds: readonly string[],
  initialDependencyIds: readonly string[],
  nextDependencyIds: readonly string[]
): TaskRelationChanges | undefined {
  const parents = relationDelta(initialParentIds, nextParentIds);
  const dependencies = relationDelta(initialDependencyIds, nextDependencyIds);
  const changes: TaskRelationChanges = {};
  if (parents.add.length) changes.addParentIds = parents.add;
  if (parents.remove.length) changes.removeParentIds = parents.remove;
  if (dependencies.add.length) changes.addDependencyIds = dependencies.add;
  if (dependencies.remove.length) changes.removeDependencyIds = dependencies.remove;
  return Object.keys(changes).length ? changes : undefined;
}

export interface ProjectTaskSource {
  projects: readonly ProjectRecord[];
  tasks: readonly TaskRecord[];
  status: "ready" | "loading" | "error" | "permission-changed" | "unauthenticated";
  notice?: string;
  pendingProjectCreation?: boolean;
  pendingTaskCreation?: boolean;
  pendingProjectCreationNoticeId?: string;
  pendingTaskCreationNoticeId?: string;
  isPendingProjectCreationReady?: (noticeId: string) => boolean;
  isPendingTaskCreationReady?: (noticeId: string) => boolean;
  acknowledgePendingProjectCreation?: (noticeId: string) => boolean;
  acknowledgePendingTaskCreation?: (noticeId: string) => boolean;
  acknowledgeTaskReconciliation?: (taskId: string) => boolean;
  isTaskReconciliationReady?: (taskId: string) => boolean;
  acknowledgeProjectReconciliation?: (projectId: string) => boolean;
  isProjectReconciliationReady?: (projectId: string) => boolean;
  isTaskRelationWritePending?: (taskId: string) => boolean;
  canCreateProjects: boolean;
  getProjectPermissions: (projectId: string | undefined) => ProjectPermissionSnapshot;
  getProject: (projectId: string | undefined) => ProjectRecord | undefined;
  getTask: (taskId: string | undefined) => TaskRecord | undefined;
  getTasksForScope: (projectId?: string) => readonly TaskRecord[];
  getTaskView: (scope: string) => TaskView;
  setTaskView: (scope: string, view: TaskView) => void;
  createProject: (draft: ProjectDraft) => MutationResult<ProjectRecord>;
  updateProject: (projectId: string, draft: ProjectDraft) => MutationResult<ProjectRecord>;
  deleteProject: (projectId: string) => MutationResult<null>;
  createTask: (draft: TaskDraft) => MutationResult<TaskRecord>;
  updateTask: (taskId: string, update: TaskUpdate) => MutationResult<TaskRecord>;
  deleteTask: (taskId: string) => MutationResult<null>;
  changeTaskRelations: (taskId: string, changes: TaskRelationChanges) => MutationResult<null>;
  refresh: () => Promise<void>;
}

export const taskStateLabels: Record<TaskState, string> = {
  待办: "待办",
  进行中: "进行中",
  阻塞: "阻塞",
  完成: "完成",
  取消: "取消"
};

export const taskStateClasses: Record<TaskState, string> = {
  待办: "state-todo",
  进行中: "state-progress",
  阻塞: "state-blocked",
  完成: "state-done",
  取消: "state-cancelled"
};
