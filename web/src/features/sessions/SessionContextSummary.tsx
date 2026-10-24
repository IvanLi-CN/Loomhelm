import { CloudOff, FolderOpen, GitBranch, History, LockKeyhole, MessageCircle, MonitorCog } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  type ConnectionAvailability,
  getConnectionLabel,
  getSessionContextKind,
  getSessionContextLabel,
  getSessionPathLabel,
  getSessionStateLabel,
  type SessionContextModel
} from "./session-model";

export interface SessionContextSummaryProps {
  context: SessionContextModel;
  connection?: ConnectionAvailability;
}
function getSessionStateTone(state: SessionContextModel["session"]["state"]): string {
  if (state === "active") return "border-[var(--line)] bg-[var(--success-bg)] text-[var(--success)]";
  if (state === "disconnected" || state === "reconciling") return "border-[var(--line)] bg-[var(--warning-bg)] text-[var(--warning)]";
  if (state === "unsupported") return "border-[var(--line)] bg-[var(--surface-soft)] text-[var(--muted)]";
  return "border-[var(--line)] bg-[var(--surface-soft)] text-[var(--muted)]";
}

export function SessionContextSummary({ context, connection = "online" }: SessionContextSummaryProps) {
  const kind = getSessionContextKind(context);
  const isStandalone = kind === "standalone";
  const sessionState = context.session.state;

  return (
    <article
      className="grid min-w-0 gap-5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow)]"
      data-testid="session-context-summary"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">会话上下文</span>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <MessageCircle className="size-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <h2 className="min-w-0 wrap-anywhere text-base font-semibold">{context.conversationTitle}</h2>
          </div>
          <p className="mt-2 max-w-[62ch] text-xs leading-6 text-[var(--muted)]">
            {isStandalone
              ? "可以先在没有项目或任务的情况下交流与执行；后续绑定任务时需要明确确认历史共享范围。"
              : "任务目标、业务状态和 Run 状态分别保留；此会话是任务唯一的主会话。"}
          </p>
        </div>
        <span className="inline-flex min-h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--selected)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
          {isStandalone ? <MessageCircle className="size-3.5" aria-hidden="true" /> : <GitBranch className="size-3.5" aria-hidden="true" />}
          {getSessionContextLabel(kind)}
        </span>
      </header>

      <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs leading-5">
        <dt className="text-[var(--muted)]">Session</dt>
        <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">{context.session.id}</dd>
        <dt className="text-[var(--muted)]">路径</dt>
        <dd>{getSessionPathLabel(context.session.path)}</dd>
        <dt className="text-[var(--muted)]">状态</dt>
        <dd>
          <span className={cn("inline-flex min-h-6 items-center rounded-[var(--radius-sm)] border px-2 py-0.5 text-[10px] font-semibold", getSessionStateTone(sessionState))}>
            {getSessionStateLabel(sessionState)}
          </span>
        </dd>
        <dt className="text-[var(--muted)]">连接</dt>
        <dd className="inline-flex items-center gap-1.5">
          {connection === "online" ? <MonitorCog className="size-3.5 text-[var(--success)]" aria-hidden="true" /> : <CloudOff className="size-3.5 text-[var(--warning)]" aria-hidden="true" />}
          {getConnectionLabel(connection)}
        </dd>
        <dt className="text-[var(--muted)]">项目</dt>
        <dd className="inline-flex min-w-0 wrap-anywhere items-center gap-1.5">
          <FolderOpen className="size-3.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
          {context.projectName ?? context.session.project_id ?? "尚未归属项目"}
        </dd>
        <dt className="text-[var(--muted)]">任务</dt>
        <dd className="min-w-0 wrap-anywhere">{context.task ? `${context.task.id} · ${context.task.title}` : "未关联任务"}</dd>
      </dl>

      {context.task ? (
        <div className="grid gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-soft)] p-3 text-xs leading-5">
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ink)]"><History className="size-3.5" aria-hidden="true" />任务主会话范围</span>
          <span className="text-[var(--muted)]">{context.task.goal}</span>
          <span className="text-[var(--muted)]">任务业务状态：{context.task.status}。一次 Run 的完成、中断或失败不会自动改变任务状态。</span>
        </div>
      ) : (
        <div className="grid gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-soft)] p-3 text-xs leading-5">
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ink)]"><LockKeyhole className="size-3.5" aria-hidden="true" />独立会话范围</span>
          <span className="text-[var(--muted)]">历史消息、执行和文件在绑定前仍属于当前创建者；未发送草稿保持私密。</span>
        </div>
      )}

      {sessionState === "unsupported" ? (
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status">
          <MonitorCog className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>当前只知道该路径尚未被真实 Desktop 会话证明；演示状态不能被称为已接入。</span>
        </div>
      ) : null}

      {connection !== "online" || sessionState === "disconnected" ? (
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" role="status">
          <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>连接不可用时只保留已观察内容，不发送或排队控制命令。</span>
        </div>
      ) : null}
    </article>
  );
}
