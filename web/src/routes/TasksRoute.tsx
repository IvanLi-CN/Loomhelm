import { FolderPlus, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { ProjectForm } from "@/features/projects/ProjectForm";
import { useOptionalDemoProjectTaskSource } from "@/features/tasks/demo-store";
import { TaskExplorer } from "@/components/product/TaskViews";

export function TasksRoute() {
  const source = useOptionalDemoProjectTaskSource();
  const [creatingProject, setCreatingProject] = useState(false);

  if (!source) return <section className="page-section unavailable-page"><span className="eyebrow">TASKS</span><h1>任务数据源尚未接入</h1><p>页面组件已准备好 production adapter，当前 route 需要可授权的数据源。</p></section>;

  return (
    <section className="page-section tasks-page">
      <div className="page-heading"><div><span className="eyebrow">TASKS</span><h1>任务</h1><p>跨项目查看同一批目标；列表、看板和图谱不会创建任务副本。</p></div><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => setCreatingProject((value) => !value)} disabled={!source.canManageProjects || source.status !== "ready"}><FolderPlus size={16} aria-hidden="true" />{creatingProject ? "收起项目表单" : "新建项目"}</Button><Button asChild variant="default" className="button button-primary"><Link to="/tasks/new"><Plus size={16} aria-hidden="true" />新建任务</Link></Button></div></div>
      {source.status === "ready" && !source.canManageProjects && <div className="inline-state inline-state-warning" role="status"><span aria-hidden="true">!</span>{source.canWrite ? "当前身份可以操作任务，但不能管理项目或成员。" : "当前身份或连接状态为只读，项目写入动作保持禁用。"}</div>}
      {creatingProject && <div className="mb-5"><ProjectForm source={source} mode="create" onCancelled={() => setCreatingProject(false)} onSaved={() => setCreatingProject(false)} /></div>}
      <TaskExplorer source={source} />
    </section>
  );
}
