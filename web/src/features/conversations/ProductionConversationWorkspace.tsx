import { Info, LoaderCircle, MonitorCog, Send, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { ApiClientError, type ResolveApprovalParams } from "@loomhelm/api-client";
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
  runFromRecoveredIdentity,
  toSessionContextModel,
  type ProductionTaskSummary
} from "./production-session-model";

const NO_PROJECT = "__none__";
const SESSION_CREATION_INTENT_PREFIX = "loomhelm:session-creation-intent:";
const RUN_INTENT_PREFIX = "loomhelm:run-intent:";
const RUN_RECOVERY_PREFIX = "loomhelm:run-recovery:";

type SessionCreationPayload = Omit<CreateSessionRequest, "command_id">;

interface SessionCreationIntent {
  commandId: string;
  fingerprint: string;
  request: SessionCreationPayload;
  uncertain: boolean;
}

interface RunIntent {
  commandId: string;
  prompt: string;
  uncertain: boolean;
}

function getSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readSessionCreationIntent(key: string | undefined): SessionCreationIntent | undefined {
  if (!key) return undefined;
  const storage = getSessionStorage();
  if (!storage) return undefined;
  try {
    const value = storage.getItem(key);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<SessionCreationIntent>;
    if (typeof parsed.commandId !== "string" || typeof parsed.fingerprint !== "string" || typeof parsed.uncertain !== "boolean" || !parsed.request || typeof parsed.request !== "object") return undefined;
    const request = parsed.request as SessionCreationPayload;
    if (request.path !== "new" && request.path !== "existing_active") return undefined;
    if ((request.active_thread_ref !== undefined && typeof request.active_thread_ref !== "string") || (request.project_id !== undefined && typeof request.project_id !== "string") || (request.prompt !== undefined && typeof request.prompt !== "string") || (request.task_id !== undefined && typeof request.task_id !== "string")) return undefined;
    return { commandId: parsed.commandId, fingerprint: parsed.fingerprint, request, uncertain: parsed.uncertain };
  } catch {
    return undefined;
  }
}

function writeSessionCreationIntent(key: string | undefined, intent: SessionCreationIntent): boolean {
  const storage = getSessionStorage();
  if (!key || !storage) return false;
  try {
    storage.setItem(key, JSON.stringify(intent));
    return true;
  } catch {
    // A storage quota or privacy failure must be reported before a side effect is sent.
    return false;
  }
}

function clearStoredIntent(key: string | undefined): void {
  const storage = getSessionStorage();
  if (!key || !storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Best effort only; the server remains the source of truth.
  }
}

function getSessionCreationIntentKey(conversationTitle: string, taskId?: string, projectId?: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return `${SESSION_CREATION_INTENT_PREFIX}${encodeURIComponent([window.location.pathname, conversationTitle, taskId ?? "", projectId ?? ""].join("|"))}`;
}

function getRunIntentKey(sessionId: string | undefined): string | undefined {
  return sessionId ? `${RUN_INTENT_PREFIX}${encodeURIComponent(sessionId)}` : undefined;
}

function getRunRecoveryKey(sessionId: string | undefined): string | undefined {
  return sessionId ? `${RUN_RECOVERY_PREFIX}${encodeURIComponent(sessionId)}` : undefined;
}

