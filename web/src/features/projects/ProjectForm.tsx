import { Check, Pencil, Save, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectRecord, ProjectTaskSource } from "@/features/tasks/types";

type Feedback = { message: string; tone: "success" | "warning"; reconcile?: boolean };

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
  const projectPermissions = mode === "edit" ? source.getProjectPermissions(projectId) : undefined;
  const canManageProject = mode === "create" ? source.canCreateProjects : projectPermissions?.canManageProjects ?? false;
  const projectWriteMessage = mode === "create"
    ? "当前身份或连接状态不能创建项目。"
    : projectPermissions?.canWrite
      ? "当前身份可以操作任务，但不能管理项目或成员。项目写入动作保持禁用。"
      : "当前身份或连接状态为只读，项目写入动作保持禁用。";

  useEffect(() => {
    setName(project?.name ?? "");
    setSummary(editableProjectSummary(project));
    setFeedback(null);
    setBlockedByUnknown(false);
  }, [mode, project?.id]);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (blockedByUnknown) return;
    setPending(true);
    setFeedback(null);
    const result = mode === "create"
      ? source.createProject({ name, summary })
      : projectId ? source.updateProject(projectId, { name, summary }) : { ok: false as const, code: "invalid" as const, message: "项目上下文不可用。", reconcile: false };
    const resolved = await result;
    setPending(false);
    if (!resolved.ok) {
      const reconcile = resolved.reconcile || resolved.code === "unknown";
      setBlockedByUnknown(reconcile);
      setFeedback({ message: resolved.message, tone: "warning", reconcile });
      return;
    }
    if (resolved.warning) {
      setFeedback({ message: resolved.warning, tone: "warning" });
      return;
    }
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
      <label className="form-field"><span>项目名称</span><Input value={name} required maxLength={80} onChange={(event) => setName(event.target.value)} disabled={!canManageProject || pending} autoFocus={mode === "edit"} /></label>
      <label className="form-field"><span>项目简介</span><Textarea value={summary} maxLength={240} rows={4} onChange={(event) => setSummary(event.target.value)} disabled={!canManageProject || pending} /></label>
      {!canManageProject && <div className="inline-state inline-state-warning"><span aria-hidden="true">!</span>{projectWriteMessage}</div>}
      {feedback?.reconcile && <div className="form-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void source.refresh(); }}>刷新并核对项目列表</Button><Button asChild type="button" variant="ghost" className="button button-quiet"><Link to="/tasks">前往项目列表核对</Link></Button></div>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><Check size={15} aria-hidden="true" />{feedback.message}</div>}
      <div className="form-actions">
        <Button type="submit" className="button button-primary" disabled={!canManageProject || pending || blockedByUnknown || !name.trim()}><Save size={15} aria-hidden="true" />{pending ? "保存中…" : "保存项目"}</Button>
        {onCancelled && <Button type="button" variant="secondary" className="button button-secondary" onClick={onCancelled}><X size={15} aria-hidden="true" />取消</Button>}
      </div>
    </form>
  );
}

interface ProjectActionsProps {
  source: ProjectTaskSource;
  projectId: string;
}

export function ProjectActions({ source, projectId }: ProjectActionsProps) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const project = source.getProject(projectId);
  const canManageProject = source.getProjectPermissions(projectId).canManageProjects;

  if (!project) return null;
  const finishEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };
  if (editing) return <ProjectForm source={source} mode="edit" projectId={projectId} onCancelled={finishEditing} onSaved={finishEditing} />;

  const remove = async () => {
    setPending(true);
    const result = await source.deleteProject(projectId);
    setPending(false);
    setFeedback(result.ok ? { message: "项目已删除。", tone: "success" } : { message: result.message, tone: "warning" });
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button ref={editButtonRef} type="button" variant="secondary" className="button button-secondary" onClick={() => setEditing(true)} disabled={!canManageProject}><Pencil size={15} aria-hidden="true" />编辑项目</Button>
        <Button type="button" variant="ghost" className="button text-[var(--danger)]" onClick={remove} disabled={!canManageProject || pending}><Trash2 size={15} aria-hidden="true" />删除项目</Button>
      </div>
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><span aria-hidden="true">!</span>{feedback.message}</div>}
    </div>
  );
}
