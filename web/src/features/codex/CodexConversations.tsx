import { AlertTriangle, ArrowLeftRight, Check, FileText, History, LoaderCircle, MessageCircle, RefreshCw, Save, Search, ShieldAlert, Wifi, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import type { CodexConversation, CodexConversationDetail } from "@loomhelm/protocol";

import { useOptionalProductionApi } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";

import {
  applyTaskTitleUpdate,
  codexRouteKey,
  conversationLabel,
  isTopLevelCodexConversation,
  sourceStateLabel,
  useCodexConversationDetail,
  useCodexBindConversation,
  useCodexOverview,
  useCodexSync,
  useCodexTitleMutation,
  useTaskTitleReplacement
} from "./source";

function formatTime(value: string | undefined): string {
  if (!value) return "时间未知";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed);
}
function stateText(conversation: CodexConversation): string {
  if (conversation.source_status === "archived") return "已归档";
  if (conversation.source_status === "deleted") return "已删除"
  if (conversation.source_status === "unavailable") return "不可用";
  if (conversation.history_state !== "complete" || !conversation.files_complete) return "材料未完整";
  return conversation.bound_task_id ? "已绑定任务" : "未绑定，只读";
}

function stateClass(conversation: CodexConversation): string {
  if (conversation.source_status !== "active") return "codex-state codex-state-warning";
  if (conversation.history_state !== "complete" || !conversation.files_complete) return "codex-state codex-state-warning";
  return conversation.bound_task_id ? "codex-state codex-state-success" : "codex-state";
}

function syncStateLabel(state: string | undefined): string {
  return ({ never: "未同步", syncing: "同步中", complete: "已完成", partial: "部分完成", stale: "已过期", failed: "失败" } as Record<string, string>)[state ?? ""] ?? state ?? "未知";
}

function historyStateLabel(state: string): string {
  return ({ pending: "待补齐", complete: "完整", partial: "部分完成", failed: "失败" } as Record<string, string>)[state] ?? state;
}

function sourceStatusLabel(status: string): string {
  return ({ active: "活跃", archived: "已归档", deleted: "已删除", unavailable: "不可用" } as Record<string, string>)[status] ?? status;
}

function titleSyncStateLabel(state: string): string {
  return ({ synced: "已同步", pending: "写回中", failed: "写回失败", conflict: "冲突待选择", paused: "已暂停", unsupported: "不可用" } as Record<string, string>)[state] ?? state;
}

function titleRowState(conversation: CodexConversation): string {
  if (conversation.title_sync_state === "conflict") return "标题冲突待选择";
  if (conversation.title_sync_state === "failed") return "标题写回失败";
  if (conversation.title_sync_state === "pending") return "标题写回中";
  if (conversation.title_sync_state === "paused") return "标题写回暂停";
  if (conversation.title_sync_state === "unsupported") return "标题写回不可用";
  return "标题已同步";
}

export type ConversationReturnTo = "demo-production-conversations";

export interface CodexConversationsRouteProps {
  returnTo?: ConversationReturnTo;
  topLevelOnly?: boolean;
}

function ConversationRow({ conversation, returnTo }: { conversation: CodexConversation; returnTo?: ConversationReturnTo }) {
  return (
    <Link to="/conversations/$conversationId" params={{ conversationId: codexRouteKey(conversation.host_id, conversation.thread_id) }} search={returnTo ? { returnTo } : {}} className="conversation-list-item codex-conversation-row">
      <span className="conversation-icon"><MessageCircle size={16} aria-hidden="true" /></span>
      <span className="min-w-0">
        <strong>{conversationLabel(conversation)}</strong>
        <small>{conversation.project_name ?? "未映射 Codex 项目"} · {conversation.bound_task_id ? `任务 ${conversation.bound_task_id}` : "未绑定任务"} · {conversation.cwd ?? "工作目录未知"}</small>
        <em>{conversation.preview || "没有可读预览"}</em>
        <span className="codex-row-meta"><span className={stateClass(conversation)}>{stateText(conversation)}</span><span>{titleRowState(conversation)}</span></span>
      </span>
      <time>{formatTime(conversation.updated_at)}</time>
    </Link>
  );
}

