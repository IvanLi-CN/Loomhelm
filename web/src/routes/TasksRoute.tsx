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
      <div className="page-heading"><div><span className="eyebrow">TASKS</span><h1>任务</h1><p>跨项目查看同一批目标；列表、看板和图谱不会创建任务副本。</p></div><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => setCreatingProject((value) => !value)}><FolderPlus size={16} aria-hidden="true" />{creatingProject ? "收起项目表单" : "新建项目"}</Button><Button asChild variant="default" className="button button-primary"><Link to="/tasks/new"><Plus size={16} aria-hidden="true" />新建任务</Link></Button></div></div>
      {creatingProject && <div className="mb-5"><ProjectForm source={source} mode="create" onCancelled={() => setCreatingProject(false)} onSaved={() => setCreatingProject(false)} /></div>}
      <TaskExplorer source={source} />
    </section>
  );
}
