import { Check, Pencil, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { taskStates } from "@/demo/types";

import { calculateTaskRelationChanges, taskWriteBlockReason, type ProjectTaskSource, type TaskRecord, type TaskUpdate } from "./types";

type Feedback = { message: string; tone: "success" | "warning"; reconcile?: boolean; taskId?: string };

export interface TaskFormBaseline {
  title: string;
  goal: string;
  projectId: string;
  state: TaskRecord["state"];
  parentIds: string[];
  dependsOn: string[];
}

interface TaskFormDraftState extends TaskFormBaseline {}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.join("\u0000") === right.join("\u0000");
}

export function reconcileTaskFormState(
  previousBaseline: TaskFormBaseline,
  nextBaseline: TaskFormBaseline,
  draft: TaskFormDraftState,
  relationshipsConfirmed: boolean
): { baseline: TaskFormBaseline; draft: TaskFormDraftState } {
  const baseline = relationshipsConfirmed
    ? nextBaseline
    : { ...nextBaseline, parentIds: previousBaseline.parentIds, dependsOn: previousBaseline.dependsOn };
  return {
    baseline,
    draft: {
      title: draft.title === previousBaseline.title ? baseline.title : draft.title,
      goal: draft.goal === previousBaseline.goal ? baseline.goal : draft.goal,
      projectId: draft.projectId === previousBaseline.projectId ? baseline.projectId : draft.projectId,
      state: draft.state === previousBaseline.state ? baseline.state : draft.state,
      parentIds: relationshipsConfirmed && sameIds(draft.parentIds, previousBaseline.parentIds) ? baseline.parentIds : draft.parentIds,
      dependsOn: relationshipsConfirmed && sameIds(draft.dependsOn, previousBaseline.dependsOn) ? baseline.dependsOn : draft.dependsOn
    }
  };
}

