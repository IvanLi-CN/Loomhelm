import type { ProjectTaskSource, TaskRecord } from "./types";

export const storyProjects = [
  { id: "loomhelm", name: "Loomhelm", summary: "产品工作台", updatedAt: "刚刚", conversationCount: 1 },
  { id: "sidecar", name: "Sidecar Notes", summary: "研究记录", updatedAt: "刚刚", conversationCount: 0 }
];

export const storyTasks: TaskRecord[] = [
  { id: "STORY-01", title: "整理工作区边界", goal: "保留项目归属并明确可见范围。", projectId: "loomhelm", state: "进行中", execution: "未开始", dependsOn: [], updated: "刚刚" },
  { id: "STORY-02", title: "核对跨项目关系", goal: "区分父子层级与前置依赖。", projectId: "sidecar", state: "待办", execution: "未开始", parentId: "STORY-01", dependsOn: [], updated: "刚刚" }
];

export function createStorySource(overrides: Partial<ProjectTaskSource> = {}): ProjectTaskSource {
  const source: ProjectTaskSource = {
    projects: storyProjects,
    tasks: storyTasks,
    status: "ready",
    canCreateProjects: true,
    getProjectPermissions: () => ({ role: "owner", canWrite: true, canManageProjects: true, isReadOnly: false }),
    getProject: (id) => storyProjects.find((project) => project.id === id),
    getTask: (id) => storyTasks.find((task) => task.id === id),
    getTasksForScope: (projectId) => projectId ? storyTasks.filter((task) => task.projectId === projectId || task.id === "STORY-01") : storyTasks,
    getTaskView: () => "list",
    setTaskView: () => undefined,
    createProject: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    updateProject: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    deleteProject: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    createTask: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    updateTask: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    deleteTask: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    setTaskParent: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    addTaskDependency: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    removeTaskDependency: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    ...overrides
  };
  return source;
}
