import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { taskStates, type ExecutionState, type TaskState, type TaskView } from "@/demo/types";
import type { ProjectTaskSource, TaskRecord } from "@/features/tasks/types";

import { ExecutionPill, TaskExplorer, TaskStateBadge } from "./TaskViews";

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
    canCreateProjects: true,
    getProjectPermissions: () => ({ role: "owner", canWrite: true, canManageProjects: true, isReadOnly: false }),
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
    changeTaskRelations: async () => ({ ok: false, code: "unsupported", message: "story source" }),
    refresh: async () => undefined,
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

  return <div className="min-h-screen bg-[var(--canvas)] p-10" data-visual-evidence-surface><div data-visual-evidence-target><div className="mb-4 flex flex-wrap gap-2"><button type="button" onClick={() => setCurrentTasks((current) => current.some((task) => task.id === "STORY-NEW") ? current : [{ id: "STORY-NEW", title: "新增验收任务", goal: "新增任务应在三种视图中保持一致。", projectId: "loomhelm", state: "待办", execution: "未开始", dependsOn: [], updated: "刚刚" }, ...current])}>新增验收任务</button><button type="button" onClick={() => setCurrentTasks((current) => current.map((task) => task.id === "STORY-NEW" ? { ...task, title: "编辑后验收任务", goal: "编辑后的任务应在三种视图中保持一致。" } : task))}>编辑验收任务</button></div><TaskExplorer source={source} renderTaskLink={renderTaskLink} /></div></div>;
}

const meta = {
  title: "Product/TaskViews",
  component: TaskExplorer,
  decorators: [(Story) => <QueryClientProvider client={new QueryClient()}><Story /></QueryClientProvider>],
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof TaskExplorer>;

export default meta;

type Story = StoryObj<typeof meta>;

function BadgeGallery({ states }: { states: readonly TaskState[] }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-10" data-visual-evidence-surface><div className="mx-auto grid max-w-2xl gap-4" data-visual-evidence-target><div><span className="section-kicker">TASK BUSINESS STATE</span><h1 className="mt-2 text-xl font-semibold">任务状态组件</h1></div><div className="flex flex-wrap gap-3">{states.map((state) => <TaskStateBadge key={state} state={state} />)}</div></div></div>;
}

export const StateGallery: Story = { render: () => <BadgeGallery states={taskStates} /> };

const executionStates: readonly ExecutionState[] = ["未开始", "执行中", "等待审批", "待核对", "已结束", "已拒绝"];

function ExecutionBadgeGallery({ executions }: { executions: readonly ExecutionState[] }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-10" data-visual-evidence-surface><div className="mx-auto grid max-w-2xl gap-4" data-visual-evidence-target><div><span className="section-kicker">TASK EXECUTION STATE</span><h1 className="mt-2 text-xl font-semibold">执行状态组件</h1></div><div className="flex flex-wrap gap-3">{executions.map((execution) => <ExecutionPill key={execution} execution={execution} />)}</div></div></div>;
}

export const ExecutionGallery: Story = { render: () => <ExecutionBadgeGallery executions={executionStates} /> };

export const ExplorerList: Story = {
  render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource()} renderTaskLink={renderTaskLink} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByPlaceholderText("搜索任务、目标或编号");
    await userEvent.type(search, "STORY-1");
    expect(search).toHaveValue("STORY-1");
    expect(canvas.getByText("待办状态任务")).toBeInTheDocument();
  }
};

export const ExplorerConsistency: Story = {
  render: () => <ConsistencyHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const views = [
      ["看板", () => expect(canvas.getByRole("region", { name: "待办任务" })).toBeInTheDocument()],
      ["图谱", () => expect(canvas.getByRole("region", { name: "任务关系图谱，可横向和纵向浏览" })).toBeInTheDocument()],
      ["列表", () => expect(canvas.getByRole("table")).toBeInTheDocument()]
    ] as const;
    await userEvent.click(canvas.getByRole("button", { name: "新增验收任务" }));
    for (const [view, assertView] of views) {
      await userEvent.click(canvas.getByRole("button", { name: view }));
      assertView();
      expect(canvas.getAllByRole("link", { name: /新增验收任务/ }).length).toBeGreaterThan(0);
    }
    await userEvent.click(canvas.getByRole("button", { name: "编辑验收任务" }));
    for (const [view, assertView] of views) {
      await userEvent.click(canvas.getByRole("button", { name: view }));
      assertView();
      expect(canvas.getAllByRole("link", { name: /编辑后验收任务/ }).length).toBeGreaterThan(0);
    }
  }
};

export const Loading: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ status: "loading" })} renderTaskLink={renderTaskLink} /></div> };

export const Empty: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ tasks: [], getTasksForScope: () => [] })} renderTaskLink={renderTaskLink} /></div> };

function ErrorRecoveryHarness() {
  const [refreshCount, setRefreshCount] = useState(0);
  const source = createSource({
    status: "error",
    notice: "任务关系写入结果待确认；请刷新后核对。",
    getTaskReconciliationToken: () => "story-reconciliation",
    refresh: async () => setRefreshCount((count) => count + 1)
  });
  return <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={source} renderTaskLink={renderTaskLink} /><output className="sr-only" data-testid="refresh-count">{refreshCount}</output></div>;
}

export const Error: Story = {
  render: () => <ErrorRecoveryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "刷新并核对任务列表" }));
    expect(canvas.getByText("刷新请求已完成；请确认当前任务和关系数据后再继续。")).toBeInTheDocument();
    expect(canvas.getByTestId("refresh-count")).toHaveTextContent("1");
  }
};

export const ReadOnly: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ getProjectPermissions: () => ({ role: "viewer", canWrite: false, canManageProjects: false, isReadOnly: true }), canCreateProjects: false, notice: "当前身份为只读，任务与关系写入已禁用。" })} renderTaskLink={renderTaskLink} /></div> };

export const PermissionChanged: Story = { render: () => <div className="min-h-screen bg-[var(--canvas)] p-8"><TaskExplorer source={createSource({ status: "permission-changed", notice: "权限范围已变化；不再展示受保护任务。", tasks: tasks.slice(0, 2), getTasksForScope: () => tasks.slice(0, 2) })} renderTaskLink={renderTaskLink} /></div> };
