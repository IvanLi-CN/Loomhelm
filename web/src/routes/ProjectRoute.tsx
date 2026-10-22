import { ListTodo, MessageCircle, Plus } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { getProject as getDemoProject, useOptionalDemoRuntime } from "@/demo/context";
import { ProjectActions } from "@/features/projects/ProjectForm";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { TaskExplorer } from "@/components/product/TaskViews";

type ProjectPanel = "tasks" | "conversations";
const projectPanels: readonly ProjectPanel[] = ["tasks", "conversations"];

export function ProjectRoute() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const navigate = useNavigate();
  const runtime = useOptionalDemoRuntime();
  const source = useOptionalProjectTaskSource();
  const [panel, setPanel] = useState<ProjectPanel>("tasks");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const project = source ? source.getProject(projectId) : runtime ? getDemoProject(runtime.fixtures, projectId) : undefined;
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

  if (source?.status === "loading") {
    return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">PROJECT ACCESS</span><h1>正在读取项目</h1><p>正在读取当前浏览器授权的项目范围，受保护的项目数据不会使用本地夹具替代。</p></section>;
  }

  if (!project || !source) {
    return <section className="page-section unavailable-page"><span className="eyebrow">PROJECT ACCESS</span><h1>项目当前不可用</h1><p>权限或连接状态发生变化，当前页面 fail-closed，不展示受保护项目的标题、数量或关系轮廓。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/">返回工作台</Link></Button></section>;
  }

  const canCreateProjectTask = source.status === "ready" && source.getProjectPermissions(projectId).canWrite;

  return (
    <section className="page-section project-page">
      <div className="page-heading project-heading"><div><span className="eyebrow">PROJECT</span><h1>{project.name}</h1><p>{project.summary}</p></div><div className="grid justify-items-end gap-3"><ProjectActions source={source} projectId={projectId} /><Button type="button" variant="secondary" className="button button-secondary" disabled={!canCreateProjectTask} onClick={() => { void navigate({ to: "/tasks/new", search: { projectId } }); }}><Plus size={16} aria-hidden="true" />新建任务</Button></div></div>
      <div className="project-tabs" role="tablist" aria-label="项目面板"><Button ref={(element) => { tabRefs.current[0] = element; }} id="project-tab-tasks" type="button" variant="ghost" role="tab" aria-selected={panel === "tasks"} aria-controls="project-panel-tasks" tabIndex={panel === "tasks" ? 0 : -1} className={`project-tab ${panel === "tasks" ? "is-selected" : ""}`} onClick={() => selectPanel("tasks")} onKeyDown={handlePanelKeyDown}><ListTodo size={16} aria-hidden="true" />任务 <span>{localTaskCount}</span></Button><Button ref={(element) => { tabRefs.current[1] = element; }} id="project-tab-conversations" type="button" variant="ghost" role="tab" aria-selected={panel === "conversations"} aria-controls="project-panel-conversations" tabIndex={panel === "conversations" ? 0 : -1} className={`project-tab ${panel === "conversations" ? "is-selected" : ""}`} onClick={() => selectPanel("conversations")} onKeyDown={handlePanelKeyDown}><MessageCircle size={16} aria-hidden="true" />对话 <span>{runtime ? conversations.length : "—"}</span></Button></div>
      <section id={`project-panel-${panel}`} role="tabpanel" aria-labelledby={`project-tab-${panel}`} tabIndex={0}>{panel === "tasks" ? <TaskExplorer source={source} scope={`project:${projectId}`} projectId={projectId} /> : runtime ? <div className="conversation-list project-conversation-list">{conversations.map((conversation) => <Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }} className="conversation-list-item" key={conversation.id}><span className="conversation-icon"><MessageCircle size={16} aria-hidden="true" /></span><span><strong>{conversation.title}</strong><small>{conversation.taskId ? `任务主对话 · ${conversation.taskId}` : "项目内未关联任务"} · {conversation.execution}</small><em>{conversation.preview}</em></span></Link>)}{!conversations.length && <div className="empty-state"><h2>项目中还没有对话</h2><p>项目范围内的对话会直接成为叶子，不插入任务导航层。</p></div>}</div> : <div className="empty-state"><h2>项目对话服务尚未接通</h2><p>当前 production 只显示真实项目与任务；会话历史和执行入口会在后续服务接入后显示。</p></div>}</section>
    </section>
  );
}
