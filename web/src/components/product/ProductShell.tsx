import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  FlaskConical,
  LayoutDashboard,
  ListTodo,
  LogIn,
  LogOut,
  Menu,
  Plus,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { useOptionalProductionApi, useProductionAuthActions } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDemoRuntime, useOptionalDemoRuntime } from "@/demo/context";
import type { ThemeMode } from "@/demo/types";
import { useOptionalDemoProjectTaskSource } from "@/features/tasks/demo-store";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import type { ProjectTaskSource } from "@/features/tasks/types";

import { DemoInspector, DemoNotice, DemoSceneBanner } from "./DemoInspector";
import { useRouteContentFocus } from "./route-focus";

type MobileCloseReason = "dismiss" | "navigate";

export function MobileNavigationBackdrop({ onDismiss }: { onDismiss: () => void }) {
  return <button type="button" className="mobile-backdrop" aria-label="关闭导航" onClick={onDismiss} />;
}

function useMobileDrawer(open: boolean, onClose: () => void) {
  const mobileQuery = "(max-width: 1199px)";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const closeReasonRef = useRef<MobileCloseReason>("dismiss");
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(mobileQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const active = open && isMobile;
  const close = useCallback((reason: MobileCloseReason) => {
    closeReasonRef.current = reason;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (open && !isMobile) close("dismiss");
  }, [close, isMobile, open]);

  useEffect(() => {
    if (!active) return;
    const drawer = drawerRef.current;
    const focusFirst = () => drawer?.querySelector<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
    const frame = requestAnimationFrame(focusFirst);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close("dismiss");
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, close]);

  useEffect(() => {
    const workArea = workAreaRef.current;
    if (!workArea) return;
    const inertWorkArea = workArea as HTMLDivElement & { inert?: boolean };
    inertWorkArea.inert = active;
    if (active) {
      workArea.setAttribute("aria-hidden", "true");
      workArea.setAttribute("inert", "");
    } else {
      workArea.removeAttribute("aria-hidden");
      workArea.removeAttribute("inert");
    }
  }, [active]);

  useEffect(() => {
    if (active) {
      openedRef.current = true;
      return;
    }
    if (openedRef.current) {
      openedRef.current = false;
      const closeReason = closeReasonRef.current;
      closeReasonRef.current = "dismiss";
      if (closeReason === "navigate") {
        document.querySelector<HTMLElement>("main.product-content")?.focus();
        return;
      }
      const trigger = triggerRef.current;
      if (trigger && trigger.getClientRects().length > 0) {
        trigger.focus();
      } else {
        document.querySelector<HTMLElement>("main.product-content")?.focus();
      }
    }
  }, [active]);

  return { drawerRef, triggerRef, workAreaRef, isMobile, active, close };
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
  const source = useOptionalDemoProjectTaskSource();
  const projects = source?.projects ?? runtime.fixtures.projects;
  return (
    <div className="nav-projects">
      <div className="nav-section-label">项目</div>
      <Button type="button" variant="ghost" className="nav-tree-toggle" onClick={() => onToggle("projects")} aria-expanded={expanded.projects}>
        {expanded.projects ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>所有项目</span>
      </Button>
      {expanded.projects && projects.map((project) => {
        const conversations = runtime.fixtures.conversations.filter((conversation) => conversation.projectId === project.id);
        const accent = runtime.fixtures.projects.find((fixture) => fixture.id === project.id)?.accent ?? "blue";
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
                <span className={`project-dot project-dot-${accent}`} aria-hidden="true" />
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

function useProductionTheme(): [ThemeMode, (theme: ThemeMode) => void] {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    try {
      const stored = window.localStorage.getItem("loomhelm.theme");
      return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      root.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      delete root.dataset.demo;
    };
    applyTheme();
    if (theme !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  const updateTheme = (next: ThemeMode) => {
    setTheme(next);
    try {
      window.localStorage.setItem("loomhelm.theme", next);
    } catch {
      // Theme persistence is optional; the current document still updates.
    }
  };

  return [theme, updateTheme];
}

function ProductionProjectTree({
  source,
  expanded,
  onToggle,
  onNavigate
}: {
  source: ProjectTaskSource | null;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onNavigate: () => void;
}) {
  const projects = source?.projects ?? [];
  return (
    <div className="nav-projects">
      <div className="nav-section-label">项目</div>
      <Button type="button" variant="ghost" className="nav-tree-toggle" onClick={() => onToggle("projects")} aria-expanded={expanded.projects}>
        {expanded.projects ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>所有项目</span>
      </Button>
      {expanded.projects && source?.status === "loading" && <div className="nav-conversation-link"><span>项目加载中…</span><small>正在读取当前授权范围</small></div>}
      {expanded.projects && source?.status === "error" && <div className="nav-conversation-link"><span>项目暂不可用</span><small>读取失败，页面保持保护</small></div>}
      {expanded.projects && source?.status === "permission-changed" && !projects.length && <div className="nav-conversation-link"><span>没有可见项目</span><small>项目权限已发生变化</small></div>}
      {expanded.projects && source?.status === "ready" && !projects.length && <div className="nav-conversation-link"><span>还没有项目</span><small>可从任务页创建项目</small></div>}
      {expanded.projects && projects.map((project) => (
        <div className="nav-project-row" key={project.id}>
          <span className="project-dot" aria-hidden="true" />
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            className="nav-link nav-project-link"
            activeProps={{ "aria-current": "page" }}
            onClick={onNavigate}
          >
            <span>{project.name}</span>
          </Link>
        </div>
      ))}
    </div>
  );
}

function ProductionBreadcrumb({ pathname, source }: { pathname: string; source: ProjectTaskSource | null }) {
  const projectId = pathname.startsWith("/projects/") ? pathname.split("/")[2] : undefined;
  const taskId = pathname.startsWith("/tasks/") ? pathname.split("/")[2] : undefined;
  const project = source?.getProject(projectId);
  const task = source?.getTask(taskId);
  if (pathname === "/") return <span>工作台</span>;
  if (task) return <span>任务 / {task.id}</span>;
  if (pathname.startsWith("/tasks")) return <span>任务 / 全部项目</span>;
  if (project) return <span>{project.name} / 任务</span>;
  if (pathname.startsWith("/projects/")) return <span>项目 / 当前范围</span>;
  if (pathname.startsWith("/conversations")) return <span>对话 / 服务尚未接通</span>;
  return <span>工作台</span>;
}

function ProductionAuthGate() {
  const assembly = useOptionalProductionApi();
  const { login } = useProductionAuthActions();
  const auth = assembly?.auth;
  if (!auth || auth.status === "loading") {
    return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">AUTHENTICATION</span><h1>正在验证浏览器会话</h1><p>正在读取当前登录身份；受保护的项目和任务数据会在验证完成后显示。</p></section>;
  }
  return (
    <section className="page-section unavailable-page">
      <span className="eyebrow">AUTHENTICATION</span>
      <h1>{auth.status === "error" ? "暂时无法验证浏览器会话" : "登录 Loomhelm"}</h1>
      <p>{auth.message ?? (auth.status === "error" ? "认证服务暂时不可用，当前不会读取受保护数据。" : "使用配置好的 OIDC 身份登录后，才能访问项目和任务。")}</p>
      <Button type="button" variant="default" className="button button-primary" onClick={login}><LogIn size={15} aria-hidden="true" />{auth.status === "error" ? "重新登录" : "通过 OIDC 登录"}</Button>
    </section>
  );
}

function ProductionShell() {
  const assembly = useOptionalProductionApi();
  const source = useOptionalProjectTaskSource();
  const { login, logout, logoutPending } = useProductionAuthActions();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const contentRef = useRouteContentFocus(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ projects: true });
  const [theme, setTheme] = useProductionTheme();
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);
  const authenticated = assembly?.auth.status === "authenticated";

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const openMobile = useCallback(() => setMobileOpen(true), []);
  const { drawerRef, triggerRef, workAreaRef, isMobile, active, close: closeDrawer } = useMobileDrawer(mobileOpen, closeMobile);
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));

  const navigation = (
    <nav className="product-navigation" aria-label="主导航">
      <div className="nav-section">
        <div className="nav-section-label">工作空间</div>
        <Link to="/" activeOptions={{ exact: true }} className="nav-link" activeProps={{ "aria-current": "page" }} onClick={() => closeDrawer("navigate")}>
          <LayoutDashboard size={17} aria-hidden="true" />
          <span>工作台</span>
        </Link>
        <Link to="/tasks" className="nav-link" activeProps={{ "aria-current": "page" }} onClick={() => closeDrawer("navigate")}>
          <ListTodo size={17} aria-hidden="true" />
          <span>任务</span>
        </Link>
      </div>
      <ProductionProjectTree source={source} expanded={expanded} onToggle={toggle} onNavigate={() => closeDrawer("navigate")} />
    </nav>
  );

  const handleLogout = async () => {
    setLogoutMessage(null);
    const result = await logout();
    if (!result.ok) setLogoutMessage(result.message);
  };

  return (
    <div className="product-shell" data-runtime="production">
      <aside ref={drawerRef} id="production-mobile-navigation" className={`product-sidebar ${mobileOpen ? "product-sidebar-open" : ""}`} role={active ? "dialog" : undefined} aria-modal={active ? true : undefined} aria-label={active ? "移动端主导航" : undefined} aria-hidden={isMobile && !active ? true : undefined}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><FlaskConical size={21} strokeWidth={1.8} /></span>
          <span>Loomhelm</span>
        </div>
        {navigation}
        <div className="sidebar-footer">
          <span className="avatar"><CircleUserRound size={18} aria-hidden="true" /></span>
          <span><strong>{authenticated ? assembly?.auth.principalId : "浏览器会话"}</strong><small>{authenticated ? "当前登录身份" : "尚未登录"}</small></span>
        </div>
      </aside>
      {mobileOpen && <MobileNavigationBackdrop onDismiss={() => closeDrawer("dismiss")} />}
      <div ref={workAreaRef} className="product-work-area">
        <header className="product-header">
          <Button ref={triggerRef} type="button" variant="ghost" size="icon" className="icon-button mobile-menu-button" aria-label="打开导航" aria-controls="production-mobile-navigation" aria-expanded={mobileOpen} title="打开导航" onClick={openMobile}>
            <Menu size={19} aria-hidden="true" />
          </Button>
          <div className="breadcrumb"><ProductionBreadcrumb pathname={pathname} source={source} /></div>
          <div className="header-actions">
            <span className="demo-label"><span className="demo-label-dot" aria-hidden="true" />{authenticated ? "浏览器会话" : "未登录"}</span>
            <Select value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
              <SelectTrigger size="sm" className="theme-select-trigger" aria-label="界面主题">
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
            {authenticated ? <>
              <Button asChild variant="default" className="button button-primary header-create" onClick={() => closeDrawer("navigate")}>
                <Link to="/tasks/new" aria-label="新建任务"><Plus size={16} aria-hidden="true" /><span>新建任务</span></Link>
              </Button>
              <Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void handleLogout(); }} disabled={logoutPending}>
                <LogOut size={15} aria-hidden="true" />{logoutPending ? "退出中…" : "退出登录"}
              </Button>
            </> : <Button type="button" variant="default" className="button button-primary" onClick={login}><LogIn size={15} aria-hidden="true" />登录</Button>}
          </div>
          <Button type="button" variant="ghost" size="icon" className="icon-button mobile-close-button" aria-label="关闭导航" title="关闭导航" onClick={() => closeDrawer("dismiss")}>
            <X size={19} aria-hidden="true" />
          </Button>
        </header>
        <main ref={contentRef} className="product-content" tabIndex={-1} aria-label="主要内容">
          {logoutMessage && <div className="inline-state inline-state-warning" role="alert"><span aria-hidden="true">!</span>{logoutMessage}</div>}
          {authenticated ? <Outlet /> : <ProductionAuthGate />}
        </main>
      </div>
    </div>
  );
}

export function ProductShell({ children }: PropsWithChildren) {
  const runtime = useDemoRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const contentRef = useRouteContentFocus(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ projects: true, "project:loomhelm": true });

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const openMobile = useCallback(() => setMobileOpen(true), []);
  const { drawerRef, triggerRef, workAreaRef, isMobile, active, close: closeDrawer } = useMobileDrawer(mobileOpen, closeMobile);
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));
  const openCreate = () => closeDrawer("navigate");

  const navigation = (
    <nav className="product-navigation" aria-label="主导航">
      <div className="nav-section">
        <div className="nav-section-label">工作空间</div>
        <Link to="/" activeOptions={{ exact: true }} className="nav-link" activeProps={{ "aria-current": "page" }} onClick={() => closeDrawer("navigate")}>
          <LayoutDashboard size={17} aria-hidden="true" />
          <span>工作台</span>
          {runtime.fixtures.attention.filter((item) => item.status === "pending").length > 0 && <span className="nav-count">{runtime.fixtures.attention.filter((item) => item.status === "pending").length}</span>}
        </Link>
        <Link to="/tasks" className="nav-link" activeProps={{ "aria-current": "page" }} onClick={() => closeDrawer("navigate")}>
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
            onClick={() => closeDrawer("navigate")}
          >
            <span>{conversation.title}</span>
            <small>{conversation.execution}</small>
          </Link>
        ))}
      </div>

      <ProjectTree expanded={expanded} onToggle={toggle} onNavigate={() => closeDrawer("navigate")} />
    </nav>
  );

  return (
    <div className={`product-shell ${runtime.inspectorOpen ? "has-inspector" : ""}`} data-inspector-mode={runtime.inspectorMode} data-scene={runtime.scene} data-network={runtime.network}>
      <aside ref={drawerRef} id="demo-mobile-navigation" className={`product-sidebar ${mobileOpen ? "product-sidebar-open" : ""}`} role={active ? "dialog" : undefined} aria-modal={active ? true : undefined} aria-label={active ? "移动端主导航" : undefined} aria-hidden={isMobile && !active ? true : undefined}>
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
      {mobileOpen && <MobileNavigationBackdrop onDismiss={() => closeDrawer("dismiss")} />}
      <div ref={workAreaRef} className="product-work-area">
        <header className="product-header">
          <Button ref={triggerRef} type="button" variant="ghost" size="icon" className="icon-button mobile-menu-button" aria-label="打开导航" aria-controls="demo-mobile-navigation" aria-expanded={mobileOpen} title="打开导航" onClick={openMobile}>
            <Menu size={19} aria-hidden="true" />
          </Button>
          <div className="breadcrumb"><Breadcrumb pathname={pathname} /></div>
          <div className="header-actions">
            <span className="demo-label"><span className="demo-label-dot" aria-hidden="true" />Demo</span>
            <Select value={runtime.theme} onValueChange={(value) => runtime.setTheme(value as "system" | "light" | "dark")}>
              <SelectTrigger size="sm" className="theme-select-trigger" aria-label="界面主题">
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
              <Link to="/tasks/new" aria-label="新建任务">
                <Plus size={16} aria-hidden="true" />
                <span>新建任务</span>
              </Link>
            </Button>
          </div>
            <Button type="button" variant="ghost" size="icon" className="icon-button mobile-close-button" aria-label="关闭导航" title="关闭导航" onClick={() => closeDrawer("dismiss")}>
            <X size={19} aria-hidden="true" />
          </Button>
        </header>
        <DemoSceneBanner />
        <main ref={contentRef} className="product-content" tabIndex={-1} aria-label="主要内容">{children ?? <Outlet />}</main>
      </div>
      <DemoNotice />
      <DemoInspector />
    </div>
  );
}

export function AppShell() {
  const runtime = useOptionalDemoRuntime();
  return runtime ? <ProductShell /> : <ProductionShell />;
}