export function CodexConversationsRoute({ returnTo, topLevelOnly = false }: CodexConversationsRouteProps = {}) {
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const overview = useCodexOverview(search, includeArchived, topLevelOnly ? false : undefined);
  const sync = useCodexSync();
  const source = overview.data?.sources[0];
  const conversations = overview.data?.conversations.filter((conversation) => !topLevelOnly || isTopLevelCodexConversation(conversation)) ?? [];
  const unsupportedCapabilities = source ? Object.values(source.capability_states ?? {}).filter((value) => value === "unsupported").length : 0;

  if (overview.isLoading) return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">CODEX 来源</span><h1>正在读取 Codex 对话</h1><p>正在读取 Host 来源、历史完整度和文件材料状态。</p></section>;
  if (overview.isError) return <section className="page-section unavailable-page"><span className="eyebrow">CODEX 来源</span><h1>Codex 来源暂时不可用</h1><p>{overview.error instanceof Error ? overview.error.message : "当前浏览器会话无法读取 Codex 来源。"}</p><Button type="button" variant="secondary" className="button button-secondary" onClick={() => void overview.refetch()}><RefreshCw size={15} aria-hidden="true" />重新读取</Button></section>;

  return (
    <section className="page-section conversations-page codex-page" data-visual-evidence-target>
      <div className="page-heading"><div><span className="eyebrow">CODEX 来源</span><h1>Codex 对话</h1><p>只展示当前 Host 已导入的历史。未绑定对话保持只读，材料完整后才能进入项目。</p></div><Button type="button" variant="default" className="button button-primary" onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw size={16} aria-hidden="true" className={sync.isPending ? "animate-spin" : undefined} />{sync.isPending ? "同步请求中" : "请求同步"}</Button></div>
      <div className="codex-source-strip"><span className="codex-source-mark"><Wifi size={16} aria-hidden="true" /></span><span><strong>{sourceStateLabel(source)}</strong><small>{source ? `${source.host_name} · 构建 ${source.build || "未知"} · 快照 ${formatTime(source.as_of)}` : "还没有可用的 Host 快照"}</small></span><span className="codex-source-facts">{syncStateLabel(overview.data?.snapshotState)} · {conversations.length} 条{unsupportedCapabilities ? ` · ${unsupportedCapabilities} 项能力不可用` : ""}</span></div>
      {sync.isError && <div className="inline-state inline-state-warning" role="alert"><AlertTriangle size={15} aria-hidden="true" />同步请求失败，请保留当前快照并稍后重试。</div>}
      {sync.isSuccess && <div className="inline-state inline-state-success" role="status"><Check size={15} aria-hidden="true" />同步已进入队列：{syncStateLabel(sync.data.state)}。</div>}
      <div className="codex-toolbar" aria-label="Codex 对话筛选"><label className="search-field conversation-search"><Search size={16} aria-hidden="true" /><span className="sr-only">搜索 Codex 对话</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、预览或工作目录" /></label><div className="codex-toolbar-meta"><label className="codex-archive-toggle"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /><span className="codex-checkbox-visual" aria-hidden="true"><Check size={10} strokeWidth={3} /></span><span>包含归档</span></label><span className="codex-as-of"><span className="codex-as-of-label">最近快照</span><strong>{formatTime(overview.data?.asOf)}</strong></span></div></div>
      {conversations.length ? <div className="conversation-list">{conversations.map((conversation) => <ConversationRow conversation={conversation} returnTo={returnTo} key={`${conversation.host_id}:${conversation.thread_id}`} />)}</div> : <div className="empty-state"><span className="empty-icon"><MessageCircle size={24} aria-hidden="true" /></span><h2>当前没有可见的 Codex 对话</h2><p>先请求同步；来源历史和支持文件材料完成后，未绑定行会出现在这里。</p></div>}
    </section>
  );
}

