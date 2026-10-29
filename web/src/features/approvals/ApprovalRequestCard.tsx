import { CheckCircle2, Clock3, FileCode2, FolderOpen, History, LoaderCircle, LockKeyhole, ShieldAlert, ShieldCheck, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ResolveApprovalParams } from "@loomhelm/api-client";
import type { Approval, ApprovalDecision, ApprovalStatus, ResolveApprovalRequest, Task } from "@loomhelm/protocol";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  canSendControl,
  type ConnectionAvailability,
  getConnectionLabel
} from "@/features/sessions/session-model";

export interface ApprovalContextModel {
  conversationTitle: string;
  sessionId: string;
  projectName?: string;
  task?: Pick<Task, "id" | "title">;
  complete?: boolean;
  command: string;
  directory?: string;
  impact?: string;
}
export interface ApprovalRequestModel {
  approval: Approval;
  context: ApprovalContextModel;
}

export interface ApprovalRequestCardProps {
  request: ApprovalRequestModel;
  commandIds?: Partial<Record<ApprovalDecision, string>>;
  connection?: ConnectionAvailability;
  readOnly?: boolean;
  canResolve?: boolean;
  onResolve?: (params: ResolveApprovalParams) => void | Promise<void>;
}

function getApprovalStatusLabel(status: ApprovalStatus): string {
  const labels: Record<ApprovalStatus, string> = {
    pending: "待处理",
    approved: "已批准",
    denied: "已拒绝",
    expired: "已过期"
  };
  return labels[status];
}

function getApprovalStatusTone(status: ApprovalStatus): string {
  if (status === "approved") return "bg-[var(--success-bg)] text-[var(--success)]";
  if (status === "denied") return "bg-[var(--danger-bg)] text-[var(--danger)]";
  if (status === "expired") return "bg-[var(--warning-bg)] text-[var(--warning)]";
  return "bg-[var(--selected)] text-[var(--accent)]";
}

function getApprovalStatusIcon(status: ApprovalStatus) {
  if (status === "approved") return CheckCircle2;
  if (status === "denied") return X;
  if (status === "expired") return Clock3;
  return ShieldAlert;
}

