import { Check, Pencil, Save, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectRecord, ProjectTaskSource } from "@/features/tasks/types";

type Feedback = { message: string; tone: "success" | "warning"; reconcile?: boolean; noticeId?: string };

export function editableProjectSummary(project: ProjectRecord | undefined): string {
  return project?.description ?? (project?.summary === "暂无项目简介" ? "" : project?.summary ?? "");
}

interface ProjectFormProps {
  source: ProjectTaskSource;
  mode: "create" | "edit";
  projectId?: string;
  onSaved?: (projectId: string) => void;
  onCancelled?: () => void;
}

export function ProjectForm({ source, mode, projectId, onSaved, onCancelled }: ProjectFormProps) {
  const project = projectId ? source.getProject(projectId) : undefined;
  const [name, setName] = useState(project?.name ?? "");
  const [summary, setSummary] = useState(editableProjectSummary(project));
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const [blockedByUnknown, setBlockedByUnknown] = useState(false);
  const identityRef = useRef<{ mode: ProjectFormProps["mode"]; projectId?: string }>({ mode, projectId });
  const nameDirtyRef = useRef(false);
  const summaryDirtyRef = useRef(false);
  const projectPermissions = mode === "edit" ? source.getProjectPermissions(projectId) : undefined;
  const canManageProject = mode === "create" ? source.canCreateProjects : projectPermissions?.canManageProjects ?? false;
  const projectWriteMessage = mode === "create"
    ? "当前身份或连接状态不能创建项目。"
    : projectPermissions?.canWrite
      ? "当前身份可以操作任务，但不能管理项目或成员。项目写入动作保持禁用。"
      : "当前身份或连接状态为只读，项目写入动作保持禁用。";
  const effectiveBlocked = blockedByUnknown || (mode === "create" && source.pendingProjectCreation === true);

  useEffect(() => {
    const identityChanged = identityRef.current.mode !== mode || identityRef.current.projectId !== projectId;
    if (identityChanged) {
      identityRef.current = { mode, projectId };
      nameDirtyRef.current = false;
      summaryDirtyRef.current = false;
      setName(project?.name ?? "");
      setSummary(editableProjectSummary(project));
      setFeedback(null);
      setBlockedByUnknown(false);
      return;
    }
    if (!nameDirtyRef.current) setName(project?.name ?? "");
    if (!summaryDirtyRef.current) setSummary(editableProjectSummary(project));
  }, [mode, project?.description, project?.id, project?.name, project?.summary, projectId]);

  const reconcile = async () => {
    setPending(true);
    const noticeId = feedback?.noticeId ?? source.pendingProjectCreationNoticeId;
    try {
      await source.refresh();
      if (mode === "create") {
        setBlockedByUnknown(true);
        setFeedback({ message: "列表已刷新，但本次项目创建结果仍待确认；为避免重复创建，当前表单不会再次提交。", tone: "warning", reconcile: true, noticeId });
      } else {
        setBlockedByUnknown(false);
        setFeedback({ message: "已刷新并核对项目列表，可以继续操作。", tone: "success" });
      }
    } catch (error) {
      setFeedback({ message: error instanceof Error ? `刷新项目列表失败：${error.message}` : "刷新项目列表失败，请稍后重试。", tone: "warning", reconcile: true });
    } finally {
      setPending(false);
    }
  };

  const acknowledgePendingCreation = () => {
    const noticeId = feedback?.noticeId ?? source.pendingProjectCreationNoticeId;
    if (!noticeId) return;
    source.acknowledgePendingProjectCreation?.(noticeId);
    setBlockedByUnknown(false);
    setFeedback({ message: "已确认项目列表中没有这次写入，可以重新提交。", tone: "success" });
  };

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (effectiveBlocked) return;
    setPending(true);
    setFeedback(null);
    const latestProject = mode === "edit" && projectId ? source.getProject(projectId) : undefined;
    const draft = {
      name: nameDirtyRef.current ? name : latestProject?.name ?? name,
      summary: summaryDirtyRef.current ? summary : editableProjectSummary(latestProject)
    };
    const result = mode === "create"
      ? source.createProject({ name, summary })
      : projectId ? source.updateProject(projectId, draft) : { ok: false as const, code: "invalid" as const, message: "项目上下文不可用。", reconcile: false, noticeId: undefined };
    const resolved = await result;
    setPending(false);
    if (!resolved.ok) {
      const reconcile = resolved.reconcile || resolved.code === "unknown";
      setBlockedByUnknown(reconcile);
      setFeedback({ message: resolved.message, tone: "warning", reconcile, noticeId: resolved.noticeId });
      return;
    }
    if (resolved.warning) {
      setFeedback({ message: resolved.warning, tone: "warning" });
      return;
    }
    nameDirtyRef.current = false;
    summaryDirtyRef.current = false;
    setFeedback({ message: mode === "create" ? "项目已创建，当前页面保留这次写入结果。" : "项目已更新。", tone: "success" });
    onSaved?.(resolved.value.id);
  };

  return (
    <form className="form-panel w-full max-w-2xl" aria-label={mode === "create" ? "创建项目" : "编辑项目"} onSubmit={(event) => { void submit(event); }}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <span className="section-kicker">{mode === "create" ? "NEW PROJECT" : "PROJECT SETTINGS"}</span>
          <h2 className="mt-1 text-lg font-semibold">{mode === "create" ? "创建项目" : "编辑项目"}</h2>
          <p className="mt-1 text-xs leading-6 text-[var(--muted)]">{mode === "create" ? "项目保存遵循当前数据源的权限与持久化语义。" : "项目名称与简介可编辑，任务归属和权限边界保持不变。"}</p>
        </div>
        {mode === "edit" && <Pencil size={17} className="text-[var(--accent)]" aria-hidden="true" />}
      </div>
      <label className="form-field"><span>项目名称</span><Input value={name} required maxLength={80} onChange={(event) => { nameDirtyRef.current = true; setName(event.target.value); }} disabled={!canManageProject || pending || effectiveBlocked} autoFocus={mode === "edit"} /></label>
      <label className="form-field"><span>项目简介</span><Textarea value={summary} maxLength={240} rows={4} onChange={(event) => { summaryDirtyRef.current = true; setSummary(event.target.value); }} disabled={!canManageProject || pending || effectiveBlocked} /></label>
      {!canManageProject && <div className="inline-state inline-state-warning"><span aria-hidden="true">!</span>{projectWriteMessage}</div>}
      {mode === "create" && source.pendingProjectCreation && !feedback && <div className="inline-state inline-state-warning" role="alert"><span aria-hidden="true">!</span>上一次项目创建结果仍待确认；请先检查项目列表，当前表单不会再次提交。<Link to="/tasks" className="inline-link ml-2">打开项目列表</Link></div>}
      {(feedback?.reconcile || (mode === "create" && source.pendingProjectCreation)) && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void reconcile(); }} disabled={pending}>刷新并核对项目列表</Button><Button asChild type="button" variant="ghost" className="button button-quiet"><Link to="/tasks">前往项目列表核对</Link></Button>{feedback?.reconcile && (feedback.noticeId ?? source.pendingProjectCreationNoticeId) && source.pendingProjectCreation && <Button type="button" variant="ghost" className="button button-quiet" onClick={acknowledgePendingCreation}>确认未创建，允许重新提交</Button>}</div>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><Check size={15} aria-hidden="true" />{feedback.message}</div>}
      <div className="form-actions">
        <Button type="submit" className="button button-primary" disabled={!canManageProject || pending || effectiveBlocked || !name.trim()}><Save size={15} aria-hidden="true" />{pending ? "保存中…" : "保存项目"}</Button>
        {onCancelled && <Button type="button" variant="secondary" className="button button-secondary" onClick={onCancelled}><X size={15} aria-hidden="true" />取消</Button>}
      </div>
    </form>
  );
}

