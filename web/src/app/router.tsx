import {
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";

import { isDemoPath } from "@/demo/bootstrap";
import { useOptionalDemoRuntime } from "@/demo/context";
import { AppShell } from "@/components/product/ProductShell";
import { CreateConversationRoute } from "@/routes/CreateConversationRoute";
import { CreateTaskRoute } from "@/routes/CreateTaskRoute";
import { ConversationsRoute } from "@/routes/ConversationsRoute";
import { ProjectRoute } from "@/routes/ProjectRoute";
import { StatusRoute } from "@/routes/StatusRoute";
import { TasksRoute } from "@/routes/TasksRoute";
import { ConversationWorkspaceRoute, TaskWorkspaceRoute } from "@/routes/WorkspaceRoute";
import { VerificationRoute } from "@/routes/VerificationRoute";
import { WorkbenchRoute } from "@/routes/WorkbenchRoute";

function RootRoute() {
  return useOptionalDemoRuntime() ? <WorkbenchRoute /> : <VerificationRoute />;
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
  component: ConversationsRoute
});

const createConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/conversations/new",
  component: CreateConversationRoute
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
  basepath: isDemoPath() ? "/demo" : "/",
  defaultPreload: "intent"
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
