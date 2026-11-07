import {
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { MessageCircle } from "lucide-react";

import { useOptionalProductionApi } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { useOptionalDemoRuntime } from "@/demo/context";
import { AppShell } from "@/components/product/ProductShell";
import { CreateConversationRoute } from "@/routes/CreateConversationRoute";
import { CreateTaskRoute } from "@/routes/CreateTaskRoute";
import { DeploymentRoute } from "@/routes/DeploymentRoute";
import { ConversationsRoute } from "@/routes/ConversationsRoute";
import { ProductionConversationsRoute } from "@/routes/ProductionConversationsRoute";
import { DemoProductionConversationRoute } from "@/routes/DemoProductionConversationRoute";
import { DemoProductionConversationsRoute } from "@/routes/DemoProductionConversationsRoute";
import { DemoCodexConversationsRoute } from "@/routes/DemoCodexConversationsRoute";
import { ProjectRoute } from "@/routes/ProjectRoute";
import { StatusRoute } from "@/routes/StatusRoute";
import { TasksRoute } from "@/routes/TasksRoute";
import { ConversationWorkspaceRoute, TaskWorkspaceRoute } from "@/routes/WorkspaceRoute";
import { WorkbenchRoute } from "@/routes/WorkbenchRoute";
import { ProductionConversationWorkspace } from "@/features/conversations/ProductionConversationWorkspace";
import { createPublishedSessionApi } from "@/features/sessions/api";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";

function ProductionWorkbenchRoute() {
  const navigate = useNavigate();
  const assembly = useOptionalProductionApi();
  const source = useOptionalProjectTaskSource();
  const api = useMemo(() => assembly?.auth.status === "authenticated" ? createPublishedSessionApi(assembly.client) : undefined, [assembly?.auth.status, assembly?.client]);
  const sourceReady = source?.status === "ready";
  const sourceStatus = !source
    ? "项目和任务范围尚未加载；独立 Session 创建仍可用。"
    : source.status === "loading"
      ? "正在读取项目和任务范围；独立 Session 创建仍可用。"
      : source.status === "ready"
        ? "项目和任务范围已核对。"
        : source.notice ?? "项目和任务范围暂时不可用；当前不会显示未确认的数据。";

  return (
    <section className="page-section grid min-w-0 gap-6">
      <div className="page-heading">
        <div><span className="eyebrow">WORKBENCH</span><h1>工作台</h1><p>从这里创建新的 Session，或查看当前账户有权访问的全部对话。</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="secondary" className="button button-secondary"><Link to="/conversations"><MessageCircle size={15} aria-hidden="true" />全部对话</Link></Button>
          <Button asChild variant="secondary" className="button button-secondary"><Link to="/deployment">部署控制</Link></Button>
        </div>
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <ProductionConversationWorkspace
          key={assembly?.auth.principalId ?? "anonymous"}
          api={api}
          conversationTitle="新建独立会话"
          onSessionCreated={(sessionId, initialRunId) => navigate({ params: { conversationId: sessionId }, search: initialRunId ? { runId: initialRunId } : {}, to: "/conversations/$conversationId" })}
          principalId={assembly?.auth.principalId}
          projectCanWrite={(projectId) => sourceReady && source.getProjectPermissions(projectId).canWrite}
          projectOptions={sourceReady ? source.projects : []}
          readOnly={assembly?.permissions.isReadOnly ?? true}
        />
        <aside className="grid content-start gap-4" aria-label="工作台状态">
          <section className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
            <span className="section-kicker">执行前提</span>
            <h2 className="text-base font-semibold text-[var(--ink)]">Connector</h2>
            <p className="text-xs leading-5 text-[var(--muted)]">新建 Desktop 对话需要已注册的 Connector。Connector 运行在执行机器上，不属于蓝绿 Web、Server、Worker 槽位。</p>
            <Link to="/deployment" className="inline-link">查看部署状态</Link>
          </section>
          <section className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
            <span className="section-kicker">当前范围</span>
            <p className="text-xs leading-5 text-[var(--muted)]">{sourceStatus}</p>
            <dl className="info-facts"><dt>项目</dt><dd>{sourceReady ? source.projects.length : "待核对"}</dd><dt>任务</dt><dd>{sourceReady ? source.tasks.length : "待核对"}</dd></dl>
            <Link to="/tasks" className="inline-link">打开任务列表</Link>
          </section>
        </aside>
      </div>
    </section>
  );
}

function RootRoute() {
  return useOptionalDemoRuntime() ? <WorkbenchRoute /> : <ProductionWorkbenchRoute />;
}

function ConversationsEntryRoute() {
  return useOptionalDemoRuntime()
    ? <ConversationsRoute />
    : <ProductionConversationsRoute />;
}

function CreateConversationEntryRoute() {
  return useOptionalDemoRuntime()
    ? <CreateConversationRoute />
    : <ProductionCreateConversationRoute />;
}

function ProductionCreateConversationRoute() {
  const navigate = useNavigate();
  const assembly = useOptionalProductionApi();
  const source = useOptionalProjectTaskSource();
  const api = useMemo(() => assembly?.auth.status === "authenticated" ? createPublishedSessionApi(assembly.client) : undefined, [assembly?.auth.status, assembly?.client]);
  return (
    <section className="page-section">
      <ProductionConversationWorkspace
        key={assembly?.auth.principalId ?? "anonymous"}
        api={api}
        conversationTitle="新建独立会话"
        onSessionCreated={(sessionId, initialRunId) => navigate({ params: { conversationId: sessionId }, search: initialRunId ? { runId: initialRunId } : {}, to: "/conversations/$conversationId" })}
        principalId={assembly?.auth.principalId}
        projectCanWrite={(projectId) => source?.getProjectPermissions(projectId).canWrite === true}
        projectOptions={source?.projects}
        readOnly={assembly?.permissions.isReadOnly ?? true}
      />
    </section>
  );
}

const rootRoute = createRootRoute({ component: AppShell });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RootRoute
});

