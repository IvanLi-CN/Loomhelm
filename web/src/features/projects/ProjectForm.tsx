import { Check, Pencil, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectTaskSource } from "@/features/tasks/types";

type Feedback = { message: string; tone: "success" | "warning" };

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
  const [summary, setSummary] = useState(project?.summary ?? "");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setName(project?.name ?? "");
    setSummary(project?.summary ?? "");
  }, [project?.id, project?.name, project?.summary]);

  const submit = async () => {
    setPending(true);
    setFeedback(null);
    const result = mode === "create"
      ? source.createProject({ name, summary })
      : projectId ? source.updateProject(projectId, { name, summary }) : { ok: false as const, code: "invalid" as const, message: "项目上下文不可用。" };
    const resolved = await result;
    setPending(false);
    if (!resolved.ok) {
      setFeedback({ message: resolved.message, tone: "warning" });
      return;
    }
    setFeedback({ message: mode === "create" ? "项目已创建，当前页面保留这次写入结果。" : "项目已更新。", tone: "success" });
    onSaved?.(resolved.value.id);
  };

  return (
    <div className="form-panel w-full max-w-2xl" aria-label={mode === "create" ? "创建项目" : "编辑项目"}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <span className="section-kicker">{mode === "create" ? "NEW PROJECT" : "PROJECT SETTINGS"}</span>
          <h2 className="mt-1 text-lg font-semibold">{mode === "create" ? "创建项目" : "编辑项目"}</h2>
          <p className="mt-1 text-xs leading-6 text-[var(--muted)]">{mode === "create" ? "项目保存遵循当前数据源的权限与持久化语义。" : "项目名称与简介可编辑，任务归属和权限边界保持不变。"}</p>
        </div>
        {mode === "edit" && <Pencil size={17} className="text-[var(--accent)]" aria-hidden="true" />}
      </div>
      <label className="form-field"><span>项目名称</span><Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} disabled={!source.canWrite} autoFocus={mode === "edit"} /></label>
      <label className="form-field"><span>项目简介</span><Textarea value={summary} maxLength={240} rows={4} onChange={(event) => setSummary(event.target.value)} disabled={!source.canWrite} /></label>
      {!source.canWrite && <div className="inline-state inline-state-warning"><span aria-hidden="true">!</span>当前身份或连接状态为只读，项目写入动作保持禁用。</div>}
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><Check size={15} aria-hidden="true" />{feedback.message}</div>}
      <div className="form-actions">
        <Button type="button" className="button button-primary" onClick={submit} disabled={!source.canWrite || pending || !name.trim() || !summary.trim()}><Save size={15} aria-hidden="true" />{pending ? "保存中…" : "保存项目"}</Button>
        {onCancelled && <Button type="button" variant="secondary" className="button button-secondary" onClick={onCancelled}><X size={15} aria-hidden="true" />取消</Button>}
      </div>
    </div>
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
  const project = source.getProject(projectId);

  if (!project) return null;
  if (editing) return <ProjectForm source={source} mode="edit" projectId={projectId} onCancelled={() => setEditing(false)} onSaved={() => setEditing(false)} />;

  const remove = async () => {
    setPending(true);
    const result = await source.deleteProject(projectId);
    setPending(false);
    setFeedback(result.ok ? { message: "项目已删除。", tone: "success" } : { message: result.message, tone: "warning" });
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="secondary" className="button button-secondary" onClick={() => setEditing(true)}><Pencil size={15} aria-hidden="true" />编辑项目</Button>
        <Button type="button" variant="ghost" className="button text-[var(--danger)]" onClick={remove} disabled={!source.canWrite || pending}><Trash2 size={15} aria-hidden="true" />删除项目</Button>
      </div>
      {feedback && <div className={`inline-state ${feedback.tone === "success" ? "inline-state-success" : "inline-state-warning"}`} role="status"><span aria-hidden="true">!</span>{feedback.message}</div>}
    </div>
  );
}
