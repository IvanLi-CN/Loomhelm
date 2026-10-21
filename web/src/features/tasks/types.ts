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
}

export interface TaskRecord {
  id: string;
  title: string;
  goal: string;
  projectId: string;
  state: TaskState;
  execution: ExecutionState;
  conversationId?: string;
  parentId?: string;
  dependsOn: string[];
  updated: string;
}

export type WriteFailureCode = "unauthenticated" | "csrf" | "readonly" | "blocked" | "unsupported" | "invalid";

export interface WriteFailure {
  ok: false;
  code: WriteFailureCode;
  message: string;
  status?: number;
  body?: unknown;
}

export type WriteResult<T> =
  | { ok: true; value: T }
  | WriteFailure;

export type MutationResult<T> = Promise<WriteResult<T>>;

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
  dependsOn?: string[];
}

export interface TaskUpdate {
  title?: string;
  goal?: string;
  state?: TaskState;
  parentId?: string;
  dependsOn?: string[];
}

export interface ProjectTaskSource {
  projects: readonly ProjectRecord[];
  tasks: readonly TaskRecord[];
  status: "ready" | "loading" | "error" | "permission-changed" | "unauthenticated";
  notice?: string;
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
  setTaskParent: (taskId: string, parentTaskId?: string) => MutationResult<null>;
  addTaskDependency: (taskId: string, prerequisiteTaskId: string) => MutationResult<null>;
  removeTaskDependency: (taskId: string, prerequisiteTaskId: string) => MutationResult<null>;
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