const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: StatusRoute
});

const deploymentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deployment",
  component: DeploymentRoute
});

const demoProductionConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/demo/production-session",
  component: DemoProductionConversationRoute
});

const demoProductionConversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/demo/production-conversations",
  component: DemoProductionConversationsRoute
});

const demoCodexConversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/demo/codex-conversations",
  component: DemoCodexConversationsRoute
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksRoute
});

const createTaskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/new",
  validateSearch: (search: Record<string, unknown>) => typeof search.projectId === "string" ? { projectId: search.projectId } : {},
  component: CreateTaskRoute
});

const taskWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  validateSearch: (search: Record<string, unknown>) => typeof search.runId === "string" ? { runId: search.runId } : {},
  component: TaskWorkspaceRoute
});

const conversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/conversations",
  component: ConversationsEntryRoute
});

const createConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/conversations/new",
  component: CreateConversationEntryRoute
});

const conversationWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/conversations/$conversationId",
  validateSearch: (search: Record<string, unknown>): { runId?: string; returnTo?: "demo-production-conversations" } => {
    const validated: { runId?: string; returnTo?: "demo-production-conversations" } = {};
    if (typeof search.runId === "string") validated.runId = search.runId;
    if (search.returnTo === "demo-production-conversations") validated.returnTo = search.returnTo;
    return validated;
  },
  component: ConversationWorkspaceRoute
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectRoute
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  statusRoute,
  deploymentRoute,
  demoProductionConversationRoute,
  demoProductionConversationsRoute,
  demoCodexConversationsRoute,
  tasksRoute,
  createTaskRoute,
  taskWorkspaceRoute,
  conversationsRoute,
  createConversationRoute,
  conversationWorkspaceRoute,
  projectRoute
]);

export const router = createRouter({
  routeTree,
  basepath: "/",
  defaultPreload: "intent"
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
