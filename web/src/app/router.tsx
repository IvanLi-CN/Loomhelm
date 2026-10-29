import {
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useOptionalProductionApi } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { useOptionalDemoRuntime } from "@/demo/context";
import { AppShell } from "@/components/product/ProductShell";
import { CreateConversationRoute } from "@/routes/CreateConversationRoute";
import { CreateTaskRoute } from "@/routes/CreateTaskRoute";
import { ConversationsRoute } from "@/routes/ConversationsRoute";
import { DemoProductionConversationRoute } from "@/routes/DemoProductionConversationRoute";
import { ProjectRoute } from "@/routes/ProjectRoute";
import { StatusRoute } from "@/routes/StatusRoute";
import { TasksRoute } from "@/routes/TasksRoute";
import { ConversationWorkspaceRoute, TaskWorkspaceRoute } from "@/routes/WorkspaceRoute";
import { WorkbenchRoute } from "@/routes/WorkbenchRoute";
import { ProductionConversationWorkspace } from "@/features/conversations/ProductionConversationWorkspace";
import { createPublishedSessionApi } from "@/features/sessions/api";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";

function ProductionNotReadyRoute({ eyebrow, title, description, to = "/tasks", linkLabel = "查看任务" }: { eyebrow: string; title: string; description: string; to?: "/" | "/tasks"; linkLabel?: string }) {
  return <section className="page-section unavailable-page"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p><Button asChild variant="secondary" className="button button-secondary"><Link to={to}>{linkLabel}</Link></Button></section>;
}

function ProductionWorkbenchRoute() {
  const assembly = useOptionalProductionApi();
  return <ProductionNotReadyRoute eyebrow="WORKBENCH" title="工作台等待会话接入" description={assembly?.auth.message ?? "当前已接入浏览器身份与项目、任务数据；会话、审批和执行能力将在服务可用后显示。"} />;
}

function RootRoute() {
  return useOptionalDemoRuntime() ? <WorkbenchRoute /> : <ProductionWorkbenchRoute />;
}

function ConversationsEntryRoute() {
  return useOptionalDemoRuntime()
    ? <ConversationsRoute />
    : <ProductionNotReadyRoute eyebrow="CONVERSATIONS" title="对话服务尚未接通" description="当前显示真实的项目和任务数据；对话功能将在服务可用后开放。" />;
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
        api={api}
        conversationTitle="新建独立会话"
        onSessionCreated={(sessionId, initialRunId) => navigate({ params: { conversationId: sessionId }, search: initialRunId ? { runId: initialRunId } : {}, to: "/conversations/$conversationId" })}
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

const demoProductionConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/demo/production-session",
  component: DemoProductionConversationRoute
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
  validateSearch: (search: Record<string, unknown>) => typeof search.runId === "string" ? { runId: search.runId } : {},
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
  demoProductionConversationRoute,
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
