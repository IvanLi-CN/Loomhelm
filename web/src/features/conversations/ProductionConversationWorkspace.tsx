import { Info, LoaderCircle, MonitorCog, Send, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";

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
import { DraftClientAdapter, type DraftReadReason } from "../sessions/draft-client-adapter";
import { RunStatusCard } from "../runs/RunStatusCard";
import { RunClientAdapter } from "../runs/run-client-adapter";
import { SessionContextSummary } from "../sessions/SessionContextSummary";
import { SessionClientAdapter } from "../sessions/session-client-adapter";
import { SessionRunHistoryClientAdapter, type SessionRunHistoryReadReason } from "../sessions/session-run-history-adapter";
import { canSendControl, type ConnectionAvailability } from "../sessions/session-model";
import {
  approvalContextFromApproval,
  applyRunEvent,
  connectionFromSessionState,
  eventToConversationMessage,
  initialRunCommandId,
  isSessionAccessFailure,
  runFromCommandAck,
  runFromRecoveredIdentity,
  runFromHistory,
  sessionReadFailureMessage,
  toSessionContextModel,
  type ProductionTaskSummary
} from "./production-session-model";

const NO_PROJECT = "__none__";
const SESSION_CREATION_INTENT_PREFIX = "loomhelm:session-creation-intent:";
const RUN_INTENT_PREFIX = "loomhelm:run-intent:";
const RUN_RECOVERY_PREFIX = "loomhelm:run-recovery:";
const DRAFT_PREFIX = "loomhelm:draft:";
const DRAFT_CLIENT_PREFIX = "loomhelm:draft-client:";
const DRAFT_SEQUENCE_PREFIX = "loomhelm:draft-sequence:";
const CONTROL_INTENT_PREFIX = "loomhelm:control-intent:";

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

interface ControlIntent {
  commandId: string;
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

function getIdentityScope(principalId: string | undefined): string {
  return encodeURIComponent(principalId?.trim() || "anonymous");
}

function getSessionCreationIntentKey(principalId: string | undefined, conversationTitle: string, taskId?: string, projectId?: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return `${SESSION_CREATION_INTENT_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent([window.location.pathname, conversationTitle, taskId ?? "", projectId ?? ""].join("|"))}`;
}

function getRunIntentKey(principalId: string | undefined, sessionId: string | undefined): string | undefined {
  return sessionId ? `${RUN_INTENT_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(sessionId)}` : undefined;
}

function getRunRecoveryKey(principalId: string | undefined, sessionId: string | undefined): string | undefined {
  return sessionId ? `${RUN_RECOVERY_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(sessionId)}` : undefined;
}

function getDraftKey(principalId: string | undefined, sessionId: string | undefined): string | undefined {
  return sessionId ? `${DRAFT_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(sessionId)}` : undefined;
}

function getDraftClientKey(principalId: string | undefined, sessionId: string | undefined): string | undefined {
  return sessionId ? `${DRAFT_CLIENT_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(sessionId)}` : undefined;
}

function getDraftSequenceKey(principalId: string | undefined, sessionId: string | undefined): string | undefined {
  return sessionId ? `${DRAFT_SEQUENCE_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(sessionId)}` : undefined;
}

function readStoredDraftClientId(principalId: string | undefined, sessionId: string | undefined): string {
  const storage = getSessionStorage();
  const key = getDraftClientKey(principalId, sessionId);
  if (storage && key) {
    try {
      const stored = storage.getItem(key);
      if (stored?.trim()) return stored;
      const created = createCommandId("draft-client");
      storage.setItem(key, created);
      return created;
    } catch {
      // Fall through to an in-memory identity when browser storage is unavailable.
    }
  }
  return createCommandId("draft-client");
}

function readStoredDraftSequence(principalId: string | undefined, sessionId: string): number | undefined {
  const storage = getSessionStorage();
  const key = getDraftSequenceKey(principalId, sessionId);
  if (!storage || !key) return undefined;
  try {
    const value = Number(storage.getItem(key));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredDraftSequence(principalId: string | undefined, sessionId: string, sequence: number): void {
  const storage = getSessionStorage();
  const key = getDraftSequenceKey(principalId, sessionId);
  if (!storage || !key) return;
  try {
    storage.setItem(key, String(sequence));
  } catch {
    // A failed sequence checkpoint is surfaced by the next server response; it must not widen access.
  }
}

function getControlIntentKey(principalId: string | undefined, sessionId: string | undefined, operationKey: string): string | undefined {
  return sessionId ? `${CONTROL_INTENT_PREFIX}${getIdentityScope(principalId)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(operationKey)}` : undefined;
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

function readDraft(key: string | undefined): string {
  const storage = getSessionStorage();
  if (!key || !storage) return "";
  try {
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string | undefined, draft: string): boolean {
  const storage = getSessionStorage();
  if (!key || !storage) return false;
  try {
    if (draft) storage.setItem(key, draft);
    else storage.removeItem(key);
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

function readControlIntent(key: string | undefined): ControlIntent | undefined {
  const storage = getSessionStorage();
  if (!key || !storage) return undefined;
  try {
    const value = storage.getItem(key);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<ControlIntent>;
    if (typeof parsed.commandId !== "string" || typeof parsed.uncertain !== "boolean") return undefined;
    return { commandId: parsed.commandId, uncertain: parsed.uncertain };
  } catch {
    return undefined;
  }
}

function writeControlIntent(key: string | undefined, intent: ControlIntent): boolean {
  const storage = getSessionStorage();
  if (!key || !storage) return false;
  try {
    storage.setItem(key, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

function controlIntentIsUncertain(principalId: string | undefined, sessionId: string | undefined, operationKey: string): boolean {
  return readControlIntent(getControlIntentKey(principalId, sessionId, operationKey))?.uncertain === true;
}

function uncertainApprovalDecision(principalId: string | undefined, sessionId: string, approval: Approval): ApprovalDecision | undefined {
  if (controlIntentIsUncertain(principalId, sessionId, `approval:${approval.id}:${approval.revision}:approve`)) return "approve";
  if (controlIntentIsUncertain(principalId, sessionId, `approval:${approval.id}:${approval.revision}:deny`)) return "deny";
  return undefined;
}

function isUnknownSessionCreationError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return true;
  const body = error.body && typeof error.body === "object" ? error.body as { code?: unknown } : undefined;
  return body?.code === "unknown_result" || error.status >= 500 || error.status === 408 || error.status === 504;
}

function isApiAccessFailure(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 403 || error.status === 404);
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
  principalId?: string;
  projectCanWrite?: (projectId: string) => boolean;
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

function sessionRunHistoryFailureMessage(reason: SessionRunHistoryReadReason | undefined): string {
  if (reason === "forbidden") return "当前账户无权读取此 Session 的 Run 历史；执行事实已清除，控制命令已暂停，请返回会话列表。";
  if (reason === "not_found") return "此 Session 的 Run 历史不存在或已不可访问；执行事实已清除，控制命令已暂停，请刷新后再试。";
  if (reason === "foreign_response") return "Run 历史响应未通过 Session 身份核对；执行事实已清除，控制命令已暂停，请刷新后再试。";
  return "读取 Session 的 Run 历史失败；执行控制已暂停，请刷新或人工对账。";
}

function draftFailureMessage(reason: DraftReadReason | undefined): string {
  if (reason === "forbidden" || reason === "not_found") return "当前账户无法读取这份私有草稿；本地草稿已清除，不会向无权身份展示。";
  if (reason === "conflict") return "草稿同步顺序已变化；已保留当前服务事实，请继续编辑后再同步。";
  return "私有草稿暂时无法同步；不会自动发送，恢复连接后再试。";
}

export function ProductionSessionCreationPanel({
  conversationTitle = "新建独立会话",
  existingActiveSupported = false,
  fixedProjectId,
  fixedProjectName,
  onCreate,
  principalId,
  projectCanWrite,
  projectOptions = [],
  readOnly = false,
  taskId
}: ProductionSessionCreationPanelProps) {
  const storageKey = getSessionCreationIntentKey(principalId, conversationTitle, taskId, fixedProjectId);
  const storedIntent = useMemo(() => readSessionCreationIntent(storageKey), [storageKey]);
  const [path, setPath] = useState<SessionPath>(() => storedIntent?.request.path ?? "new");
  const [activeThreadRef, setActiveThreadRef] = useState(() => storedIntent?.request.active_thread_ref ?? "");
  const [prompt, setPrompt] = useState(() => storedIntent?.request.prompt ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState(() => fixedProjectId ?? storedIntent?.request.project_id ?? NO_PROJECT);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [creationUncertain, setCreationUncertain] = useState(() => storedIntent?.uncertain ?? false);
  const commandRef = useRef<SessionCreationIntent | undefined>(storedIntent);
  const selectedProjectReadOnly = selectedProjectId !== NO_PROJECT && Boolean(projectCanWrite && !projectCanWrite(selectedProjectId));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || readOnly) return;
    if (selectedProjectReadOnly) {
      setFailure("当前所选项目为只读；请选择可写项目或独立会话后再创建 Session。");
      return;
    }
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
                {projectOptions.map((project) => <SelectItem key={project.id} value={project.id} disabled={Boolean(projectCanWrite && !projectCanWrite(project.id))}>{project.name}{projectCanWrite && !projectCanWrite(project.id) ? "（只读）" : ""}</SelectItem>)}
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
        {selectedProjectReadOnly ? <div className="rounded-[var(--radius-sm)] bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" role="status">当前所选项目为只读；项目内 Session 创建已禁用，独立会话仍可创建。</div> : null}
        {failure ? <div className="rounded-[var(--radius-sm)] bg-[var(--danger-bg)] p-3 text-xs leading-5 text-[var(--danger)]" role="alert">{failure}</div> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
          <span className="text-[11px] leading-5 text-[var(--muted)]">不会自动发送草稿；创建请求只提交一次 command_id。</span>
          <Button type="submit" disabled={pending || readOnly || selectedProjectReadOnly || (path === "existing_active" && !existingActiveSupported)}>
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
  principalId?: string;
  projectCanWrite?: (projectId: string) => boolean;
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
  principalId,
  projectCanWrite,
  projectId,
  projectName,
  projectOptions = [],
  readOnly = false,
  sessionId,
  task
}: ProductionConversationWorkspaceProps) {
  const draftClientId = useMemo(() => sessionId ? readStoredDraftClientId(principalId, sessionId) : undefined, [principalId, sessionId]);
  const adapters = useMemo(() => api ? {
    approval: new ApprovalClientAdapter(api),
    draft: new DraftClientAdapter(api, {
      clientId: draftClientId ?? "loomhelm-draft-anonymous",
      readSequence: (currentSessionId) => readStoredDraftSequence(principalId, currentSessionId),
      writeSequence: (currentSessionId, sequence) => writeStoredDraftSequence(principalId, currentSessionId, sequence)
    }),
    history: new SessionRunHistoryClientAdapter(api),
    run: new RunClientAdapter(api),
    session: new SessionClientAdapter(api)
  } : undefined, [api, draftClientId, principalId]);
  const runIntentKey = getRunIntentKey(principalId, sessionId);
  const storedRunIntent = useMemo(() => readRunIntent(runIntentKey), [runIntentKey]);
  const draftKey = getDraftKey(principalId, sessionId);
  const [session, setSession] = useState<Session | undefined>();
  const [sessionLoading, setSessionLoading] = useState(Boolean(sessionId));
  const [sessionFailure, setSessionFailure] = useState<string | null>(null);
  const [sessionRunHistoryLoading, setSessionRunHistoryLoading] = useState(Boolean(sessionId));
  const [sessionRunHistoryFailure, setSessionRunHistoryFailure] = useState<string | null>(null);
  const [sessionRunHistory, setSessionRunHistory] = useState<readonly Run[]>([]);
  const [run, setRun] = useState<Run | undefined>();
  const [commandState, setCommandState] = useState<CommandState | undefined>();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [approvalHistoryAvailable, setApprovalHistoryAvailable] = useState(false);
  const [runIdentityVerified, setRunIdentityVerified] = useState(false);
  const [sessionReadUncertain, setSessionReadUncertain] = useState(false);
  const [sessionAccessBlocked, setSessionAccessBlocked] = useState(false);
  const [sessionAccessFailure, setSessionAccessFailure] = useState<string | null>(null);
  const [runReadUncertain, setRunReadUncertain] = useState(false);
  const [runReadFailure, setRunReadFailure] = useState<string | null>(null);
  const [approvalReadUncertain, setApprovalReadUncertain] = useState(false);
  const [approvalReadFailure, setApprovalReadFailure] = useState<string | null>(null);
  const [draftReadUncertain, setDraftReadUncertain] = useState(false);
  const [draftAccessBlocked, setDraftAccessBlocked] = useState(false);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);
  const [, setControlIntentRevision] = useState(0);
  const [draft, setDraft] = useState(() => storedRunIntent?.prompt ?? readDraft(draftKey));
  const [activityNotice, setActivityNotice] = useState<string | null>(() => storedRunIntent?.uncertain ? "上一次 Run 命令结果不确定；请先完成对账，不会自动重复提交。" : null);
  const [uncertainRunCommandId, setUncertainRunCommandId] = useState<string | undefined>(() => storedRunIntent?.uncertain ? storedRunIntent.commandId : undefined);
  const draftRef = useRef(draft);
  const seenEventIds = useRef(new Set<string>());
  const approvalCommandIds = useRef(new Map<string, string>());
  const pendingRunSubmission = useRef<{ commandId: string; prompt: string } | undefined>(storedRunIntent ? { commandId: storedRunIntent.commandId, prompt: storedRunIntent.prompt } : undefined);
  const currentSessionIdRef = useRef<string | undefined>(sessionId);
  const routeVersionRef = useRef(0);
  const mountedRef = useRef(false);
  const previousSessionId = useRef<string | undefined>(undefined);
  const previousRunId = useRef<string | undefined>(initialRunId);
  const lastAppliedRunSequence = useRef(0);
  const hasPreviousSessionId = useRef(false);
  const selectedRunIdRef = useRef<string | undefined>(initialRunId ?? readRunRecoveryId(getRunRecoveryKey(principalId, sessionId)));
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const draftRevisionRef = useRef(0);
  const draftDirtyRef = useRef(false);
  const pendingDraftValueRef = useRef<string | undefined>(undefined);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftSavePromiseRef = useRef<Promise<void> | undefined>(undefined);
  const draftAccessBlockedRef = useRef(false);
  const draftInputSinceReadRef = useRef(false);

  const sessionForRoute = session && (sessionId === undefined || session.id === sessionId) ? session : undefined;
  const activeSessionId = sessionForRoute?.id ?? sessionId;
  const activeRun = run && run.session_id === activeSessionId ? run : undefined;
  const activeRunId = activeRun?.id;
  const connection: ConnectionAvailability = sessionForRoute ? connectionFromSessionState(sessionForRoute.state) : "online";
  const sessionProjectReadOnly = Boolean(sessionForRoute?.project_id && projectCanWrite && !projectCanWrite(sessionForRoute.project_id));
  const effectiveReadOnly = readOnly || sessionProjectReadOnly;
  const sessionRunHistoryBlocked = sessionRunHistoryLoading || Boolean(sessionRunHistoryFailure);
  const effectiveCommandState = sessionReadUncertain || sessionAccessBlocked || sessionRunHistoryBlocked || runReadUncertain || approvalReadUncertain ? "unknown" : commandState;
  const readFailure = sessionAccessBlocked
    ? sessionAccessFailure
    : sessionReadUncertain
      ? sessionFailure
      : sessionRunHistoryFailure
        ? sessionRunHistoryFailure
      : runReadUncertain
        ? runReadFailure
        : approvalReadUncertain
          ? approvalReadFailure
          : null;
  const connectionRef = useRef<ConnectionAvailability>(connection);
  const currentConversationTitle = conversationTitle ?? task?.title ?? "独立会话";
  const taskSummary = mapTaskSummary(task);
  const context = sessionForRoute ? toSessionContextModel(sessionForRoute, { conversationTitle: currentConversationTitle, projectName, task: taskSummary }) : undefined;
  const activeApprovals = runIdentityVerified && activeRunId ? approvals.filter((approval) => approval.run_id === activeRunId) : [];
  const approvalHistoryBlocked = Boolean(activeRunId && !approvalHistoryAvailable);
  const runRouteUnverified = Boolean(initialRunId && (!activeRun || !runIdentityVerified));
  const selectedHistoryRunId = activeRunId && sessionRunHistory.some((historyRun) => historyRun.id === activeRunId) ? activeRunId : undefined;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    draftAccessBlockedRef.current = draftAccessBlocked;
  }, [draftAccessBlocked]);

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
    lastAppliedRunSequence.current = 0;
    setMessages([]);
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setSessionReadUncertain(false);
    setSessionAccessBlocked(false);
    setSessionAccessFailure(null);
    setSessionRunHistoryLoading(Boolean(sessionId));
    setSessionRunHistoryFailure(null);
    setSessionRunHistory([]);
    setRunReadUncertain(false);
    setRunReadFailure(null);
    setApprovalReadUncertain(false);
    setApprovalReadFailure(null);
    setDraftReadUncertain(false);
    setDraftAccessBlocked(false);
    draftAccessBlockedRef.current = false;
    setDraftFailure(null);
    setRun(undefined);
    setCommandState(undefined);
    setActivityNotice(null);
    setSession(undefined);
    setSessionFailure(null);
    setSessionLoading(Boolean(sessionId));
    const nextRunIntent = readRunIntent(getRunIntentKey(principalId, sessionId));
    pendingRunSubmission.current = nextRunIntent ? { commandId: nextRunIntent.commandId, prompt: nextRunIntent.prompt } : undefined;
    selectedRunIdRef.current = initialRunId ?? readRunRecoveryId(getRunRecoveryKey(principalId, sessionId));
    draftRevisionRef.current = 0;
    draftDirtyRef.current = false;
    draftInputSinceReadRef.current = false;
    pendingDraftValueRef.current = undefined;
    if (draftSaveTimerRef.current !== undefined) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = undefined;
    draftSavePromiseRef.current = undefined;
    setDraft(nextRunIntent?.prompt ?? readDraft(getDraftKey(principalId, sessionId)));
    setUncertainRunCommandId(nextRunIntent?.uncertain ? nextRunIntent.commandId : undefined);
  }, [principalId, sessionId]);

  useLayoutEffect(() => {
    routeVersionRef.current += 1;
    if (previousRunId.current === initialRunId) return;
    previousRunId.current = initialRunId;
    selectedRunIdRef.current = initialRunId ?? readRunRecoveryId(getRunRecoveryKey(principalId, sessionId));
    lastAppliedRunSequence.current = 0;
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setSessionReadUncertain(false);
    setSessionAccessBlocked(false);
    setSessionAccessFailure(null);
    setSessionRunHistoryLoading(Boolean(sessionId));
    setSessionRunHistoryFailure(null);
    setSessionRunHistory([]);
    setRunReadUncertain(false);
    setRunReadFailure(null);
    setApprovalReadUncertain(false);
    setApprovalReadFailure(null);
    setDraftReadUncertain(false);
    setDraftAccessBlocked(false);
    draftAccessBlockedRef.current = false;
    setDraftFailure(null);
    setRun(undefined);
    setCommandState(undefined);
    const nextRunIntent = readRunIntent(getRunIntentKey(principalId, sessionId));
    pendingRunSubmission.current = nextRunIntent ? { commandId: nextRunIntent.commandId, prompt: nextRunIntent.prompt } : undefined;
    selectedRunIdRef.current = initialRunId ?? readRunRecoveryId(getRunRecoveryKey(principalId, sessionId));
    setUncertainRunCommandId(nextRunIntent?.uncertain ? nextRunIntent.commandId : undefined);
    setActivityNotice(nextRunIntent?.uncertain ? "上一次 Run 命令结果不确定；请先完成对账，不会自动重复提交。" : null);
  }, [initialRunId, principalId, sessionId]);

  useEffect(() => {
    if (!api || !adapters || !sessionId) {
      setSessionLoading(false);
      setSessionRunHistoryLoading(false);
      if (!sessionId || !api) setSession(undefined);
      if (sessionId && !api) setSessionFailure("当前浏览器没有可用的会话服务。");
      return;
    }
    adapters.session.selectSession(sessionId);
    adapters.history.selectSession(sessionId);
    adapters.draft.selectSession(sessionId);
    adapters.run.selectSession(sessionId);
    adapters.approval.selectSession(sessionId);
    let active = true;
    setSession(undefined);
    setSessionRunHistoryLoading(true);
    setSessionRunHistoryFailure(null);
    setSessionRunHistory([]);
    setRun(undefined);
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setSessionReadUncertain(false);
    setSessionAccessBlocked(false);
    setSessionAccessFailure(null);
    setRunReadUncertain(false);
    setRunReadFailure(null);
    setApprovalReadUncertain(false);
    setApprovalReadFailure(null);
    setDraftReadUncertain(false);
    setDraftAccessBlocked(false);
    draftAccessBlockedRef.current = false;
    setDraftFailure(null);
    draftRevisionRef.current = 0;
    draftDirtyRef.current = false;
    draftInputSinceReadRef.current = false;
    pendingDraftValueRef.current = undefined;
    selectedRunIdRef.current = initialRunId ?? readRunRecoveryId(getRunRecoveryKey(principalId, sessionId));
    lastAppliedRunSequence.current = 0;
    setSessionLoading(true);
    setSessionFailure(null);
    void adapters.session.readSession(sessionId).then((result) => {
      if (!active) return;
      if (result.state === "received" && result.session) {
        setSession(result.session);
        const recoveredRunId = initialRunId ?? readRunRecoveryId(getRunRecoveryKey(principalId, sessionId));
        if (recoveredRunId) setRun(runFromRecoveredIdentity(result.session, recoveredRunId));
      } else {
        setSession(undefined);
        const failureMessage = sessionReadFailureMessage(result.reason);
        if (isSessionAccessFailure(result.reason)) {
          setSessionAccessBlocked(true);
          setSessionAccessFailure(failureMessage);
        }
        setSessionFailure(failureMessage);
      }
      setSessionLoading(false);
    });
    return () => {
      active = false;
    };
  }, [adapters, api, initialRunId, principalId, sessionId]);

  useEffect(() => {
    if (!api || !adapters || !sessionForRoute) return;
    const loadedSession = sessionForRoute;
    const loadedSessionId = loadedSession.id;
    adapters.history.selectSession(loadedSessionId);
    let active = true;
    const refreshRunHistory = async () => {
      const result = await adapters.history.readRuns(loadedSessionId);
      if (!active || result.state === "pending") return;
      if (result.state === "received" && result.runs) {
        setSessionRunHistoryLoading(false);
        setSessionRunHistoryFailure(null);
        setSessionRunHistory(result.runs);
        const preferredRunId = selectedRunIdRef.current ?? activeRunIdRef.current;
        const selected = (preferredRunId ? result.runs.find((candidate) => candidate.id === preferredRunId) : undefined) ?? (!preferredRunId ? result.runs.at(-1) : undefined);
        if (selected) {
          selectedRunIdRef.current = selected.id;
          if (activeRunIdRef.current !== selected.id) {
            seenEventIds.current = new Set();
            approvalCommandIds.current = new Map();
            lastAppliedRunSequence.current = 0;
            setRun(runFromHistory(loadedSession, selected));
            setMessages([]);
            setApprovals([]);
            setApprovalHistoryAvailable(false);
            setRunIdentityVerified(false);
            setRunReadUncertain(false);
            setRunReadFailure(null);
            setApprovalReadUncertain(false);
            setApprovalReadFailure(null);
            setCommandState(undefined);
          }
        } else if (!activeRunIdRef.current) {
          setRun(undefined);
          setMessages([]);
          setApprovals([]);
          setApprovalHistoryAvailable(false);
          setRunIdentityVerified(false);
          setCommandState(undefined);
        }
        return;
      }

      setSessionRunHistoryLoading(false);
      setSessionRunHistoryFailure(sessionRunHistoryFailureMessage(result.reason));
      setSessionRunHistory([]);
      setRun(undefined);
      setMessages([]);
      setApprovals([]);
      setApprovalHistoryAvailable(false);
      setRunIdentityVerified(false);
      setRunReadUncertain(false);
      setRunReadFailure(null);
      setApprovalReadUncertain(false);
      setApprovalReadFailure(null);
      setCommandState(undefined);
      setActivityNotice(null);
    };

    void refreshRunHistory();
    const interval = setInterval(() => void refreshRunHistory(), 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [adapters, api, initialRunId, sessionForRoute?.id]);

  const persistDraftValue = (sessionIdForDraft: string, value: string): Promise<void> => {
    pendingDraftValueRef.current = value;
    const existing = draftSavePromiseRef.current;
    if (existing) return existing;
    const operation = (async () => {
      while (pendingDraftValueRef.current !== undefined) {
        const nextValue = pendingDraftValueRef.current;
        pendingDraftValueRef.current = undefined;
        if (!adapters || currentSessionIdRef.current !== sessionIdForDraft) return;
        const result = await adapters.draft.updateDraft(sessionIdForDraft, nextValue);
        if (currentSessionIdRef.current !== sessionIdForDraft) return;
        if (result.state === "received" && result.draft) {
          draftRevisionRef.current = result.draft.revision;
          setDraftReadUncertain(false);
          setDraftAccessBlocked(false);
          draftAccessBlockedRef.current = false;
          setDraftFailure(null);
          if (draftRef.current === nextValue) {
            draftDirtyRef.current = false;
            draftInputSinceReadRef.current = false;
            writeDraft(draftKey, nextValue);
          }
          continue;
        }
        if (result.reason === "forbidden" || result.reason === "not_found") {
          const preserveFreshInput = draftInputSinceReadRef.current;
          draftDirtyRef.current = false;
          pendingDraftValueRef.current = undefined;
          if (!preserveFreshInput) {
            draftRef.current = "";
            setDraft("");
            writeDraft(draftKey, "");
          }
          setDraftReadUncertain(false);
          setDraftAccessBlocked(true);
          draftAccessBlockedRef.current = true;
          setDraftFailure(draftFailureMessage(result.reason));
          return;
        }
        draftDirtyRef.current = true;
        setDraftReadUncertain(true);
        setDraftFailure(draftFailureMessage(result.reason));
        return;
      }
    })().finally(() => {
      draftSavePromiseRef.current = undefined;
    });
    draftSavePromiseRef.current = operation;
    return operation;
  };

  const scheduleDraftPersistence = (sessionIdForDraft: string, value: string): void => {
    pendingDraftValueRef.current = value;
    if (draftSaveTimerRef.current !== undefined) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = undefined;
      void persistDraftValue(sessionIdForDraft, value);
    }, 300);
  };

  useEffect(() => {
    if (!api || !adapters || !sessionForRoute) return;
    const loadedSessionId = sessionForRoute.id;
    adapters.draft.selectSession(loadedSessionId);
    draftInputSinceReadRef.current = false;
    let active = true;
    const refreshDraft = async () => {
      const result = await adapters.draft.readDraft(loadedSessionId);
      if (!active || result.state === "pending") return;
      if (result.state === "received" && result.draft) {
        if (result.draft.revision < draftRevisionRef.current) return;
        draftRevisionRef.current = result.draft.revision;
        setDraftReadUncertain(false);
        setDraftAccessBlocked(false);
        draftAccessBlockedRef.current = false;
        setDraftFailure(null);
        const localDraft = readDraft(draftKey);
        if (draftInputSinceReadRef.current && draftRef.current !== result.draft.content) {
          draftDirtyRef.current = true;
          scheduleDraftPersistence(loadedSessionId, draftRef.current);
          return;
        }
        if (draftDirtyRef.current) {
          if (draftRef.current === result.draft.content) {
            draftDirtyRef.current = false;
            draftInputSinceReadRef.current = false;
            writeDraft(draftKey, result.draft.content);
          } else {
            scheduleDraftPersistence(loadedSessionId, draftRef.current);
          }
        } else if (result.draft.revision === 0 && result.draft.content === "" && localDraft) {
          draftRef.current = localDraft;
          draftDirtyRef.current = true;
          setDraft(localDraft);
          scheduleDraftPersistence(loadedSessionId, localDraft);
        } else {
          draftRef.current = result.draft.content;
          setDraft(result.draft.content);
          draftDirtyRef.current = false;
          draftInputSinceReadRef.current = false;
          writeDraft(draftKey, result.draft.content);
        }
        return;
      }
      if (result.reason === "forbidden" || result.reason === "not_found") {
        const preserveFreshInput = draftInputSinceReadRef.current;
        draftDirtyRef.current = false;
        pendingDraftValueRef.current = undefined;
        if (draftSaveTimerRef.current !== undefined) clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = undefined;
        if (!preserveFreshInput) {
          draftRef.current = "";
          setDraft("");
          writeDraft(draftKey, "");
        }
        setDraftReadUncertain(false);
        setDraftAccessBlocked(true);
        draftAccessBlockedRef.current = true;
        setDraftFailure(draftFailureMessage(result.reason));
        return;
      }
      setDraftReadUncertain(true);
      setDraftFailure(draftFailureMessage(result.reason));
    };
    void refreshDraft();
    const interval = setInterval(() => void refreshDraft(), 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [adapters, api, draftKey, sessionForRoute?.id]);

  useEffect(() => {
    if (!api || !adapters || !activeSessionId) return;
    let active = true;
    const refreshSession = async () => {
      const result = await adapters.session.readSession(activeSessionId);
      if (!active) return;
      if (result.state === "received" && result.session) {
        setSession(result.session);
        setSessionFailure(null);
        setSessionReadUncertain(false);
        setSessionAccessBlocked(false);
        setSessionAccessFailure(null);
        return;
      }
      if (result.state === "pending") return;
      if (isSessionAccessFailure(result.reason)) {
        seenEventIds.current = new Set();
        approvalCommandIds.current = new Map();
        lastAppliedRunSequence.current = 0;
        setSession(undefined);
        setMessages([]);
        setApprovals([]);
        setApprovalHistoryAvailable(false);
        setRunIdentityVerified(false);
        setSessionReadUncertain(false);
        setSessionAccessBlocked(true);
        setSessionAccessFailure(sessionReadFailureMessage(result.reason));
        if (activeRunId) {
          setRunReadUncertain(true);
          setRunReadFailure("当前 Run 状态无法核对；控制命令已暂停，请刷新或人工对账。");
          setRun((current) => current ? { ...current, status: "unknown" } : current);
        } else {
          setRunReadUncertain(false);
          setRunReadFailure(null);
          setRun(undefined);
        }
        setApprovalReadUncertain(false);
        setApprovalReadFailure(null);
        setCommandState(undefined);
        setActivityNotice(null);
        setSessionFailure(sessionReadFailureMessage(result.reason));
        return;
      }
      setSessionReadUncertain(true);
      setSessionFailure(sessionReadFailureMessage(result.reason, true));
    };
    const interval = setInterval(() => void refreshSession(), 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activeRunId, activeSessionId, adapters, api]);

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
          const observedEvents = events.stream?.events.length ? events.stream.events : events.page.events;
          const identityVerifiedByEvents = observedEvents.length > 0;
          if (identityVerifiedByEvents) setRunIdentityVerified(true);
          const freshEvents = observedEvents.filter((event) => {
            const eventKey = `${activeRunId}:${event.event_id}`;
            if (seenEventIds.current.has(eventKey)) return false;
            seenEventIds.current.add(eventKey);
            return true;
          }).sort((left, right) => left.sequence - right.sequence);
          if (freshEvents.length > 0) {
            setMessages((current) => {
              const next = [...current, ...freshEvents.map(eventToConversationMessage)];
              return next.sort((left, right) => {
                if (left.sequence === undefined || right.sequence === undefined) return 0;
                return left.sequence - right.sequence;
              });
            });
          }
          const stateEvents = observedEvents.filter((event) => event.sequence > lastAppliedRunSequence.current).sort((left, right) => left.sequence - right.sequence);
          if (stateEvents.length > 0) {
            setRun((current) => current ? stateEvents.reduce(applyRunEvent, current) : current);
            lastAppliedRunSequence.current = Math.max(lastAppliedRunSequence.current, ...stateEvents.map((event) => event.sequence));
          }
          if (!runIdentityVerified && !identityVerifiedByEvents) {
            setApprovals([]);
            setApprovalHistoryAvailable(false);
            return;
          }
        } else if (events.state === "pending") {
          return;
        } else if (events.state === "unknown" && isSessionAccessFailure(events.reason)) {
          seenEventIds.current = new Set();
          approvalCommandIds.current = new Map();
          lastAppliedRunSequence.current = 0;
          setMessages([]);
          setApprovals([]);
          setApprovalHistoryAvailable(false);
          setRunIdentityVerified(false);
          setRunReadUncertain(true);
          setApprovalReadUncertain(true);
          setRun((current) => current ? { ...current, status: "unknown" } : current);
          setCommandState(undefined);
          setActivityNotice(null);
          setRunReadFailure(events.reason === "forbidden"
            ? "当前账户无权读取该 Run 的事件；当前会话消息已清除，控制命令已暂停，请返回会话列表。"
            : "该 Run 不存在或已不可访问；当前会话消息已清除，控制命令已暂停，请刷新后再试。");
          return;
        } else if (events.state === "unknown" && events.reason !== "pending") {
          setRunReadUncertain(true);
          setApprovalReadUncertain(true);
          setRunReadFailure("事件读取结果不确定；已保留当前事实，控制命令已暂停，请刷新或手动对账。");
          setActivityNotice(null);
          setApprovals([]);
          setApprovalHistoryAvailable(false);
          return;
        }

        try {
          const responseApprovals = await readAllApprovalPages(api, activeRunId, () => active);
          if (!active) return;
          const approvalItems = responseApprovals.filter((approval) => approval.run_id === activeRunId);
          if (approvalItems.length !== responseApprovals.length) {
            setApprovals([]);
            setApprovalHistoryAvailable(false);
            setApprovalReadUncertain(true);
            setApprovalReadFailure("审批响应包含其他 Run 的记录；审批历史未完成身份核对，控制命令已暂停。");
            setActivityNotice(null);
            return;
          }
          setApprovals((current) => mergeApprovals(current, approvalItems));
          setApprovalHistoryAvailable(true);
          setRunReadUncertain(false);
          setRunReadFailure(null);
          setApprovalReadUncertain(false);
          setApprovalReadFailure(null);
        } catch (error) {
          if (active) {
            setApprovalHistoryAvailable(false);
            if (isApiAccessFailure(error)) {
              seenEventIds.current = new Set();
              approvalCommandIds.current = new Map();
              lastAppliedRunSequence.current = 0;
              setMessages([]);
              setApprovals([]);
              setRunIdentityVerified(false);
              setRunReadUncertain(true);
              setApprovalReadUncertain(true);
              setRun((current) => current ? { ...current, status: "unknown" } : current);
              setCommandState(undefined);
              setActivityNotice(null);
              const accessMessage = error instanceof ApiClientError && error.status === 403
                ? "当前账户无权读取该 Run 的审批历史；当前会话消息已清除，控制命令已暂停，请返回会话列表。"
                : "该 Run 的审批历史不存在或已不可访问；当前会话消息已清除，控制命令已暂停，请刷新后再试。";
              setRunReadFailure(accessMessage);
              setApprovalReadFailure(accessMessage);
            } else {
              setActivityNotice("审批历史暂时无法读取；当前已展示的审批事实保持不变，审批控制已禁用。");
            }
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
  }, [activeRunId, activeSessionId, adapters, api, runIdentityVerified]);

  const createSession = async (request: CreateSessionRequest) => {
    if (!api || !adapters) throw new Error("当前浏览器没有可用的会话服务");
    const response = await api.createSession({ body: request });
    const initialAck = response.initial_run_ack;
    const initialPrompt = request.prompt?.trim() ?? "";
    const expectedInitialCommandId = initialRunCommandId(response.session.id);
    const initialAckMatchesExpectedCommand = Boolean(initialAck && initialAck.command_id === expectedInitialCommandId);
    const initialRunId = initialAckMatchesExpectedCommand && typeof initialAck?.run_id === "string" && initialAck.run_id.trim() ? initialAck.run_id.trim() : undefined;
    if (initialRunId && !writeRunRecoveryId(getRunRecoveryKey(principalId, response.session.id), initialRunId)) {
      throw new Error("Session 已收到但首个 Run 恢复身份无法持久化；请恢复浏览器存储后用同一创建命令对账。");
    }
    const initialRunUncertain = Boolean(
      (initialAck && (!initialAckMatchesExpectedCommand || initialAck.state === "unknown" || !initialRunId))
      || (initialPrompt && !initialAck)
    );
    if (initialRunUncertain && !writeRunIntent(getRunIntentKey(principalId, response.session.id), { commandId: expectedInitialCommandId, prompt: initialPrompt, uncertain: true })) {
      throw new Error("Session 已收到但首个 Run 命令身份无法持久化；请恢复浏览器存储后用同一创建命令对账。");
    }
    if (!mountedRef.current) {
      throw new Error("Session 已创建但工作区已卸载；已保留同一创建命令，请重新进入后完成对账。");
    }
    adapters.session.selectSession(response.session.id);
    adapters.run.selectSession(response.session.id);
    adapters.approval.selectSession(response.session.id);
    adapters.history.selectSession(response.session.id);
    adapters.draft.selectSession(response.session.id);
    selectedRunIdRef.current = initialRunId;
    setSession(response.session);
    setSessionFailure(null);
    setSessionRunHistoryLoading(true);
    setSessionRunHistoryFailure(null);
    setSessionRunHistory([]);
    setSessionAccessBlocked(false);
    setSessionAccessFailure(null);
    setRunReadUncertain(false);
    setRunReadFailure(null);
    setApprovalReadUncertain(false);
    setApprovalReadFailure(null);
    setDraftReadUncertain(false);
    setDraftAccessBlocked(false);
    draftAccessBlockedRef.current = false;
    setDraftFailure(null);
    draftRevisionRef.current = 0;
    draftDirtyRef.current = false;
    draftInputSinceReadRef.current = false;
    pendingDraftValueRef.current = undefined;
    if (initialAck) {
      setCommandState(initialRunUncertain ? "unknown" : initialAck.state);
      const initialRun = initialAckMatchesExpectedCommand ? runFromCommandAck(response.session, initialAck) : undefined;
      setRun(initialRun);
      setRunIdentityVerified(false);
      setUncertainRunCommandId(initialRunUncertain ? expectedInitialCommandId : undefined);
      pendingRunSubmission.current = initialRunUncertain ? { commandId: expectedInitialCommandId, prompt: initialPrompt } : undefined;
      setActivityNotice(initialRunUncertain ? "首条 Run 结果不确定；已保留同一命令身份，请先完成对账。" : initialRunId ? "首条提示已收到命令确认，等待实际 Run 事件。" : "Session 已创建；首条提示已提交，但服务尚未返回 Run ID。");
      if (!initialRunUncertain) clearStoredIntent(getRunIntentKey(principalId, response.session.id));
    } else if (initialPrompt) {
      setCommandState("unknown");
      setRun(undefined);
      setRunIdentityVerified(false);
      setUncertainRunCommandId(expectedInitialCommandId);
      pendingRunSubmission.current = { commandId: expectedInitialCommandId, prompt: initialPrompt };
      setActivityNotice("首条提示已随 Session 提交，但服务没有返回 Run 命令确认；已保留同一命令身份，请先对账。");
    } else {
      setCommandState(undefined);
      setRun(undefined);
      setRunIdentityVerified(false);
      setUncertainRunCommandId(undefined);
      pendingRunSubmission.current = undefined;
      setActivityNotice("Session 已创建；当前没有首条 Run 命令确认。");
    }
    await onSessionCreated?.(response.session.id, initialRunId);
  };

  const send = async (prompt: string) => {
    if (!api || !adapters || !sessionForRoute) throw new Error("Session 尚未就绪");
    if (!canSendControl(connection, effectiveReadOnly) || sessionForRoute.state !== "active") throw new Error("当前 Session 不允许发送控制命令");
    if (runRouteUnverified || sessionReadUncertain || sessionAccessBlocked || sessionRunHistoryBlocked || runReadUncertain || approvalReadUncertain || approvalHistoryBlocked || activeRun?.status === "unknown" || effectiveCommandState === "unknown") {
      setActivityNotice("当前 Run 结果不确定；请先完成对账，不能在未确认的执行上继续发送或授权。");
      return;
    }
    if (uncertainRunCommandId) {
      setActivityNotice("上一次 Run 结果不确定；请刷新或手动对账后再发送新的控制命令。");
      return;
    }
    const sessionIdForSubmit = sessionForRoute.id;
    const routeVersion = routeVersionRef.current;
    const intentKey = getRunIntentKey(principalId, sessionIdForSubmit);
    const commandId = pendingRunSubmission.current?.prompt === prompt ? pendingRunSubmission.current.commandId : createCommandId("run");
    if (!writeRunIntent(intentKey, { commandId, prompt, uncertain: true })) {
      setActivityNotice("当前浏览器无法持久化 Run 命令身份；为避免未知结果下重复执行，请先恢复存储后再发送。");
      return;
    }
    pendingRunSubmission.current = { commandId, prompt };
    const result = await adapters.run.submitRun(sessionIdForSubmit, { command_id: commandId, prompt }, { connection, readOnly: effectiveReadOnly });
    const routeChanged = !mountedRef.current || currentSessionIdRef.current !== sessionIdForSubmit || routeVersionRef.current !== routeVersion;
    if (routeChanged) {
      const currentIntent = readRunIntent(intentKey);
      if (!currentIntent || currentIntent.commandId === commandId) {
        if (result.state === "failed") {
          pendingRunSubmission.current = undefined;
          clearStoredIntent(intentKey);
        } else {
          const recoveryKey = getRunRecoveryKey(principalId, sessionIdForSubmit);
          const storedRecoveryId = readRunRecoveryId(recoveryKey);
          if (result.ack?.run_id && (!storedRecoveryId || storedRecoveryId === result.ack.run_id)) writeRunRecoveryId(recoveryKey, result.ack.run_id);
          writeRunIntent(intentKey, { commandId, prompt, uncertain: true });
        }
      }
      return;
    }
    if (result.state === "unknown") {
      const acknowledgedRun = result.ack ? runFromCommandAck(sessionForRoute, result.ack) : undefined;
      const recoveryPersisted = acknowledgedRun ? writeRunRecoveryId(getRunRecoveryKey(principalId, sessionIdForSubmit), acknowledgedRun.id) : false;
      if (acknowledgedRun) {
        setRun(acknowledgedRun);
        setRunIdentityVerified(false);
      }
      setUncertainRunCommandId(commandId);
      writeRunIntent(intentKey, { commandId, prompt, uncertain: true });
      setActivityNotice(acknowledgedRun && !recoveryPersisted ? "发送结果不确定，且 Run 恢复身份无法持久化；已暂停控制，请恢复浏览器存储后再对账。" : "发送结果不确定；请刷新或手动对账后再决定是否继续。相同意图不会自动重复提交。");
      if (acknowledgedRun && recoveryPersisted) void onRunCreated?.(sessionIdForSubmit, acknowledgedRun.id);
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
    const recoveryPersisted = nextRun ? writeRunRecoveryId(getRunRecoveryKey(principalId, sessionIdForSubmit), nextRun.id) : false;
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
        selectedRunIdRef.current = nextRun.id;
        if (previousRunId && previousRunId !== nextRun.id) {
          seenEventIds.current = new Set();
          approvalCommandIds.current = new Map();
          lastAppliedRunSequence.current = 0;
          setMessages([]);
          setApprovals([]);
          setApprovalHistoryAvailable(false);
          setRunReadUncertain(false);
          setRunReadFailure(null);
          setApprovalReadUncertain(false);
          setApprovalReadFailure(null);
        }
        setCommandState(result.ack.state);
        setRun(nextRun);
        setRunIdentityVerified(false);
      }
      setActivityNotice(commandReconciled ? "Run 命令已收到，等待实际事件。" : "命令已收到，但 Run 恢复身份未确认；请先对账，不会自动重复提交。");
    }
    if (commandReconciled) {
      setUncertainRunCommandId(undefined);
      if (draftRef.current.trim() === prompt) {
        if (draftAccessBlockedRef.current) {
          draftRef.current = "";
          setDraft("");
          draftInputSinceReadRef.current = false;
          writeDraft(draftKey, "");
          setActivityNotice("Run 命令已收到；当前账户没有可同步的私有草稿，已清除本地输入，不会自动再次发送。");
        } else {
          setActivityNotice("Run 命令已收到；已发送内容暂保持为私有草稿，等待 revision-aware consume 接线，不会自动再次发送。");
        }
      }
      if (nextRun) void onRunCreated?.(sessionIdForSubmit, nextRun.id);
    }
  };

  const resolveApproval = async (params: ResolveApprovalParams) => {
    if (!api || !adapters || !sessionForRoute) throw new Error("Session 尚未就绪");
    if (!approvalHistoryAvailable) throw new Error("审批历史尚未通过当前 Run 核对，请刷新后再确认");
    if (runRouteUnverified || !runIdentityVerified || sessionReadUncertain || sessionAccessBlocked || sessionRunHistoryBlocked || runReadUncertain || approvalReadUncertain || approvalHistoryBlocked || uncertainRunCommandId || activeRun?.status === "unknown" || effectiveCommandState === "unknown") throw new Error("当前 Run 身份或结果未完成核对，不能继续提交审批控制命令");
    if (sessionForRoute.state !== "active" || !canSendControl(connection, effectiveReadOnly)) throw new Error("当前 Session 不允许提交审批控制命令");
    const approval = activeApprovals.find((item) => item.id === params.approval_id && item.revision === params.body.revision);
    if (!approval) throw new Error("审批修订已变化，请刷新后重新确认");
    const latestRevision = activeApprovals.filter((item) => item.id === approval.id).reduce((latest, item) => Math.max(latest, item.revision), 0);
    if (approval.revision !== latestRevision) throw new Error("审批修订已过期，请刷新后重新确认");
    const operationKey = `approval:${approval.id}:${approval.revision}:${params.body.decision}`;
    const controlIntentKey = getControlIntentKey(principalId, sessionForRoute.id, operationKey);
    const storedControlIntent = readControlIntent(controlIntentKey);
    if (storedControlIntent?.uncertain) throw new Error("审批命令结果未完成对账；请先确认服务事实，不会自动重复提交");
    if (storedControlIntent && storedControlIntent.commandId !== params.body.command_id) throw new Error("审批命令身份已变化，请刷新后重新核对");
    if (!writeControlIntent(controlIntentKey, { commandId: params.body.command_id, uncertain: true })) throw new Error("当前浏览器无法持久化审批命令身份；为避免未知结果下重复授权，请先恢复存储后再试");
    const sessionIdForApproval = sessionForRoute.id;
    const routeVersion = routeVersionRef.current;
    const result = await adapters.approval.resolve({
      approval,
      commandId: params.body.command_id,
      decision: params.body.decision,
      sessionId: sessionIdForApproval
    }, { connection, readOnly: effectiveReadOnly });
    const routeChanged = !mountedRef.current || currentSessionIdRef.current !== sessionIdForApproval || routeVersionRef.current !== routeVersion;
    if (routeChanged) {
      if (result.state === "failed") {
        approvalCommandIds.current.delete(`approval:${approval.id}:${approval.revision}:${params.body.decision}`);
        clearStoredIntent(controlIntentKey);
      } else {
        writeControlIntent(controlIntentKey, { commandId: params.body.command_id, uncertain: result.state === "unknown" });
      }
      return;
    }
    if (result.state === "failed") {
      approvalCommandIds.current.delete(`approval:${approval.id}:${approval.revision}:${params.body.decision}`);
      clearStoredIntent(controlIntentKey);
      throw new Error("审批命令被服务拒绝；请确认当前修订后重试");
    }
    if (result.state === "unknown") {
      writeControlIntent(controlIntentKey, { commandId: params.body.command_id, uncertain: true });
      throw new Error("审批结果未被确认；请对账，不会自动重复提交");
    }
    writeControlIntent(controlIntentKey, { commandId: params.body.command_id, uncertain: false });
    setActivityNotice("审批命令已收到，等待服务事件确认当前修订。");
  };

  const reconcileApproval = (approval: Approval, decision: ApprovalDecision) => {
    if (!adapters || !sessionForRoute) return;
    const operationKey = `approval:${approval.id}:${approval.revision}:${decision}`;
    const controlIntentKey = getControlIntentKey(principalId, sessionForRoute.id, operationKey);
    const intent = readControlIntent(controlIntentKey);
    if (!intent) return;
    adapters.approval.resolveUncertain(approval.id, approval.revision, approval.run_id, intent.commandId);
    if (writeControlIntent(controlIntentKey, { ...intent, uncertain: false })) {
      setControlIntentRevision((current) => current + 1);
      setActivityNotice("已记录审批人工对账；下一次会复用同一 command_id，不会创建新的授权身份。");
    }
  };

  const reconcileRunSubmission = () => {
    if (!adapters || !uncertainRunCommandId) return;
    const intentKey = getRunIntentKey(principalId, activeSessionId);
    const intent = readRunIntent(intentKey);
    if (adapters.run.resolveUncertainSubmit(uncertainRunCommandId) || intent?.commandId === uncertainRunCommandId) {
      setUncertainRunCommandId(undefined);
      if (!activeRun || activeRun.status !== "unknown") setCommandState(undefined);
      if (intent) writeRunIntent(intentKey, { ...intent, uncertain: false });
      setActivityNotice("已记录人工对账；下一次发送会复用同一 command_id，不会创建新的 Run 身份。");
    } else {
      setActivityNotice("本地未知命令状态已变化，请刷新后重新核对。");
    }
  };

  const interrupt = async (request: { command_id: string; reason?: string }) => {
    if (!api || !adapters || !sessionForRoute || !activeRun) throw new Error("Run 尚未就绪");
    if (sessionForRoute.state !== "active" || !canSendControl(connection, effectiveReadOnly)) throw new Error("当前 Session 不允许提交中断控制命令");
    const interruptOperationKey = `interrupt:${activeRun.id}`;
    const interruptIntentKey = getControlIntentKey(principalId, sessionForRoute.id, interruptOperationKey);
    const storedInterruptIntent = readControlIntent(interruptIntentKey);
    if (runRouteUnverified || !runIdentityVerified || sessionReadUncertain || sessionAccessBlocked || sessionRunHistoryBlocked || runReadUncertain || approvalReadUncertain || approvalHistoryBlocked || uncertainRunCommandId || activeRun.status === "unknown" || effectiveCommandState === "unknown") throw new Error("当前 Run 身份或结果未完成核对，不能继续提交中断控制命令");
    if (storedInterruptIntent?.uncertain) throw new Error("中断命令结果未完成对账；请先确认服务事实，不会自动重复提交");
    if (storedInterruptIntent && storedInterruptIntent.commandId !== request.command_id) throw new Error("中断命令身份已变化，请刷新后重新核对");
    if (!writeControlIntent(interruptIntentKey, { commandId: request.command_id, uncertain: true })) throw new Error("当前浏览器无法持久化中断命令身份；为避免未知结果下重复中断，请先恢复存储后再试");
    const sessionIdForInterrupt = sessionForRoute.id;
    const runIdForInterrupt = activeRun.id;
    const routeVersion = routeVersionRef.current;
    const result = await adapters.run.interruptRun(sessionIdForInterrupt, runIdForInterrupt, request, { connection, readOnly: effectiveReadOnly });
    const routeChanged = !mountedRef.current || currentSessionIdRef.current !== sessionIdForInterrupt || routeVersionRef.current !== routeVersion;
    if (routeChanged) {
      if (result.state === "failed") {
        approvalCommandIds.current.delete(`interrupt:${runIdForInterrupt}`);
        clearStoredIntent(interruptIntentKey);
      } else {
        writeControlIntent(interruptIntentKey, { commandId: request.command_id, uncertain: result.state === "unknown" });
      }
      return;
    }
    if (result.state === "failed") {
      approvalCommandIds.current.delete(`interrupt:${activeRun.id}`);
      clearStoredIntent(interruptIntentKey);
      throw new Error("中断命令被服务拒绝；请重新观察 Run 状态后再试");
    }
    if (result.state === "unknown") {
      writeControlIntent(interruptIntentKey, { commandId: request.command_id, uncertain: true });
      throw new Error("中断结果未被确认；请对账，不会自动重试");
    }
    writeControlIntent(interruptIntentKey, { commandId: request.command_id, uncertain: false });
    setCommandState(result.ack?.state);
    setActivityNotice("中断命令已收到，等待 run.interrupted 事件。");
  };

  const reconcileInterrupt = () => {
    if (!adapters || !sessionForRoute || !activeRun) return;
    const operationKey = `interrupt:${activeRun.id}`;
    const controlIntentKey = getControlIntentKey(principalId, sessionForRoute.id, operationKey);
    const intent = readControlIntent(controlIntentKey);
    if (!intent) return;
    adapters.run.resolveUncertainInterrupt(activeRun.id, intent.commandId);
    if (writeControlIntent(controlIntentKey, { ...intent, uncertain: false })) {
      setControlIntentRevision((current) => current + 1);
      setActivityNotice("已记录中断人工对账；下一次会复用同一 command_id，不会自动重复中断。");
    }
  };

  const selectHistoricalRun = (runId: string) => {
    if (!sessionForRoute) return;
    const selected = sessionRunHistory.find((historyRun) => historyRun.id === runId);
    if (!selected || selected.id === activeRunId) return;
    routeVersionRef.current += 1;
    selectedRunIdRef.current = selected.id;
    activeRunIdRef.current = selected.id;
    seenEventIds.current = new Set();
    approvalCommandIds.current = new Map();
    lastAppliedRunSequence.current = 0;
    setRun(runFromHistory(sessionForRoute, selected));
    setMessages([]);
    setApprovals([]);
    setApprovalHistoryAvailable(false);
    setRunIdentityVerified(false);
    setRunReadUncertain(false);
    setRunReadFailure(null);
    setApprovalReadUncertain(false);
    setApprovalReadFailure(null);
    setCommandState(undefined);
    setActivityNotice("已切换 Run；正在重新核对事件和审批历史，核对完成前不会提交控制命令。");
  };

  if (!sessionForRoute && !sessionId) {
    return (
      <section className="grid min-w-0 gap-5" aria-label="创建会话工作区">
        {api ? <ProductionSessionCreationPanel conversationTitle={currentConversationTitle} existingActiveSupported={existingActiveSupported} fixedProjectId={projectId} fixedProjectName={projectName} onCreate={createSession} principalId={principalId} projectCanWrite={projectCanWrite} projectOptions={projectOptions} readOnly={effectiveReadOnly} taskId={task?.id} /> : <div className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]"><h2 className="text-base font-semibold text-[var(--ink)]">会话服务不可用</h2><p>当前浏览器没有已认证的生产 API，不能创建 Session。</p></div>}
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
      {readFailure ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/30 bg-[var(--danger-bg)] p-3 text-xs leading-5 text-[var(--danger)]" role="alert" aria-live="assertive"><Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{readFailure}</span></div> : null}
      {sessionRunHistory.length > 1 ? <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] p-3" aria-label="Run 历史选择"><label className="text-xs font-medium text-[var(--ink)]" htmlFor="production-run-history">Run 历史</label><Select value={selectedHistoryRunId} onValueChange={selectHistoricalRun}><SelectTrigger className="min-w-0 max-w-full" id="production-run-history" size="sm"><SelectValue placeholder="选择已授权 Run" /></SelectTrigger><SelectContent>{sessionRunHistory.map((historyRun) => <SelectItem key={historyRun.id} value={historyRun.id}><span className="font-mono text-xs">{historyRun.id}</span><span className="text-xs text-[var(--muted)]">· {historyRun.created_at}</span></SelectItem>)}</SelectContent></Select><span className="text-[11px] leading-5 text-[var(--muted)]">每台设备独立选择；切换后会重新核对事件和审批。</span></div> : null}
      <ConversationMessageStream connection={connection} emptyMessage="当前没有已接收消息或事件；首条提示和控制命令不会以乐观消息显示。" messages={messages} />
      {activeRun ? <RunStatusCard key={activeRun.id} canControl={Boolean(api) && runIdentityVerified && !sessionReadUncertain && !sessionAccessBlocked && !sessionRunHistoryBlocked && !runReadUncertain && !approvalReadUncertain && !approvalHistoryBlocked && !uncertainRunCommandId && activeRun.status !== "unknown" && effectiveCommandState !== "unknown" && !controlIntentIsUncertain(principalId, sessionForRoute.id, `interrupt:${activeRun.id}`) && sessionForRoute.state === "active"} commandState={effectiveCommandState} connection={connection} interruptCommandId={createCommandIdForRun(activeRun.id, approvalCommandIds.current, principalId, sessionForRoute.id)} onInterrupt={interrupt} onReconcile={reconcileInterrupt} readOnly={effectiveReadOnly} recoveryRequired={controlIntentIsUncertain(principalId, sessionForRoute.id, `interrupt:${activeRun.id}`)} run={activeRun} session={sessionForRoute} /> : null}
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
        const recoveryDecision = uncertainApprovalDecision(principalId, sessionForRoute.id, approval);
        return <ApprovalRequestCard key={`${approval.id}:${approval.revision}`} commandIds={{ approve: commandIdForApproval(approval, "approve", approvalCommandIds.current, principalId, sessionForRoute.id), deny: commandIdForApproval(approval, "deny", approvalCommandIds.current, principalId, sessionForRoute.id) }} connection={connection} canResolve={runIdentityVerified && !sessionReadUncertain && !sessionAccessBlocked && !sessionRunHistoryBlocked && !runReadUncertain && !approvalReadUncertain && !uncertainRunCommandId && sessionForRoute.state === "active" && approvalHistoryAvailable && activeRun?.status !== "unknown" && effectiveCommandState !== "unknown" && !controlIntentIsUncertain(principalId, sessionForRoute.id, `approval:${approval.id}:${approval.revision}:approve`) && !controlIntentIsUncertain(principalId, sessionForRoute.id, `approval:${approval.id}:${approval.revision}:deny`) && approval.revision === latestRevision} onReconcile={(decision) => reconcileApproval(approval, decision)} onResolve={resolveApproval} readOnly={effectiveReadOnly} recoveryDecision={recoveryDecision} request={request} />;
      })}
      {draftFailure ? <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" role="status" aria-live="polite"><Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{draftFailure}</span></div> : null}
      <ConversationComposer connection={connection} disabled={!api || sessionForRoute.state !== "active" || runRouteUnverified || sessionReadUncertain || sessionAccessBlocked || sessionRunHistoryBlocked || runReadUncertain || approvalReadUncertain || activeRun?.status === "unknown" || effectiveCommandState === "unknown" || Boolean(uncertainRunCommandId)} onChange={(value) => { draftRef.current = value; draftInputSinceReadRef.current = true; setDraft(value); if (!draftAccessBlockedRef.current) { draftDirtyRef.current = true; writeDraft(draftKey, value); scheduleDraftPersistence(sessionForRoute.id, value); } }} onSend={send} readOnly={effectiveReadOnly} value={draft} />
      <div className="flex items-start gap-2 text-[11px] leading-5 text-[var(--muted)]"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" /><span>审批、Run 控制和消息发送都以当前 Session、Run、修订和连接状态为准；未知结果不会自动重试。</span></div>
    </section>
  );
}

function createCommandIdForRun(runId: string, cache: Map<string, string>, principalId: string | undefined, sessionId: string): string {
  const key = `interrupt:${runId}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const persisted = readControlIntent(getControlIntentKey(principalId, sessionId, key));
  if (persisted) {
    cache.set(key, persisted.commandId);
    return persisted.commandId;
  }
  const commandId = createCommandId("interrupt");
  cache.set(key, commandId);
  return commandId;
}

function commandIdForApproval(approval: Approval, decision: ApprovalDecision, cache: Map<string, string>, principalId: string | undefined, sessionId: string): string {
  const key = `approval:${approval.id}:${approval.revision}:${decision}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const persisted = readControlIntent(getControlIntentKey(principalId, sessionId, key));
  if (persisted) {
    cache.set(key, persisted.commandId);
    return persisted.commandId;
  }
  const commandId = createCommandId(`approval-${decision}`);
  cache.set(key, commandId);
  return commandId;
}
