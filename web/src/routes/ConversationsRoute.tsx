import { MessageCircle, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getProject, useDemoRuntime } from "@/demo/context";

export function ConversationsRoute() {
  const runtime = useDemoRuntime();
  const [search, setSearch] = useState("");
  const conversations = useMemo(() => runtime.fixtures.conversations.filter((conversation) => `${conversation.title} ${conversation.preview}`.toLowerCase().includes(search.toLowerCase())), [runtime.fixtures.conversations, search]);
  return (
    <section className="page-section conversations-page">
      <div className="page-heading"><div><span className="eyebrow">CONVERSATIONS</span><h1>全部对话</h1><p>跨项目查看授权对话；项目和任务归属仍保留在每一行上下文里。</p></div><Button asChild variant="default" className="button button-primary"><Link to="/conversations/new"><Plus size={16} aria-hidden="true" />新建对话</Link></Button></div>
      <label className="search-field conversation-search"><Search size={16} aria-hidden="true" /><span className="sr-only">搜索对话</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索对话标题或内容" /></label>
      {runtime.dataMode === "empty" || !conversations.length ? <div className="empty-state"><span className="empty-icon"><MessageCircle size={24} aria-hidden="true" /></span><h2>没有符合条件的对话</h2><p>独立对话可以暂时不选择项目，稍后再关联任务。</p></div> : <div className="conversation-list">{conversations.map((conversation) => <Link to="/conversations/$conversationId" params={{ conversationId: conversation.id }} className="conversation-list-item" key={conversation.id}><span className="conversation-icon"><MessageCircle size={16} aria-hidden="true" /></span><span><strong>{conversation.title}</strong><small>{conversation.projectId ? getProject(runtime.fixtures, conversation.projectId)?.name : "未归属项目"} · {conversation.taskId ? `任务 ${conversation.taskId}` : "未关联任务"} · {conversation.execution}</small><em>{conversation.preview}</em></span><time>{conversation.updated}</time></Link>)}</div>}
    </section>
  );
}
