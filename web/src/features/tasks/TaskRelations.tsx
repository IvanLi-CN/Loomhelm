import { Check, Link2, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { taskWriteBlockReason, type ProjectTaskSource, type TaskRelationChanges } from "./types";

export function TaskRelationshipEditor({ source, taskId }: { source: ProjectTaskSource; taskId: string }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; reconcile?: boolean; tone: "success" | "warning" } | null>(null);
  const [blockedByUnknown, setBlockedByUnknown] = useState(false);
  const [canAcknowledgeReconciliation, setCanAcknowledgeReconciliation] = useState(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const restoreFocusAfterAcknowledgementRef = useRef(false);
  const task = source.getTask(taskId);
  useEffect(() => {
    if (!restoreFocusAfterAcknowledgementRef.current) return;
    restoreFocusAfterAcknowledgementRef.current = false;
    feedbackRef.current?.focus({ preventScroll: true });
  }, [canAcknowledgeReconciliation, feedback]);
  if (!task) return null;
  const canWrite = source.getProjectPermissions(task.projectId).canWrite;
  const sourceRelationshipNotice = taskWriteBlockReason(task);
  const sourceRelationshipBlocked = Boolean(sourceRelationshipNotice);
  const relationWritePending = source.isTaskRelationWritePending?.(taskId) === true;
  const relationBlocked = blockedByUnknown || sourceRelationshipBlocked || relationWritePending;
  const candidates = source.tasks.filter((candidate) => candidate.id !== taskId);
  const writableCandidates = candidates.filter((candidate) => source.getProjectPermissions(candidate.projectId).canWrite);
  const parentIds = task.parentIds ?? (task.parentId ? [task.parentId] : []);
  const applyRelation = async (changes: TaskRelationChanges) => {
    setPending(true);
    setFeedback(null);
    setCanAcknowledgeReconciliation(false);
    const result = await source.changeTaskRelations(taskId, changes);
    setPending(false);
    if (!result.ok) {
      const reconcile = result.reconcile || result.code === "unknown";
      setBlockedByUnknown(reconcile);
      setFeedback({ message: result.message, reconcile, tone: "warning" });
      return;
    }
    if (result.warning) {
      setBlockedByUnknown(Boolean(result.reconcile));
      setFeedback({ message: result.warning, reconcile: result.reconcile, tone: "warning" });
    }
  };
  const reconcile = async () => {
    setPending(true);
    try {
      await source.refresh();
      const ready = source.isTaskReconciliationReady?.(taskId) === true;
      setBlockedByUnknown(!ready);
      setCanAcknowledgeReconciliation(ready);
      setFeedback({ message: ready ? "已刷新并核对任务关系，可以确认当前状态后解除阻塞。" : "列表已刷新，但任务关系仍在进行或尚未完成确认；请稍后再次刷新。", reconcile: !ready, tone: ready ? "success" : "warning" });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? `刷新任务关系失败：${error.message}` : "刷新任务关系失败，请稍后重试。", reconcile: true, tone: "warning" });
    } finally {
      setPending(false);
    }
  };
  const toggleParent = (parentTaskId: string) => {
    const adding = !parentIds.includes(parentTaskId);
    void applyRelation(adding ? { addParentIds: [parentTaskId] } : { removeParentIds: [parentTaskId] });
  };
  const addDependency = (value: string) => {
    if (value === "none" || task.dependsOn.includes(value)) return;
    void applyRelation({ addDependencyIds: [value] });
  };
  const removeDependency = (value: string) => {
    const dependency = source.getTask(value);
    if (!dependency || !source.getProjectPermissions(dependency.projectId).canWrite) return;
    void applyRelation({ removeDependencyIds: [value] });
  };
  const acknowledgeReconciliation = (event: MouseEvent<HTMLButtonElement>) => {
    if (!canAcknowledgeReconciliation || !source.acknowledgeTaskReconciliation?.(taskId)) return;
    if (event.currentTarget === document.activeElement) restoreFocusAfterAcknowledgementRef.current = true;
    setBlockedByUnknown(false);
    setCanAcknowledgeReconciliation(false);
    setFeedback({ message: "已确认当前关系状态，可以继续操作。", tone: "success" });
  };

  return (
    <section className="info-block" aria-label="任务关系">
      <div className="flex items-center gap-2"><Link2 size={15} className="text-[var(--accent)]" aria-hidden="true" /><span className="section-kicker">关系</span></div>
      <fieldset className="info-select task-relation-options" disabled={!canWrite || pending || relationBlocked}><legend>父任务</legend>{candidates.length ? <div className="grid gap-2">{candidates.map((candidate) => { const candidateCanWrite = source.getProjectPermissions(candidate.projectId).canWrite; return <label className={`task-relation-option flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-xs${candidateCanWrite ? "" : " opacity-70"}`} key={candidate.id} title={candidateCanWrite ? undefined : "当前父任务只读，关系不可修改"}><input type="checkbox" checked={parentIds.includes(candidate.id)} onChange={() => toggleParent(candidate.id)} disabled={!candidateCanWrite} /> <span className="min-w-0 truncate">{candidate.id} · {candidate.title} · {source.getProject(candidate.projectId)?.name}{candidateCanWrite ? "" : " · 只读"}</span></label>; })}</div> : <p className="mt-1 text-xs text-[var(--muted)]">当前范围没有可选的父任务。</p>}</fieldset>
      <label className="info-select"><span>添加前置任务</span><Select value="none" onValueChange={addDependency} disabled={!canWrite || pending || relationBlocked || writableCandidates.every((candidate) => task.dependsOn.includes(candidate.id))}><SelectTrigger className="info-select-trigger" aria-label="添加前置任务"><SelectValue placeholder="选择任务" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">选择任务</SelectItem>{writableCandidates.filter((candidate) => !task.dependsOn.includes(candidate.id)).map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.id} · {candidate.title} · {source.getProject(candidate.projectId)?.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label>
      {task.dependsOn.length > 0 && <div className="mt-3 grid gap-2"><span className="text-[11px] text-[var(--muted)]">当前前置任务</span>{task.dependsOn.map((dependencyId) => { const dependency = source.getTask(dependencyId); const canWriteDependency = Boolean(dependency) && source.getProjectPermissions(dependency?.projectId).canWrite; return <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--selected)] px-2 py-1.5 text-xs" key={dependencyId}><Link2 size={13} aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{dependency?.id ?? dependencyId} · {dependency?.title ?? "当前无权查看"}</span><Button type="button" variant="ghost" size="icon" className="task-relation-remove text-[var(--muted)]" onClick={() => removeDependency(dependencyId)} disabled={!canWrite || !canWriteDependency || pending || relationBlocked} aria-label={`移除前置任务 ${dependencyId}`} title={canWriteDependency ? "移除前置任务" : "当前关系端点为只读或不可见"}><X size={13} aria-hidden="true" /></Button></div>; })}</div>}
      {(pending || relationWritePending) && <p className="mt-3 text-xs leading-6 text-[var(--muted)]" role="status">关系保存中…</p>}
      {(feedback?.reconcile || sourceRelationshipBlocked) && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void reconcile(); }} disabled={pending}>刷新并核对任务关系</Button>{sourceRelationshipBlocked && canAcknowledgeReconciliation && <Button type="button" variant="ghost" className="button button-quiet" onClick={acknowledgeReconciliation}><Check size={15} aria-hidden="true" />确认当前关系，解除阻塞</Button>}</div>}
      {sourceRelationshipBlocked && !feedback && <p className="mt-3 text-xs leading-6 text-[var(--warning)]" role="alert">{sourceRelationshipNotice}</p>}
      {feedback && <p ref={feedbackRef} tabIndex={-1} className={`mt-3 text-xs leading-6 ${feedback.tone === "success" ? "text-[var(--success)]" : "text-[var(--warning)]"}`} role={feedback.tone === "success" ? "status" : "alert"}>{feedback.message}</p>}
      {!canWrite && <p className="mt-3 text-xs leading-6 text-[var(--muted)]">当前关系只读；请在有权项目范围内完成关系编辑。</p>}
    </section>
  );
}
