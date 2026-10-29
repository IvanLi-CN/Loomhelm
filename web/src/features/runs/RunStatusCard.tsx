import { Ban, CheckCircle2, CircleHelp, CloudOff, Clock3, LoaderCircle, OctagonX, PauseCircle, PlayCircle, Square, WifiOff, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CommandState, InterruptRunRequest, Run, RunStatus, Session } from "@loomhelm/protocol";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  canSendControl,
  type ConnectionAvailability,
  getConnectionLabel,
  getSessionStateLabel
} from "@/features/sessions/session-model";

export type RunUiPhase = "sending" | "received" | "executing" | "waiting_approval" | "interrupt_requested" | "terminated" | "completed" | "failed" | "unknown" | "disconnected";

export interface RunPhaseInput {
  commandState?: CommandState;
  connection?: ConnectionAvailability;
  interruptRequested?: boolean;
  runStatus: RunStatus;
  sessionState: Session["state"];
  transport?: "sending" | "received";
}
export function getRunUiPhase({ commandState, connection = "online", interruptRequested = false, runStatus, sessionState, transport = "received" }: RunPhaseInput): RunUiPhase {
  if (connection !== "online" || sessionState === "disconnected") return "disconnected";
  if (runStatus === "unknown" || commandState === "unknown") return "unknown";
  if (runStatus === "interrupted") return "terminated";
  if (runStatus === "completed") return "completed";
  if (runStatus === "failed" || commandState === "failed" || commandState === "rejected") return "failed";
  if (interruptRequested) return "interrupt_requested";
  if (transport === "sending") return "sending";
  if (runStatus === "waiting_approval") return "waiting_approval";
  if (runStatus === "running") return "executing";
  if (runStatus === "pending" || commandState === "accepted" || commandState === "executing") return "received";
  return "unknown";
}

interface RunPhasePresentation {
  description: string;
  icon: LucideIcon;
  label: string;
  tone: string;
}

const phasePresentations: Record<RunUiPhase, RunPhasePresentation> = {
  sending: { description: "命令正在发送；尚未观察到平台接收。", icon: LoaderCircle, label: "发送中", tone: "bg-[var(--selected)] text-[var(--accent)]" },
  received: { description: "平台已确认命令身份，等待实际 Run 事件。", icon: CheckCircle2, label: "已接收", tone: "bg-[var(--selected)] text-[var(--accent)]" },
  executing: { description: "已观察到实际执行事件；任务业务状态仍独立。", icon: PlayCircle, label: "实际执行中", tone: "bg-[var(--selected)] text-[var(--accent)]" },
  waiting_approval: { description: "Run 正在等待当前修订的审批决定。", icon: Clock3, label: "等待审批", tone: "bg-[var(--warning-bg)] text-[var(--warning)]" },
  interrupt_requested: { description: "中断请求已提交，但尚未观察到实际终止。", icon: PauseCircle, label: "中断请求中", tone: "bg-[var(--warning-bg)] text-[var(--warning)]" },
  terminated: { description: "已观察到 run.interrupted；这不是任务业务状态变更。", icon: Square, label: "实际终止", tone: "bg-[var(--success-bg)] text-[var(--success)]" },
  completed: { description: "已观察到 Run 完成；结果仍按授权和对账事实处理。", icon: CheckCircle2, label: "执行完成", tone: "bg-[var(--success-bg)] text-[var(--success)]" },
  failed: { description: "已观察到明确失败事件。", icon: OctagonX, label: "执行失败", tone: "bg-[var(--danger-bg)] text-[var(--danger)]" },
  unknown: { description: "结果不确定，不能推断为成功或失败，也不会自动重试。", icon: CircleHelp, label: "unknown", tone: "bg-[var(--surface-soft)] text-[var(--muted)]" },
  disconnected: { description: "连接不可用；控制命令不会发送或排队。", icon: WifiOff, label: "已断线", tone: "bg-[var(--warning-bg)] text-[var(--warning)]" }
};

export interface RunStatusCardProps {
  run: Run;
  session: Session;
  commandState?: CommandState;
  connection?: ConnectionAvailability;
  transport?: "sending" | "received";
  interruptRequested?: boolean;
  interruptCommandId?: string;
  canControl?: boolean;
  readOnly?: boolean;
  onInterrupt?: (request: InterruptRunRequest) => void | Promise<void>;
}

