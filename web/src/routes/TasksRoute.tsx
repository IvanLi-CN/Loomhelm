import { FolderPlus, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { ProjectForm } from "@/features/projects/ProjectForm";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { TaskExplorer } from "@/components/product/TaskViews";
import { queueOwnedFocusRestore } from "@/lib/focus-ownership";

export function TasksRoute() {
  const source = useOptionalProjectTaskSource();
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectFeedback, setProjectFeedback] = useState<string | null>(null);
  const createProjectButtonRef = useRef<HTMLButtonElement>(null);
  const createProjectFormRef = useRef<HTMLFormElement>(null);
  const closeProjectForm = (focusWasOwned = false) => {
    queueOwnedFocusRestore(createProjectFormRef.current, () => createProjectButtonRef.current, { restoreWhenFocusDropped: focusWasOwned });
    setCreatingProject(false);
  };

  if (!source) return <section className="page-section unavailable-page"><span className="eyebrow">TASKS</span><h1>任务暂不可用</h1><p>当前无法读取任务，请稍后再试。</p></section>;
  const canCreateTask = source.status === "ready" && source.projects.length > 0;

  return (
    <section className="page-section tasks-page">
      <div className="page-heading"><div><span className="eyebrow">TASKS</span><h1>任务</h1><p>跨项目查看同一批目标；列表、看板和图谱不会创建任务副本。</p></div><div className="flex flex-wrap gap-2"><Button ref={createProjectButtonRef} type="button" variant="secondary" className="button button-secondary" onClick={() => { setCreatingProject((value) => !value); setProjectFeedback(null); }} disabled={!source.canCreateProjects}><FolderPlus size={16} aria-hidden="true" />{creatingProject ? "收起项目表单" : "新建项目"}</Button>{canCreateTask ? <Button asChild variant="default" className="button button-primary"><Link to="/tasks/new"><Plus size={16} aria-hidden="true" />新建任务</Link></Button> : <Button type="button" variant="default" className="button button-primary" disabled><Plus size={16} aria-hidden="true" />新建任务</Button>}</div></div>
      {!source.canCreateProjects && <div className="inline-state inline-state-warning" role="status"><span aria-hidden="true">!</span>当前身份或连接状态不能创建项目，已有项目仍按各自成员权限控制。</div>}
      {projectFeedback && <div className="inline-state inline-state-success mb-5" role="status">{projectFeedback}</div>}
      {creatingProject && <div className="mb-5"><ProjectForm source={source} mode="create" focusOwnerRef={createProjectFormRef} onCancelled={() => { closeProjectForm(); setProjectFeedback("已取消创建项目。"); }} onSaved={(_, focusWasOwned) => { closeProjectForm(focusWasOwned); setProjectFeedback("项目已创建。"); }} /></div>}
      <TaskExplorer source={source} />
    </section>
  );
}
