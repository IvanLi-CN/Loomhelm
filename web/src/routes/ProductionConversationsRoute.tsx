import type { Session } from "@loomhelm/protocol";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, MessageCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useOptionalProductionApi } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodexConversationsRoute } from "@/features/codex/CodexConversations";
import { listAllSessions } from "@/features/conversations/session-list";
import type { PublishedSessionApi } from "@/features/sessions/api";

const sessionStateLabels: Record<Session["state"], string> = {
  starting: "启动中",
  active: "活跃",
  reconciling: "对账中",
  disconnected: "已断开",
  closed: "已关闭",
  unsupported: "不支持"
};

const sessionPathLabels: Record<Session["path"], string> = {
  new: "新建",
  existing_active: "接入现有"
};

export function matchesSessionSearch(session: Session, search: string): boolean {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;
  return `${session.id} ${session.external_thread_ref} ${session.project_id ?? ""} ${session.task_id ?? ""}`.toLowerCase().includes(normalized);
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function sessionContext(session: Session): string {
  const project = session.project_id ? `项目 ${session.project_id}` : "独立会话";
  const task = session.task_id ? `任务 ${session.task_id}` : "未关联任务";
  return `${project} · ${task} · ${sessionPathLabels[session.path]} · ${sessionStateLabels[session.state]}`;
}

export interface ProductionConversationsRouteProps {
  api?: PublishedSessionApi;
  principalId?: string;
  sessionGeneration?: number;
  includeCodex?: boolean;
}

export function ProductionConversationsRoute({ api, principalId: providedPrincipalId, sessionGeneration: providedSessionGeneration, includeCodex = true }: ProductionConversationsRouteProps = {}) {
  const assembly = useOptionalProductionApi();
  const [search, setSearch] = useState("");
  const sessionApi = api ?? (assembly?.auth.status === "authenticated" ? assembly.client : undefined);
  const principalId = providedPrincipalId ?? assembly?.auth.principalId ?? "anonymous";
  const sessionGeneration = providedSessionGeneration ?? assembly?.auth.sessionGeneration ?? 0;
  const sessionsQuery = useQuery({
    queryKey: ["loomhelm", principalId, sessionGeneration, "sessions"],
    queryFn: () => {
      if (!sessionApi) throw new Error("浏览器会话尚未就绪");
      return listAllSessions(sessionApi);
    },
    enabled: Boolean(sessionApi),
    refetchInterval: 30_000
  });
  const sessions = useMemo(
    () => (sessionsQuery.data ?? []).filter((session) => matchesSessionSearch(session, search)),
    [search, sessionsQuery.data]
  );
  const showCodex = includeCodex && assembly?.auth.status === "authenticated";

  return (
    <div className="grid min-w-0 gap-10">
      <section className="page-section conversations-page">
        <div className="page-heading">
          <div><span className="eyebrow">SESSIONS</span><h1>全部对话</h1><p>跨项目查看当前账户有权访问的 Loomhelm Session；已导入的 Codex 历史会在下方以独立来源记录显示。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" className="button button-secondary" onClick={() => void sessionsQuery.refetch()} disabled={sessionsQuery.isFetching}>
              {sessionsQuery.isFetching ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              刷新
            </Button>
            <Button asChild variant="default" className="button button-primary"><Link to="/conversations/new"><Plus size={16} aria-hidden="true" />新建对话</Link></Button>
          </div>
        </div>
        <label className="search-field conversation-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">搜索 Session</span>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Session、Host thread、项目或任务" />
        </label>
        {sessionsQuery.isPending ? (
          <div className="empty-state" aria-busy="true"><span className="empty-icon"><LoaderCircle className="animate-spin" size={24} aria-hidden="true" /></span><h2>正在读取对话</h2><p>正在核对当前身份可访问的 Session。</p></div>
        ) : sessionsQuery.isError ? (
          <div className="empty-state"><span className="empty-icon"><MessageCircle size={24} aria-hidden="true" /></span><h2>暂时无法读取对话</h2><p>Session 列表读取失败，请刷新后重试。</p><Button type="button" variant="secondary" className="button button-secondary" onClick={() => void sessionsQuery.refetch()}>重新读取</Button></div>
        ) : !sessions.length ? (
          <div className="empty-state"><span className="empty-icon"><MessageCircle size={24} aria-hidden="true" /></span><h2>{search.trim() ? "没有符合条件的对话" : "还没有可访问的对话"}</h2><p>可以先创建一个独立 Session，之后再按项目和任务范围查看。</p></div>
        ) : (
          <div className="conversation-list">
            {sessions.map((session) => (
              <Link to="/conversations/$conversationId" params={{ conversationId: session.id }} className="conversation-list-item" key={session.id}>
                <span className="conversation-icon"><MessageCircle size={16} aria-hidden="true" /></span>
                <span className="min-w-0">
                  <strong className="wrap-anywhere">Session {session.id}</strong>
                  <small>{sessionContext(session)}</small>
                  <em className="wrap-anywhere">Host thread：{session.external_thread_ref}</em>
                </span>
                <time dateTime={session.updated_at}>{formatSessionTime(session.updated_at)}</time>
              </Link>
            ))}
          </div>
        )}
      </section>
      {showCodex && <CodexConversationsRoute />}
    </div>
  );
}