function TitleStatus({ detail }: { detail: CodexConversationDetail }) {
  const conversation = detail.conversation;
  if (conversation.title_sync_state === "conflict" && conversation.title_conflict) return <div className="codex-title-conflict" role="alert"><ShieldAlert size={16} aria-hidden="true" /><span><strong>标题冲突</strong><small>Loomhelm：{conversation.title_conflict.loomhelm_title} · Codex：{conversation.title_conflict.codex_title}</small></span></div>;
  if (conversation.title_sync_state === "failed") return <div className="codex-title-conflict" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span><strong>Codex 写回失败</strong><small>{conversation.title_sync_error ?? "原因未提供，可手动重试。"}</small></span></div>;
  if (conversation.title_sync_state === "pending") return <div className="codex-title-pending" role="status"><LoaderCircle size={15} aria-hidden="true" className="animate-spin" />标题写回待确认</div>;
  if (conversation.title_sync_state === "paused") return <div className="codex-title-pending" role="status"><X size={15} aria-hidden="true" />来源状态暂停，恢复后再写回</div>;
  if (conversation.title_sync_state === "unsupported") return <div className="codex-title-pending" role="status"><X size={15} aria-hidden="true" />当前来源不支持标题写回</div>;
  return null;
}

function HistoryList({ detail }: { detail: CodexConversationDetail }) {
  return <section className="codex-detail-section"><div className="codex-detail-heading"><span><History size={15} aria-hidden="true" />历史事件</span><small>{detail.history.length} 条 · {historyStateLabel(detail.conversation.history_state)}</small></div>{detail.history.length ? <ol className="codex-history-list">{detail.history.map((event) => <li key={event.event_id}><span className="codex-history-index">{event.sequence}</span><span><strong>{event.readable_fallback || event.event_type}</strong><small>{event.event_type} · {formatTime(event.occurred_at)}</small><details><summary>查看原始事件</summary><pre>{JSON.stringify(event.raw_payload, null, 2)}</pre></details></span></li>)}</ol> : <p className="codex-muted">当前快照还没有可读历史。</p>}</section>;
}

function FileList({ detail }: { detail: CodexConversationDetail }) {
  return <section className="codex-detail-section"><div className="codex-detail-heading"><span><FileText size={15} aria-hidden="true" />文件材料</span><small>{detail.files.length} 项 · {detail.conversation.files_complete ? "完整" : "未完整"}</small></div>{detail.files.length ? <ul className="codex-file-list">{detail.files.map((file) => <li key={file.path}><FileText size={15} aria-hidden="true" /><span><strong>{file.path}</strong><small>{file.content_type} · {file.size} bytes{file.complete ? " · 已就绪" : " · 待补齐"}</small></span></li>)}</ul> : <p className="codex-muted">没有支持的文件材料。</p>}</section>;
}

function BackToConversations({ returnTo, children }: { returnTo?: ConversationReturnTo; children: ReactNode }) {
  return returnTo
    ? <Link to="/demo/production-conversations" className="button button-secondary">{children}</Link>
    : <Link to="/conversations" className="button button-secondary">{children}</Link>;
}

