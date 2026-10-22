import { Link2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { ProjectTaskSource } from "./types";

export function TaskRelationshipEditor({ source, taskId }: { source: ProjectTaskSource; taskId: string }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const task = source.getTask(taskId);
  if (!task) return null;
  const canWrite = source.getProjectPermissions(task.projectId).canWrite;
  const candidates = source.tasks.filter((candidate) => candidate.id !== taskId);
  const parentIds = task.parentIds ?? (task.parentId ? [task.parentId] : []);
  const applyRelation = async (operation: () => ReturnType<ProjectTaskSource["setTaskParent"]>) => {
    setPending(true);
    setFeedback(null);
    const result = await operation();
    setPending(false);
    if (!result.ok) setFeedback(result.message);
  };
  const toggleParent = (parentTaskId: string) => {
    const next = parentIds.includes(parentTaskId) ? parentIds.filter((id) => id !== parentTaskId) : [...parentIds, parentTaskId];
    void applyRelation(() => source.setTaskParents(taskId, next));
  };
  const addDependency = (value: string) => {
    if (value === "none" || task.dependsOn.includes(value)) return;
    void applyRelation(() => source.addTaskDependency(taskId, value));
  };
  const removeDependency = (value: string) => {
    void applyRelation(() => source.removeTaskDependency(taskId, value));
  };

  return (
    <section className="info-block" aria-label="任务关系">
      <div className="flex items-center gap-2"><Link2 size={15} className="text-[var(--accent)]" aria-hidden="true" /><span className="section-kicker">关系</span></div>
      <fieldset className="info-select task-relation-options" disabled={!canWrite || pending}><legend>父任务</legend>{candidates.length ? <div className="grid gap-2">{candidates.map((candidate) => <label className="task-relation-option flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-xs" key={candidate.id}><input type="checkbox" checked={parentIds.includes(candidate.id)} onChange={() => toggleParent(candidate.id)} /> <span className="min-w-0 truncate">{candidate.id} · {candidate.title} · {source.getProject(candidate.projectId)?.name}</span></label>)}</div> : <p className="mt-1 text-xs text-[var(--muted)]">当前范围没有可选的父任务。</p>}</fieldset>
      <label className="info-select"><span>添加前置任务</span><Select value="none" onValueChange={addDependency} disabled={!canWrite || pending || candidates.every((candidate) => task.dependsOn.includes(candidate.id))}><SelectTrigger className="info-select-trigger" aria-label="添加前置任务"><SelectValue placeholder="选择任务" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">选择任务</SelectItem>{candidates.filter((candidate) => !task.dependsOn.includes(candidate.id)).map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.id} · {candidate.title} · {source.getProject(candidate.projectId)?.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label>
      {task.dependsOn.length > 0 && <div className="mt-3 grid gap-2"><span className="text-[11px] text-[var(--muted)]">当前前置任务</span>{task.dependsOn.map((dependencyId) => { const dependency = source.getTask(dependencyId); return <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--selected)] px-2 py-1.5 text-xs" key={dependencyId}><Link2 size={13} aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{dependency?.id ?? dependencyId} · {dependency?.title ?? "当前无权查看"}</span><Button type="button" variant="ghost" size="icon-xs" className="text-[var(--muted)]" onClick={() => removeDependency(dependencyId)} disabled={!canWrite} aria-label={`移除前置任务 ${dependencyId}`} title="移除前置任务"><X size={13} aria-hidden="true" /></Button></div>; })}</div>}
      {pending && <p className="mt-3 text-xs leading-6 text-[var(--muted)]" role="status">关系保存中…</p>}
      {feedback && <p className="mt-3 text-xs leading-6 text-[var(--warning)]" role="alert">{feedback}</p>}
      {!canWrite && <p className="mt-3 text-xs leading-6 text-[var(--muted)]">当前关系只读；请在有权项目范围内完成关系编辑。</p>}
    </section>
  );
}