function readRunRecoveryId(key: string | undefined): string | undefined {
  const storage = getSessionStorage();
  if (!key || !storage) return undefined;
  try {
    const value = storage.getItem(key);
    return value && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeRunRecoveryId(key: string | undefined, runId: string): boolean {
  const storage = getSessionStorage();
  if (!key || !storage) return false;
  try {
    storage.setItem(key, runId);
    return true;
  } catch {
    return false;
  }
}

function readRunIntent(key: string | undefined): RunIntent | undefined {
  if (!key) return undefined;
  const storage = getSessionStorage();
  if (!storage) return undefined;
  try {
    const value = storage.getItem(key);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<RunIntent>;
    if (typeof parsed.commandId !== "string" || typeof parsed.prompt !== "string" || typeof parsed.uncertain !== "boolean") return undefined;
    return { commandId: parsed.commandId, prompt: parsed.prompt, uncertain: parsed.uncertain };
  } catch {
    return undefined;
  }
}

function writeRunIntent(key: string | undefined, intent: RunIntent): boolean {
  const storage = getSessionStorage();
  if (!key || !storage) return false;
  try {
    storage.setItem(key, JSON.stringify(intent));
    return true;
  } catch {
    // A storage quota or privacy failure must block command admission.
    return false;
  }
}

function isUnknownSessionCreationError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return true;
  const body = error.body && typeof error.body === "object" ? error.body as { code?: unknown } : undefined;
  return body?.code === "unknown_result" || error.status >= 500 || error.status === 408 || error.status === 504;
}

interface ProjectOption {
  id: string;
  name: string;
}

export interface ProductionSessionCreationPanelProps {
  conversationTitle?: string;
  existingActiveSupported?: boolean;
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
  existingActiveSupported = false,
  fixedProjectId,
  fixedProjectName,
  onCreate,
  projectOptions = [],
  readOnly = false,
  taskId
}: ProductionSessionCreationPanelProps) {
  const storageKey = getSessionCreationIntentKey(conversationTitle, taskId, fixedProjectId);
  const storedIntent = useMemo(() => readSessionCreationIntent(storageKey), [storageKey]);
  const [path, setPath] = useState<SessionPath>(() => storedIntent?.request.path ?? "new");
  const [activeThreadRef, setActiveThreadRef] = useState(() => storedIntent?.request.active_thread_ref ?? "");
  const [prompt, setPrompt] = useState(() => storedIntent?.request.prompt ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState(() => fixedProjectId ?? storedIntent?.request.project_id ?? NO_PROJECT);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [creationUncertain, setCreationUncertain] = useState(() => storedIntent?.uncertain ?? false);
  const commandRef = useRef<SessionCreationIntent | undefined>(storedIntent);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || readOnly) return;
    const submitPath = path;
    if (submitPath === "existing_active" && !existingActiveSupported) {
      setFailure("当前服务暂不支持接入现有活跃对话；入口保留用于展示一期缺口，不会提交请求。");
      return;
    }
    setPending(true);
    setFailure(null);
    const requestWithoutCommand = {
      ...(activeThreadRef.trim() && submitPath === "existing_active" ? { active_thread_ref: activeThreadRef.trim() } : {}),
      ...(selectedProjectId !== NO_PROJECT ? { project_id: selectedProjectId } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      path: submitPath
    } satisfies SessionCreationPayload;
    const fingerprint = JSON.stringify(requestWithoutCommand);
    if (creationUncertain && commandRef.current?.fingerprint !== fingerprint) {
      setPending(false);
      setFailure("创建结果仍不确定；请先用相同请求完成对账，不能把修改后的请求当作新工作提交。");
      return;
    }
    const commandId = commandRef.current?.fingerprint === fingerprint ? commandRef.current.commandId : createCommandId("session");
    const intent: SessionCreationIntent = { commandId, fingerprint, request: requestWithoutCommand, uncertain: true };
    if (!writeSessionCreationIntent(storageKey, intent)) {
      setPending(false);
      setFailure("当前浏览器无法持久化创建命令身份；为避免未知结果下重复创建，请先恢复存储后再试。");
      return;
    }
    commandRef.current = intent;
    try {
      await onCreate({
        ...requestWithoutCommand,
        command_id: commandId
      });
      commandRef.current = undefined;
      setCreationUncertain(false);
      clearStoredIntent(storageKey);
    } catch (error) {
      const uncertain = isUnknownSessionCreationError(error);
      setCreationUncertain(uncertain);
      if (uncertain) {
        const pendingIntent = { ...intent, uncertain: true };
        commandRef.current = pendingIntent;
        writeSessionCreationIntent(storageKey, pendingIntent);
      } else {
        commandRef.current = undefined;
        clearStoredIntent(storageKey);
      }
      setFailure(errorMessage(error, "创建会话"));
    } finally {
      setPending(false);
    }
  };

  const abandonUncertainCreation = () => {
    commandRef.current = undefined;
    setCreationUncertain(false);
    setFailure("已放弃未确认的创建意图；修改后的表单会使用新的 command_id。");
    clearStoredIntent(storageKey);
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
          <Select value={path} onValueChange={(value) => setPath(value as SessionPath)} disabled={pending || readOnly || creationUncertain}>
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
            <input id="production-active-thread-ref" className="h-10 rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--surface-glass)] px-3 text-sm font-normal text-[var(--ink)] outline-none focus:border-[var(--accent)]" value={activeThreadRef} onChange={(event) => setActiveThreadRef(event.target.value)} placeholder="例如 thread-abc" disabled={pending || readOnly || creationUncertain} required />
          </label>
        ) : null}
        {path === "existing_active" && !existingActiveSupported ? <div className="rounded-[var(--radius-sm)] bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" role="status">当前后端尚未支持 existing_active；入口和 thread ref 保留，但提交按钮会禁用，避免把新建会话误报为接入现有活跃对话。</div> : null}
        {creationUncertain ? <div className="grid gap-2 rounded-[var(--radius-sm)] bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" role="status"><span>创建结果不确定；刷新后仍会保留同一请求身份。请先用相同请求重试或完成人工对账，不能直接改成另一项创建。</span><Button type="button" variant="secondary" onClick={abandonUncertainCreation}>我已对账，放弃这次创建</Button></div> : null}

        {fixedProjectId ? (
          <div className="grid gap-2 text-xs">
            <span className="font-semibold">项目</span>
            <div className="rounded-[var(--radius-sm)] bg-[var(--surface-soft)] px-3 py-2.5 text-[var(--muted)]">{fixedProjectName ?? fixedProjectId}</div>
          </div>
        ) : projectOptions.length > 0 ? (
          <label className="grid gap-2 text-xs font-semibold">
            <span>项目（可选）</span>
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId} disabled={pending || readOnly || creationUncertain}>
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
          <Textarea id="production-session-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="明确说明要讨论或执行的目标…" disabled={pending || readOnly || creationUncertain} className="min-h-28 resize-y border-[var(--line-strong)] bg-[var(--surface-glass)] text-[var(--ink)] placeholder:text-[var(--muted)]" />
        </label>

        {readOnly ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status"><WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>当前身份或项目权限为只读；表单保留展示，但不会创建 Session。</span></div> : null}
        {failure ? <div className="rounded-[var(--radius-sm)] bg-[var(--danger-bg)] p-3 text-xs leading-5 text-[var(--danger)]" role="alert">{failure}</div> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
          <span className="text-[11px] leading-5 text-[var(--muted)]">不会自动发送草稿；创建请求只提交一次 command_id。</span>
          <Button type="submit" disabled={pending || readOnly || (path === "existing_active" && !existingActiveSupported)}>
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            {pending ? "正在创建" : creationUncertain ? "重试同一命令" : "创建会话"}
          </Button>
        </div>
      </form>
    </article>
  );
}

export interface ProductionConversationWorkspaceProps {
  api?: PublishedSessionApi;
  conversationTitle?: string;
  existingActiveSupported?: boolean;
  initialRunId?: string;
  onRunCreated?: (sessionId: string, runId: string) => void | Promise<void>;
  onSessionCreated?: (sessionId: string, initialRunId?: string) => void | Promise<void>;
  projectId?: string;
  projectName?: string;
  projectOptions?: readonly ProjectOption[];
  readOnly?: boolean;
  sessionId?: string;
  task?: Pick<TaskRecord, "id" | "title" | "goal" | "state">;
}

function mergeApprovals(current: readonly Approval[], incoming: readonly Approval[]): readonly Approval[] {
  const byRevision = new Map<string, Approval>(current.map((approval) => [`${approval.id}:${approval.revision}`, approval]));
  incoming.forEach((approval) => {
    const key = `${approval.id}:${approval.revision}`;
    const existing = byRevision.get(key);
    if (!existing || existing.status === "pending" || existing.status === approval.status) byRevision.set(key, approval);
  });
  return [...byRevision.values()].sort((left, right) => {
    if (left.status === "pending" && right.status !== "pending") return -1;
    if (left.status !== "pending" && right.status === "pending") return 1;
    return right.requested_at.localeCompare(left.requested_at);
  });
}

async function readAllApprovalPages(api: Pick<PublishedSessionApi, "listRunApprovals">, runId: string, shouldContinue: () => boolean = () => true): Promise<readonly Approval[]> {
  const approvals: Approval[] = [];
  const seenCursors = new Set<string>();
  let afterCursor: string | undefined;

  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    if (!shouldContinue()) return approvals;
    const page = await api.listRunApprovals({ run_id: runId, limit: 200, ...(afterCursor ? { after_cursor: afterCursor } : {}) });
    approvals.push(...page.items);
    if (!page.has_more) return approvals;
    const nextCursor = page.next_cursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("审批历史分页游标未前进");
    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }

  throw new Error("审批历史分页超过安全页数限制");
}

