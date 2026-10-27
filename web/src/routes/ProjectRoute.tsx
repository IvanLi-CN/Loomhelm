import { ListTodo, MessageCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { getProject as getDemoProject, useOptionalDemoRuntime } from "@/demo/context";
import { ProjectActions } from "@/features/projects/ProjectForm";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { ProjectReadRecovery, TaskExplorer } from "@/components/product/TaskViews";

type ProjectPanel = "tasks" | "conversations";
const projectPanels: readonly ProjectPanel[] = ["tasks", "conversations"];

export function ProjectRoute() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const navigate = useNavigate();
  const runtime = useOptionalDemoRuntime();
  const source = useOptionalProjectTaskSource();
  const [panel, setPanel] = useState<ProjectPanel>("tasks");
  const [deleteState, setDeleteState] = useState<{ projectId: string; status: "idle" | "pending" | "success" } | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const project = source ? source.getProject(projectId) : runtime ? getDemoProject(runtime.fixtures, projectId) : undefined;
  const lastProjectRef = useRef<{ projectId: string; project: typeof project } | undefined>(undefined);
  const deleteResultHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (project) lastProjectRef.current = { projectId, project };
  }, [project, projectId]);
  const currentDeleteState = deleteState?.projectId === projectId ? deleteState.status : "idle";
  const displayedProject = project ?? (currentDeleteState === "pending" && lastProjectRef.current?.projectId === projectId ? lastProjectRef.current.project : undefined);
  useEffect(() => {
    if (currentDeleteState !== "success") return;
    const frame = requestAnimationFrame(() => deleteResultHeadingRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [currentDeleteState]);
  const conversations = runtime?.fixtures.conversations.filter((conversation) => conversation.projectId === projectId) ?? [];
  const localTaskCount = source?.tasks.filter((task) => task.projectId === projectId).length ?? runtime?.fixtures.tasks.filter((task) => task.projectId === projectId).length ?? 0;
  const selectPanel = (nextPanel: ProjectPanel, focus = false) => {
    setPanel(nextPanel);
    if (focus) requestAnimationFrame(() => tabRefs.current[projectPanels.indexOf(nextPanel)]?.focus());
  };
  const handlePanelKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = projectPanels.indexOf(panel);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (currentIndex + 1) % projectPanels.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (currentIndex - 1 + projectPanels.length) % projectPanels.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? projectPanels.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    selectPanel(projectPanels[nextIndex], true);
  };

  if (currentDeleteState === "success") {
    return <section className="page-section unavailable-page"><span className="eyebrow">PROJECT</span><h1 ref={deleteResultHeadingRef} tabIndex={-1}>项目已删除</h1><div className="inline-state inline-state-success" role="status">项目已删除。</div><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务列表</Link></Button></section>;
  }

  if (source?.status === "loading" && currentDeleteState === "idle") {
    return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">PROJECT ACCESS</span><h1>正在读取项目</h1><p>正在读取当前授权的项目范围，请稍候。</p></section>;
  }

  if (!displayedProject || !source) {
    return source
      ? <section className="page-section unavailable-page"><span className="eyebrow">PROJECT ACCESS</span><ProjectReadRecovery source={source} projectId={projectId} /></section>
      : <section className="page-section unavailable-page"><span className="eyebrow">PROJECT ACCESS</span><h1>项目当前不可用</h1><p>权限或连接状态发生变化，当前页面无法显示受保护项目的信息。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/">返回工作台</Link></Button></section>;
  }

  const canCreateProjectTask = source.status === "ready" && source.getProjectPermissions(projectId).canWrite;

  return (
    <section className="page-section project-page">
      <div className="page-heading project-heading"><div><span className="eyebrow">PROJECT</span><h1>{displayedProject.name}</h1><p>{displayedProject.summary}</p></div><div className="grid justify-items-end gap-3"><ProjectActions key={projectId} source={source} projectId={projectId} fallbackProject={displayedProject} onDeleteStarted={() => setDeleteState({ projectId, status: "pending" })} onDeleteFailed={() => setDeleteState({ projectId, status: "idle" })} onDeleted={() => setDeleteState({ projectId, status: "success" })} /><Button type="button" variant="secondary" className="button button-secondary" disabled={!canCreateProjectTask} onClick={() => { void navigate({ to: "/tasks/new", search: { projectId } }); }}><Plus size={16} aria-hidden="true" />新建任务</Button></div></div>
      <div className="project-tabs" role="tablist" aria-label="项目面板"><Button ref={(element) => { tabRefs.current[0] = element; }} id="project-tab-tasks" type="button" variant="ghost" role="tab" aria-selected={panel === "tasks"} aria-controls="project-panel-tasks" tabIndex={panel === "tasks" ? 0 : -1} className={`project-tab ${panel === "tasks" ? "is-selected" : ""}`} onClick={() => selectPanel("tasks")} onKeyDown={handlePanelKeyDown}><ListTodo size={16} aria-hidden="true" />任务 <span>{localTaskCount}</span></Button><Button ref={(element) => { tabRefs.current[1] = element; }} id="project-tab-conversations" type="button" variant="ghost" role="tab" aria-selected={panel === "conversations"} aria-controls="project-panel-conversations" tabIndex={panel === "conversations" ? 0 : -1} className={`project-tab ${panel === "conversations" ? "is-selected" : ""}`} onClick={() => selectPanel("conversations")} onKeyDown={handlePanelKeyDown}><MessageCircle size={16} aria-hidden="true" />对话 <span>{runtime ? conversations.length : "—"}</span></Button></div>
      <section id="project-panel-tasks" role="tabpanel" aria-labelledby="project-tab-tasks" tabIndex={panel === "tasks" ? 0 : -1} hidden={panel !== "tasks"}>
        {panel === "tasks" && <TaskExplorer source={source} scope={`project:${projectId}`} projectId={projectId} />}
      </section>
      <section id="project-panel-conversations" role="tabpanel" aria-labelledby="project-tab-conversations" tabIndex={panel === "conversations" ? 0 : -1} hidden={panel !== "conversations"}>
        {panel === "conversations" && (runtime ? <div className="conversation-list project-conversation-list">{conversations.map((conversation) => <Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }} className="conversation-list-item" key={conversation.id}><span className="conversation-icon"><MessageCircle size={16} aria-hidden="true" /></span><span><strong>{conversation.title}</strong><small>{conversation.taskId ? `任务主对话 · ${conversation.taskId}` : "项目内未关联任务"} · {conversation.execution}</small><em>{conversation.preview}</em></span></Link>)}{!conversations.length && <div className="empty-state"><h2>项目中还没有对话</h2><p>项目范围内的对话会直接成为叶子，不插入任务导航层。</p></div>}</div> : <div className="empty-state"><h2>项目对话服务尚未接通</h2><p>项目与任务信息仍可查看，会话历史和执行入口将在服务可用后显示。</p></div>)}
      </section>
    </section>
  );
}
