import { FileText, Info, MessageCircle, Pause, Send, ShieldCheck, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "@tanstack/react-router";

import { getConversation, getProject, getTask, useDemoRuntime } from "@/demo/context";
import { taskStates } from "@/demo/types";

function WorkspaceHeader({ taskId, conversationId }: { taskId?: string; conversationId?: string }) {
  const runtime = useDemoRuntime();
  const task = getTask(runtime.fixtures, taskId);
  const conversation = getConversation(runtime.fixtures, conversationId ?? task?.conversationId);
  const project = getProject(runtime.fixtures, task?.projectId ?? conversation?.projectId);
  const title = task?.title ?? conversation?.title ?? "对话工作区";
  const execution = task?.execution ?? conversation?.execution ?? "未开始";
  return (
    <header className="workspace-heading">
      <div><span className="workspace-context">{project?.name ?? "未归属项目"} {task ? ` / ${task.id}` : " / 对话"}</span><h1>{title}</h1><div className="workspace-meta"><span className={`execution-dot execution-${execution}`}>{execution}</span>{task && <span>任务业务状态：{task.state}</span>}</div></div>
      {task && execution === "执行中" && <button type="button" className="button button-secondary" disabled={!runtime.canWrite}><Pause size={15} aria-hidden="true" />请求中断</button>}
    </header>
  );
}

function MessageStream({ conversationId }: { conversationId: string | undefined }) {
  const runtime = useDemoRuntime();
  const conversation = getConversation(runtime.fixtures, conversationId);
  if (!conversation) return <div className="empty-state"><h2>这段对话还没有消息</h2><p>可以从下方草稿开始继续。</p></div>;
  return <div className="message-stream">{conversation.history.length ? conversation.history.map((message) => <article className={`message-item message-${message.role}`} key={message.id}><div className="message-label">{message.role === "assistant" ? <><ShieldCheck size={14} aria-hidden="true" />{message.label}</> : <><UserRound size={14} aria-hidden="true" />{message.label}</>}</div><p>{message.text}</p>{message.detail && <details><summary>查看过程</summary><p>{message.detail}</p></details>}</article>) : <div className="empty-state"><h2>从这里开始</h2><p>这段对话还没有已提交消息，草稿只有在明确点击发送后才会加入内存夹具。</p></div>}</div>;
}

function WorkspaceInfo({ taskId, conversationId }: { taskId?: string; conversationId?: string }) {
  const runtime = useDemoRuntime();
  const task = getTask(runtime.fixtures, taskId);
  const conversation = getConversation(runtime.fixtures, conversationId ?? task?.conversationId);
  const project = getProject(runtime.fixtures, task?.projectId ?? conversation?.projectId);
  return (
    <aside className="workspace-info" aria-label="任务信息">
      {task ? <>
        <section className="info-block"><span className="section-kicker">任务信息</span><h2>目标</h2><p>{task.goal}</p><label className="info-select"><span>任务业务状态</span><select value={task.state} disabled={!runtime.canWrite} onChange={(event) => runtime.setTaskState(task.id, event.target.value as (typeof taskStates)[number])}>{taskStates.map((state) => <option key={state} value={state}>{state}</option>)}</select></label></section>
        <section className="info-block"><span className="section-kicker">关联上下文</span><dl className="info-facts"><dt>项目</dt><dd>{project?.name ?? "未归属项目"}</dd><dt>主对话</dt><dd>{conversation ? conversation.title : "尚未开始"}</dd><dt>执行状态</dt><dd>{task.execution}</dd>{task.parentId && <><dt>父任务</dt><dd><Link to="/tasks/$taskId" params={{ taskId: task.parentId }} className="inline-link">{task.parentId}</Link></dd></>}{task.dependsOn.length > 0 && <><dt>前置任务</dt><dd>{task.dependsOn.map((id) => <Link key={id} to="/tasks/$taskId" params={{ taskId: id }} className="relation-chip">{id}</Link>)}</dd></>}</dl></section>
        <section className="info-block info-note"><Info size={16} aria-hidden="true" /><p>任务业务状态、执行状态、审批与对话草稿分别保留。子代理活动只在真实事件存在时展开。</p></section>
      </> : <>
        <section className="info-block"><span className="section-kicker">对话信息</span><h2>{conversation?.title ?? "独立对话"}</h2><dl className="info-facts"><dt>项目</dt><dd>{project?.name ?? "尚未归属项目"}</dd><dt>任务</dt><dd>未关联任务</dd><dt>执行状态</dt><dd>{conversation?.execution ?? "未开始"}</dd></dl><p>这段对话可以先继续讨论；真实绑定和历史共享确认由后续服务合同接入。</p><button type="button" className="button button-secondary" disabled>关联任务</button></section>
      </>}
      <section className="info-block"><span className="section-kicker">对话文件</span><button type="button" className="file-reference" disabled><FileText size={15} aria-hidden="true" />verification-notes.md</button><small>文件入口保留在当前对话上下文。</small></section>
    </aside>
  );
}

export function WorkspaceRoute({ taskId, conversationId }: { taskId?: string; conversationId?: string }) {
  const runtime = useDemoRuntime();
  const task = getTask(runtime.fixtures, taskId);
  const conversation = getConversation(runtime.fixtures, conversationId ?? task?.conversationId);
  const [panel, setPanel] = useState<"chat" | "info">("chat");
  const conversationKey = conversation?.id;
  const [draft, setDraft] = useState(conversationKey ? runtime.drafts[conversationKey] ?? "" : "");

  if (!task && !conversation) return <section className="page-section unavailable-page"><span className="eyebrow">WORKSPACE</span><h1>工作区不可用</h1><p>当前路由没有对应的任务或对话，或它已不在当前权限夹具中。</p><Link to="/" className="button button-secondary">返回工作台</Link></section>;

  const activeConversationId = conversation?.id ?? task?.conversationId;
  const composerDisabled = !activeConversationId || !runtime.canWrite || runtime.scene === "unknown" || task?.execution === "待核对";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!activeConversationId || composerDisabled) return;
    runtime.setDraft(activeConversationId, draft);
    runtime.sendMessage(activeConversationId);
    setDraft("");
  };

  return (
    <section className="workspace-page">
      <WorkspaceHeader taskId={task?.id} conversationId={conversation?.id} />
      <div className="workspace-tabs" role="tablist" aria-label="工作区面板"><button type="button" role="tab" aria-selected={panel === "chat"} className={panel === "chat" ? "is-selected" : ""} onClick={() => setPanel("chat")}><MessageCircle size={15} aria-hidden="true" />对话</button><button type="button" role="tab" aria-selected={panel === "info"} className={panel === "info" ? "is-selected" : ""} onClick={() => setPanel("info")}><Info size={15} aria-hidden="true" />{task ? "任务信息" : "对话信息"}</button></div>
      <div className={`workspace-layout workspace-panel-${panel}`}>
        <section className="chat-panel" aria-label="主对话"><MessageStream conversationId={activeConversationId} /><form className="composer" onSubmit={submit}><label htmlFor="message-draft">对话共享草稿</label><textarea id="message-draft" value={draft} onChange={(event) => { setDraft(event.target.value); if (activeConversationId) runtime.setDraft(activeConversationId, event.target.value); }} placeholder={composerDisabled ? "当前状态不可发送，但草稿仍可保留" : "继续说明目标或补充上下文…"} disabled={!activeConversationId || runtime.scene === "readonly" || runtime.persona === "viewer"} /><div className="composer-footer"><small>发送需要明确点击；断线恢复不会自动发送。</small><button type="submit" className="button button-primary" disabled={composerDisabled || !draft.trim()}><Send size={15} aria-hidden="true" />发送</button></div></form></section>
        <WorkspaceInfo taskId={task?.id} conversationId={activeConversationId} />
      </div>
    </section>
  );
}

export function TaskWorkspaceRoute() {
  const { taskId } = useParams({ from: "/tasks/$taskId" });
  return <WorkspaceRoute taskId={taskId} />;
}

export function ConversationWorkspaceRoute() {
  const { conversationId } = useParams({ from: "/conversations/$conversationId" });
  const runtime = useDemoRuntime();
  const conversation = getConversation(runtime.fixtures, conversationId);
  return <WorkspaceRoute taskId={conversation?.taskId} conversationId={conversationId} />;
}
