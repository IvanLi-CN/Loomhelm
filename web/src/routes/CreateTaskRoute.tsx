import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDemoRuntime } from "@/demo/context";

export function CreateTaskRoute() {
  const runtime = useDemoRuntime();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(runtime.fixtures.projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const taskId = runtime.createTask({ title: title.trim(), goal: goal.trim(), projectId });
    if (taskId) {
      setSubmitted(true);
      void navigate({ to: "/tasks/$taskId", params: { taskId } });
    }
  };

  return (
    <section className="page-section create-page">
      <Link to="/tasks" className="back-link"><ArrowLeft size={15} aria-hidden="true" />返回任务</Link>
      <div className="page-heading"><div><span className="eyebrow">SIMULATED WRITE</span><h1>新建任务</h1><p>这项任务只写入当前 Demo 的内存夹具，刷新或重置后恢复初始数据。</p></div><span className="demo-write-chip"><CheckCircle2 size={14} aria-hidden="true" />memory-only</span></div>
      <form className="form-panel" onSubmit={submit}>
        <label className="form-field"><span>项目</span><Select value={projectId} onValueChange={setProjectId} disabled={!runtime.canWrite}><SelectTrigger aria-label="项目"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{runtime.fixtures.projects.map((project) => <SelectItem value={project.id} key={project.id}>{project.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label>
        <label className="form-field"><span>任务名称</span><Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="这项任务要完成什么" disabled={!runtime.canWrite} /></label>
        <label className="form-field"><span>目标与上下文</span><Textarea required rows={6} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="说明期望结果，以及需要保留的约束" disabled={!runtime.canWrite} /></label>
        {!runtime.canWrite && <div className="inline-state inline-state-warning"><ShieldNote />当前身份或网络状态为只读，创建动作保持禁用。</div>}
        <div className="form-actions"><Button type="submit" variant="default" className="button button-primary" disabled={!runtime.canWrite || !title.trim() || !goal.trim()}>保存模拟任务</Button><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">取消</Link></Button></div>
        {submitted && <p className="form-success">模拟任务已创建，已进入任务工作区。</p>}
      </form>
    </section>
  );
}

function ShieldNote() {
  return <span aria-hidden="true">!</span>;
}
