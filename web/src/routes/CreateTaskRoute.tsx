import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { TaskForm } from "@/features/tasks/TaskForm";

export function CreateTaskRoute() {
  const navigate = useNavigate();
  const source = useOptionalProjectTaskSource();

  if (!source) return <section className="page-section unavailable-page"><span className="eyebrow">TASK CREATION</span><h1>创建入口等待数据源</h1><p>任务表单使用同一套可注入组件，当前路由需要可授权的数据源。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;
  if (source.status === "loading") return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">TASK CREATION</span><h1>正在读取可用项目</h1><p>任务表单会在真实项目授权范围加载完成后开放，不会使用本地夹具填充项目选择。</p></section>;
  if (source.status === "error" || source.status === "permission-changed" || !source.projects.length) return <section className="page-section unavailable-page"><span className="eyebrow">TASK CREATION</span><h1>{source.projects.length ? "当前不能创建任务" : "当前没有可用项目"}</h1><p>{source.notice ?? "任务必须归属当前已授权项目；页面保持 fail-closed，不创建没有项目边界的任务。"}</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;

  return (
    <section className="page-section create-page">
      <Link to="/tasks" className="back-link"><ArrowLeft size={15} aria-hidden="true" />返回任务</Link>
      <div className="page-heading"><div><span className="eyebrow">TASK CREATION</span><h1>新建任务</h1><p>任务创建使用当前授权的数据源；成功后打开任务工作区。</p></div><span className="demo-write-chip"><CheckCircle2 size={14} aria-hidden="true" />authorized source</span></div>
      <TaskForm source={source} mode="create" onSaved={(taskId) => { void navigate({ to: "/tasks/$taskId", params: { taskId } }); }} />
    </section>
  );
}
