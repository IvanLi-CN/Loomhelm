import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { taskStates, type TaskState, type TaskView } from "@/demo/types";
import type { ProjectTaskSource, TaskRecord } from "@/features/tasks/types";

import { TaskExplorer, TaskStateBadge } from "./TaskViews";

const projects = [
  { id: "loomhelm", name: "Loomhelm", summary: "产品工作台", updatedAt: "刚刚", conversationCount: 1 },
  { id: "sidecar", name: "Sidecar Notes", summary: "研究记录", updatedAt: "刚刚", conversationCount: 0 }
];

const tasks: TaskRecord[] = taskStates.map((state, index) => ({
  id: `STORY-${index + 1}`,
  title: `${state}状态任务`,
  goal: "用于检查状态、项目归属和任务视图之间的稳定关系。",
  projectId: index === 4 ? "sidecar" : "loomhelm",
  state,
  execution: index === 1 ? "执行中" : "未开始",
  parentId: index === 2 ? "STORY-2" : undefined,
  dependsOn: index === 3 ? ["STORY-2"] : [],
  updated: "刚刚"
}));

function createSource(overrides: Partial<ProjectTaskSource> = {}): ProjectTaskSource {
  const source: ProjectTaskSource = {
    projects,
    tasks,
    status: "ready",
    canWrite: true,
    canManageProjects: true,
    isReadOnly: false,
    getProject: (id) => projects.find((project) => project.id === id),
    getTask: (id) => tasks.find((task) => task.id === id),
    getTasksForScope: (projectId) => projectId ? tasks.filter((task) => task.projectId === projectId || task.id === "STORY-2") : tasks,
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

function renderTaskLink(task: TaskRecord, children: ReactNode, className: string, options?: { style?: CSSProperties }) {
  return <a href={`/tasks/${task.id}`} className={className} style={options?.style}>{children}</a>;
}

function ConsistencyHarness() {
  const [view, setView] = useState<TaskView>("list");
  const [currentTasks, setCurrentTasks] = useState(tasks);
  const source = createSource({
    tasks: currentTasks,
    getTask: (id) => currentTasks.find((task) => task.id === id),
    getTasksForScope: () => currentTasks,
    getTaskView: () => view,
    setTaskView: (_scope, nextView) => setView(nextView)
  });

  return <div className="min-h-screen bg-[var(--canvas)] p-8"><div className="mb-4 flex flex-wrap gap-2"><button type="button" onClick={() => setCurrentTasks((current) => current.some((task) => task.id === "STORY-NEW") ? current : [{ id: "STORY-NEW", title: "新增验收任务", goal: "新增任务应在三种视图中保持一致。", projectId: "loomhelm", state: "待办", execution: "未开始", dependsOn: [], updated: "刚刚" }, ...current])}>新增验收任务</button><button type="button" onClick={() => setCurrentTasks((current) => current.map((task) => task.id === "STORY-NEW" ? { ...task, title: "编辑后验收任务", goal: "编辑后的任务应在三种视图中保持一致。" } : task))}>编辑验收任务</button></div><TaskExplorer source={source} renderTaskLink={renderTaskLink} /></div>;
}

const meta = {
  title: "Product/TaskViews",
  component: TaskExplorer,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof TaskExplorer>;

export default meta;

type Story = StoryObj<typeof meta>;

function BadgeGallery({ states }: { states: readonly TaskState[] }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface><div className="mx-auto grid max-w-2xl gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-8 shadow-[var(--shadow)]" data-visual-evidence-target><div><span className="section-kicker">TASK BUSINESS STATE</span><h1 className="mt-2 text-xl font-semibold">任务状态组件</h1></div><div className="flex flex-wrap gap-3">{states.map((state) => <TaskStateBadge key={state} state={state} />)}</div></div></div>;
}

export const StateGallery: Story = { render: () => <BadgeGallery states={taskStates} /> };

export const ExplorerList: Story = {
  render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource()} renderTaskLink={renderTaskLink} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByPlaceholderText("搜索任务、目标或编号");
    await userEvent.type(search, "STORY-01");
    expect(search).toHaveValue("STORY-01");
    expect(canvas.getByText("待办状态任务")).toBeInTheDocument();
  }
};

export const ExplorerConsistency: Story = {
  render: () => <ConsistencyHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const views = ["看板", "图谱", "列表"];
    await userEvent.click(canvas.getByRole("button", { name: "新增验收任务" }));
    for (const view of views) {
      await userEvent.click(canvas.getByRole("button", { name: view }));
      expect(canvas.getAllByText("新增验收任务").length).toBeGreaterThan(0);
    }
    await userEvent.click(canvas.getByRole("button", { name: "编辑验收任务" }));
    for (const view of views) {
      await userEvent.click(canvas.getByRole("button", { name: view }));
      expect(canvas.getAllByText("编辑后验收任务").length).toBeGreaterThan(0);
    }
  }
};

export const Loading: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ status: "loading" })} renderTaskLink={renderTaskLink} /></div> };

export const Empty: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ tasks: [], getTasksForScope: () => [] })} renderTaskLink={renderTaskLink} /></div> };

export const Error: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ status: "error" })} renderTaskLink={renderTaskLink} /></div> };

export const ReadOnly: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ canWrite: false, isReadOnly: true, notice: "当前身份为只读，任务与关系写入已禁用。" })} renderTaskLink={renderTaskLink} /></div> };

export const PermissionChanged: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ status: "permission-changed", notice: "权限范围已变化；不再展示受保护任务。", tasks: tasks.slice(0, 2), getTasksForScope: () => tasks.slice(0, 2) })} renderTaskLink={renderTaskLink} /></div> };
