import { FileText, Info, MessageCircle, Pause, Send, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { getConversation, getProject, getTask, useDemoRuntime, useOptionalDemoRuntime } from "@/demo/context";
import { taskStates } from "@/demo/types";
import { useOptionalDemoProjectTaskSource } from "@/features/tasks/demo-store";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { TaskEditor } from "@/features/tasks/TaskForm";
import { TaskRelationshipEditor } from "@/features/tasks/TaskRelations";
import { TaskStateBadge } from "@/components/product/TaskViews";

function WorkspaceHeader({ taskId, conversationId }: { taskId?: string; conversationId?: string }) {
  const runtime = useDemoRuntime();
  const source = useOptionalDemoProjectTaskSource();
  const task = source ? source.getTask(taskId) : getTask(runtime.fixtures, taskId);
  const conversation = getConversation(runtime.fixtures, conversationId ?? task?.conversationId);
  const project = source ? source.getProject(task?.projectId ?? conversation?.projectId) : getProject(runtime.fixtures, task?.projectId ?? conversation?.projectId);
  const title = task?.title ?? conversation?.title ?? "对话工作区";
  const execution = task?.execution ?? conversation?.execution ?? "未开始";
  return (
    <header className="workspace-heading">
      <div><span className="workspace-context">{project?.name ?? "未归属项目"} {task ? ` / ${task.id}` : " / 对话"}</span><h1>{title}</h1><div className="workspace-meta"><span className={`execution-pill execution-dot execution-${execution}`}>{execution}</span>{task && <span className="inline-flex items-center gap-1">任务业务状态：<TaskStateBadge state={task.state} /></span>}</div></div>
      {task && execution === "执行中" && <Button type="button" variant="secondary" className="button button-secondary" disabled={!runtime.canWrite}><Pause size={15} aria-hidden="true" />请求中断</Button>}
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
  const source = useOptionalDemoProjectTaskSource();
  const task = source ? source.getTask(taskId) : getTask(runtime.fixtures, taskId);
  const conversation = getConversation(runtime.fixtures, conversationId ?? task?.conversationId);
  const project = source ? source.getProject(task?.projectId ?? conversation?.projectId) : getProject(runtime.fixtures, task?.projectId ?? conversation?.projectId);
  const [statePending, setStatePending] = useState(false);
  const [stateFeedback, setStateFeedback] = useState<string | null>(null);

  const changeState = async (value: string) => {
    if (!task) return;
    setStatePending(true);
    setStateFeedback(null);
    if (source) {
      const result = await source.updateTask(task.id, { state: value as (typeof taskStates)[number] });
      if (!result.ok) setStateFeedback(result.message);
    } else {
      runtime.setTaskState(task.id, value as (typeof taskStates)[number]);
    }
    setStatePending(false);
  };

  return (
    <aside className="workspace-info" aria-label="任务信息">
      {task ? <>
        <section className="info-block"><span className="section-kicker">任务信息</span><h2>目标</h2><p>{task.goal}</p><label className="info-select"><span>任务业务状态</span><Select value={task.state} disabled={!runtime.canWrite || statePending} onValueChange={(value) => { void changeState(value); }}><SelectTrigger className="info-select-trigger" aria-label="任务业务状态"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{taskStates.map((state) => <SelectItem key={state} value={state}>{state}</SelectItem>)}</SelectGroup></SelectContent></Select></label>{statePending && <p className="mt-2 text-xs text-[var(--muted)]" role="status">状态保存中…</p>}{stateFeedback && <p className="mt-2 text-xs text-[var(--warning)]" role="alert">{stateFeedback}</p>}</section>
        <section className="info-block"><span className="section-kicker">关联上下文</span><dl className="info-facts"><dt>项目</dt><dd>{project?.name ?? "未归属项目"}</dd><dt>主对话</dt><dd>{conversation ? conversation.title : "尚未开始"}</dd><dt>执行状态</dt><dd>{task.execution}</dd>{task.parentId && <><dt>父任务</dt><dd><Link to="/tasks/$taskId" params={{ taskId: task.parentId }} className="inline-link">{task.parentId}</Link></dd></>}{task.dependsOn.length > 0 && <><dt>前置任务</dt><dd>{task.dependsOn.map((id) => <Link key={id} to="/tasks/$taskId" params={{ taskId: id }} className="relation-chip">{id}</Link>)}</dd></>}</dl></section>
        {source && <><TaskRelationshipEditor source={source} taskId={task.id} /><TaskEditor source={source} taskId={task.id} /></>}
        <section className="info-block info-note"><Info size={16} aria-hidden="true" /><p>任务业务状态、执行状态、审批与对话草稿分别保留。子代理活动只在真实事件存在时展开。</p></section>
      </> : <section className="info-block"><span className="section-kicker">对话信息</span><h2>{conversation?.title ?? "独立对话"}</h2><dl className="info-facts"><dt>项目</dt><dd>{project?.name ?? "尚未归属项目"}</dd><dt>任务</dt><dd>未关联任务</dd><dt>执行状态</dt><dd>{conversation?.execution ?? "未开始"}</dd></dl><p>这段对话可以先继续讨论；真实绑定和历史共享确认由后续服务合同接入。</p><Button type="button" variant="secondary" className="button button-secondary" disabled>关联任务</Button></section>}
      <section className="info-block"><span className="section-kicker">对话文件</span><Button type="button" variant="ghost" className="file-reference" disabled><FileText size={15} aria-hidden="true" />verification-notes.md</Button><small>文件入口保留在当前对话上下文。</small></section>
    </aside>
  );
}

export function WorkspaceRoute({ taskId, conversationId }: { taskId?: string; conversationId?: string }) {
  const runtime = useDemoRuntime();
  const source = useOptionalDemoProjectTaskSource();
  const task = source ? source.getTask(taskId) : getTask(runtime.fixtures, taskId);
  const conversation = getConversation(runtime.fixtures, conversationId ?? task?.conversationId);
  const [panel, setPanel] = useState<"chat" | "info">("chat");
  const conversationKey = conversation?.id;
  const [draft, setDraft] = useState(conversationKey ? runtime.drafts[conversationKey] ?? "" : "");

  if (!task && !conversation) return <section className="page-section unavailable-page"><span className="eyebrow">WORKSPACE</span><h1>工作区不可用</h1><p>当前路由没有对应的任务或对话，或它已不在当前权限夹具中。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/">返回工作台</Link></Button></section>;

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
      <Tabs value={panel} onValueChange={(value) => setPanel(value as "chat" | "info")} className="workspace-tabs" aria-label="工作区面板"><TabsList className="workspace-tabs-list" variant="line"><TabsTrigger value="chat"><MessageCircle size={15} aria-hidden="true" />对话</TabsTrigger><TabsTrigger value="info"><Info size={15} aria-hidden="true" />{task ? "任务信息" : "对话信息"}</TabsTrigger></TabsList></Tabs>
      <div className={`workspace-layout workspace-panel-${panel}`}><section className="chat-panel" aria-label="主对话"><MessageStream conversationId={activeConversationId} /><form className="composer" onSubmit={submit}><label htmlFor="message-draft">对话共享草稿</label><Textarea id="message-draft" value={draft} onChange={(event) => { setDraft(event.target.value); if (activeConversationId) runtime.setDraft(activeConversationId, event.target.value); }} placeholder={composerDisabled ? "当前状态不可发送，但草稿仍可保留" : "继续说明目标或补充上下文…"} disabled={!activeConversationId || runtime.scene === "readonly" || runtime.persona === "viewer"} /><div className="composer-footer"><small>发送需要明确点击；断线恢复不会自动发送。</small><Button type="submit" variant="default" className="button button-primary" disabled={composerDisabled || !draft.trim()}><Send size={15} aria-hidden="true" />发送</Button></div></form></section><WorkspaceInfo taskId={task?.id} conversationId={activeConversationId} /></div>
    </section>
  );
}

function ProductionTaskWorkspaceRoute({ taskId }: { taskId: string }) {
  const source = useOptionalProjectTaskSource();
  const task = source?.getTask(taskId);
  const [deleteState, setDeleteState] = useState<"idle" | "pending" | "success">("idle");
  const lastTaskRef = useRef<typeof task>(undefined);
  useEffect(() => {
    if (task) lastTaskRef.current = task;
  }, [task]);

  if (deleteState === "success") {
    return <section className="page-section unavailable-page"><span className="eyebrow">TASK WORKSPACE</span><h1>任务已删除</h1><div className="inline-state inline-state-success" role="status">任务已删除。</div><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务列表</Link></Button></section>;
  }

  const displayedTask = task ?? (deleteState === "pending" ? lastTaskRef.current : undefined);

  if (!source || (source.status === "loading" && deleteState === "idle")) {
    return <section className="page-section unavailable-page" aria-busy="true"><span className="eyebrow">TASK WORKSPACE</span><h1>正在读取任务</h1><p>任务工作区会在真实授权数据加载完成后显示，不会使用 Demo 夹具替代项目或任务信息。</p></section>;
  }
  if ((source.status === "error" || source.status === "permission-changed") && deleteState === "idle") {
    return <section className="page-section unavailable-page"><span className="eyebrow">TASK WORKSPACE</span><h1>任务当前不可用</h1><p>{source.notice ?? "项目权限或连接状态发生变化，页面保持 fail-closed。"}</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;
  }
  if (!displayedTask) {
    return <section className="page-section unavailable-page"><span className="eyebrow">TASK WORKSPACE</span><h1>任务当前不可用</h1><p>任务不存在，或当前浏览器身份无权查看它的受保护信息。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button></section>;
  }

  const project = source.getProject(displayedTask.projectId);
  const projectPermissions = source.getProjectPermissions(displayedTask.projectId);
  return (
    <section className="workspace-page">
      <header className="workspace-heading">
        <div><span className="workspace-context">{project?.name ?? "当前无权查看项目"} / {displayedTask.id}</span><h1>{displayedTask.title}</h1><div className="workspace-meta"><span className="execution-pill execution-dot">执行服务未接通</span><span className="inline-flex items-center gap-1">任务业务状态：<TaskStateBadge state={displayedTask.state} /></span></div></div>
      </header>
      <div className="workspace-layout workspace-panel-info">
        <section className="chat-panel" aria-label="任务工作区">
          <div className="empty-state"><span className="section-kicker">SESSION / EXECUTION</span><h2>会话与执行尚未接通</h2><p>当前页面展示真实的任务、项目权限和关系数据。对话历史、审批和执行控制会在后续会话服务接入后出现在这里。</p>{project ? <Button asChild variant="secondary" className="button button-secondary"><Link to="/projects/$projectId" params={{ projectId: project.id }}>返回项目</Link></Button> : <Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">返回任务</Link></Button>}</div>
        </section>
        <aside className="workspace-info" aria-label="任务信息">
          <section className="info-block"><span className="section-kicker">任务信息</span><h2>目标</h2><p>{displayedTask.goal}</p><dl className="info-facts"><dt>项目</dt><dd>{project?.name ?? "当前无权查看"}</dd><dt>业务状态</dt><dd><TaskStateBadge state={displayedTask.state} /></dd><dt>执行状态</dt><dd>服务尚未接通</dd></dl></section>
          {deleteState === "idle" && <TaskRelationshipEditor source={source} taskId={displayedTask.id} />}
          <TaskEditor source={source} taskId={displayedTask.id} fallbackTask={displayedTask} onDeleteStarted={() => setDeleteState("pending")} onDeleteFailed={() => setDeleteState("idle")} onDeleted={() => setDeleteState("success")} />
          <section className="info-block info-note"><Info size={16} aria-hidden="true" /><p>{projectPermissions.canWrite ? "当前项目成员权限允许编辑任务与关系；会话和执行仍保持未就绪。" : "当前项目成员权限为只读；任务编辑与关系写入保持禁用。"}</p></section>
        </aside>
      </div>
    </section>
  );
}

export function TaskWorkspaceRoute() {
  const { taskId } = useParams({ from: "/tasks/$taskId" });
  return useOptionalDemoRuntime() ? <WorkspaceRoute taskId={taskId} /> : <ProductionTaskWorkspaceRoute taskId={taskId} />;
}

export function ConversationWorkspaceRoute() {
  const { conversationId } = useParams({ from: "/conversations/$conversationId" });
  const runtime = useOptionalDemoRuntime();
  if (!runtime) return <section className="page-section unavailable-page"><span className="eyebrow">CONVERSATION WORKSPACE</span><h1>对话服务尚未接通</h1><p>当前 production 不会在没有真实会话数据时调用 Demo 工作区或展示模拟历史。</p><Button asChild variant="secondary" className="button button-secondary"><Link to="/tasks">查看任务</Link></Button></section>;
  const conversation = getConversation(runtime.fixtures, conversationId);
  return <WorkspaceRoute taskId={conversation?.taskId} conversationId={conversationId} />;
}
