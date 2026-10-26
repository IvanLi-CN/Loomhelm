import { Check, Link2 } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";

import { TaskRelationPicker, type TaskRelationCandidate } from "./TaskRelationPicker";
import { taskWriteBlockReason, type ProjectTaskSource, type TaskRelationChanges } from "./types";

export function TaskRelationshipEditor({ source, taskId }: { source: ProjectTaskSource; taskId: string }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; reconcile?: boolean; tone: "success" | "warning" } | null>(null);
  const [blockedByUnknown, setBlockedByUnknown] = useState(false);
  const [canAcknowledgeReconciliation, setCanAcknowledgeReconciliation] = useState(false);
  const [reconciliationToken, setReconciliationToken] = useState<string | undefined>();
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
  const canConfirmReconciliation = canAcknowledgeReconciliation
    && source.isTaskReconciliationReady?.(taskId, reconciliationToken) === true;
  const candidates = source.tasks.filter((candidate) => candidate.id !== taskId);
  const parentIds = task.parentIds ?? (task.parentId ? [task.parentId] : []);
  const relationCandidates: TaskRelationCandidate[] = candidates.map((candidate) => {
    const candidateCanWrite = source.getProjectPermissions(candidate.projectId).canWrite;
    return {
      id: candidate.id,
      title: candidate.title,
      projectName: source.getProject(candidate.projectId)?.name,
      disabled: !candidateCanWrite,
      disabledReason: candidateCanWrite ? undefined : "当前关系端点只读，关系不可修改"
    };
  });
  const selectedRelationCandidates = (ids: readonly string[], relationName: string) => ids.map((id) => relationCandidates.find((candidate) => candidate.id === id) ?? {
    id,
    title: "当前无权查看",
    disabled: true,
    disabledReason: `当前${relationName}任务不可见`
  });
  const relationDisabledMessage = !canWrite
    ? "当前项目只读，关系不能修改。"
    : sourceRelationshipBlocked
      ? "关系状态待核对，暂时不能修改。"
      : relationWritePending
        ? "关系保存中，暂时不能修改。"
        : blockedByUnknown
          ? "关系写入结果待确认，暂时不能修改。"
          : pending
            ? "关系保存中，暂时不能修改。"
            : undefined;
  const applyRelation = async (changes: TaskRelationChanges) => {
    setPending(true);
    setFeedback(null);
    setCanAcknowledgeReconciliation(false);
    setReconciliationToken(undefined);
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
      const token = source.getTaskReconciliationToken?.(taskId);
      const ready = source.isTaskReconciliationReady?.(taskId, token) === true;
      setBlockedByUnknown(!ready);
      setCanAcknowledgeReconciliation(ready);
      setReconciliationToken(token);
      setFeedback({ message: ready ? "已刷新并核对任务关系，可以确认当前状态后解除阻塞。" : "列表已刷新，但任务关系仍在进行或尚未完成确认；请稍后再次刷新。", reconcile: !ready, tone: ready ? "success" : "warning" });
    } catch (error) {
      setReconciliationToken(undefined);
      setFeedback({ message: error instanceof Error ? `刷新任务关系失败：${error.message}` : "刷新任务关系失败，请稍后重试。", reconcile: true, tone: "warning" });
    } finally {
      setPending(false);
    }
  };
  const updateParentSelection = (nextIds: string[]) => {
    const current = new Set(parentIds);
    const next = new Set(nextIds);
    const addParentIds = nextIds.filter((id) => !current.has(id));
    const removeParentIds = parentIds.filter((id) => !next.has(id));
    const changes: TaskRelationChanges = {};
    if (addParentIds.length) changes.addParentIds = addParentIds;
    if (removeParentIds.length) changes.removeParentIds = removeParentIds;
    if (Object.keys(changes).length) void applyRelation(changes);
  };
  const updateDependencySelection = (nextIds: string[]) => {
    const current = new Set(task.dependsOn);
    const next = new Set(nextIds);
    const addDependencyIds = nextIds.filter((id) => !current.has(id));
    const removeDependencyIds = task.dependsOn.filter((id) => !next.has(id));
    const changes: TaskRelationChanges = {};
    if (addDependencyIds.length) changes.addDependencyIds = addDependencyIds;
    if (removeDependencyIds.length) changes.removeDependencyIds = removeDependencyIds;
    if (Object.keys(changes).length) void applyRelation(changes);
  };
  const acknowledgeReconciliation = (event: MouseEvent<HTMLButtonElement>) => {
    if (!canConfirmReconciliation || !source.acknowledgeTaskReconciliation?.(taskId, reconciliationToken)) return;
    if (event.currentTarget === document.activeElement) restoreFocusAfterAcknowledgementRef.current = true;
    setBlockedByUnknown(false);
    setCanAcknowledgeReconciliation(false);
    setReconciliationToken(undefined);
    setFeedback({ message: "已确认当前关系状态，可以继续操作。", tone: "success" });
  };

  return (
    <section className="info-block" aria-label="任务关系">
      <div className="flex items-center gap-2"><Link2 size={15} className="text-[var(--accent)]" aria-hidden="true" /><span className="section-kicker">关系</span></div>
      <TaskRelationPicker label="父任务" candidates={relationCandidates} selectedIds={parentIds} selectedCandidates={selectedRelationCandidates(parentIds, "父任务")} onChange={updateParentSelection} disabled={!canWrite || pending || relationBlocked} disabledMessage={relationDisabledMessage} emptyMessage="当前范围没有可选的父任务。" />
      <TaskRelationPicker label="前置依赖" candidates={relationCandidates} selectedIds={task.dependsOn} selectedCandidates={selectedRelationCandidates(task.dependsOn, "前置依赖")} onChange={updateDependencySelection} disabled={!canWrite || pending || relationBlocked} disabledMessage={relationDisabledMessage} emptyMessage="当前范围没有可选的前置任务。" />
      {(pending || relationWritePending) && <p className="mt-3 text-xs leading-6 text-[var(--muted)]" role="status">关系保存中…</p>}
      {(feedback?.reconcile || sourceRelationshipBlocked) && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void reconcile(); }} disabled={pending}>刷新并核对任务关系</Button>{sourceRelationshipBlocked && canConfirmReconciliation && <Button type="button" variant="ghost" className="button button-quiet" onClick={acknowledgeReconciliation}><Check size={15} aria-hidden="true" />确认当前关系，解除阻塞</Button>}</div>}
      {sourceRelationshipBlocked && !feedback && <p className="mt-3 text-xs leading-6 text-[var(--warning)]" role="alert">{sourceRelationshipNotice}</p>}
      {feedback && <p ref={feedbackRef} tabIndex={-1} className={`mt-3 text-xs leading-6 ${feedback.tone === "success" ? "text-[var(--success)]" : "text-[var(--warning)]"}`} role={feedback.tone === "success" ? "status" : "alert"}>{feedback.message}</p>}
      {!canWrite && <p className="mt-3 text-xs leading-6 text-[var(--muted)]">当前关系只读；请在有权项目范围内完成关系编辑。</p>}
    </section>
  );
}