function mapTaskSummary(task: ProductionConversationWorkspaceProps["task"]): ProductionTaskSummary | undefined {
  return task ? { goal: task.goal, id: task.id, state: task.state, title: task.title } : undefined;
}

export function ProductionConversationWorkspace({
  api,
  conversationTitle,
  existingActiveSupported = false,
  initialRunId,
  onRunCreated,
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
  const runIntentKey = getRunIntentKey(sessionId);
  const storedRunIntent = useMemo(() => readRunIntent(runIntentKey), [runIntentKey]);
  const [session, setSession] = useState<Session | undefined>();
  const [sessionLoading, setSessionLoading] = useState(Boolean(sessionId));
  const [sessionFailure, setSessionFailure] = useState<string | null>(null);
  const [run, setRun] = useState<Run | undefined>();
  const [commandState, setCommandState] = useState<CommandState | undefined>();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [approvalHistoryAvailable, setApprovalHistoryAvailable] = useState(false);
  const [runIdentityVerified, setRunIdentityVerified] = useState(false);
  const [draft, setDraft] = useState(() => storedRunIntent?.prompt ?? "");
  const [activityNotice, setActivityNotice] = useState<string | null>(null);
  const [uncertainRunCommandId, setUncertainRunCommandId] = useState<string | undefined>(() => storedRunIntent?.uncertain ? storedRunIntent.commandId : undefined);
  const draftRef = useRef(draft);
  const seenEventIds = useRef(new Set<string>());
  const approvalCommandIds = useRef(new Map<string, string>());
  const pendingRunSubmission = useRef<{ commandId: string; prompt: string } | undefined>(storedRunIntent ? { commandId: storedRunIntent.commandId, prompt: storedRunIntent.prompt } : undefined);
  const currentSessionIdRef = useRef<string | undefined>(sessionId);
  const previousSessionId = useRef<string | undefined>(undefined);
  const previousRunId = useRef<string | undefined>(initialRunId);
  const hasPreviousSessionId = useRef(false);

  const sessionForRoute = session && (sessionId === undefined || session.id === sessionId) ? session : undefined;
  const activeSessionId = sessionForRoute?.id ?? sessionId;
  const activeRun = run && run.session_id === activeSessionId ? run : undefined;
  const activeRunId = activeRun?.id;
  const connection: ConnectionAvailability = sessionForRoute ? connectionFromSessionState(sessionForRoute.state) : "online";
  const connectionRef = useRef<ConnectionAvailability>(connection);
  const currentConversationTitle = conversationTitle ?? task?.title ?? "独立会话";
  const taskSummary = mapTaskSummary(task);
  const context = sessionForRoute ? toSessionContextModel(sessionForRoute, { conversationTitle: currentConversationTitle, projectName, task: taskSummary }) : undefined;
  const activeApprovals = activeRunId ? approvals.filter((approval) => approval.run_id === activeRunId) : [];

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    currentSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!hasPreviousSessionId.current) {
      hasPreviousSessionId.current = true;
      previousSessionId.current = sessionId;
      return;
    }
    if (previousSessionId.current === sessionId) return;
    previousSessionId.current = sessionId;
    seenEventIds.current = new Set();
    approvalCommandIds.current = new Map();
    setMessages([]);
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setRun(undefined);
    setCommandState(undefined);
    setActivityNotice(null);
    setSession(undefined);
    setSessionFailure(null);
    setSessionLoading(Boolean(sessionId));
    const nextRunIntent = readRunIntent(getRunIntentKey(sessionId));
    pendingRunSubmission.current = nextRunIntent ? { commandId: nextRunIntent.commandId, prompt: nextRunIntent.prompt } : undefined;
    setDraft(nextRunIntent?.prompt ?? "");
    setUncertainRunCommandId(nextRunIntent?.uncertain ? nextRunIntent.commandId : undefined);
  }, [sessionId]);

  useEffect(() => {
    if (previousRunId.current === initialRunId) return;
    previousRunId.current = initialRunId;
    seenEventIds.current = new Set();
    setMessages([]);
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setRun(undefined);
    setCommandState(undefined);
    setActivityNotice(null);
  }, [initialRunId]);

  useEffect(() => {
    if (!api || !adapters || !sessionId) {
      setSessionLoading(false);
      if (!sessionId || !api) setSession(undefined);
      if (sessionId && !api) setSessionFailure("当前浏览器没有可用的会话服务。");
      return;
    }
    adapters.session.selectSession(sessionId);
    adapters.run.selectSession(sessionId);
    adapters.approval.selectSession(sessionId);
    let active = true;
    setSession(undefined);
    setRun(undefined);
    setMessages([]);
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setSessionLoading(true);
    setSessionFailure(null);
    void adapters.session.readSession(sessionId).then((result) => {
      if (!active) return;
      if (result.state === "received" && result.session) {
        setSession(result.session);
        const recoveredRunId = initialRunId ?? readRunRecoveryId(getRunRecoveryKey(sessionId));
        if (recoveredRunId) setRun(runFromRecoveredIdentity(result.session, recoveredRunId));
      } else {
        setSession(undefined);
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
      if (!active) return;
      if (result.state === "received" && result.session) {
        setSession(result.session);
        setSessionFailure(null);
        return;
      }
      setSession(undefined);
      setCommandState("unknown");
      setSessionFailure(result.state === "unknown" ? "Session 响应结果不确定，当前不展示旧控制面板；请刷新或人工对账。" : "读取 Session 失败，请刷新后再试。");
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
    let pollInFlight = false;
    setApprovalHistoryAvailable(false);
    const poll = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const events = await adapters.run.readRunEvents({ id: "production-conversation", runId: activeRunId, sessionId: activeSessionId }, { connection: connectionRef.current, limit: 100 });
        if (!active) return;
        if (events.state === "received" && events.page) {
          if (events.page.events.length > 0) setRunIdentityVerified(true);
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
          const responseApprovals = await readAllApprovalPages(api, activeRunId, () => active);
          if (!active) return;
          const approvalItems = responseApprovals.filter((approval) => approval.run_id === activeRunId);
          if (approvalItems.length !== responseApprovals.length) setActivityNotice("审批响应包含其他 Run 的记录；已丢弃越界事实。");
          setApprovals((current) => mergeApprovals(current, approvalItems));
          setApprovalHistoryAvailable(true);
        } catch {
          if (active) {
            setApprovalHistoryAvailable(false);
            setActivityNotice("审批历史暂时无法读取；当前已展示的审批事实保持不变，审批控制已禁用。");
          }
        }
      } finally {
        pollInFlight = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activeRunId, activeSessionId, adapters, api]);

  const createSession = async (request: CreateSessionRequest) => {
    if (!api || !adapters) throw new Error("当前浏览器没有可用的会话服务");
    const response = await api.createSession({ body: request });
    const initialRunId = response.initial_run_ack?.run_id;
    if (initialRunId && !writeRunRecoveryId(getRunRecoveryKey(response.session.id), initialRunId)) {
      throw new Error("Session 已收到但首个 Run 恢复身份无法持久化；请恢复浏览器存储后用同一创建命令对账。");
    }
    adapters.session.selectSession(response.session.id);
    adapters.run.selectSession(response.session.id);
    adapters.approval.selectSession(response.session.id);
    setSession(response.session);
    setSessionFailure(null);
    if (response.initial_run_ack) {
      setCommandState(response.initial_run_ack.state);
      const initialRun = runFromCommandAck(response.session, response.initial_run_ack);
      setRun(initialRun);
      setRunIdentityVerified(Boolean(initialRun));
      setActivityNotice(response.initial_run_ack.run_id ? "首条提示已收到命令确认，等待实际 Run 事件。" : "Session 已创建；首条提示已提交，但服务尚未返回 Run ID。");
    } else {
      setActivityNotice("Session 已创建；当前没有首条 Run 命令确认。");
    }
    await onSessionCreated?.(response.session.id, response.initial_run_ack?.run_id);
  };

  const send = async (prompt: string) => {
    if (!api || !adapters || !sessionForRoute) throw new Error("Session 尚未就绪");
    if (!canSendControl(connection, readOnly) || sessionForRoute.state !== "active") throw new Error("当前 Session 不允许发送控制命令");
    if (activeRun?.status === "unknown" || commandState === "unknown") {
      setActivityNotice("当前 Run 结果不确定；请先完成对账，不能在未确认的执行上继续发送或授权。");
      return;
    }
    if (uncertainRunCommandId) {
      setActivityNotice("上一次 Run 结果不确定；请刷新或手动对账后再发送新的控制命令。");
      return;
    }
    const sessionIdForSubmit = sessionForRoute.id;
    const intentKey = getRunIntentKey(sessionIdForSubmit);
    const commandId = pendingRunSubmission.current?.prompt === prompt ? pendingRunSubmission.current.commandId : createCommandId("run");
    if (!writeRunIntent(intentKey, { commandId, prompt, uncertain: true })) {
      setActivityNotice("当前浏览器无法持久化 Run 命令身份；为避免未知结果下重复执行，请先恢复存储后再发送。");
      return;
    }
    pendingRunSubmission.current = { commandId, prompt };
    const result = await adapters.run.submitRun(sessionIdForSubmit, { command_id: commandId, prompt }, { connection, readOnly });
    if (currentSessionIdRef.current !== sessionIdForSubmit) return;
    if (result.state === "unknown") {
      setUncertainRunCommandId(commandId);
      writeRunIntent(intentKey, { commandId, prompt, uncertain: true });
      setActivityNotice("发送结果不确定；请刷新或手动对账后再决定是否继续。相同意图不会自动重复提交。");
      return;
    }
    if (result.state === "pending" && !result.ack) {
      setActivityNotice("相同 Run 命令仍在处理中；已保留命令身份，不会重复提交。");
      return;
    }
    if (result.state === "failed") {
      pendingRunSubmission.current = undefined;
      clearStoredIntent(intentKey);
      setActivityNotice("Run 命令被服务拒绝；草稿仍保留，可以修改后重新发送。");
      return;
    }
    const nextRun = result.ack ? runFromCommandAck(sessionForRoute, result.ack) : undefined;
    const previousRunId = activeRun?.id;
    const recoveryPersisted = nextRun ? writeRunRecoveryId(getRunRecoveryKey(sessionIdForSubmit), nextRun.id) : false;
    const commandReconciled = Boolean(nextRun && recoveryPersisted);
    if (commandReconciled) {
      pendingRunSubmission.current = undefined;
      clearStoredIntent(intentKey);
    } else {
      setUncertainRunCommandId(commandId);
      writeRunIntent(intentKey, { commandId, prompt, uncertain: true });
    }
    if (result.ack) {
      if (nextRun) {
        if (previousRunId && previousRunId !== nextRun.id) {
          seenEventIds.current = new Set();
          setMessages([]);
          setApprovals([]);
          setApprovalHistoryAvailable(false);
        }
        setCommandState(result.ack.state);
        setRun(nextRun);
        setRunIdentityVerified(true);
      }
      setActivityNotice(commandReconciled ? "Run 命令已收到，等待实际事件。" : "命令已收到，但 Run 恢复身份未确认；请先对账，不会自动重复提交。");
    }
    if (commandReconciled) {
      setUncertainRunCommandId(undefined);
      if (draftRef.current === prompt) setDraft("");
      if (nextRun) void onRunCreated?.(sessionIdForSubmit, nextRun.id);
    }
  };

  const resolveApproval = async (params: ResolveApprovalParams) => {
    if (!api || !adapters || !sessionForRoute) throw new Error("Session 尚未就绪");
    if (!approvalHistoryAvailable) throw new Error("审批历史尚未通过当前 Run 核对，请刷新后再确认");
    if (!runIdentityVerified || uncertainRunCommandId || activeRun?.status === "unknown" || commandState === "unknown") throw new Error("当前 Run 身份或结果未完成核对，不能继续提交审批控制命令");
    if (sessionForRoute.state !== "active" || !canSendControl(connection, readOnly)) throw new Error("当前 Session 不允许提交审批控制命令");
    const approval = activeApprovals.find((item) => item.id === params.approval_id && item.revision === params.body.revision);
    if (!approval) throw new Error("审批修订已变化，请刷新后重新确认");
    const latestRevision = activeApprovals.filter((item) => item.id === approval.id).reduce((latest, item) => Math.max(latest, item.revision), 0);
    if (approval.revision !== latestRevision) throw new Error("审批修订已过期，请刷新后重新确认");
    const result = await adapters.approval.resolve({
      approval,
      commandId: params.body.command_id,
      decision: params.body.decision,
      sessionId: sessionForRoute.id
    }, { connection, readOnly });
    if (result.state === "failed") {
      approvalCommandIds.current.delete(`approval:${approval.id}:${approval.revision}:${params.body.decision}`);
      throw new Error("审批命令被服务拒绝；请确认当前修订后重试");
    }
    if (result.state === "unknown") throw new Error("审批结果未被确认；请对账，不会自动重复提交");
    setActivityNotice("审批命令已收到，等待服务事件确认当前修订。");
  };

  const reconcileRunSubmission = () => {
    if (!adapters || !uncertainRunCommandId) return;
    const intentKey = getRunIntentKey(activeSessionId);
    const intent = readRunIntent(intentKey);
    if (adapters.run.resolveUncertainSubmit(uncertainRunCommandId) || intent?.commandId === uncertainRunCommandId) {
      setUncertainRunCommandId(undefined);
      if (intent) writeRunIntent(intentKey, { ...intent, uncertain: false });
      setActivityNotice("已记录人工对账；下一次发送会复用同一 command_id，不会创建新的 Run 身份。");
    } else {
      setActivityNotice("本地未知命令状态已变化，请刷新后重新核对。");
    }
  };

  const interrupt = async (request: { command_id: string; reason?: string }) => {
    if (!api || !adapters || !sessionForRoute || !activeRun) throw new Error("Run 尚未就绪");
    if (sessionForRoute.state !== "active" || !canSendControl(connection, readOnly)) throw new Error("当前 Session 不允许提交中断控制命令");
    if (!runIdentityVerified || uncertainRunCommandId || activeRun.status === "unknown" || commandState === "unknown") throw new Error("当前 Run 身份或结果未完成核对，不能继续提交中断控制命令");
    const result = await adapters.run.interruptRun(sessionForRoute.id, activeRun.id, request, { connection, readOnly });
    if (result.state === "failed") {
      approvalCommandIds.current.delete(`interrupt:${activeRun.id}`);
      throw new Error("中断命令被服务拒绝；请重新观察 Run 状态后再试");
    }
    if (result.state === "unknown") throw new Error("中断结果未被确认；请对账，不会自动重试");
    setCommandState(result.ack?.state);
    setActivityNotice("中断命令已收到，等待 run.interrupted 事件。");
  };

  if (!sessionForRoute && !sessionId) {
    return (
      <section className="grid min-w-0 gap-5" aria-label="创建会话工作区">
        {api ? <ProductionSessionCreationPanel conversationTitle={currentConversationTitle} existingActiveSupported={existingActiveSupported} fixedProjectId={projectId} fixedProjectName={projectName} onCreate={createSession} projectOptions={projectOptions} readOnly={readOnly} taskId={task?.id} /> : <div className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]"><h2 className="text-base font-semibold text-[var(--ink)]">会话服务不可用</h2><p>当前浏览器没有已认证的生产 API，不能创建 Session。</p></div>}
      </section>
    );
  }

  if (sessionLoading) {
    return <section className="grid min-w-0 gap-5 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]" aria-busy="true"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在读取 Session 与 Host 状态…</section>;
  }

  if (!sessionForRoute || !context) {
    return <section className="grid min-w-0 gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5" role="alert"><h2 className="text-base font-semibold">会话工作区暂不可用</h2><p className="text-sm leading-6 text-[var(--muted)]">{sessionFailure ?? "没有收到可验证的 Session 响应。"}</p></section>;
  }

  return (
    <section className="grid min-w-0 gap-5" aria-label="生产会话工作区">
      <SessionContextSummary connection={connection} context={context} />
      {activityNotice ? <div className="flex flex-wrap items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-3 text-xs leading-5 text-[var(--muted)]" role="status"><Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1">{activityNotice}</span>{uncertainRunCommandId ? <Button type="button" variant="secondary" onClick={reconcileRunSubmission}>我已对账，复用命令重试</Button> : null}</div> : null}
      <ConversationMessageStream connection={connection} emptyMessage="当前没有已接收消息或事件；首条提示和控制命令不会以乐观消息显示。" messages={messages} />
      {activeRun ? <RunStatusCard canControl={Boolean(api) && runIdentityVerified && !uncertainRunCommandId && activeRun.status !== "unknown" && commandState !== "unknown" && sessionForRoute.state === "active"} commandState={commandState} connection={connection} interruptCommandId={createCommandIdForRun(activeRun.id, approvalCommandIds.current)} onInterrupt={interrupt} readOnly={readOnly} run={activeRun} session={sessionForRoute} /> : null}
      {activeApprovals.map((approval) => {
        const approvalContext = approvalContextFromApproval(approval);
        const request: ApprovalRequestModel = {
          approval,
          context: {
            command: approvalContext.command,
            complete: approvalContext.complete,
            conversationTitle: currentConversationTitle,
            directory: approvalContext.directory,
            impact: approvalContext.impact,
            rawContext: approvalContext.rawContext,
            projectName,
            sessionId: sessionForRoute.id,
            task: task ? { id: task.id, title: task.title } : undefined
          }
        };
        const latestRevision = activeApprovals.filter((candidate) => candidate.id === approval.id).reduce((latest, candidate) => Math.max(latest, candidate.revision), 0);
        return <ApprovalRequestCard key={`${approval.id}:${approval.revision}`} commandIds={{ approve: commandIdForApproval(approval, "approve", approvalCommandIds.current), deny: commandIdForApproval(approval, "deny", approvalCommandIds.current) }} connection={connection} canResolve={runIdentityVerified && !uncertainRunCommandId && sessionForRoute.state === "active" && approvalHistoryAvailable && activeRun?.status !== "unknown" && commandState !== "unknown" && approval.revision === latestRevision} onResolve={resolveApproval} readOnly={readOnly} request={request} />;
      })}
      <ConversationComposer connection={connection} disabled={!api || sessionForRoute.state !== "active" || activeRun?.status === "unknown" || commandState === "unknown" || Boolean(uncertainRunCommandId)} onChange={setDraft} onSend={send} readOnly={readOnly} value={draft} />
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