function baselineFor(task: TaskRecord | undefined, defaultProjectId: string | undefined, firstProjectId: string | undefined): TaskFormBaseline {
  return {
    title: task?.title ?? "",
    goal: task?.goal ?? "",
    projectId: task?.projectId ?? defaultProjectId ?? firstProjectId ?? "",
    state: task?.state ?? "待办",
    parentIds: [...(task?.parentIds ?? (task?.parentId ? [task.parentId] : []))],
    dependsOn: [...(task?.dependsOn ?? [])]
  };
}

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
  const [parentIds, setParentIds] = useState<string[]>(task?.parentIds ?? (task?.parentId ? [task.parentId] : []));
  const [dependsOn, setDependsOn] = useState<string[]>(task?.dependsOn ?? []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const targetProjectId = task?.projectId ?? projectId;
  const canWrite = source.getProjectPermissions(targetProjectId).canWrite;
  const sourceRelationshipNotice = taskWriteBlockReason(task);
  const sourceRelationshipBlocked = Boolean(sourceRelationshipNotice);
  const baselineRef = useRef<TaskFormBaseline>(baselineFor(task, defaultProjectId, source.projects[0]?.id));
  const [blockedByUnknown, setBlockedByUnknown] = useState(false);
  const candidates = useMemo(() => source.tasks.filter((candidate) => candidate.id !== task?.id), [source, task?.id]);
  const taskSyncKey = [
    mode,
    defaultProjectId ?? "",
    source.projects[0]?.id ?? "",
    task?.id ?? "",
    task?.title ?? "",
    task?.goal ?? "",
    task?.projectId ?? "",
    task?.state ?? "",
    task?.parentId ?? "",
    task?.parentIds?.join("\u0000") ?? "",
    task?.dependsOn.join("\u0000") ?? "",
    task?.relationshipsConfirmed === false ? "incomplete" : "confirmed"
  ].join("\u0001");
  const lastSyncedTaskKeyRef = useRef<string | undefined>(undefined);
  const taskIdentityKey = `${mode}:${task?.id ?? "create"}`;
  const lastTaskIdentityKeyRef = useRef<string | undefined>(undefined);
  const effectiveBlocked = blockedByUnknown || sourceRelationshipBlocked || (mode === "create" && source.pendingTaskCreation === true);

  useEffect(() => {
    if (lastTaskIdentityKeyRef.current === undefined) {
      lastTaskIdentityKeyRef.current = taskIdentityKey;
      return;
    }
    if (lastTaskIdentityKeyRef.current === taskIdentityKey) return;
    lastTaskIdentityKeyRef.current = taskIdentityKey;
    setFeedback(null);
    setBlockedByUnknown(false);
  }, [taskIdentityKey]);

  useEffect(() => {
    if (lastSyncedTaskKeyRef.current === taskSyncKey) return;
    lastSyncedTaskKeyRef.current = taskSyncKey;
    const previousBaseline = baselineRef.current;
    const nextBaseline = baselineFor(task, defaultProjectId, source.projects[0]?.id);
    const draft = { title, goal, projectId, state, parentIds, dependsOn };
    const reconciled = reconcileTaskFormState(previousBaseline, nextBaseline, draft, task?.relationshipsConfirmed !== false);
    baselineRef.current = reconciled.baseline;
    setTitle(reconciled.draft.title);
    setGoal(reconciled.draft.goal);
    setProjectId(reconciled.draft.projectId);
    setState(reconciled.draft.state);
    setParentIds(reconciled.draft.parentIds);
    setDependsOn(reconciled.draft.dependsOn);
  }, [defaultProjectId, dependsOn, goal, mode, parentIds, projectId, source.projects, state, task, taskSyncKey, title]);

  useEffect(() => {
    if (mode === "create" && !projectId && source.projects[0]) setProjectId(source.projects[0].id);
  }, [mode, projectId, source.projects]);

  const reconcile = async () => {
    setPending(true);
    try {
      await source.refresh();
      if (mode === "create") {
        setBlockedByUnknown(true);
        setFeedback({ message: "列表已刷新，但本次任务创建结果仍待确认；为避免重复创建，当前表单不会再次提交。", tone: "warning", reconcile: true });
      } else {
        setBlockedByUnknown(false);
        setFeedback({ message: "已刷新并核对任务列表，可以继续操作。", tone: "success" });
      }
    } catch (error) {
      setFeedback({ message: error instanceof Error ? `刷新任务列表失败：${error.message}` : "刷新任务列表失败，请稍后重试。", tone: "warning", reconcile: true });
    } finally {
      setPending(false);
    }
  };

  const toggleDependency = (id: string) => {
    setDependsOn((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const toggleParent = (id: string) => {
    setParentIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (effectiveBlocked) return;
    setPending(true);
    setFeedback(null);
    const baseline = baselineRef.current;
    const update: TaskUpdate = {};
    if (title.trim() !== baseline.title) update.title = title;
    if (goal.trim() !== baseline.goal) update.goal = goal;
    if (state !== baseline.state) update.state = state;
    const relationChanges = calculateTaskRelationChanges(baseline.parentIds, parentIds, baseline.dependsOn, dependsOn);
    if (relationChanges) update.relationChanges = relationChanges;
    const result = mode === "create"
      ? source.createTask({ title, goal, projectId, state, parentIds, dependsOn })
      : task ? source.updateTask(task.id, update) : { ok: false as const, code: "invalid" as const, message: "任务上下文不可用。", reconcile: false };
    const resolved = await result;
    setPending(false);
    if (!resolved.ok) {
      const reconcile = resolved.reconcile || resolved.code === "unknown";
      setBlockedByUnknown(reconcile);
      setFeedback({ message: resolved.message, tone: "warning", reconcile });
      return;
    }
    if (resolved.warning) {
      const reconcile = resolved.reconcile ?? false;
      setBlockedByUnknown(reconcile);
      setFeedback({ message: resolved.warning, tone: "warning", reconcile, taskId: mode === "create" ? resolved.value.id : undefined });
      if (mode === "create") onSaved?.(resolved.value.id);
      return;
    }
    setFeedback({ message: mode === "create" ? "任务已创建，已保留项目归属与关系。" : "任务已更新。", tone: "success" });
    onSaved?.(resolved.value.id);
  };

  return (
    <form className="form-panel w-full max-w-3xl" aria-label={mode === "create" ? "创建任务" : "编辑任务"} onSubmit={(event) => { void submit(event); }}>
      <div className="mb-5">
        <span className="section-kicker">{mode === "create" ? "NEW TASK" : "TASK EDITOR"}</span>
        <h2 className="mt-1 text-lg font-semibold">{mode === "create" ? "创建任务" : "编辑任务"}</h2>
        <p className="mt-1 text-xs leading-6 text-[var(--muted)]">业务状态与执行事实分开保存；关系只改变当前任务的指向，不迁移项目归属。</p>
      </div>
      <label className="form-field"><span>项目</span><Select value={projectId} onValueChange={setProjectId} disabled={mode === "edit" || source.status !== "ready" || pending || effectiveBlocked}><SelectTrigger aria-label="任务项目"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{source.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label>
      <label className="form-field"><span>任务标题</span><Input name="title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="这项任务要完成什么" disabled={!canWrite || pending || effectiveBlocked} autoFocus={mode === "edit"} /></label>
      <label className="form-field"><span>目标与上下文</span><Textarea name="goal" required rows={5} maxLength={800} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="说明期望结果，以及需要保留的约束" disabled={!canWrite || pending || effectiveBlocked} /></label>
      {mode === "edit" && <label className="form-field"><span>任务业务状态</span><Select value={state} onValueChange={(value) => setState(value as typeof state)} disabled={!canWrite || pending || effectiveBlocked}><SelectTrigger aria-label="任务业务状态"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{taskStates.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectGroup></SelectContent></Select></label>}
      <fieldset className="mb-[18px] grid gap-2 text-xs font-semibold text-[var(--muted)] task-relation-options" disabled={!canWrite || pending || effectiveBlocked}><legend>父任务 <small className="font-normal">（可多选）</small></legend>{candidates.length ? <div className="grid gap-2 sm:grid-cols-2">{candidates.map((candidate) => { const candidateCanWrite = source.getProjectPermissions(candidate.projectId).canWrite; return <label className={`task-relation-option flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 font-normal text-[var(--ink)] hover:bg-[var(--selected)]${candidateCanWrite ? "" : " opacity-70"}`} key={candidate.id} title={candidateCanWrite ? undefined : "当前父任务只读，关系不可修改"}><input type="checkbox" checked={parentIds.includes(candidate.id)} onChange={() => toggleParent(candidate.id)} disabled={!candidateCanWrite} /> <span className="min-w-0 truncate">{candidate.id} · {candidate.title} · {source.getProject(candidate.projectId)?.name}{candidateCanWrite ? "" : " · 只读"}</span></label>; })}</div> : <p className="font-normal">当前范围没有可选的父任务。</p>}</fieldset>
      <fieldset className="mb-[18px] grid gap-2 text-xs font-semibold text-[var(--muted)]" disabled={!canWrite || pending || effectiveBlocked}><legend>前置依赖 <small className="font-normal">（可多选）</small></legend>{candidates.length ? <div className="grid gap-2 sm:grid-cols-2">{candidates.map((candidate) => { const candidateCanWrite = source.getProjectPermissions(candidate.projectId).canWrite; return <label className={`task-relation-option flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 font-normal text-[var(--ink)] hover:bg-[var(--selected)]${candidateCanWrite ? "" : " opacity-70"}`} key={candidate.id} title={candidateCanWrite ? undefined : "当前前置任务只读，关系不可修改"}><input type="checkbox" checked={dependsOn.includes(candidate.id)} onChange={() => toggleDependency(candidate.id)} disabled={!candidateCanWrite} /> <span className="min-w-0 truncate">{candidate.id} · {candidate.title}{candidateCanWrite ? "" : " · 只读"}</span></label>; })}</div> : <p className="font-normal">当前范围没有可选的前置任务。</p>}</fieldset>
      {!canWrite && <div className="inline-state inline-state-warning"><span aria-hidden="true">!</span>当前项目成员权限为只读，创建和编辑动作保持禁用。</div>}
      {mode === "create" && source.pendingTaskCreation && !feedback && <div className="inline-state inline-state-warning" role="alert"><span aria-hidden="true">!</span>上一次任务创建结果仍待确认；请先检查任务列表，当前表单不会再次提交。<Link to="/tasks" className="inline-link ml-2">打开任务列表</Link></div>}
      {sourceRelationshipBlocked && !feedback && <div className="inline-state inline-state-warning" role="alert"><span aria-hidden="true">!</span>{sourceRelationshipNotice}</div>}
      {(feedback?.reconcile || sourceRelationshipBlocked) && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void reconcile(); }} disabled={pending}>刷新并核对任务列表</Button><Button asChild type="button" variant="ghost" className="button button-quiet"><Link to="/tasks">前往任务列表核对</Link></Button></div>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><Check size={15} aria-hidden="true" />{feedback.message}{feedback.taskId && <Link to="/tasks/$taskId" params={{ taskId: feedback.taskId }} className="inline-link ml-2">打开已创建任务</Link>}</div>}
      <div className="form-actions">
        <Button type="submit" className="button button-primary" disabled={!canWrite || pending || effectiveBlocked || !title.trim() || !goal.trim() || !projectId}><Save size={15} aria-hidden="true" />{pending ? "保存中…" : "保存任务"}</Button>
        {onCancelled && <Button type="button" variant="secondary" className="button button-secondary" onClick={onCancelled}><X size={15} aria-hidden="true" />取消</Button>}
      </div>
    </form>
  );
}

interface TaskEditorProps {
  source: ProjectTaskSource;
  taskId: string;
  fallbackTask?: TaskRecord;
  onDeleteStarted?: () => void;
  onDeleteFailed?: () => void;
  onDeleted?: () => void;
}

export function TaskEditor({ source, taskId, fallbackTask, onDeleteStarted, onDeleteFailed, onDeleted }: TaskEditorProps) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const [blockedByUnknown, setBlockedByUnknown] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const task = source.getTask(taskId) ?? fallbackTask;
  const finishEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  if (deleted) {
    return <section className="info-block" aria-label="任务操作"><span className="section-kicker">任务操作</span><div className="inline-state inline-state-success" role="status"><Check size={15} aria-hidden="true" />任务已删除。</div><div className="form-actions"><Button asChild type="button" variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务列表</Link></Button></div></section>;
  }
  if (!task) return null;
  const canWrite = source.getProjectPermissions(task.projectId).canWrite;
  const sourceRelationshipNotice = taskWriteBlockReason(task);
  const sourceRelationshipBlocked = Boolean(sourceRelationshipNotice);
  const effectiveBlocked = blockedByUnknown || sourceRelationshipBlocked;

  if (editing) return <TaskForm source={source} mode="edit" task={task} onCancelled={finishEditing} onSaved={finishEditing} />;

  const remove = async () => {
    onDeleteStarted?.();
    setPending(true);
    setFeedback(null);
    const result = await source.deleteTask(taskId);
    setPending(false);
    if (!result.ok) {
      onDeleteFailed?.();
      const reconcile = result.reconcile || result.code === "unknown";
      setBlockedByUnknown(reconcile);
      setFeedback({ message: result.message, tone: "warning", reconcile });
      return;
    }
    setBlockedByUnknown(false);
    setDeleted(true);
    setFeedback({ message: "任务已删除。", tone: "success" });
    onDeleted?.();
  };

  const reconcile = async () => {
    setPending(true);
    try {
      await source.refresh();
      setBlockedByUnknown(false);
      setFeedback({ message: "已刷新并核对任务列表，可以继续操作。", tone: "success" });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? `刷新任务列表失败：${error.message}` : "刷新任务列表失败，请稍后重试。", tone: "warning", reconcile: true });
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="info-block" aria-label="任务操作">
      <span className="section-kicker">任务操作</span>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button ref={editButtonRef} type="button" variant="secondary" className="button button-secondary" onClick={() => setEditing(true)} disabled={!canWrite || effectiveBlocked}><Pencil size={15} aria-hidden="true" />编辑任务</Button>
        <Button type="button" variant="ghost" className="button text-[var(--danger)]" onClick={() => { void remove(); }} disabled={!canWrite || pending || effectiveBlocked}><Trash2 size={15} aria-hidden="true" />{pending ? "删除中…" : "删除任务"}</Button>
      </div>
      {(feedback?.reconcile || sourceRelationshipBlocked) && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void reconcile(); }} disabled={pending}>刷新并核对任务列表</Button><Button asChild type="button" variant="ghost" className="button button-quiet"><Link to="/tasks">前往任务列表核对</Link></Button></div>}
      {sourceRelationshipBlocked && !feedback && <p className="mt-3 text-xs leading-6 text-[var(--warning)]" role="alert">{sourceRelationshipNotice}</p>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><span aria-hidden="true">!</span>{feedback.message}</div>}
    </section>
  );
}
