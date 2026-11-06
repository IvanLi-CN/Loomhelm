import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";

import type { TaskView } from "@/demo/types";
import type { ProjectTaskSource, ProjectRecord, TaskRecord } from "@/features/tasks/types";

import { TaskExplorer } from "./TaskViews";

type FocusCacheState = "ready" | "refreshing" | "offline" | "permission";

const projects: readonly ProjectRecord[] = [
  { id: "project-alpha", name: "Alpha workspace", summary: "Primary product work", updatedAt: "刚刚", conversationCount: 2 },
  { id: "project-beta", name: "Beta workspace", summary: "Secondary research", updatedAt: "刚刚", conversationCount: 1 }
];

const tasks: readonly TaskRecord[] = [
  { id: "FOCUS-1", title: "焦点缓存任务", goal: "保持选择、筛选、视图和滚动位置。", projectId: "project-alpha", state: "进行中", execution: "执行中", dependsOn: [], updated: "刚刚" },
  { id: "FOCUS-2", title: "后台刷新任务", goal: "后台读取失败时仍保留最近成功内容。", projectId: "project-alpha", state: "待办", execution: "未开始", dependsOn: [], updated: "刚刚" },
  { id: "FOCUS-3", title: "权限边界任务", goal: "权限变化后隐藏未授权资源。", projectId: "project-beta", state: "阻塞", execution: "待核对", dependsOn: [], updated: "刚刚" }
];

const stateLabels: Record<FocusCacheState, string> = {
  ready: "内容可用",
  refreshing: "正在后台更新",
  offline: "网络暂时不可用",
  permission: "权限范围已变化"
};

function createMockSource(state: FocusCacheState, view: TaskView, setView: (view: TaskView) => void): ProjectTaskSource {
  const visibleProjects = state === "permission" ? projects.slice(0, 1) : projects;
  const visibleTasks = state === "permission" ? tasks.filter((task) => task.projectId === "project-alpha") : tasks;
  const notice = state === "ready"
    ? "已恢复；当前内容仍由同一焦点缓存承载。"
    : state === "refreshing"
      ? "正在后台更新，已保留最近成功数据。"
      : state === "offline"
        ? "网络暂时不可用，已保留最近成功数据；恢复后可重试。"
        : "权限范围已变化；已隐藏未授权项目和任务。";

  return {
    projects: visibleProjects,
    tasks: visibleTasks,
    status: state === "refreshing" ? "ready" : state === "offline" ? "error" : state === "permission" ? "permission-changed" : "ready",
    notice,
    canCreateProjects: false,
    getProjectPermissions: () => ({ role: "owner", canWrite: true, canManageProjects: true, isReadOnly: false }),
    getProject: (projectId) => visibleProjects.find((project) => project.id === projectId),
    getTask: (taskId) => visibleTasks.find((task) => task.id === taskId),
    getTasksForScope: (projectId) => projectId ? visibleTasks.filter((task) => task.projectId === projectId) : visibleTasks,
    getTaskView: () => view,
    setTaskView: (_scope, nextView) => setView(nextView),
    createProject: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    updateProject: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    deleteProject: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    createTask: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    updateTask: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    deleteTask: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    changeTaskRelations: async () => ({ ok: false, code: "unsupported", message: "Mock-only FocusCache story" }),
    refresh: async () => undefined
  };
}

function renderTaskLink(task: TaskRecord, children: ReactNode, className: string, options?: { style?: CSSProperties }) {
  return <a href={`/tasks/${task.id}`} className={className} style={options?.style}>{children}</a>;
}

