import { ListTodo, MessageCircle, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { getProject as getDemoProject, useOptionalDemoRuntime } from "@/demo/context";
import { ProjectActions } from "@/features/projects/ProjectForm";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { TaskExplorer } from "@/components/product/TaskViews";

export function ProjectRoute() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const runtime = useOptionalDemoRuntime();
  const source = useOptionalProjectTaskSource();
  const [panel, setPanel] = useState<"tasks" | "conversations">("tasks");
  const project = source ? source.getProject(projectId) : runtime ? getDemoProject(runtime.fixtures, projectId) : undefined;
  const conversations = runtime?.fixtures.conversations.filter((conversation) => conversation.projectId === projectId) ?? [];
  const localTaskCount = source?.tasks.filter((task) => task.projectId === projectId).length ?? runtime?.fixtures.tasks.filter((task) => task.projectId === projectId).length ?? 0;

  if (!project || !source) {
    return <section className="page-section unavailable-page"><span className="eyebrow">PROJECT ACCESS</span><h1>项目当前不可用</h1><p>权限或连接状态发生变化，当前页面 fail-closed，不展示受保护项目的标题、数量或关系轮廓。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/">返回工作台</Link></Button></section>;
  }

  return (
    <section className="page-section project-page">
      <div className="page-heading project-heading"><div><span className="eyebrow">PROJECT</span><h1>{project.name}</h1><p>{project.summary}</p></div><div className="grid justify-items-end gap-3"><ProjectActions source={source} projectId={projectId} /><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks/new"><Plus size={16} aria-hidden="true" />新建任务</Link></Button></div></div>
      <div className="project-tabs" role="tablist" aria-label="项目面板"><Button type="button" variant="ghost" role="tab" aria-selected={panel === "tasks"} className={`project-tab ${panel === "tasks" ? "is-selected" : ""}`} onClick={() => setPanel("tasks")}><ListTodo size={16} aria-hidden="true" />任务 <span>{localTaskCount}</span></Button><Button type="button" variant="ghost" role="tab" aria-selected={panel === "conversations"} className={`project-tab ${panel === "conversations" ? "is-selected" : ""}`} onClick={() => setPanel("conversations")}><MessageCircle size={16} aria-hidden="true" />对话 <span>{conversations.length}</span></Button></div>
      {panel === "tasks" ? <TaskExplorer source={source} scope={`project:${projectId}`} projectId={projectId} /> : <div className="conversation-list project-conversation-list">{conversations.map((conversation) => <Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }} className="conversation-list-item" key={conversation.id}><span className="conversation-icon"><MessageCircle size={16} aria-hidden="true" /></span><span><strong>{conversation.title}</strong><small>{conversation.taskId ? `任务主对话 · ${conversation.taskId}` : "项目内未关联任务"} · {conversation.execution}</small><em>{conversation.preview}</em></span></Link>)}{!conversations.length && <div className="empty-state"><h2>项目中还没有对话</h2><p>项目范围内的对话会直接成为叶子，不插入任务导航层。</p></div>}</div>}
    </section>
  );
}
