import {
  createGeneratedApiClient,
  type GeneratedApiClient
} from "@loomhelm/api-client";
import type { CreateProjectRequest, Project, ProjectMember, Task, TaskRelationshipPage, TaskStatus } from "@loomhelm/protocol";

import type { ProjectPermissionSnapshot, ProjectRecord, TaskRecord } from "@/features/tasks/types";

export const unsupportedProjectTaskOperations = [
  "deletionProtectionDetails"
] as const;

export type UnsupportedProjectTaskOperation = (typeof unsupportedProjectTaskOperations)[number];

export interface PublishedProjectTaskApi {
  listProjects: GeneratedApiClient["listProjects"];
  createProject: GeneratedApiClient["createProject"];
  getProject: GeneratedApiClient["getProject"];
  updateProject: GeneratedApiClient["updateProject"];
  deleteProject: GeneratedApiClient["deleteProject"];
  listProjectMembers: GeneratedApiClient["listProjectMembers"];
  grantProjectMember: GeneratedApiClient["grantProjectMember"];
  revokeProjectMember: GeneratedApiClient["revokeProjectMember"];
  listTasks: GeneratedApiClient["listTasks"];
  createTask: GeneratedApiClient["createTask"];
  getTask: GeneratedApiClient["getTask"];
  updateTask: GeneratedApiClient["updateTask"];
  deleteTask: GeneratedApiClient["deleteTask"];
  getTaskRelationships: GeneratedApiClient["getTaskRelationships"];
  addTaskParent: GeneratedApiClient["addTaskParent"];
  removeTaskParent: GeneratedApiClient["removeTaskParent"];
  addTaskDependency: GeneratedApiClient["addTaskDependency"];
  removeTaskDependency: GeneratedApiClient["removeTaskDependency"];
}

export function createPublishedProjectTaskApi(client: GeneratedApiClient = createGeneratedApiClient()): PublishedProjectTaskApi {
  return {
    listProjects: (request) => client.listProjects(request),
    createProject: (request) => client.createProject(request),
    getProject: (request) => client.getProject(request),
    updateProject: (request) => client.updateProject(request),
    deleteProject: (request) => client.deleteProject(request),
    listProjectMembers: (request) => client.listProjectMembers(request),
    grantProjectMember: (request) => client.grantProjectMember(request),
    revokeProjectMember: (request) => client.revokeProjectMember(request),
    listTasks: (request) => client.listTasks(request),
    createTask: (request) => client.createTask(request),
    getTask: (request) => client.getTask(request),
    updateTask: (request) => client.updateTask(request),
    deleteTask: (request) => client.deleteTask(request),
    getTaskRelationships: (request) => client.getTaskRelationships(request),
    addTaskParent: (request) => client.addTaskParent(request),
    removeTaskParent: (request) => client.removeTaskParent(request),
    addTaskDependency: (request) => client.addTaskDependency(request),
    removeTaskDependency: (request) => client.removeTaskDependency(request)
  };
}

export type ProjectMemberPermissions = ProjectPermissionSnapshot;

export function permissionsForProjectMember(members: readonly ProjectMember[], principalId: string | undefined): ProjectMemberPermissions {
  const role = principalId ? members.find((member) => member.user_id === principalId)?.role ?? null : null;
  return {
    role,
    canWrite: role === "owner" || role === "operator",
    canManageProjects: role === "owner",
    isReadOnly: role !== "owner" && role !== "operator"
  };
}

export interface PublishedProjectMembershipApi {
  listProjectMembers: GeneratedApiClient["listProjectMembers"];
  grantProjectMember: GeneratedApiClient["grantProjectMember"];
  revokeProjectMember: GeneratedApiClient["revokeProjectMember"];
}

export function createPublishedProjectMembershipApi(client: GeneratedApiClient = createGeneratedApiClient()): PublishedProjectMembershipApi {
  return {
    listProjectMembers: (request) => client.listProjectMembers(request),
    grantProjectMember: (request) => client.grantProjectMember(request),
    revokeProjectMember: (request) => client.revokeProjectMember(request)
  };
}

export function mapProject(project: Project): ProjectRecord {
  return {
    id: project.id,
    name: project.name,
    summary: project.description ?? "暂无项目简介",
    description: project.description,
    updatedAt: project.updated_at,
    conversationCount: 0
  };
}

const taskStatusToState: Record<TaskStatus, TaskRecord["state"]> = {
  todo: "待办",
  in_progress: "进行中",
  blocked: "阻塞",
  done: "完成",
  cancelled: "取消"
};

export function mapTask(task: Task, relationships?: TaskRelationshipPage): TaskRecord {
  const parentIds = relationships?.parents.map((relationship) => relationship.parent_task_id) ?? [];
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    projectId: task.project_id,
    state: taskStatusToState[task.status],
    execution: null,
    conversationId: task.session_id,
    parentId: parentIds[0],
    parentIds,
    dependsOn: relationships?.prerequisites.map((relationship) => relationship.prerequisite_task_id) ?? [],
    updated: task.updated_at
  };
}

export function toCreateProjectRequest(name: string, description: string): CreateProjectRequest {
  return { name: name.trim(), description: description.trim() || undefined };
}
