import { AlertCircle, ArrowUpRight, Check, ChevronRight, Clock3, Inbox, MessageCircle, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { getConversation, getProject, getTask, useDemoRuntime } from "@/demo/context";

function RequestDetail({ attentionId }: { attentionId: string }) {
  const runtime = useDemoRuntime();
  const item = runtime.fixtures.attention.find((entry) => entry.id === attentionId);
  if (!item) return <div className="empty-state"><h2>当前没有待介入事项</h2><p>所有请求都已处理，或当前身份没有可见的审批。</p></div>;
  const task = getTask(runtime.fixtures, item.taskId);
  const conversation = getConversation(runtime.fixtures, item.conversationId);
  const expired = runtime.scene === "approval-expired" || item.status === "expired";
  const resolved = item.status === "resolved";

  return (
    <section className="review-request" aria-label="待介入详情">
      <div className="section-kicker"><span className="kicker-dot" aria-hidden="true" />{item.kind}</div>
      <h2>{item.title}</h2>
      <p className="lead-copy">{item.summary}</p>
      <dl className="request-facts">
        <dt>项目</dt><dd>{getProject(runtime.fixtures, task?.projectId)?.name ?? "未归属项目"}</dd>
        <dt>任务</dt><dd>{task ? <Link to="/tasks/$taskId" params={{ taskId: task.id }} className="inline-link">{task.id} · {task.title}</Link> : "当前任务不可用"}</dd>
        <dt>对话</dt><dd>{conversation ? <Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }} className="inline-link">{conversation.title}</Link> : "当前对话不可用"}</dd>
        {item.directory && <><dt>目录</dt><dd><code>{item.directory}</code></dd></>}
        {item.impact && <><dt>影响</dt><dd>{item.impact}</dd></>}
      </dl>
      {item.command && <pre className="command-preview"><code>{item.command}</code></pre>}
      {expired ? <div className="inline-state inline-state-warning"><Clock3 size={15} aria-hidden="true" /><span>请求已过期，保留事实但不再提供有效控制入口。</span></div> : resolved ? <div className="inline-state inline-state-success"><Check size={15} aria-hidden="true" /><span>{item.decision === "approve" ? "已模拟批准" : "已模拟拒绝"}；任务业务状态保持独立。</span></div> : null}
      <div className="request-actions">
        <Button type="button" variant="default" className="button button-primary" disabled={expired || resolved || !runtime.canWrite} onClick={() => runtime.decideAttention(item.id, "approve")}><Check size={15} aria-hidden="true" />批准</Button>
        <Button type="button" variant="secondary" className="button button-secondary" disabled={expired || resolved || !runtime.canWrite} onClick={() => runtime.decideAttention(item.id, "deny")}><ShieldAlert size={15} aria-hidden="true" />拒绝</Button>
        {conversation && <Button asChild variant="ghost" className="button button-quiet request-conversation-link"><Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }}><MessageCircle size={15} aria-hidden="true" />打开完整对话<ArrowUpRight size={14} aria-hidden="true" /></Link></Button>}
      </div>
    </section>
  );
}

export function WorkbenchRoute() {
  const runtime = useDemoRuntime();
  const [selectedId, setSelectedId] = useState("approval-1");
  const activeItems = useMemo(() => runtime.fixtures.attention.filter((item) => item.status === "pending" || runtime.scene === "approval-expired"), [runtime.fixtures.attention, runtime.scene]);
  const recent = runtime.fixtures.conversations.slice(0, 4);

  if (runtime.scene === "loading") {
    return <section className="page-section workbench-page"><div className="page-heading"><span className="eyebrow">WORKBENCH</span><h1>工作台</h1><p>跨项目查看需要介入的事项，并从同一上下文继续对话。</p></div><div className="page-skeleton"><span /><span /><span /><span /></div></section>;
  }

  if (runtime.dataMode === "empty" || runtime.scene === "empty") {
    return <section className="page-section empty-page"><div className="empty-hero"><span className="empty-icon"><Inbox size={24} aria-hidden="true" /></span><span className="eyebrow">WORKBENCH</span><h1>工作台还没有待处理内容</h1><p>切换回完整数据夹具，或先从任务入口建立一项模拟任务。Demo 中的变更只存在于当前内存。</p><div className="empty-actions"><Button asChild variant="default" className="button button-primary"><Link to="/tasks">查看任务</Link></Button><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks/new">新建模拟任务</Link></Button></div></div></section>;
  }

  const selected = activeItems.find((item) => item.id === selectedId) ?? activeItems[0];

  return (
    <section className="page-section workbench-page">
      <div className="page-heading">
        <div><span className="eyebrow">WORKBENCH</span><h1>工作台</h1><p>先处理待介入事项，再回到最近的项目对话。</p></div>
        <div className="heading-meta"><span className="metric-value">{activeItems.length}</span><span>项待介入</span></div>
      </div>
      <div className="workbench-grid">
        <section className="queue-panel" aria-label="待介入事项">
          <div className="panel-heading"><div><span className="section-kicker">需要你的决定</span><h2>待介入</h2></div><span className="panel-count">{activeItems.length}</span></div>
          {activeItems.length ? <div className="attention-list">{activeItems.map((item) => (
            <Button type="button" variant="ghost" key={item.id} className={`attention-item ${selected?.id === item.id ? "is-selected" : ""}`} aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)}>
              <span className={`attention-kind attention-${item.kind === "审批" ? "approval" : item.kind === "需要输入" ? "input" : "result"}`}>{item.kind}</span>
              <span className="attention-copy"><strong>{item.title}</strong><small>{item.summary}</small></span>
              <ChevronRight size={15} aria-hidden="true" />
            </Button>
          ))}</div> : <p className="muted-copy">当前没有需要处理的事项。</p>}
        </section>
        <section className="request-panel">
          <div className="panel-heading"><div><span className="section-kicker">完整上下文</span><h2>请求详情</h2></div><span className="panel-status">Mock context</span></div>
          {selected ? <RequestDetail attentionId={selected.id} /> : <div className="empty-state"><h2>选择一项待介入事项</h2><p>请求、影响范围与相关对话会在这里完整展开。</p></div>}
        </section>
        <section className="recent-panel">
          <div className="panel-heading"><div><span className="section-kicker">保持连续</span><h2>最近对话</h2></div><Link to="/conversations" className="text-link">全部对话</Link></div>
          <div className="recent-list">{recent.map((conversation) => <Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }} className="recent-item" key={conversation.id}><span className="recent-item-icon"><MessageCircle size={15} aria-hidden="true" /></span><span><strong>{conversation.title}</strong><small>{conversation.preview}</small><em>{conversation.updated}</em></span></Link>)}</div>
        </section>
      </div>
    </section>
  );
}