interface ProjectActionsProps {
  source: ProjectTaskSource;
  projectId: string;
  fallbackProject?: Pick<ProjectRecord, "id" | "name" | "summary">;
  onDeleteStarted?: () => void;
  onDeleteFailed?: () => void;
  onDeleted?: () => void;
}

export function ProjectActions({ source, projectId, fallbackProject, onDeleteStarted, onDeleteFailed, onDeleted }: ProjectActionsProps) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const [blockedByUnknown, setBlockedByUnknown] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const project = source.getProject(projectId) ?? fallbackProject;

  if (deleted) {
    return <div className="grid gap-3"><div className="inline-state inline-state-success" role="status"><Check size={15} aria-hidden="true" />项目已删除。</div><div className="form-actions"><Button asChild type="button" variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务列表</Link></Button></div></div>;
  }
  if (!project) return null;
  const canManageProject = source.getProjectPermissions(projectId).canManageProjects;
  const finishEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };
  if (editing) return <ProjectForm source={source} mode="edit" projectId={projectId} onCancelled={finishEditing} onSaved={finishEditing} />;

  const remove = async () => {
    onDeleteStarted?.();
    setPending(true);
    setFeedback(null);
    const result = await source.deleteProject(projectId);
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
    setFeedback({ message: "项目已删除。", tone: "success" });
    onDeleted?.();
  };

  const reconcile = async () => {
    setPending(true);
    try {
      await source.refresh();
      setBlockedByUnknown(false);
      setFeedback({ message: "已刷新并核对项目列表，可以继续操作。", tone: "success" });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? `刷新项目列表失败：${error.message}` : "刷新项目列表失败，请稍后重试。", tone: "warning", reconcile: true });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button ref={editButtonRef} type="button" variant="secondary" className="button button-secondary" onClick={() => setEditing(true)} disabled={!canManageProject}><Pencil size={15} aria-hidden="true" />编辑项目</Button>
        <Button type="button" variant="ghost" className="button text-[var(--danger)]" onClick={() => { void remove(); }} disabled={!canManageProject || pending || blockedByUnknown}><Trash2 size={15} aria-hidden="true" />删除项目</Button>
      </div>
      {feedback?.reconcile && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void reconcile(); }} disabled={pending}>刷新并核对项目列表</Button><Button asChild type="button" variant="ghost" className="button button-quiet"><Link to="/tasks">前往项目列表核对</Link></Button></div>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><span aria-hidden="true">!</span>{feedback.message}</div>}
    </div>
  );
}
