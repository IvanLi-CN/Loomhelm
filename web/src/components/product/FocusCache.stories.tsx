import { ApiClientError, type AuthenticatedApiClient, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { Project, ProjectMember, Task, TaskRelationshipPage } from "@loomhelm/protocol";

import { AppProviders } from "@/app/providers";
import { router as appRouter } from "@/app/router";
import type { TaskView } from "@/demo/types";
import type { ProjectTaskSource, ProjectRecord, TaskRecord } from "@/features/tasks/types";

import { TaskExplorer } from "./TaskViews";

function createProductionStoryRouter() {
  return createRouter({
    routeTree: appRouter.routeTree,
    basepath: appRouter.options.basepath,
    defaultPreload: appRouter.options.defaultPreload,
    history: createMemoryHistory({ initialEntries: ["/projects/project-alpha"] })
  });
}

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
            <h1 className="mt-2 text-2xl font-semibold">TaskExplorer mock 状态恢复</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">这里仅验证可复用 TaskExplorer mock source 的状态展示与局部交互；真实 ProductShell、Provider 和 Outlet 的挂载恢复由 ProductionBoundary story 与回归验证覆盖。</p>
          </div>
          <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
            <span className="block text-[var(--muted)]">mock source 身份</span>
            <strong data-testid="mock-source-identity">mock-task-explorer</strong>
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
              <div className="mt-5 rounded-lg border border-dashed border-[var(--line)] px-4 py-3 text-sm">最近成功内容仍在当前 mock TaskExplorer 状态内。</div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

const productionStoryProjects: readonly Project[] = [
  { id: "project-alpha", name: "Alpha workspace", description: "真实 ProductShell focus-cache fixture", created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z" },
  { id: "project-beta", name: "Beta workspace", description: "权限边界 fixture", created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z" }
];

const emptyProductionRelationships: TaskRelationshipPage = { parents: [], children: [], prerequisites: [], dependents: [] };

const productionStoryRelationships: Readonly<Record<string, TaskRelationshipPage>> = {
  "FOCUS-1": {
    parents: [],
    children: [{ child_task_id: "FOCUS-2", created_at: "2026-11-07T00:00:00Z", kind: "parent_child", parent_task_id: "FOCUS-1" }],
    prerequisites: [],
    dependents: []
  },
  "FOCUS-2": {
    parents: [{ child_task_id: "FOCUS-2", created_at: "2026-11-07T00:00:00Z", kind: "parent_child", parent_task_id: "FOCUS-1" }],
    children: [],
    prerequisites: [],
    dependents: []
  },
  "FOCUS-BETA": {
    parents: [],
    children: [],
    prerequisites: [{ created_at: "2026-11-07T00:00:00Z", dependent_task_id: "FOCUS-BETA", kind: "prerequisite", prerequisite_task_id: "FOCUS-1" }],
    dependents: []
  }
};

function createProductionStoryTasks(principalId: string): readonly Task[] {
  return Array.from({ length: 48 }, (_, index) => ({
    id: index === 47 ? "FOCUS-BETA" : `FOCUS-${index + 1}`,
    project_id: index === 47 ? "project-beta" : "project-alpha",
    title: index === 47 ? "Beta 私有任务" : index === 0 ? (principalId === "principal-a" ? "焦点缓存任务" : "主体 B 焦点任务") : `焦点缓存任务 ${index + 1}`,
    goal: "同一主体恢复时保留任务、筛选、视图和滚动位置。",
    status: index % 3 === 0 ? "in_progress" : "todo",
    updated_at: "2026-11-07T00:00:00Z",
    created_at: "2026-11-07T00:00:00Z"
  }));
}

interface ProductionStoryState {
  principalId: string;
  offline: boolean;
  invalid: boolean;
  taskForbidden: boolean;
  relationshipsForbidden: boolean;
  revokedProjectIds: string[];
  bootstrapCalls: number;
  revalidateCalls: number;
  invalidationCalls: number;
  projectRequests: string[];
  taskRequests: string[];
  membershipRequests: string[];
  relationshipRequests: string[];
  boundPrincipals: string[];
  listeners: Set<() => void>;
}

interface ProductionStoryMock {
  state: ProductionStoryState;
  client: AuthenticatedApiClient;
  subscribe: (listener: () => void) => () => void;
  update: (patch: Partial<Pick<ProductionStoryState, "principalId" | "offline" | "invalid" | "taskForbidden" | "relationshipsForbidden" | "revokedProjectIds">>) => void;
  revokeProject: (projectId: string) => void;
}

function createProductionStoryMock(): ProductionStoryMock {
  const state: ProductionStoryState = {
    principalId: "principal-a",
    offline: false,
    invalid: false,
    taskForbidden: false,
    relationshipsForbidden: false,
    revokedProjectIds: [],
    bootstrapCalls: 0,
    revalidateCalls: 0,
    invalidationCalls: 0,
    projectRequests: [],
    taskRequests: [],
    membershipRequests: [],
    relationshipRequests: [],
    boundPrincipals: [],
    listeners: new Set()
  };
  let notificationScheduled = false;
  const notify = () => {
    if (notificationScheduled) return;
    notificationScheduled = true;
    window.setTimeout(() => {
      notificationScheduled = false;
      state.listeners.forEach((listener) => listener());
    }, 0);
  };
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  const update = (patch: Partial<Pick<ProductionStoryState, "principalId" | "offline" | "invalid" | "taskForbidden" | "relationshipsForbidden" | "revokedProjectIds">>) => {
    Object.assign(state, patch);
    notify();
  };
  const revokeProject = (projectId: string) => update({ revokedProjectIds: [...new Set([...state.revokedProjectIds, projectId])] });
  const readSession = async (kind: "bootstrap" | "revalidate") => {
    if (kind === "bootstrap") state.bootstrapCalls += 1;
    else state.revalidateCalls += 1;
    notify();
    if (state.offline) throw new Error("mock network unavailable");
    if (state.invalid) throw new ApiClientError(401, { code: "unauthorized" });
    return { user_id: state.principalId, csrf_protection: "same_origin" as const };
  };
  const bind = ({ principalId }: { principalId: string }): GeneratedApiClient => {
    state.boundPrincipals.push(principalId);
    notify();
    const boundTasks = createProductionStoryTasks(principalId);
    const assertOnline = () => {
      if (state.offline) throw new Error("mock network unavailable");
    };
    return {
      listProjects: async () => {
        state.projectRequests.push(principalId);
        notify();
        assertOnline();
        return { items: productionStoryProjects.filter((project) => !state.revokedProjectIds.includes(project.id)), has_more: false };
      },
      listProjectMembers: async ({ project_id }: { project_id: string }) => {
        state.membershipRequests.push(`${principalId}:${project_id}`);
        notify();
        assertOnline();
        if (state.revokedProjectIds.includes(project_id)) throw new ApiClientError(403, { code: "forbidden" });
        const member: ProjectMember = { project_id, user_id: principalId, role: "owner", created_at: "2026-11-07T00:00:00Z" };
        return { items: [member] };
      },
      listTasks: async ({ project_id }: { project_id?: string } = {}) => {
        state.taskRequests.push(`${principalId}:${project_id ?? "all"}`);
        notify();
        assertOnline();
        if (state.taskForbidden) throw new ApiClientError(403, { code: "forbidden" });
        return { items: project_id ? boundTasks.filter((task) => task.project_id === project_id) : boundTasks, has_more: false };
      },
      getTaskRelationships: async ({ task_id }: { task_id: string }) => {
        state.relationshipRequests.push(`${principalId}:${task_id}`);
        notify();
        assertOnline();
        if (state.relationshipsForbidden && task_id === "FOCUS-BETA") throw new ApiClientError(403, { code: "forbidden" });
        return productionStoryRelationships[task_id] ?? emptyProductionRelationships;
      }
    } as unknown as GeneratedApiClient;
  };
  const client = {
    bootstrapBrowserSession: () => readSession("bootstrap"),
    revalidateBrowserSession: () => readSession("revalidate"),
    invalidateBrowserSession: () => {
      state.invalidationCalls += 1;
      notify();
    },
    bindBrowserSession: bind
  } as unknown as AuthenticatedApiClient;
  return { state, client, subscribe, update, revokeProject };
}

function dispatchProductionFocus(): void {
  window.dispatchEvent(new Event("focus"));
}

function dispatchProductionVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

function dispatchProductionResume(): void {
  dispatchProductionFocus();
  dispatchProductionVisibilityChange();
}

interface ProductionStoryNodes {
  shell: HTMLElement | null;
  outlet: HTMLElement | null;
}

function readProductionStoryNodes(root: HTMLElement | null): ProductionStoryNodes {
  return {
    shell: root?.querySelector<HTMLElement>('[data-runtime="production"]') ?? null,
    outlet: root?.querySelector<HTMLElement>('[data-runtime="production"] main.product-content > section') ?? null
  };
}

interface ProductionMountSnapshot {
  shellMounts: number;
  shellUnmounts: number;
  outletMounts: number;
  outletUnmounts: number;
}

function ProductionMountProbe({ rootRef }: { rootRef: { current: HTMLDivElement | null } }) {
  const trackerRef = useRef<ProductionStoryNodes & ProductionMountSnapshot>({
    shell: null,
    outlet: null,
    shellMounts: 0,
    shellUnmounts: 0,
    outletMounts: 0,
    outletUnmounts: 0
  });
  const [snapshot, setSnapshot] = useState<ProductionMountSnapshot>({ shellMounts: 0, shellUnmounts: 0, outletMounts: 0, outletUnmounts: 0 });
  const scan = useCallback(() => {
    const tracker = trackerRef.current;
    const next = readProductionStoryNodes(rootRef.current);
    if (tracker.shell !== next.shell) {
      if (tracker.shell) tracker.shellUnmounts += 1;
      if (next.shell) tracker.shellMounts += 1;
      tracker.shell = next.shell;
    }
    if (tracker.outlet !== next.outlet) {
      if (tracker.outlet) tracker.outletUnmounts += 1;
      if (next.outlet) tracker.outletMounts += 1;
      tracker.outlet = next.outlet;
    }
    const nextSnapshot = {
      shellMounts: tracker.shellMounts,
      shellUnmounts: tracker.shellUnmounts,
      outletMounts: tracker.outletMounts,
      outletUnmounts: tracker.outletUnmounts
    };
    setSnapshot((current) => current.shellMounts === nextSnapshot.shellMounts
      && current.shellUnmounts === nextSnapshot.shellUnmounts
      && current.outletMounts === nextSnapshot.outletMounts
      && current.outletUnmounts === nextSnapshot.outletUnmounts ? current : nextSnapshot);
  }, [rootRef]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    scan();
    return () => observer.disconnect();
  }, [rootRef, scan]);
  const recordBaseline = () => {
    scan();
    const tracker = trackerRef.current;
    tracker.shellMounts = tracker.shell ? 1 : 0;
    tracker.shellUnmounts = 0;
    tracker.outletMounts = tracker.outlet ? 1 : 0;
    tracker.outletUnmounts = 0;
    setSnapshot({ shellMounts: tracker.shellMounts, shellUnmounts: 0, outletMounts: tracker.outletMounts, outletUnmounts: 0 });
  };
  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs shadow-lg" data-testid="production-mount-probe">
      <div className="flex items-center justify-between gap-3"><strong>真实生产挂载探针</strong><button type="button" className="button button-secondary" onClick={recordBaseline}>记录生产挂载基线</button></div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[var(--muted)]">
        <dt>ProductShell mounts</dt><dd data-testid="production-shell-mounts">{snapshot.shellMounts}</dd>
        <dt>ProductShell unmounts</dt><dd data-testid="production-shell-unmounts">{snapshot.shellUnmounts}</dd>
        <dt>Outlet mounts</dt><dd data-testid="production-outlet-mounts">{snapshot.outletMounts}</dd>
        <dt>Outlet unmounts</dt><dd data-testid="production-outlet-unmounts">{snapshot.outletUnmounts}</dd>
      </dl>
    </div>
  );
}

function ProductionStoryControls({ mock, storyRouter }: { mock: ProductionStoryMock; storyRouter: ReturnType<typeof createProductionStoryRouter> }) {
  const queryClient = useQueryClient();
  const [, rerender] = useState(0);
  useEffect(() => mock.subscribe(() => rerender((value) => value + 1)), [mock]);
  const resume = () => dispatchProductionResume();
  const revokeBetaAndRefresh = async () => {
    mock.revokeProject("project-beta");
    await queryClient.invalidateQueries({ queryKey: ["loomhelm", mock.state.principalId] });
  };
  const setOfflineAndResume = () => {
    mock.update({ offline: true, invalid: false });
    resume();
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", mock.state.principalId] });
  };
  const switchPrincipalAndResume = () => {
    mock.update({ principalId: "principal-b", offline: false, invalid: false, taskForbidden: false, revokedProjectIds: [] });
    resume();
  };
  const invalidateAndResume = () => {
    mock.update({ offline: false, invalid: true });
    resume();
  };
  const simulateTaskForbiddenAndRefresh = () => {
    mock.update({ offline: false, invalid: false, taskForbidden: true });
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", mock.state.principalId] });
  };
  const simulateRelationshipsForbiddenAndRefresh = () => {
    mock.update({ offline: false, invalid: false, taskForbidden: false, relationshipsForbidden: true });
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", mock.state.principalId] });
  };
  const restoreMockOnline = () => {
    mock.update({ offline: false, invalid: false, taskForbidden: false, relationshipsForbidden: false });
    void queryClient.invalidateQueries({ queryKey: ["loomhelm", mock.state.principalId] });
  };
  return (
    <section className="relative z-50 border-b border-[var(--line)] bg-[var(--surface)] p-4" data-visual-evidence-target>
      <div className="mx-auto max-w-6xl">
        <span className="section-kicker">FOCUS CACHE / PRODUCTION BOUNDARY</span>
        <h1 className="mt-2 text-xl font-semibold">真实 ProductShell + Outlet 恢复回归</h1>
        <p className="mt-2 max-w-4xl text-sm text-[var(--muted)]">这里渲染真实 AppProviders、ProductionApiProvider、ProductShell 和 Router Outlet；REST/session 全部由本地 mock client 驱动，不访问真实服务。Story play 会验证同主体 focus/visibility、离线提示、主体切换和请求合并。</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="button button-secondary" onClick={dispatchProductionFocus}>仅触发 window focus</button>
          <button type="button" className="button button-secondary" onClick={dispatchProductionVisibilityChange}>仅触发 visibilitychange</button>
          <button type="button" className="button button-secondary" onClick={resume}>并发 focus + visibility</button>
          <button type="button" className="button button-secondary" onClick={setOfflineAndResume}>模拟离线 focus + visibility</button>
          <button type="button" className="button button-secondary" onClick={switchPrincipalAndResume}>切换主体并恢复</button>
          <button type="button" className="button button-secondary" onClick={invalidateAndResume}>模拟会话失效</button>
          <button type="button" className="button button-secondary" onClick={() => { void revokeBetaAndRefresh(); }}>撤销 Beta 项目并刷新</button>
          <button type="button" className="button button-secondary" onClick={simulateTaskForbiddenAndRefresh}>模拟任务权限收紧并刷新</button>
          <button type="button" className="button button-secondary" onClick={simulateRelationshipsForbiddenAndRefresh}>模拟关系权限收紧并刷新</button>
          <button type="button" className="button button-secondary" onClick={() => { void storyRouter.navigate({ to: "/tasks" }); }}>打开全局任务范围</button>
          <button type="button" className="button button-primary" onClick={restoreMockOnline}>恢复 mock 在线</button>
        </div>
        <dl className="mt-3 grid max-w-4xl grid-cols-2 gap-x-5 gap-y-1 text-xs text-[var(--muted)] md:grid-cols-4">
          <dt>mock principal</dt><dd data-testid="production-principal">{mock.state.principalId}</dd>
          <dt>mock session state</dt><dd data-testid="production-session-state">{mock.state.invalid ? "invalid" : mock.state.offline ? "offline" : "online"}</dd>
          <dt>task read state</dt><dd data-testid="production-task-read-state">{mock.state.taskForbidden ? "forbidden" : "available"}</dd>
          <dt>relationship read state</dt><dd data-testid="production-relationship-read-state">{mock.state.relationshipsForbidden ? "beta-forbidden" : "available"}</dd>
          <dt>session calls</dt><dd data-testid="production-session-calls">{mock.state.bootstrapCalls + mock.state.revalidateCalls}</dd>
          <dt>revalidate calls</dt><dd data-testid="production-revalidate-calls">{mock.state.revalidateCalls}</dd>
          <dt>project requests</dt><dd data-testid="production-project-calls">{mock.state.projectRequests.length}</dd>
          <dt>task requests</dt><dd data-testid="production-task-calls">{mock.state.taskRequests.length}</dd>
          <dt>membership requests</dt><dd data-testid="production-membership-calls">{mock.state.membershipRequests.length}</dd>
          <dt>relationship requests</dt><dd data-testid="production-relationship-calls">{mock.state.relationshipRequests.length}</dd>
          <dt>bound principals</dt><dd data-testid="production-bound-principals">{mock.state.boundPrincipals.join(", ") || "—"}</dd>
          <dt>auth invalidations</dt><dd data-testid="production-invalidation-calls">{mock.state.invalidationCalls}</dd>
          <dt>revoked projects</dt><dd data-testid="production-revoked-projects">{mock.state.revokedProjectIds.join(", ") || "—"}</dd>
        </dl>
      </div>
    </section>
  );
}

function ProductionRecoveryPreviewTrigger({ mock }: { mock: ProductionStoryMock }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: number | undefined;
    const applyOfflineState = () => {
      if (timer !== undefined || mock.state.bootstrapCalls < 1) return;
      timer = window.setTimeout(() => {
        mock.update({ offline: true, invalid: false, taskForbidden: false });
        dispatchProductionResume();
        void queryClient.invalidateQueries({ queryKey: ["loomhelm", mock.state.principalId] });
      }, 200);
    };
    const unsubscribe = mock.subscribe(applyOfflineState);
    applyOfflineState();
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [mock, queryClient]);
  return null;
}

