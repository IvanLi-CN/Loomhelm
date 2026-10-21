import { Check, Pencil, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { taskStates } from "@/demo/types";

import type { ProjectTaskSource, TaskRecord } from "./types";

type Feedback = { message: string; tone: "success" | "warning" };

interface TaskFormProps {
  source: ProjectTaskSource;
  mode: "create" | "edit";
  task?: TaskRecord;
  defaultProjectId?: string;
  onSaved?: (taskId: string) => void;
  onCancelled?: () => void;
}

export function TaskForm({ source, mode, task, defaultProjectId, onSaved, onCancelled }: TaskFormProps) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [goal, setGoal] = useState(task?.goal ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? defaultProjectId ?? source.projects[0]?.id ?? "");
  const [state, setState] = useState(task?.state ?? "待办");
  const [parentId, setParentId] = useState(task?.parentId ?? "none");
  const [dependsOn, setDependsOn] = useState<string[]>(task?.dependsOn ?? []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const candidates = useMemo(() => source.tasks.filter((candidate) => candidate.id !== task?.id), [source.tasks, task?.id]);

  useEffect(() => {
    setTitle(task?.title ?? "");
    setGoal(task?.goal ?? "");
    setProjectId(task?.projectId ?? defaultProjectId ?? source.projects[0]?.id ?? "");
    setState(task?.state ?? "待办");
    setParentId(task?.parentId ?? "none");
    setDependsOn(task?.dependsOn ?? []);
  }, [defaultProjectId, source.projects, task?.dependsOn, task?.goal, task?.id, task?.parentId, task?.projectId, task?.state, task?.title]);

  const toggleDependency = (id: string) => {
    setDependsOn((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const submit = async () => {
    setPending(true);
    setFeedback(null);
    const result = mode === "create"
      ? source.createTask({ title, goal, projectId, state, parentId: parentId === "none" ? undefined : parentId, dependsOn })
      : task ? source.updateTask(task.id, { title, goal, state, parentId: parentId === "none" ? "" : parentId, dependsOn }) : { ok: false as const, code: "invalid" as const, message: "任务上下文不可用。" };
    const resolved = await result;
    setPending(false);
    if (!resolved.ok) {
      setFeedback({ message: resolved.message, tone: "warning" });
      return;
    }
    setFeedback({ message: mode === "create" ? "任务已创建，已保留项目归属与关系。" : "任务已更新。", tone: "success" });
    onSaved?.(resolved.value.id);
  };

  return (
    <div className="form-panel w-full max-w-3xl" aria-label={mode === "create" ? "创建任务" : "编辑任务"}>
      <div className="mb-5">
        <span className="section-kicker">{mode === "create" ? "NEW TASK" : "TASK EDITOR"}</span>
        <h2 className="mt-1 text-lg font-semibold">{mode === "create" ? "创建任务" : "编辑任务"}</h2>
        <p className="mt-1 text-xs leading-6 text-[var(--muted)]">业务状态与执行事实分开保存；关系只改变当前任务的指向，不迁移项目归属。</p>
      </div>
      <label className="form-field"><span>项目</span><Select value={projectId} onValueChange={setProjectId} disabled={mode === "edit" || !source.canWrite}><SelectTrigger aria-label="任务项目"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{source.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label>
      <label className="form-field"><span>任务标题</span><Input name="title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="这项任务要完成什么" disabled={!source.canWrite} /></label>
      <label className="form-field"><span>目标与上下文</span><Textarea name="goal" required rows={5} maxLength={800} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="说明期望结果，以及需要保留的约束" disabled={!source.canWrite} /></label>
      {mode === "edit" && <label className="form-field"><span>任务业务状态</span><Select value={state} onValueChange={(value) => setState(value as typeof state)} disabled={!source.canWrite}><SelectTrigger aria-label="任务业务状态"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{taskStates.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectGroup></SelectContent></Select></label>}
      <label className="form-field"><span>父任务 <small className="font-normal text-[var(--muted)]">（可选）</small></span><Select value={parentId} onValueChange={setParentId} disabled={!source.canWrite}><SelectTrigger aria-label="父任务"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">无父任务</SelectItem>{candidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.id} · {candidate.title} · {source.getProject(candidate.projectId)?.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label>
      <fieldset className="mb-[18px] grid gap-2 text-xs font-semibold text-[var(--muted)]" disabled={!source.canWrite}><legend>前置依赖 <small className="font-normal">（可多选）</small></legend>{candidates.length ? <div className="grid gap-2 sm:grid-cols-2">{candidates.map((candidate) => <label className="flex min-h-9 items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 font-normal text-[var(--ink)] hover:bg-[var(--selected)]" key={candidate.id}><input type="checkbox" checked={dependsOn.includes(candidate.id)} onChange={() => toggleDependency(candidate.id)} /> <span className="min-w-0 truncate">{candidate.id} · {candidate.title}</span></label>)}</div> : <p className="font-normal">当前范围没有可选的前置任务。</p>}</fieldset>
      {!source.canWrite && <div className="inline-state inline-state-warning"><span aria-hidden="true">!</span>当前身份或连接状态为只读，创建和编辑动作保持禁用。</div>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><Check size={15} aria-hidden="true" />{feedback.message}</div>}
      <div className="form-actions">
        <Button type="button" className="button button-primary" onClick={submit} disabled={!source.canWrite || pending || !title.trim() || !goal.trim() || !projectId}><Save size={15} aria-hidden="true" />{pending ? "保存中…" : "保存任务"}</Button>
        {onCancelled && <Button type="button" variant="secondary" className="button button-secondary" onClick={onCancelled}><X size={15} aria-hidden="true" />取消</Button>}
      </div>
    </div>
  );
}

interface TaskEditorProps {
  source: ProjectTaskSource;
  taskId: string;
}

export function TaskEditor({ source, taskId }: TaskEditorProps) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const task = source.getTask(taskId);
  if (!task) return null;

  if (editing) return <TaskForm source={source} mode="edit" task={task} onCancelled={() => setEditing(false)} onSaved={() => setEditing(false)} />;

  const remove = async () => {
    setPending(true);
    const result = await source.deleteTask(taskId);
    setPending(false);
    setFeedback(result.ok ? { message: "任务已删除。", tone: "success" } : { message: result.message, tone: "warning" });
  };

  return (
    <section className="info-block" aria-label="任务操作">
      <span className="section-kicker">任务操作</span>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" className="button button-secondary" onClick={() => setEditing(true)}><Pencil size={15} aria-hidden="true" />编辑任务</Button>
        <Button type="button" variant="ghost" className="button text-[var(--danger)]" onClick={remove} disabled={!source.canWrite || pending}><Trash2 size={15} aria-hidden="true" />{pending ? "删除中…" : "删除任务"}</Button>
      </div>
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><span aria-hidden="true">!</span>{feedback.message}</div>}
    </section>
  );
}
