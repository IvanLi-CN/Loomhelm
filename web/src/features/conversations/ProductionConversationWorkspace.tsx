import { Info, LoaderCircle, MonitorCog, Send, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { ResolveApprovalParams } from "@loomhelm/api-client";
import type { Approval, ApprovalDecision, CommandState, CreateSessionRequest, Run, Session, SessionPath } from "@loomhelm/protocol";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { TaskRecord } from "@/features/tasks/types";

import { ApprovalRequestCard, type ApprovalRequestModel } from "../approvals/ApprovalRequestCard";
import { ApprovalClientAdapter } from "../approvals/approval-client-adapter";
import { ConversationComposer, ConversationMessageStream, type ConversationMessage } from "./ConversationMessageStream";
import type { PublishedSessionApi } from "../sessions/api";
import { RunStatusCard } from "../runs/RunStatusCard";
import { RunClientAdapter } from "../runs/run-client-adapter";
import { SessionContextSummary } from "../sessions/SessionContextSummary";
import { SessionClientAdapter } from "../sessions/session-client-adapter";
import { canSendControl, type ConnectionAvailability } from "../sessions/session-model";
import {
  approvalContextFromApproval,
  applyRunEvent,
  connectionFromSessionState,
  eventToConversationMessage,
  runFromCommandAck,
  toSessionContextModel,
  type ProductionTaskSummary
} from "./production-session-model";

const NO_PROJECT = "__none__";

interface ProjectOption {
  id: string;
  name: string;
}

export interface ProductionSessionCreationPanelProps {
  conversationTitle?: string;
  fixedProjectId?: string;
  fixedProjectName?: string;
  onCreate: (request: CreateSessionRequest) => void | Promise<void>;
  projectOptions?: readonly ProjectOption[];
  readOnly?: boolean;
  taskId?: string;
}

function createCommandId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, operation: string): string {
  return error instanceof Error && error.message ? `${operation}失败：${error.message}` : `${operation}失败，请刷新核对后再试。`;
}