export function CodexConversationWorkspace({ hostId, threadId, returnTo }: { hostId: string; threadId: string; returnTo?: ConversationReturnTo }) {
  const detailQuery = useCodexConversationDetail(hostId, threadId);
  const detail = detailQuery.data;
  const titleMutation = useCodexTitleMutation(hostId, threadId);
  const bindMutation = useCodexBindConversation(hostId, threadId);
  const taskSource = useOptionalProjectTaskSource();
  const taskId = detail?.conversation.bound_task_id;
  const taskReplacement = useTaskTitleReplacement(taskId);
  const [title, setTitle] = useState("");
  const [shortcutMessage, setShortcutMessage] = useState<string | undefined>();
  const [bindTaskId, setBindTaskId] = useState("");
  useEffect(() => {
    if (detail) setTitle(detail.conversation.conversation_title);
  }, [detail?.conversation.conversation_title]);

  const conversation = detail?.conversation;
  const titleWritable = Boolean(conversation?.can_edit_title && !conversation.read_only && conversation.history_state === "complete" && conversation.files_complete);
  const titleRetryable = Boolean(conversation?.bound_task_id && (conversation.title_sync_state === "failed" || conversation.title_sync_state === "paused" || conversation.title_sync_state === "unsupported"));
  const bindableTasks = taskSource?.tasks.filter((task) => !task.conversationId && taskSource.getProjectPermissions(task.projectId).canWrite) ?? [];
  const saveTitle = async (nextTitle: string, resolution?: string, allowRetry = false): Promise<boolean> => {
    if (!conversation || !nextTitle.trim() || (!titleWritable && !allowRetry)) return false;
    setShortcutMessage(undefined);
    try {
      await titleMutation.mutateAsync({ title: nextTitle.trim(), expected_codex_title: conversation.codex_title, resolution });
      setTitle(nextTitle.trim());
      return true;
    } catch (error) {
      setShortcutMessage(error instanceof Error ? error.message : "标题保存失败，请稍后重试。");
      return false;
    }
  };
  const useTaskTitle = async () => {
    if (!taskReplacement.task || !titleWritable) return;
    if (await saveTitle(taskReplacement.task.title)) {
      setShortcutMessage("已按“Task 标题 → 对话标题”执行；Codex 标题只会随对话标题同步。");
    }
  };
  const useConversationTitle = async () => {
    if (!taskReplacement.task || !taskReplacement.canWrite || !title.trim()) return;
    const result = await applyTaskTitleUpdate(taskSource, taskReplacement.task.id, title.trim());
    setShortcutMessage(result.ok ? "已按“对话标题 → Task 标题”执行。" : result.message ?? "Task 标题更新失败。");
  };
  const bindConversation = async () => {
    if (!conversation || conversation.source_kind !== "main" || conversation.bound_task_id || conversation.bound_session_id || !bindTaskId || conversation.history_state !== "complete" || !conversation.files_complete) return;
    setShortcutMessage(undefined);
    try {
      await bindMutation.mutateAsync({ task_id: bindTaskId, expected_as_of: conversation.as_of });
      setBindTaskId("");
      setShortcutMessage("已绑定到所选 Task；对话历史仍保持 Host-scoped 记录。");
    } catch (error) {
      setShortcutMessage(error instanceof Error ? error.message : "绑定 Task 失败，请刷新后重试。");
    }
  };

  if (detailQuery.isLoading) return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">CODEX 对话</span><h1>正在读取对话材料</h1><p>正在读取完整历史、文件材料和标题状态。</p></section>;
  if (detailQuery.isError || !detail || !conversation) return <section className="page-section unavailable-page"><span className="eyebrow">CODEX 对话</span><h1>对话材料不可用</h1><p>{detailQuery.error instanceof Error ? detailQuery.error.message : "当前对话不在授权的 Host 历史中。"}</p><BackToConversations returnTo={returnTo}>返回 Codex 对话</BackToConversations></section>;

  const incomplete = conversation.history_state !== "complete" || !conversation.files_complete;
  return (
    <section className="page-section codex-workspace" data-visual-evidence-target>
      <div className="page-heading"><div><span className="eyebrow">CODEX 对话</span><h1>{conversationLabel(conversation)}</h1><p>{conversation.project_name ?? "未映射项目"} · Host {conversation.host_id} · {sourceStatusLabel(conversation.source_status)}</p></div><BackToConversations returnTo={returnTo}>返回对话列表</BackToConversations></div>
      <div className="codex-detail-grid">
        <section className="codex-title-panel"><div className="codex-detail-heading"><span><MessageCircle size={15} aria-hidden="true" />标题同步</span><span className={stateClass(conversation)}>{titleSyncStateLabel(conversation.title_sync_state)}</span></div><label className="codex-title-editor"><span>Loomhelm 对话标题</span><Input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!titleWritable || titleMutation.isPending} /><small>Codex 标题：{conversation.codex_title || "未设置，当前仅使用展示回退"}</small></label><div className="codex-title-actions"><Button type="button" variant="default" className="button button-primary" onClick={() => void saveTitle(title)} disabled={!titleWritable || titleMutation.isPending || !title.trim()}><Save size={15} aria-hidden="true" />{titleMutation.isPending ? "保存中" : "保存并同步"}</Button>{titleRetryable && <Button type="button" variant="secondary" className="button button-secondary" onClick={() => void saveTitle(title, "retry", true)} disabled={titleMutation.isPending || !title.trim()}><RefreshCw size={15} aria-hidden="true" />手动重试</Button>}</div><TitleStatus detail={detail} />{conversation.title_sync_state === "conflict" && conversation.title_conflict && <div className="codex-conflict-actions"><Button type="button" variant="secondary" className="button button-secondary" onClick={() => void saveTitle(conversation.title_conflict?.loomhelm_title ?? "", "use_loomhelm")} disabled={!titleWritable || titleMutation.isPending}><Check size={15} aria-hidden="true" />采用 Loomhelm</Button><Button type="button" variant="secondary" className="button button-secondary" onClick={() => void saveTitle(conversation.title_conflict?.codex_title ?? "", "use_codex")} disabled={!titleWritable || titleMutation.isPending}><Check size={15} aria-hidden="true" />采用 Codex</Button></div>}
          {taskReplacement.task && <div className="codex-shortcuts"><div><strong>标题快捷替换</strong><small>Task 标题与对话标题独立；每次只执行一个明确方向。</small></div><Button type="button" variant="ghost" className="button button-secondary" onClick={() => void useTaskTitle()} disabled={!titleWritable || titleMutation.isPending}><ArrowLeftRight size={15} aria-hidden="true" />Task → 对话</Button><Button type="button" variant="ghost" className="button button-secondary" onClick={() => void useConversationTitle()} disabled={!taskReplacement.canWrite || !title.trim()}><ArrowLeftRight size={15} aria-hidden="true" />对话 → Task</Button></div>}
          {shortcutMessage && <p className="codex-feedback" role="status">{shortcutMessage}</p>}
        </section>
        <section className="codex-status-panel"><div className="codex-detail-heading"><span><ShieldAlert size={15} aria-hidden="true" />来源与权限</span></div><dl className="codex-facts"><dt>来源状态</dt><dd>{sourceStatusLabel(conversation.source_status)}</dd><dt>历史完整度</dt><dd>{historyStateLabel(conversation.history_state)}</dd><dt>文件材料</dt><dd>{conversation.files_complete ? "完整" : "未完整"}</dd><dt>项目可见</dt><dd>{conversation.bound_task_id ? "已绑定" : "未绑定，只读"}</dd><dt>快照时间</dt><dd>{formatTime(conversation.as_of)}</dd><dt>最近更新</dt><dd>{formatTime(conversation.updated_at)}</dd></dl>{conversation.source_kind === "subagent" && <p className="codex-readonly-note"><ShieldAlert size={15} aria-hidden="true" />子代理活动归属于主对话，当前保持只读，不会创建独立 Session。</p>}{incomplete && <p className="codex-readonly-note"><ShieldAlert size={15} aria-hidden="true" />历史或文件材料未完整，当前只能查看，不能绑定到项目或写回标题。</p>}{conversation.source_kind === "main" && !conversation.bound_task_id && !conversation.bound_session_id && !incomplete && conversation.source_status === "active" && <div className="codex-bind-panel"><strong>绑定到 Task</strong><small>绑定是独立动作；确认后只会建立固定关联，不会把 Task 标题直接写入 Codex。</small>{taskSource ? <><select aria-label="选择要绑定的 Task" className="codex-bind-select" value={bindTaskId} onChange={(event) => setBindTaskId(event.target.value)} disabled={bindMutation.isPending || !bindableTasks.length}><option value="">选择一个可写 Task</option>{bindableTasks.map((task) => <option value={task.id} key={task.id}>{task.title} · {task.projectId}</option>)}</select><Button type="button" variant="secondary" className="button button-secondary" onClick={() => void bindConversation()} disabled={!bindTaskId || bindMutation.isPending}>{bindMutation.isPending ? "绑定中" : "确认绑定"}</Button>{!bindableTasks.length && <small>当前没有可绑定的授权 Task。</small>}</> : <small>Task 数据尚未加载，当前保持只读。</small>}</div>}</section>
      </div>
      <div className="codex-detail-sections"><HistoryList detail={detail} /><FileList detail={detail} /></div>
    </section>
  );
}