export function RunStatusCard({ run, session, commandState, connection = "online", transport = "received", interruptRequested = false, interruptCommandId, canControl = true, readOnly = false, onInterrupt }: RunStatusCardProps) {
  const [interruptPending, setInterruptPending] = useState(false);
  const [localInterruptRequested, setLocalInterruptRequested] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionLock = useRef(false);

  useEffect(() => {
    setInterruptPending(false);
    setLocalInterruptRequested(false);
    setActionError(null);
    actionLock.current = false;
  }, [run.id]);

  const phase = getRunUiPhase({
    commandState,
    connection,
    interruptRequested: interruptRequested || localInterruptRequested || interruptPending,
    runStatus: run.status,
    sessionState: session.state,
    transport
  });
  const presentation = phasePresentations[phase];
  const Icon = presentation.icon;
  const canInterrupt = phase === "executing" && Boolean(onInterrupt) && Boolean(interruptCommandId) && canControl && canSendControl(connection, readOnly) && !actionLock.current;

  const requestInterrupt = async () => {
    if (!canInterrupt || !onInterrupt || !interruptCommandId || actionLock.current) return;
    const request: InterruptRunRequest = { command_id: interruptCommandId, reason: "user_requested" };
    actionLock.current = true;
    setActionError(null);
    setInterruptPending(true);
    try {
      await onInterrupt(request);
      setLocalInterruptRequested(true);
      setInterruptPending(false);
      actionLock.current = false;
    } catch {
      setActionError("中断请求未被确认；请对账，不会自动重试。");
      setInterruptPending(false);
      actionLock.current = false;
    }
  };

  return (
    <article className="grid min-w-0 gap-5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow)]" data-phase={phase} data-testid="run-status-card">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Run 状态</span>
          <h2 className="mt-2 wrap-anywhere font-mono text-sm font-semibold">{run.id}</h2>
        </div>
        <span className={cn("inline-flex min-h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-[11px] font-semibold", presentation.tone)} data-testid="run-phase">
          <Icon className={cn("size-3.5", phase === "sending" && "animate-spin")} aria-hidden="true" />
          {presentation.label}
        </span>
      </header>

      <p className="text-xs leading-6 text-[var(--muted)]">{presentation.description}</p>

      <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs leading-5">
        <dt className="text-[var(--muted)]">Session</dt>
        <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">{session.id}</dd>
        <dt className="text-[var(--muted)]">Run</dt>
        <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">{run.id}</dd>
        <dt className="text-[var(--muted)]">原始状态</dt>
        <dd>{run.status}</dd>
        <dt className="text-[var(--muted)]">连接</dt>
        <dd className="inline-flex items-center gap-1.5">{connection === "online" ? <CloudOff className="size-3.5 rotate-180 text-[var(--success)]" aria-hidden="true" /> : <CloudOff className="size-3.5 text-[var(--warning)]" aria-hidden="true" />}{connection === "online" ? getSessionStateLabel(session.state) : getConnectionLabel(connection)}</dd>
        {commandState ? <><dt className="text-[var(--muted)]">命令确认</dt><dd>{commandState}</dd></> : null}
      </dl>

      {phase === "unknown" ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status"><CircleHelp className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>保留 unknown 事实，等待事件或人工对账；不会把它显示为失败或成功。</span></div> : null}
      {phase === "disconnected" ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" role="status"><CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>断线期间不发送、不排队，也不把中断请求当作已经终止。</span></div> : null}
      {actionError ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--danger-bg)] p-3 text-xs leading-5 text-[var(--danger)]" role="alert"><Ban className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{actionError}</span></div> : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
        <span className="text-[11px] leading-5 text-[var(--muted)]">{session.state === "unsupported" ? "Desktop 路径未证明" : "执行状态与任务业务状态分开"}</span>
        <Button type="button" variant="secondary" disabled={!canInterrupt} onClick={requestInterrupt} data-testid="run-interrupt-button">
          {interruptPending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <PauseCircle className="size-4" aria-hidden="true" />}
          {interruptPending || phase === "interrupt_requested" ? "中断请求中" : phase === "terminated" ? "已终止" : "请求中断"}
        </Button>
      </div>
    </article>
  );
}