export function ProductionSessionCreationPanel({
  conversationTitle = "新建独立会话",
  fixedProjectId,
  fixedProjectName,
  onCreate,
  projectOptions = [],
  readOnly = false,
  taskId
}: ProductionSessionCreationPanelProps) {
  const [path, setPath] = useState<SessionPath>("new");
  const [activeThreadRef, setActiveThreadRef] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState(fixedProjectId ?? NO_PROJECT);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || readOnly) return;
    setPending(true);
    setFailure(null);
    try {
      await onCreate({
        ...(activeThreadRef.trim() && path === "existing_active" ? { active_thread_ref: activeThreadRef.trim() } : {}),
        command_id: createCommandId("session"),
        ...(selectedProjectId !== NO_PROJECT ? { project_id: selectedProjectId } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(taskId ? { task_id: taskId } : {}),
        path
      });
    } catch (error) {
      setFailure(errorMessage(error, "创建会话"));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="grid min-w-0 gap-5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow)]" data-testid="production-session-creation-panel">
      <header className="grid gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Host / 会话</span>
        <div className="flex min-w-0 items-center gap-2">
          <MonitorCog className="size-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <h2 className="wrap-anywhere text-base font-semibold">{conversationTitle}</h2>
        </div>
        <p className="max-w-[68ch] text-xs leading-6 text-[var(--muted)]">Host 路径、Session 身份和首条提示会作为一次明确创建命令提交；只有收到事件后，消息流才会显示实际内容。</p>
      </header>

      <form className="grid min-w-0 gap-4" onSubmit={submit}>
        <label className="grid gap-2 text-xs font-semibold">
          <span>Host 路径</span>
          <Select value={path} onValueChange={(value) => setPath(value as SessionPath)} disabled={pending || readOnly}>
            <SelectTrigger aria-label="Host 路径"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="new">新建 Desktop 对话</SelectItem>
              <SelectItem value="existing_active">接入现有活跃对话</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {path === "existing_active" ? (
          <label className="grid gap-2 text-xs font-semibold" htmlFor="production-active-thread-ref">
            <span>现有 Host thread ref</span>
            <input id="production-active-thread-ref" className="h-10 rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--surface-glass)] px-3 text-sm font-normal text-[var(--ink)] outline-none focus:border-[var(--accent)]" value={activeThreadRef} onChange={(event) => setActiveThreadRef(event.target.value)} placeholder="例如 thread-abc" disabled={pending || readOnly} required />
          </label>
        ) : null}

        {fixedProjectId ? (
          <div className="grid gap-2 text-xs">
            <span className="font-semibold">项目</span>
            <div className="rounded-[var(--radius-sm)] bg-[var(--surface-soft)] px-3 py-2.5 text-[var(--muted)]">{fixedProjectName ?? fixedProjectId}</div>
          </div>
        ) : projectOptions.length > 0 ? (
          <label className="grid gap-2 text-xs font-semibold">
            <span>项目（可选）</span>
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId} disabled={pending || readOnly}>
              <SelectTrigger aria-label="项目"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>独立会话，不归属项目</SelectItem>
                {projectOptions.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ) : (
          <div className="grid gap-2 text-xs">
            <span className="font-semibold">项目</span>
            <div className="rounded-[var(--radius-sm)] bg-[var(--surface-soft)] px-3 py-2.5 text-[var(--muted)]">独立会话，不归属项目</div>
          </div>
        )}

        <label className="grid gap-2 text-xs font-semibold" htmlFor="production-session-prompt">
          <span>首条提示（可选）</span>
          <Textarea id="production-session-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="明确说明要讨论或执行的目标…" disabled={pending || readOnly} className="min-h-28 resize-y border-[var(--line-strong)] bg-[var(--surface-glass)] text-[var(--ink)] placeholder:text-[var(--muted)]" />
        </label>

        {readOnly ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status"><WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>当前身份或项目权限为只读；表单保留展示，但不会创建 Session。</span></div> : null}
        {failure ? <div className="rounded-[var(--radius-sm)] bg-[var(--danger-bg)] p-3 text-xs leading-5 text-[var(--danger)]" role="alert">{failure}</div> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
          <span className="text-[11px] leading-5 text-[var(--muted)]">不会自动发送草稿；创建请求只提交一次 command_id。</span>
          <Button type="submit" disabled={pending || readOnly}>
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            {pending ? "正在创建" : "创建会话"}
          </Button>
        </div>
      </form>
    </article>
  );
}

export interface ProductionConversationWorkspaceProps {
  api?: PublishedSessionApi;
  conversationTitle?: string;
  initialRunId?: string;
  onSessionCreated?: (sessionId: string, initialRunId?: string) => void | Promise<void>;
  projectId?: string;
  projectName?: string;
  projectOptions?: readonly ProjectOption[];
  readOnly?: boolean;
  sessionId?: string;
  task?: Pick<TaskRecord, "id" | "title" | "goal" | "state">;
}

function mergeApprovals(current: readonly Approval[], incoming: readonly Approval[]): readonly Approval[] {
  const byRevision = new Map(current.map((approval) => [`${approval.id}:${approval.revision}`, approval] as const));
  incoming.forEach((approval) => byRevision.set(`${approval.id}:${approval.revision}`, approval));
  return [...byRevision.values()].sort((left, right) => {
    if (left.status === "pending" && right.status !== "pending") return -1;
    if (left.status !== "pending" && right.status === "pending") return 1;
    return right.requested_at.localeCompare(left.requested_at);
  });
}

function mapTaskSummary(task: ProductionConversationWorkspaceProps["task"]): ProductionTaskSummary | undefined {
  return task ? { goal: task.goal, id: task.id, state: task.state, title: task.title } : undefined;
}

export function ProductionConversationWorkspace({
  api,
  conversationTitle,
  initialRunId,
  onSessionCreated,
  projectId,
  projectName,
  projectOptions = [],
  readOnly = false,
  sessionId,
  task
}: ProductionConversationWorkspaceProps) {
  const adapters = useMemo(() => api ? {
    approval: new ApprovalClientAdapter(api),
    run: new RunClientAdapter(api),
    session: new SessionClientAdapter(api)
  } : undefined, [api]);
  const [session, setSession] = useState<Session | undefined>();
  const [sessionLoading, setSessionLoading] = useState(Boolean(sessionId));
  const [sessionFailure, setSessionFailure] = useState<string | null>(null);
  const [run, setRun] = useState<Run | undefined>();
  const [commandState, setCommandState] = useState<CommandState | undefined>();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [draft, setDraft] = useState("");
  const [activityNotice, setActivityNotice] = useState<string | null>(null);
  const seenEventIds = useRef(new Set<string>());
  const approvalCommandIds = useRef(new Map<string, string>());
  const previousSessionId = useRef<string | undefined>(undefined);

  const activeSessionId = session?.id ?? sessionId;
  const activeRunId = run?.id;
  const connection: ConnectionAvailability = session ? connectionFromSessionState(session.state) : "online";
  const currentConversationTitle = conversationTitle ?? task?.title ?? "独立会话";
  const taskSummary = mapTaskSummary(task);
  const context = session ? toSessionContextModel(session, { conversationTitle: currentConversationTitle, projectName, task: taskSummary }) : undefined;

  useEffect(() => {
    if (previousSessionId.current === undefined) {
      previousSessionId.current = sessionId;
      return;
    }
    if (previousSessionId.current === sessionId) return;
    previousSessionId.current = sessionId;
    seenEventIds.current = new Set();
    approvalCommandIds.current = new Map();
    setMessages([]);
    setApprovals([]);
    setRun(undefined);
    setCommandState(undefined);
    setActivityNotice(null);
  }, [sessionId]);

  useEffect(() => {
    if (!api || !adapters || !sessionId) {
      setSessionLoading(false);
      if (!sessionId) setSession(undefined);
      if (sessionId && !api) setSessionFailure("当前浏览器没有可用的会话服务。");
      return;
    }
    adapters.session.selectSession(sessionId);
    adapters.run.selectSession(sessionId);
    adapters.approval.selectSession(sessionId);
    let active = true;
    setSessionLoading(true);
    setSessionFailure(null);
    void adapters.session.readSession(sessionId).then((result) => {
      if (!active) return;
      if (result.state === "received" && result.session) {
        setSession(result.session);
        if (initialRunId) {
          const routeRun = runFromCommandAck(result.session, { command_id: "route-run", deduplicated: true, received_at: result.session.updated_at, run_id: initialRunId, state: "accepted" });
          setRun(routeRun);
        }
      } else {
        setSessionFailure(result.reason === "transport" ? "读取 Session 失败，请刷新后再试。" : "Session 响应未通过身份核对，当前不展示猜测内容。");
      }
      setSessionLoading(false);
    });
    return () => {
      active = false;
    };
  }, [adapters, api, initialRunId, sessionId]);

  useEffect(() => {
    if (!api || !adapters || !activeSessionId) return;
    let active = true;
    const refreshSession = async () => {
      const result = await adapters.session.readSession(activeSessionId);
      if (!active || result.state !== "received" || !result.session) return;
      setSession(result.session);
    };
    const interval = setInterval(() => void refreshSession(), 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activeSessionId, adapters, api]);

  useEffect(() => {
    if (!api || !adapters || !activeSessionId || !activeRunId) return;
    let active = true;
    const poll = async () => {
      const events = await adapters.run.readRunEvents({ id: "production-conversation", runId: activeRunId, sessionId: activeSessionId }, { connection, limit: 100 });
      if (!active) return;
      if (events.state === "received" && events.page) {
        const freshEvents = events.page.events.filter((event) => {
          const eventKey = `${activeRunId}:${event.event_id}`;
          if (seenEventIds.current.has(eventKey)) return false;
          seenEventIds.current.add(eventKey);
          return true;
        });
        if (freshEvents.length > 0) {
          setMessages((current) => [...current, ...freshEvents.map(eventToConversationMessage)]);
          setRun((current) => current ? freshEvents.reduce(applyRunEvent, current) : current);
        }
      } else if (events.state === "unknown" && events.reason !== "pending") {
        setActivityNotice("事件读取结果不确定；已保留当前事实，不会自动重试控制命令。请刷新或手动对账。");
      }

      try {
        const approvalPage = await api.listRunApprovals({ limit: 100, run_id: activeRunId });
        if (active) setApprovals((current) => mergeApprovals(current, approvalPage.items));
      } catch {
        if (active) setActivityNotice("审批历史暂时无法读取；当前已展示的审批事实保持不变。");
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activeRunId, activeSessionId, adapters, api, connection]);

  const createSession = async (request: CreateSessionRequest) => {
    if (!api || !adapters) throw new Error("当前浏览器没有可用的会话服务");
    const response = await api.createSession({ body: request });
    adapters.session.selectSession(response.session.id);
    adapters.run.selectSession(response.session.id);
    adapters.approval.selectSession(response.session.id);
    setSession(response.session);
    setSessionFailure(null);
    if (response.initial_run_ack) {
      setCommandState(response.initial_run_ack.state);
      setRun(runFromCommandAck(response.session, response.initial_run_ack));
      setActivityNotice(response.initial_run_ack.run_id ? "首条提示已收到命令确认，等待实际 Run 事件。" : "Session 已创建；首条提示已提交，但服务尚未返回 Run ID。");
    } else {
      setActivityNotice("Session 已创建；当前没有首条 Run 命令确认。");
    }
    await onSessionCreated?.(response.session.id, response.initial_run_ack?.run_id);
  };

  const send = async (prompt: string) => {
    if (!api || !adapters || !session) throw new Error("Session 尚未就绪");
    if (!canSendControl(connection, readOnly) || session.state !== "active") throw new Error("当前 Session 不允许发送控制命令");
    const result = await adapters.run.submitRun(session.id, { command_id: createCommandId("run"), prompt }, { connection, readOnly });
    setCommandState(result.ack?.state);
    if (result.state === "unknown") throw new Error("发送结果不确定；请对账后再决定是否继续");
    if (result.state === "failed") throw new Error("Run 命令被服务拒绝");
    if (result.ack) {
      const nextRun = runFromCommandAck(session, result.ack);
      if (nextRun) setRun(nextRun);
      setActivityNotice(nextRun ? "Run 命令已收到，等待实际事件。" : "命令已收到，但服务尚未返回 Run ID。");
    }
    setDraft("");
  };

  const resolveApproval = async (params: ResolveApprovalParams) => {
    if (!api || !adapters || !session) throw new Error("Session 尚未就绪");
    if (session.state !== "active" || !canSendControl(connection, readOnly)) throw new Error("当前 Session 不允许提交审批控制命令");
    const approval = approvals.find((item) => item.id === params.approval_id && item.revision === params.body.revision);
    if (!approval) throw new Error("审批修订已变化，请刷新后重新确认");
    const result = await adapters.approval.resolve({
      approval,
      commandId: params.body.command_id,
      decision: params.body.decision,
      sessionId: session.id
    }, { connection, readOnly });
    if (result.state === "unknown" || result.state === "failed") throw new Error("审批结果未被确认；请对账，不会自动重复提交");
    setActivityNotice("审批命令已收到，等待服务事件确认当前修订。");
  };

  const interrupt = async (request: { command_id: string; reason?: string }) => {
    if (!api || !adapters || !session || !run) throw new Error("Run 尚未就绪");
    if (session.state !== "active" || !canSendControl(connection, readOnly)) throw new Error("当前 Session 不允许提交中断控制命令");
    const result = await adapters.run.interruptRun(session.id, run.id, request, { connection, readOnly });
    setCommandState(result.ack?.state);
    if (result.state === "unknown" || result.state === "failed") throw new Error("中断结果未被确认；请对账，不会自动重试");
    setActivityNotice("中断命令已收到，等待 run.interrupted 事件。");
  };

  if (!session && !sessionId) {
    return (
      <section className="grid min-w-0 gap-5" aria-label="创建会话工作区">
        {api ? <ProductionSessionCreationPanel conversationTitle={currentConversationTitle} fixedProjectId={projectId} fixedProjectName={projectName} onCreate={createSession} projectOptions={projectOptions} readOnly={readOnly} taskId={task?.id} /> : <div className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]"><h2 className="text-base font-semibold text-[var(--ink)]">会话服务不可用</h2><p>当前浏览器没有已认证的生产 API，不能创建 Session。</p></div>}
      </section>
    );
  }

  if (sessionLoading) {
    return <section className="grid min-w-0 gap-5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]" aria-busy="true"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在读取 Session 与 Host 状态…</section>;
  }

  if (!session || !context) {
    return <section className="grid min-w-0 gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5" role="alert"><h2 className="text-base font-semibold">会话工作区暂不可用</h2><p className="text-sm leading-6 text-[var(--muted)]">{sessionFailure ?? "没有收到可验证的 Session 响应。"}</p></section>;
  }

  return (
    <section className="grid min-w-0 gap-5" aria-label="生产会话工作区">
      <SessionContextSummary connection={connection} context={context} />
      {activityNotice ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status"><Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{activityNotice}</span></div> : null}
      <ConversationMessageStream connection={connection} emptyMessage="当前没有已接收消息或事件；首条提示和控制命令不会以乐观消息显示。" messages={messages} />
      {run ? <RunStatusCard canControl={Boolean(api) && session.state === "active"} commandState={commandState} connection={connection} interruptCommandId={createCommandIdForRun(run.id, approvalCommandIds.current)} onInterrupt={interrupt} readOnly={readOnly} run={run} session={session} /> : null}
      {approvals.map((approval) => {
        const approvalContext = approvalContextFromApproval(approval);
        const request: ApprovalRequestModel = {
          approval,
          context: {
            command: approvalContext.command,
            conversationTitle: currentConversationTitle,
            directory: approvalContext.directory,
            impact: approvalContext.impact,
            projectName,
            sessionId: session.id,
            task: task ? { id: task.id, title: task.title } : undefined
          }
        };
        return <ApprovalRequestCard key={`${approval.id}:${approval.revision}`} commandIds={{ approve: commandIdForApproval(approval, "approve", approvalCommandIds.current), deny: commandIdForApproval(approval, "deny", approvalCommandIds.current) }} connection={connection} canResolve={session.state === "active"} onResolve={resolveApproval} readOnly={readOnly} request={request} />;
      })}
      <ConversationComposer connection={connection} disabled={!api || session.state !== "active"} onChange={setDraft} onSend={send} readOnly={readOnly} value={draft} />
      <div className="flex items-start gap-2 text-[11px] leading-5 text-[var(--muted)]"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" /><span>审批、Run 控制和消息发送都以当前 Session、Run、修订和连接状态为准；未知结果不会自动重试。</span></div>
    </section>
  );
}

function createCommandIdForRun(runId: string, cache: Map<string, string>): string {
  const key = `interrupt:${runId}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const commandId = createCommandId("interrupt");
  cache.set(key, commandId);
  return commandId;
}

function commandIdForApproval(approval: Approval, decision: ApprovalDecision, cache: Map<string, string>): string {
  const key = `approval:${approval.id}:${approval.revision}:${decision}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const commandId = createCommandId(`approval-${decision}`);
  cache.set(key, commandId);
  return commandId;
}
