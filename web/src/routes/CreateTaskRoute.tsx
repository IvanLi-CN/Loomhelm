import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { TaskForm } from "@/features/tasks/TaskForm";

export function CreateTaskRoute() {
  const navigate = useNavigate();
  const source = useOptionalProjectTaskSource();
  const { projectId: requestedProjectId } = useSearch({ from: "/tasks/new" });

  if (!source) return <section className="page-section unavailable-page"><span className="eyebrow">TASK CREATION</span><h1>创建任务暂不可用</h1><p>任务创建需要先加载可用的项目范围，请稍后再试。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;
  if (source.status === "loading") return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">TASK CREATION</span><h1>正在读取可用项目</h1><p>项目范围加载完成后即可创建任务，请稍候。</p></section>;
  if (source.status === "error" || source.status === "permission-changed" || !source.projects.length) return <section className="page-section unavailable-page"><span className="eyebrow">TASK CREATION</span><h1>{source.projects.length ? "当前不能创建任务" : "当前没有可用项目"}</h1><p>{source.notice ?? "任务必须归属当前已授权项目；当前页面保持保护，不会创建没有项目边界的任务。"}</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;

  return (
    <section className="page-section create-page">
      <Link to="/tasks" className="back-link"><ArrowLeft size={15} aria-hidden="true" />返回任务</Link>
      <div className="page-heading"><div><span className="eyebrow">TASK CREATION</span><h1>新建任务</h1><p>创建任务后会打开对应的任务工作区。</p></div></div>
      <TaskForm source={source} mode="create" defaultProjectId={requestedProjectId && source.getProject(requestedProjectId) ? requestedProjectId : undefined} onSaved={(taskId) => { void navigate({ to: "/tasks/$taskId", params: { taskId } }); }} />
    </section>
  );
}