function ProductionBoundaryHarness({ offlinePreview = false, showMountProbe = true }: { offlinePreview?: boolean; showMountProbe?: boolean } = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mockRef = useRef<ProductionStoryMock | null>(null);
  const routerRef = useRef<ReturnType<typeof createProductionStoryRouter> | null>(null);
  if (!mockRef.current) mockRef.current = createProductionStoryMock();
  if (!routerRef.current) routerRef.current = createProductionStoryRouter();
  const mock = mockRef.current;
  const storyRouter = routerRef.current;
  return (
    <div ref={rootRef} className="min-h-screen bg-[var(--canvas)]" data-visual-evidence-surface>
      <AppProviders productionClient={mock.client}>
        {offlinePreview && <ProductionRecoveryPreviewTrigger mock={mock} />}
        <ProductionStoryControls mock={mock} storyRouter={storyRouter} />
        <div className="min-h-[70dvh]"><RouterProvider router={storyRouter} /></div>
      </AppProviders>
      {showMountProbe && <ProductionMountProbe rootRef={rootRef} />}
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
    expect(canvas.getByTestId("mock-source-identity")).toHaveTextContent("mock-task-explorer");
    expect(canvas.getByText("焦点缓存任务")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "模拟离线" }));
    expect(canvas.getByText("网络暂时不可用，已保留最近成功数据；恢复后可重试。")).toBeInTheDocument();
    expect(canvas.getByText("焦点缓存任务")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "模拟权限收紧" }));
    expect(canvas.getByText("权限范围已变化；已隐藏未授权项目和任务。")).toBeInTheDocument();
  }
};

