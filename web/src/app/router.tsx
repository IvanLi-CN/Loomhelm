import {
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";

import { useOptionalProductionApi } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { useOptionalDemoRuntime } from "@/demo/context";
import { AppShell } from "@/components/product/ProductShell";
import { CreateConversationRoute } from "@/routes/CreateConversationRoute";
import { CreateTaskRoute } from "@/routes/CreateTaskRoute";
import { ConversationsRoute } from "@/routes/ConversationsRoute";
import { ProjectRoute } from "@/routes/ProjectRoute";
import { StatusRoute } from "@/routes/StatusRoute";
import { TasksRoute } from "@/routes/TasksRoute";
import { ConversationWorkspaceRoute, TaskWorkspaceRoute } from "@/routes/WorkspaceRoute";
import { WorkbenchRoute } from "@/routes/WorkbenchRoute";

function ProductionNotReadyRoute({ eyebrow, title, description, to = "/tasks", linkLabel = "查看任务" }: { eyebrow: string; title: string; description: string; to?: "/" | "/tasks"; linkLabel?: string }) {
  return <section className="page-section unavailable-page"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p><Button asChild variant="secondary" className="button button-secondary"><Link to={to}>{linkLabel}</Link></Button></section>;
}

function ProductionWorkbenchRoute() {
  const assembly = useOptionalProductionApi();
  return <ProductionNotReadyRoute eyebrow="WORKBENCH" title="工作台等待会话接入" description={assembly?.auth.message ?? "当前 production 已接入浏览器身份与项目/任务数据；会话、审批和执行能力会在服务端合同接通后显示。"} />;
}

function RootRoute() {
  return useOptionalDemoRuntime() ? <WorkbenchRoute /> : <ProductionWorkbenchRoute />;
}

function ConversationsEntryRoute() {
  return useOptionalDemoRuntime()
    ? <ConversationsRoute />
    : <ProductionNotReadyRoute eyebrow="CONVERSATIONS" title="对话服务尚未接通" description="当前 production 只显示真实的项目和任务数据，不会虚构对话叶子或使用 Demo fallback。" />;
}

function CreateConversationEntryRoute() {
  return useOptionalDemoRuntime()
    ? <CreateConversationRoute />
    : <ProductionNotReadyRoute eyebrow="CONVERSATIONS" title="创建对话尚未接通" description="会话创建、历史共享和执行入口由后续会话服务接入；当前不会提交模拟对话。" to="/" linkLabel="返回工作台" />;
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
