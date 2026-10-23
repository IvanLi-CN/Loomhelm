import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  FlaskConical,
  LayoutDashboard,
  ListTodo,
  Menu,
  Plus,
  X
} from "lucide-react";
import { useState, type PropsWithChildren } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDemoRuntime, useOptionalDemoRuntime } from "@/demo/context";

import { DemoInspector, DemoNotice, DemoSceneBanner } from "./DemoInspector";

function TechnicalShell() {
  return (
    <div className="technical-shell">
      <header>
        <strong>Loomhelm / web foundation</strong>
        <span>Technical verification surface</span>
      </header>
      <main><Outlet /></main>
    </div>
  );
}

function isSelected(pathname: string, target: string): boolean {
  return target === "/" ? pathname === target : pathname === target || pathname.startsWith(`${target}/`);
}

function ProjectTree({
  expanded,
  onToggle,
  onNavigate
}: {
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onNavigate: () => void;
}) {
  const runtime = useDemoRuntime();
  return (
    <div className="nav-projects">
      <div className="nav-section-label">项目</div>
      <Button type="button" variant="ghost" className="nav-tree-toggle" onClick={() => onToggle("projects")} aria-expanded={expanded.projects}>
        {expanded.projects ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>所有项目</span>
      </Button>
      {expanded.projects && runtime.fixtures.projects.map((project) => {
        const conversations = runtime.fixtures.conversations.filter((conversation) => conversation.projectId === project.id);
        const key = `project:${project.id}`;
        return (
          <div className="nav-project" key={project.id}>
            <div className="nav-project-row">
              <Button type="button" variant="ghost" size="icon" className="nav-project-toggle" onClick={() => onToggle(key)} aria-expanded={expanded[key]}>
                {expanded[key] ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              </Button>
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="nav-link nav-project-link"
                activeProps={{ "aria-current": "page" }}
                onClick={onNavigate}
              >
                <span className={`project-dot project-dot-${project.accent}`} aria-hidden="true" />
                <span>{project.name}</span>
              </Link>
            </div>
            {expanded[key] && (
              <div className="nav-conversation-list">
                {conversations.map((conversation) => (
                  <Link
                    key={conversation.id}
                    to="/conversations/$conversationId"
                    params={{ conversationId: conversation.id }}
                    className="nav-conversation-link"
                    activeProps={{ "aria-current": "page" }}
                    onClick={onNavigate}
                  >
                    <span>{conversation.title}</span>
                    <small>{conversation.taskId ? `任务 ${conversation.taskId}` : "未关联任务"}</small>
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Breadcrumb({ pathname }: { pathname: string }) {
  const runtime = useDemoRuntime();
  const task = runtime.fixtures.tasks.find((item) => pathname.includes(`/tasks/${item.id}`));
  const conversation = runtime.fixtures.conversations.find((item) => pathname.includes(`/conversations/${item.id}`));
  const project = runtime.fixtures.projects.find((item) => pathname.includes(`/projects/${item.id}`));
  if (pathname === "/") return <span>工作台</span>;
  if (pathname.startsWith("/tasks") && task) return <span>任务 / {task.id}</span>;
  if (pathname.startsWith("/tasks")) return <span>任务 / 全部项目</span>;
  if (pathname.startsWith("/conversations") && conversation) return <span>对话 / {conversation.title}</span>;
  if (pathname.startsWith("/conversations")) return <span>对话 / 全部项目</span>;
  if (project) return <span>{project.name} / 对话</span>;
  return <span>工作台</span>;
}

export function ProductShell({ children }: PropsWithChildren) {
  const runtime = useDemoRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ projects: true, "project:loomhelm": true });

  const closeMobile = () => setMobileOpen(false);
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));
  const openCreate = () => closeMobile();

  const navigation = (
    <nav className="product-navigation" aria-label="主导航">
      <div className="nav-section">
        <div className="nav-section-label">工作空间</div>
        <Link to="/" activeOptions={{ exact: true }} className="nav-link" activeProps={{ "aria-current": "page" }} onClick={closeMobile}>
          <LayoutDashboard size={17} aria-hidden="true" />
          <span>工作台</span>
          {runtime.fixtures.attention.filter((item) => item.status === "pending").length > 0 && <span className="nav-count">{runtime.fixtures.attention.filter((item) => item.status === "pending").length}</span>}
        </Link>
        <Link to="/tasks" className="nav-link" activeProps={{ "aria-current": "page" }} onClick={closeMobile}>
          <ListTodo size={17} aria-hidden="true" />
          <span>任务</span>
        </Link>
      </div>

      <div className="nav-section">
        <div className="nav-section-label">对话</div>
        {runtime.fixtures.conversations.filter((conversation) => !conversation.projectId).map((conversation) => (
          <Link
            key={conversation.id}
            to="/conversations/$conversationId"
            params={{ conversationId: conversation.id }}
            className="nav-conversation-link nav-conversation-link-root"
            activeProps={{ "aria-current": "page" }}
            onClick={closeMobile}
          >
            <span>{conversation.title}</span>
            <small>{conversation.execution}</small>
          </Link>
        ))}
      </div>

      <ProjectTree expanded={expanded} onToggle={toggle} onNavigate={closeMobile} />
    </nav>
  );

  return (
    <div className={`product-shell ${runtime.inspectorOpen ? "has-inspector" : ""}`} data-inspector-mode={runtime.inspectorMode} data-scene={runtime.scene} data-network={runtime.network}>
      <aside className={`product-sidebar ${mobileOpen ? "product-sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><FlaskConical size={21} strokeWidth={1.8} /></span>
          <span>Loomhelm</span>
        </div>
        {navigation}
        <div className="sidebar-footer">
          <span className="avatar"><CircleUserRound size={18} aria-hidden="true" /></span>
          <span><strong>我的工作区</strong><small>个人工作空间</small></span>
        </div>
      </aside>
      {mobileOpen && <Button type="button" variant="ghost" className="mobile-backdrop" aria-label="关闭导航" onClick={closeMobile} />}
      <div className="product-work-area">
        <header className="product-header">
          <Button type="button" variant="ghost" size="icon" className="icon-button mobile-menu-button" aria-label="打开导航" title="打开导航" onClick={() => setMobileOpen(true)}>
            <Menu size={19} aria-hidden="true" />
          </Button>
          <div className="breadcrumb"><Breadcrumb pathname={pathname} /></div>
          <div className="header-actions">
            <span className="demo-label"><span className="demo-label-dot" aria-hidden="true" />Demo</span>
            <Select value={runtime.theme} onValueChange={(value) => runtime.setTheme(value as "system" | "light" | "dark")}>
              <SelectTrigger className="theme-select-trigger" aria-label="界面主题">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="system">系统主题</SelectItem>
                  <SelectItem value="light">亮色</SelectItem>
                  <SelectItem value="dark">暗色</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button asChild variant="default" className="button button-primary header-create" onClick={openCreate}>
              <Link to="/tasks/new">
                <Plus size={16} aria-hidden="true" />
                <span>新建任务</span>
              </Link>
            </Button>
          </div>
          <Button type="button" variant="ghost" size="icon" className="icon-button mobile-close-button" aria-label="关闭导航" title="关闭导航" onClick={closeMobile}>
            <X size={19} aria-hidden="true" />
          </Button>
        </header>
        <DemoSceneBanner />
        <main className="product-content">{children ?? <Outlet />}</main>
      </div>
      <DemoNotice />
      <DemoInspector />
    </div>
  );
}

export function AppShell() {
  const runtime = useOptionalDemoRuntime();
  return runtime ? <ProductShell /> : <TechnicalShell />;
}
