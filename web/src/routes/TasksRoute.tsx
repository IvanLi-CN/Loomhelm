import { Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useDemoRuntime } from "@/demo/context";
import { TaskExplorer } from "@/components/product/TaskViews";

export function TasksRoute() {
  const runtime = useDemoRuntime();
  return (
    <section className="page-section tasks-page">
      <div className="page-heading">
        <div><span className="eyebrow">TASKS</span><h1>任务</h1><p>跨项目查看同一批目标；列表、看板和图谱不会创建任务副本。</p></div>
        <Button asChild variant="default" className="button button-primary"><Link to="/tasks/new"><Plus size={16} aria-hidden="true" />新建任务</Link></Button>
      </div>
      {runtime.scene === "error" ? <div className="error-state"><AlertTriangleText /><h2>暂时无法读取任务</h2><p>Demo 保持 fail-closed，已有输入不会自动发送。</p><Button type="button" variant="secondary" className="button button-secondary" onClick={runtime.recover}>重试</Button></div> : <TaskExplorer />}
    </section>
  );
}

function AlertTriangleText() {
  return <span className="empty-icon empty-icon-danger" aria-hidden="true">!</span>;
}
