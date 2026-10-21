import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useOptionalDemoProjectTaskSource } from "@/features/tasks/demo-store";
import { TaskForm } from "@/features/tasks/TaskForm";

export function CreateTaskRoute() {
  const navigate = useNavigate();
  const source = useOptionalDemoProjectTaskSource();

  if (!source) return <section className="page-section unavailable-page"><span className="eyebrow">TASK CREATION</span><h1>创建入口等待数据源</h1><p>任务表单使用同一套可注入组件，当前路由需要可授权的数据源。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;

  return (
    <section className="page-section create-page">
      <Link to="/tasks" className="back-link"><ArrowLeft size={15} aria-hidden="true" />返回任务</Link>
      <div className="page-heading"><div><span className="eyebrow">TASK CREATION</span><h1>新建任务</h1><p>任务创建使用当前授权的数据源；成功后打开任务工作区。</p></div><span className="demo-write-chip"><CheckCircle2 size={14} aria-hidden="true" />authorized source</span></div>
      <TaskForm source={source} mode="create" onSaved={(taskId) => { void navigate({ to: "/tasks/$taskId", params: { taskId } }); }} />
    </section>
  );
}