function FocusCacheHarness() {
  const [state, setState] = useState<FocusCacheState>("ready");
  const [selectedProject, setSelectedProject] = useState("project-alpha");
  const [view, setView] = useState<TaskView>("list");
  const source = useMemo(() => createMockSource(state, view, setView), [state, view]);

  const startBackgroundRecovery = () => {
    setState("refreshing");
    window.setTimeout(() => setState("ready"), 60);
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
      <div className="mx-auto max-w-6xl space-y-6" data-visual-evidence-target>
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="section-kicker">FOCUS CACHE / MOCK ONLY</span>
            <h1 className="mt-2 text-2xl font-semibold">焦点恢复不重置工作区</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">同一主体的后台恢复保留 ProductShell 内容身份、项目选择、筛选、视图和滚动容器；权限变化仍单独显示边界。</p>
          </div>
          <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
            <span className="block text-[var(--muted)]">挂载身份</span>
            <strong data-testid="mount-identity">principal-focus-cache</strong>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
          <label className="flex items-center gap-2 text-sm">
            <span>项目选择</span>
            <select aria-label="项目选择" className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
          </label>
          <button type="button" className="button button-secondary" onClick={startBackgroundRecovery}>后台恢复</button>
          <button type="button" className="button button-secondary" onClick={() => setState("offline")}>模拟离线</button>
          <button type="button" className="button button-secondary" onClick={() => setState("permission")}>模拟权限收紧</button>
          <button type="button" className="button button-primary" onClick={() => setState("ready")}>恢复在线</button>
          <span className="text-sm text-[var(--muted)]" data-testid="cache-state">{stateLabels[state]}</span>
        </div>

        <div className="max-h-80 overflow-y-auto" data-testid="focus-scroll-region">
          <TaskExplorer source={source} scope="focus-cache" projectId={selectedProject} renderTaskLink={renderTaskLink} />
          <div className="h-20" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

const stateCards: readonly { state: FocusCacheState; title: string; description: string }[] = [
  { state: "ready", title: "可用内容", description: "最近成功的项目和任务保持可读。" },
  { state: "refreshing", title: "后台刷新", description: "读取进行中，不卸载外层内容。" },
  { state: "offline", title: "网络失败", description: "保留内容并给出可恢复提示。" },
  { state: "permission", title: "权限边界", description: "显式隐藏不再授权的资源。" }
];

function FocusCacheStateGallery() {
  return (
    <div className="min-h-screen bg-[var(--canvas)] p-8" data-visual-evidence-surface>
      <div className="mx-auto max-w-5xl space-y-6" data-visual-evidence-target>
        <div>
          <span className="section-kicker">FOCUS CACHE STATES</span>
          <h1 className="mt-2 text-2xl font-semibold">可恢复读取状态</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">所有状态均由本地 mock source 驱动，不访问真实会话、网络或浏览器程序。</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {stateCards.map(({ state, title, description }) => (
            <article className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5" key={state}>
              <div className="flex items-center justify-between gap-4">
                <span className="section-kicker">{state.toUpperCase()}</span>
                <span className={`inline-state ${state === "permission" ? "inline-state-warning" : state === "offline" ? "inline-state-warning" : "inline-state-info"}`} role="status">{stateLabels[state]}</span>
              </div>
              <h2 className="mt-4 text-lg font-semibold">{title}</h2>
              <p className="mt-2 text-sm text-[var(--muted)]">{description}</p>
              <div className="mt-5 rounded-lg border border-dashed border-[var(--line)] px-4 py-3 text-sm">最近成功内容仍在当前 ProductShell 内。</div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Product/FocusCache",
  component: TaskExplorer,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
} satisfies Meta<typeof TaskExplorer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StateGallery: Story = { render: () => <FocusCacheStateGallery /> };

export const PreservesMountedState: Story = {
  render: () => <FocusCacheHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByPlaceholderText("搜索任务、目标或编号");
    fireEvent.change(search, { target: { value: "FOCUS-1" } });
    await waitFor(() => expect(canvas.getByPlaceholderText("搜索任务、目标或编号")).toHaveValue("FOCUS-1"));
    await userEvent.click(canvas.getByRole("button", { name: "看板" }));
    await waitFor(() => expect(canvas.getByPlaceholderText("搜索任务、目标或编号")).toHaveValue("FOCUS-1"));
    const filter = canvas.getByRole("combobox", { name: "任务状态筛选" });
    await userEvent.click(filter);
    await userEvent.click(within(document.body).getByRole("option", { name: "进行中" }));
    const project = canvas.getByRole("combobox", { name: "项目选择" });
    await userEvent.selectOptions(project, "project-alpha");
    const scrollRegion = canvas.getByTestId("focus-scroll-region");
    scrollRegion.scrollTop = 24;
    fireEvent.scroll(scrollRegion);
    await userEvent.click(canvas.getByRole("button", { name: "后台恢复" }));
    await waitFor(() => expect(canvas.getByTestId("cache-state")).toHaveTextContent("正在后台更新"));
    await waitFor(() => expect(canvas.getByTestId("cache-state")).toHaveTextContent("内容可用"));
    expect(canvas.getByPlaceholderText("搜索任务、目标或编号")).toHaveValue("FOCUS-1");
    expect(canvas.getByRole("button", { name: "看板" })).toHaveAttribute("aria-pressed", "true");
    expect(canvas.getByRole("combobox", { name: "任务状态筛选" })).toHaveTextContent("进行中");
    expect(project).toHaveValue("project-alpha");
    expect(scrollRegion.scrollTop).toBe(24);
    expect(canvas.getByTestId("mount-identity")).toHaveTextContent("principal-focus-cache");
    expect(canvas.getByText("焦点缓存任务")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "模拟离线" }));
    expect(canvas.getByText("网络暂时不可用，已保留最近成功数据；恢复后可重试。")).toBeInTheDocument();
    expect(canvas.getByText("焦点缓存任务")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "模拟权限收紧" }));
    expect(canvas.getByText("权限范围已变化；已隐藏未授权项目和任务。")).toBeInTheDocument();
  }
};