export function ApprovalRequestCard({ request, commandIds = {}, connection = "online", readOnly = false, canResolve = true, onResolve }: ApprovalRequestCardProps) {
  const [resolving, setResolving] = useState<ApprovalDecision | null>(null);
  const [submitted, setSubmitted] = useState<ApprovalDecision | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const { approval, context } = request;
  const StatusIcon = getApprovalStatusIcon(approval.status);
  const isPending = approval.status === "pending";
  const incompleteContext = context.complete === false;
  const actionBlocked = !isPending || incompleteContext || readOnly || !canResolve || !canSendControl(connection) || Boolean(submitted) || Boolean(resolving) || !onResolve;

  useEffect(() => {
    setResolving(null);
    setSubmitted(null);
    setActionError(null);
    actionLock.current = false;
  }, [approval.id, approval.revision]);

  const resolve = async (decision: ApprovalDecision) => {
    const commandId = commandIds[decision];
    if (actionBlocked || !commandId || !onResolve || actionLock.current) return;
    const body: ResolveApprovalRequest = { command_id: commandId, decision, revision: approval.revision };
    const params: ResolveApprovalParams = { approval_id: approval.id, body, run_id: approval.run_id };
    actionLock.current = true;
    setActionError(null);
    setResolving(decision);
    try {
      await onResolve(params);
      setSubmitted(decision);
    } catch {
      setActionError("审批请求未被确认；请对账，不会自动重复提交。");
    } finally {
      setResolving(null);
      actionLock.current = false;
    }
  };

  const unavailableReason = readOnly
    ? "当前身份只读，保留请求事实但不能批准或拒绝。"
    : incompleteContext
      ? "请求上下文不完整，不能安全批准或拒绝；请刷新并重新核对。"
    : approval.status !== "pending"
      ? `当前请求${getApprovalStatusLabel(approval.status)}，不能再次操作。`
      : connection === "online"
        ? submitted
          ? "当前修订已提交，等待服务事件确认；不能再次提交。"
          : "批准或拒绝都需要当前修订和明确点击。"
        : `${getConnectionLabel(connection)}，审批不会发送或排队。`;

  return (
    <article className="grid min-w-0 gap-5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow)]" data-approval-status={approval.status} data-testid="approval-request-card">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">审批请求</span>
          <h2 className="mt-2 wrap-anywhere text-base font-semibold">{approval.summary}</h2>
        </div>
        <span className={cn("inline-flex min-h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-[11px] font-semibold", getApprovalStatusTone(approval.status))} data-testid="approval-status">
          <StatusIcon className="size-3.5" aria-hidden="true" />
          {getApprovalStatusLabel(approval.status)}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
        <span className="rounded-[var(--radius-sm)] bg-[var(--surface-soft)] px-2 py-1 font-semibold text-[var(--ink)]">{approval.kind}</span>
        <span className="inline-flex items-center gap-1"><History className="size-3.5" aria-hidden="true" />修订 #{approval.revision}</span>
        <span>请求时间 {approval.requested_at}</span>
      </div>

      <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs leading-5">
        <dt className="text-[var(--muted)]">Run</dt>
        <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">{approval.run_id}</dd>
        <dt className="text-[var(--muted)]">Session</dt>
        <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">{context.sessionId}</dd>
        <dt className="text-[var(--muted)]">对话</dt>
        <dd className="min-w-0 wrap-anywhere">{context.conversationTitle}</dd>
        <dt className="text-[var(--muted)]">项目</dt>
        <dd className="inline-flex min-w-0 wrap-anywhere items-center gap-1.5"><FolderOpen className="size-3.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />{context.projectName ?? "未归属项目"}</dd>
        <dt className="text-[var(--muted)]">任务</dt>
        <dd className="min-w-0 wrap-anywhere">{context.task ? `${context.task.id} · ${context.task.title}` : "未关联任务"}</dd>
      </dl>

      <div className="grid gap-3 border-t border-[var(--line)] pt-4">
        <div className="flex items-center gap-2 text-xs font-semibold"><FileCode2 className="size-4 text-[var(--accent)]" aria-hidden="true" />{incompleteContext ? "请求上下文不完整" : "完整请求上下文"}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-soft)] p-3 font-mono text-[11px] leading-6"><code>{context.command}</code></pre>
        {context.directory ? <p className="inline-flex min-w-0 items-start gap-2 text-xs leading-5 text-[var(--muted)]"><FolderOpen className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span>目录：<code className="break-all">{context.directory}</code></span></p> : null}
        {context.impact ? <p className="text-xs leading-6 text-[var(--muted)]">影响范围：{context.impact}</p> : null}
      </div>

      <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status">
        {connection === "online" ? <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        <span>{unavailableReason}</span>
      </div>
      {actionError ? <div className="rounded-[var(--radius-sm)] bg-[var(--danger-bg)] p-3 text-xs leading-5 text-[var(--danger)]" role="alert">{actionError}</div> : null}

      <div className="grid grid-cols-1 gap-2 border-t border-[var(--line)] pt-4 sm:grid-cols-2">
        <Button type="button" disabled={actionBlocked || !commandIds.approve} onClick={() => resolve("approve")} data-testid="approval-approve-button">
          {resolving === "approve" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
          {resolving === "approve" ? "正在批准" : "批准"}
        </Button>
        <Button type="button" variant="secondary" disabled={actionBlocked || !commandIds.deny} onClick={() => resolve("deny")} data-testid="approval-deny-button">
          {resolving === "deny" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ShieldAlert className="size-4" aria-hidden="true" />}
          {resolving === "deny" ? "正在拒绝" : "拒绝"}
        </Button>
      </div>
    </article>
  );
}