export const ProductionBoundary: Story = {
  render: () => <ProductionBoundaryHarness />,
  play: async ({ canvasElement }) => {
    const run = async () => {
      const canvas = within(canvasElement);
      const ownerDocument = canvasElement.ownerDocument;
    const pause = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
    const readCounter = (testId: string) => Number(canvas.getByTestId(testId).textContent ?? "0");
    const readRequests = () => ({
      projects: readCounter("production-project-calls"),
      tasks: readCounter("production-task-calls"),
      memberships: readCounter("production-membership-calls"),
      relationships: readCounter("production-relationship-calls"),
      revalidate: readCounter("production-revalidate-calls")
    });
    const readNodes = () => readProductionStoryNodes(canvasElement);
    const assertNoDuplicateRead = (before: ReturnType<typeof readRequests>, after: ReturnType<typeof readRequests>) => {
      expect(after.projects - before.projects).toBeLessThanOrEqual(1);
      expect(after.tasks - before.tasks).toBeLessThanOrEqual(1);
      expect(after.memberships - before.memberships).toBeLessThanOrEqual(1);
      expect(after.relationships - before.relationships).toBeLessThanOrEqual(1);
    };
    await waitFor(() => expect(canvas.getByText("焦点缓存任务", { exact: true })).toBeInTheDocument());
    await waitFor(() => expect(canvasElement.querySelector('[data-runtime="production"][data-mount-identity="principal-a"]')).not.toBeNull());
    await waitFor(() => expect(readCounter("production-project-calls")).toBeGreaterThan(0));

    const search = canvas.getByPlaceholderText("搜索任务、目标或编号");
    fireEvent.change(search, { target: { value: "FOCUS-1" } });
    await waitFor(() => expect(canvas.getByPlaceholderText("搜索任务、目标或编号")).toHaveValue("FOCUS-1"));
    await userEvent.click(canvas.getByRole("button", { name: "看板" }));
    const filter = canvas.getByRole("combobox", { name: "任务状态筛选" });
    await userEvent.click(filter);
    await userEvent.click(within(ownerDocument.body).getByRole("option", { name: "进行中" }));
    const scrollContainer = ownerDocument.scrollingElement ?? ownerDocument.documentElement;
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    expect(maxScrollTop).toBeGreaterThan(0);
    const targetScrollTop = Math.min(96, maxScrollTop);
    scrollContainer.scrollTop = targetScrollTop;
    fireEvent.scroll(scrollContainer);
    await userEvent.click(canvas.getByRole("button", { name: "记录生产挂载基线" }));
    await waitFor(() => expect(canvas.getByTestId("production-shell-mounts")).toHaveTextContent("1"));
    const initialNodes = readNodes();
    if (!initialNodes.shell || !initialNodes.outlet) throw new Error("production shell and outlet nodes were not rendered");
    const initialShellMounts = readCounter("production-shell-mounts");
    const initialOutletMounts = readCounter("production-outlet-mounts");
    expect(canvas.getByRole("heading", { name: "Alpha workspace" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "看板" })).toHaveAttribute("aria-pressed", "true");
    expect(filter).toHaveTextContent("进行中");
    expect(scrollContainer.scrollTop).toBe(targetScrollTop);

    const assertMountedState = () => {
      expect(readNodes().shell).toBe(initialNodes.shell);
      expect(readNodes().outlet).toBe(initialNodes.outlet);
      expect(readCounter("production-shell-mounts")).toBe(initialShellMounts);
      expect(readCounter("production-shell-unmounts")).toBe(0);
      expect(readCounter("production-outlet-mounts")).toBe(initialOutletMounts);
      expect(readCounter("production-outlet-unmounts")).toBe(0);
      expect(canvas.getByPlaceholderText("搜索任务、目标或编号")).toHaveValue("FOCUS-1");
      expect(canvas.getByRole("button", { name: "看板" })).toHaveAttribute("aria-pressed", "true");
      expect(canvas.getByRole("combobox", { name: "任务状态筛选" })).toHaveTextContent("进行中");
      expect(scrollContainer.scrollTop).toBe(targetScrollTop);
    };

    const focusBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "仅触发 window focus" }));
    await waitFor(() => expect(readCounter("production-revalidate-calls")).toBe(focusBefore.revalidate + 1));
    const focusAfter = readRequests();
    assertNoDuplicateRead(focusBefore, focusAfter);
    assertMountedState();
    expect(canvas.queryByTestId("production-auth-message")).toBeNull();

    await pause(1100);
    const visibilityBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "仅触发 visibilitychange" }));
    await waitFor(() => expect(readCounter("production-revalidate-calls")).toBe(visibilityBefore.revalidate + 1));
    const visibilityAfter = readRequests();
    assertNoDuplicateRead(visibilityBefore, visibilityAfter);
    assertMountedState();

    await pause(1100);
    const mergedBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "并发 focus + visibility" }));
    await waitFor(() => expect(readCounter("production-revalidate-calls")).toBe(mergedBefore.revalidate + 1));
    const mergedAfter = readRequests();
    assertNoDuplicateRead(mergedBefore, mergedAfter);
    assertMountedState();

    await pause(1100);
    const offlineBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "模拟离线 focus + visibility" }));
    await waitFor(() => expect(readCounter("production-revalidate-calls")).toBe(offlineBefore.revalidate + 1));
    await waitFor(() => expect(canvas.getByTestId("production-auth-message")).toHaveTextContent("后台验证浏览器会话失败：mock network unavailable"));
    await waitFor(() => expect(readCounter("production-task-calls")).toBeGreaterThan(offlineBefore.tasks));
    assertMountedState();
    expect(canvas.getByText("当前任务范围刷新失败，已保留最近成功数据；请稍后重试。", { exact: true })).toBeInTheDocument();
    expect(canvas.getByText("焦点缓存任务", { exact: true })).toBeInTheDocument();

    await pause(1100);
    const recoveryBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "恢复 mock 在线" }));
    await waitFor(() => expect(readCounter("production-task-calls")).toBeGreaterThan(recoveryBefore.tasks));
    await pause(1100);
    await userEvent.click(canvas.getByRole("button", { name: "仅触发 window focus" }));
    await waitFor(() => expect(readCounter("production-revalidate-calls")).toBe(recoveryBefore.revalidate + 1));
    await waitFor(() => expect(canvas.queryByTestId("production-auth-message")).toBeNull());
    await waitFor(() => expect(canvas.queryByText("当前任务范围刷新失败，已保留最近成功数据；请稍后重试。", { exact: true })).toBeNull());
    assertMountedState();

    await userEvent.click(canvas.getByRole("button", { name: "打开全局任务范围" }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "任务" })).toBeInTheDocument());
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true }).length).toBeGreaterThan(0));
    await userEvent.click(canvas.getByRole("button", { name: "图谱" }));
    await waitFor(() => expect(canvas.getByRole("region", { name: "任务关系图谱，可横向和纵向浏览" })).toBeInTheDocument());
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true }).length).toBeGreaterThan(0));
    await waitFor(() => expect(readCounter("production-relationship-calls")).toBeGreaterThan(0));

    await pause(1100);
    const graphOfflineBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "模拟离线 focus + visibility" }));
    await waitFor(() => expect(canvas.getByTestId("production-auth-message")).toHaveTextContent("后台验证浏览器会话失败：mock network unavailable"));
    await waitFor(() => expect(readCounter("production-task-calls")).toBeGreaterThan(graphOfflineBefore.tasks));
    expect(canvas.queryAllByText("Beta 私有任务", { exact: true }).length).toBeGreaterThan(0);
    expect(canvas.getByText("当前任务范围刷新失败，已保留最近成功数据；请稍后重试。", { exact: true })).toBeInTheDocument();

    await pause(1100);
    const graphRecoveryBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "恢复 mock 在线" }));
    await waitFor(() => expect(readCounter("production-task-calls")).toBeGreaterThan(graphRecoveryBefore.tasks));
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true }).length).toBeGreaterThan(0));

    const relationshipForbiddenBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "模拟关系权限收紧并刷新" }));
    await waitFor(() => expect(canvas.getByTestId("production-relationship-read-state")).toHaveTextContent("beta-forbidden"));
    await waitFor(() => expect(readCounter("production-relationship-calls")).toBeGreaterThan(relationshipForbiddenBefore.relationships));
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true })).toHaveLength(0));
    expect(canvas.getByTestId("production-task-read-state")).toHaveTextContent("available");
    expect(canvas.queryAllByText("焦点缓存任务", { exact: true }).length).toBeGreaterThan(0);
    expect(canvas.queryAllByText("焦点缓存任务 2", { exact: true }).length).toBeGreaterThan(0);
    expect(canvas.queryAllByText(/已授权关系：子任务：FOCUS-2 焦点缓存任务 2/).length).toBeGreaterThan(0);

    await userEvent.click(canvas.getByRole("button", { name: "恢复 mock 在线" }));
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true }).length).toBeGreaterThan(0));

    const forbiddenBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "模拟任务权限收紧并刷新" }));
    await waitFor(() => expect(canvas.getByTestId("production-task-read-state")).toHaveTextContent("forbidden"));
    await waitFor(() => expect(readCounter("production-task-calls")).toBeGreaterThan(forbiddenBefore.tasks));
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true })).toHaveLength(0));
    expect(canvas.queryAllByText("焦点缓存任务", { exact: true })).toHaveLength(0);

    await userEvent.click(canvas.getByRole("button", { name: "恢复 mock 在线" }));
    await waitFor(() => expect(canvas.queryAllByText("Beta 私有任务", { exact: true }).length).toBeGreaterThan(0));
    await userEvent.click(canvas.getByRole("button", { name: "列表" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true"));

    const permissionBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "撤销 Beta 项目并刷新" }));
    await waitFor(() => expect(canvas.getByTestId("production-revoked-projects")).toHaveTextContent("project-beta"));
    await waitFor(() => expect(readCounter("production-project-calls")).toBeGreaterThan(permissionBefore.projects));
    await waitFor(() => expect(readCounter("production-membership-calls")).toBeGreaterThan(permissionBefore.memberships));
    await waitFor(() => expect(canvas.queryByText("Beta 私有任务", { exact: true })).toBeNull());
    expect(canvas.getByText("焦点缓存任务", { exact: true })).toBeInTheDocument();
    expect(canvas.queryByRole("link", { name: /Beta workspace/ })).toBeNull();

    await pause(1100);
    const replacementBefore = readRequests();
    await userEvent.click(canvas.getByRole("button", { name: "切换主体并恢复" }));
    await waitFor(() => expect(canvasElement.querySelector('[data-runtime="production"][data-mount-identity="principal-b"]')).not.toBeNull());
    await waitFor(() => expect(canvas.getByText("主体 B 焦点任务", { exact: true })).toBeInTheDocument());
    const replacementNodes = readNodes();
    if (!replacementNodes.shell || !replacementNodes.outlet) throw new Error("replacement production nodes were not rendered");
    expect(replacementNodes.shell).not.toBe(initialNodes.shell);
    expect(replacementNodes.outlet).not.toBe(initialNodes.outlet);
    expect(readCounter("production-shell-mounts")).toBeGreaterThan(initialShellMounts);
    expect(readCounter("production-shell-unmounts")).toBeGreaterThan(0);
    expect(readCounter("production-outlet-mounts")).toBeGreaterThan(initialOutletMounts);
    expect(readCounter("production-outlet-unmounts")).toBeGreaterThan(0);
    expect(readCounter("production-project-calls")).toBeGreaterThan(replacementBefore.projects);
    expect(canvas.getByTestId("production-bound-principals")).toHaveTextContent("principal-a");
    expect(canvas.getByTestId("production-bound-principals")).toHaveTextContent("principal-b");
    expect(canvas.getByPlaceholderText("搜索任务、目标或编号")).not.toHaveValue("FOCUS-1");

    await pause(1100);
    await userEvent.click(canvas.getByRole("button", { name: "模拟会话失效" }));
    await waitFor(() => expect(canvas.getByText("登录 Loomhelm")).toBeInTheDocument());
    expect(canvas.getByText("当前浏览器没有有效会话。")).toBeInTheDocument();
      await waitFor(() => expect(canvasElement.querySelector('[data-runtime="production"][data-mount-identity="unauthenticated"]')).not.toBeNull());
    };
    canvasElement.dataset.playState = "running";
    delete canvasElement.dataset.playError;
    try {
      await run();
      canvasElement.dataset.playState = "passed";
    } catch (error) {
      canvasElement.dataset.playState = "failed";
      canvasElement.dataset.playError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
};

export const ProductionRecoveryPreview: Story = {
  render: () => <ProductionBoundaryHarness offlinePreview showMountProbe={false} />
};
