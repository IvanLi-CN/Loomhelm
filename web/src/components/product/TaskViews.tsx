import {
  Columns3,
  GitBranch,
  List,
  Minus,
  Plus,
  Search,
  SlidersHorizontal
} from "lucide-react";
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { taskStates, type TaskState, type TaskView } from "@/demo/types";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";
import { taskStateClasses, taskStateLabels, type ProjectTaskSource, type TaskRecord } from "@/features/tasks/types";

function parentIdsFor(task: TaskRecord): readonly string[] {
  return task.parentIds ?? (task.parentId ? [task.parentId] : []);
}

export function TaskStateBadge({ state }: { state: TaskState }) {
  return <span className={`task-state-badge ${taskStateClasses[state]}`}>{taskStateLabels[state]}</span>;
}

export function ExecutionPill({ execution, className }: { execution: TaskRecord["execution"]; className?: string }) {
  const label = execution ?? "执行服务未接通";
  return <span className={`execution-pill ${execution ? `execution-${execution}` : "execution-unavailable"}${className ? ` ${className}` : ""}`}>{label}</span>;
}

export function TaskReadRecovery({ source, taskId }: { source: ProjectTaskSource; taskId?: string }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const hasReconciliationBarrier = Boolean(taskId && source.getTaskReconciliationToken?.(taskId));

  const refresh = async () => {
    setPending(true);
    setFeedback(null);
    try {
      await source.refresh();
      setFeedback("刷新请求已完成；请确认当前任务和关系数据后再继续。");
    } catch (error) {
      setFeedback(error instanceof Error ? `刷新失败：${error.message}` : "刷新失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="error-state task-read-recovery" role="alert" data-task-read-recovery>
      <span className="empty-icon empty-icon-danger" aria-hidden="true">!</span>
      <h2>暂时无法读取任务</h2>
      {taskId && <p className="task-read-recovery-identity">任务 ID：<code>{taskId}</code></p>}
      <p>{hasReconciliationBarrier ? "任务写入结果仍待核对；刷新并完成核对前，不会恢复编辑、关系修改或删除。" : "当前页面保持保护，不会显示未确认的项目或关系数据。"}</p>
      <div className="form-actions task-read-recovery-actions">
        <Button type="button" variant="secondary" className="button button-secondary" onClick={() => { void refresh(); }} disabled={pending}>{pending ? "刷新中…" : taskId ? "刷新并核对任务" : "刷新并核对任务列表"}</Button>
        <Button asChild type="button" variant="ghost" className="button button-quiet"><Link to="/tasks">前往任务列表核对</Link></Button>
      </div>
      {feedback && <p className="task-read-recovery-feedback" role="status">{feedback}</p>}
    </div>
  );
}

interface TaskLinkOptions {
  style?: CSSProperties;
}

type RenderTaskLink = (task: TaskRecord, children: ReactNode, className: string, options?: TaskLinkOptions) => ReactNode;

function defaultRenderTaskLink(task: TaskRecord, children: ReactNode, className: string, options?: TaskLinkOptions): ReactNode {
  return <Link to="/tasks/$taskId" params={{ taskId: task.id }} className={className} style={options?.style}>{children}</Link>;
}

function TaskViewSwitch({ source, scope, value }: { source: ProjectTaskSource; scope: string; value: TaskView }) {
  const options = [
    ["list", "列表", List],
    ["board", "看板", Columns3],
    ["graph", "图谱", GitBranch]
  ] as const;
  return (
    <div className="view-switch" role="group" aria-label="任务视图">
      {options.map(([option, label, Icon]) => (
        <Button type="button" variant="secondary" className={`button button-secondary view-switch-button ${value === option ? "is-selected" : ""}`} aria-pressed={value === option} key={option} onClick={() => source.setTaskView(scope, option)}>
          <Icon size={15} aria-hidden="true" />
          <span>{label}</span>
        </Button>
      ))}
    </div>
  );
}

function TaskList({ source, tasks, renderTaskLink }: { source: ProjectTaskSource; tasks: readonly TaskRecord[]; renderTaskLink: RenderTaskLink }) {
  return (
    <div className="task-list-frame">
      <table className="task-list-table">
        <thead><tr><th scope="col">任务</th><th scope="col">项目</th><th scope="col">业务状态</th><th scope="col">执行</th></tr></thead>
        <tbody>{tasks.map((task) => { const parents = parentIdsFor(task); return <tr key={task.id} className="task-list-row"><td className="task-list-task" data-label="任务">{renderTaskLink(task, <><span className="task-id">{task.id}</span><strong className="task-title">{task.title}</strong><span className="task-goal">{task.goal}</span>{(parents.length > 0 || task.dependsOn.length > 0) && <span className="task-relations">{parents.length ? `父任务 ${parents.join(", ")}` : ""}{parents.length && task.dependsOn.length ? " · " : ""}{task.dependsOn.length ? `前置 ${task.dependsOn.join(", ")}` : ""}</span>}</>, "task-open-button")}</td><td className="task-list-project" data-label="项目"><span className="task-project-name">{source.getProject(task.projectId)?.name ?? "当前无权查看"}</span></td><td className="task-list-state" data-label="业务状态"><TaskStateBadge state={task.state} /></td><td className="task-list-execution" data-label="执行"><ExecutionPill execution={task.execution} /></td></tr>; })}</tbody>
      </table>
    </div>
  );
}

function TaskBoard({ source, tasks, renderTaskLink }: { source: ProjectTaskSource; tasks: readonly TaskRecord[]; renderTaskLink: RenderTaskLink }) {
  return (
    <div className="task-board-viewport"><div className="task-board-grid">{taskStates.map((state) => { const columnTasks = tasks.filter((task) => task.state === state); return <section className={`task-board-column ${taskStateClasses[state]}`} key={state} aria-label={`${state}任务`}><div className="task-board-column-heading"><h2>{state}</h2><span className="count">{columnTasks.length}</span></div><div className="task-board-items">{columnTasks.length ? columnTasks.map((task) => <Fragment key={task.id}>{renderTaskLink(task, <><span className="task-card-heading"><span className="task-id">{task.id}</span><TaskStateBadge state={task.state} /></span><strong className="task-card-title">{task.title}</strong><span className="task-card-goal">{task.goal}</span><span className="task-card-footer"><span className="task-card-project">{source.getProject(task.projectId)?.name ?? "当前无权查看"}</span><ExecutionPill execution={task.execution} /></span></>, "task-board-card")}</Fragment>) : <p className="task-board-empty">当前没有任务</p>}</div></section>; })}</div></div>
  );
}

interface GraphNode {
  task: TaskRecord;
  x: number;
  y: number;
}

interface ProjectGraphNode {
  id: string;
  name: string;
  taskCount: number;
  x: number;
  y: number;
}

function TaskGraph({ source, tasks, projectId, renderTaskLink }: { source: ProjectTaskSource; tasks: readonly TaskRecord[]; projectId?: string; renderTaskLink: RenderTaskLink }) {
  const [zoom, setZoom] = useState(1);
  const nodeIds = new Set(tasks.map((task) => task.id));
  const projectNodes: ProjectGraphNode[] = [...new Set(tasks.map((task) => task.projectId))].map((id, index) => ({ id, name: source.getProject(id)?.name ?? "当前无权查看", taskCount: tasks.filter((task) => task.projectId === id).length, x: 36, y: 32 + index * 140 }));
  const nodes: GraphNode[] = tasks.map((task, index) => ({ task, x: 382, y: 32 + index * 140 }));
  const byId = new Map(nodes.map((node) => [node.task.id, node]));
  const width = 700;
  const height = Math.max(260, Math.max(projectNodes.length, nodes.length) * 140 + 32);

  const edge = (sourceNode: GraphNode, targetNode: GraphNode, dependency: boolean) => {
    const sourceX = sourceNode.x + 236;
    const targetX = targetNode.x;
    const sourceY = sourceNode.y + 52;
    const targetY = targetNode.y + 52;
    const mid = (sourceX + targetX) / 2;
    return <path key={`${sourceNode.task.id}-${targetNode.task.id}-${dependency ? "dependency" : "hierarchy"}`} className={dependency ? "task-graph-edge task-graph-edge-dependency" : "task-graph-edge"} d={`M ${sourceX} ${sourceY} C ${mid} ${sourceY}, ${mid} ${targetY}, ${targetX} ${targetY}`} markerEnd={dependency ? "url(#task-arrow)" : undefined} />;
  };

  const ownershipEdge = (projectNode: ProjectGraphNode, targetNode: GraphNode) => {
    const sourceX = projectNode.x + 236;
    const targetX = targetNode.x;
    const sourceY = projectNode.y + 52;
    const targetY = targetNode.y + 52;
    const mid = (sourceX + targetX) / 2;
    return <path key={`${projectNode.id}-${targetNode.task.id}-ownership`} className="task-graph-edge task-graph-edge-ownership" d={`M ${sourceX} ${sourceY} C ${mid} ${sourceY}, ${mid} ${targetY}, ${targetX} ${targetY}`} />;
  };

  return (
    <section className="task-graph-view" aria-label="任务关系图谱">
      <div className="task-graph-header"><div className="task-graph-legend" aria-label="关系图例"><span><i className="legend-line legend-line-ownership" aria-hidden="true" />项目归属</span><span><i className="legend-line legend-line-hierarchy" aria-hidden="true" />父子层级</span><span><i className="legend-line legend-line-dashed" aria-hidden="true" />前置任务 → 后续任务</span></div><div className="task-graph-controls" role="group" aria-label="图谱缩放"><Button type="button" variant="ghost" size="icon" className="icon-button icon-button-subtle" aria-label="缩小图谱" title="缩小图谱" onClick={() => setZoom((value) => Math.max(0.7, Number((value - 0.1).toFixed(1))))}><Minus size={16} aria-hidden="true" /></Button><span>{Math.round(zoom * 100)}%</span><Button type="button" variant="ghost" size="icon" className="icon-button icon-button-subtle" aria-label="放大图谱" title="放大图谱" onClick={() => setZoom((value) => Math.min(1.4, Number((value + 0.1).toFixed(1))))}><Plus size={16} aria-hidden="true" /></Button><Button type="button" variant="secondary" className="button button-secondary" onClick={() => setZoom(1)}>重置</Button></div></div>
      <p className="task-graph-summary">{projectId ? `项目范围 · ${tasks.filter((task) => task.projectId === projectId).length} 项本地任务 · 已授权关系节点保留实际项目标签` : `全局范围 · ${tasks.length} 项任务 · 项目归属保持不变`}</p>
      {tasks.length ? <div className="task-graph-viewport" role="region" aria-label="任务关系图谱，可横向和纵向浏览"><div className="task-graph-stage" style={{ width, height }}><div className="task-graph-zoom-layer" style={{ width, height, transform: `scale(${zoom})` }}><svg className="task-graph-connectors" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><defs><marker id="task-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" className="task-graph-arrow" /></marker></defs>{projectNodes.flatMap((projectNode) => nodes.filter((node) => node.task.projectId === projectNode.id).map((node) => ownershipEdge(projectNode, node)))}{nodes.flatMap((node) => [...parentIdsFor(node.task).filter((id) => byId.has(id)).map((id) => edge(byId.get(id)!, node, false)), ...node.task.dependsOn.filter((id) => nodeIds.has(id)).map((id) => edge(byId.get(id)!, node, true))])}</svg>{projectNodes.map((projectNode) => <div className="task-graph-node task-graph-project-node" key={projectNode.id} style={{ left: projectNode.x, top: projectNode.y }}><span className="task-graph-project-kicker">项目归属</span><strong>{projectNode.name}</strong><span>{projectNode.taskCount} 项任务</span></div>)}{nodes.map(({ task, x, y }) => { const external = Boolean(projectId && task.projectId !== projectId); return <Fragment key={task.id}>{renderTaskLink(task, <><span className="task-graph-node-kicker"><span className="task-id">{task.id}</span><TaskStateBadge state={task.state} /></span><strong>{task.title}</strong><span>{source.getProject(task.projectId)?.name ?? "当前无权查看"} · {task.execution ?? "执行服务未接通"}</span></>, `task-graph-node ${external ? "task-graph-node-external" : ""}`.trim(), { style: { left: x, top: y } })}</Fragment>; })}</div></div></div> : <div className="empty-inline">当前范围没有可显示的关系。</div>}
      <div className="task-graph-node-list"><h2>节点列表</h2><ol>{tasks.map((task) => <li key={task.id}>{renderTaskLink(task, <><span className="task-id">{task.id}</span><strong>{task.title}</strong><small>{source.getProject(task.projectId)?.name ?? "当前无权查看"} · {task.state}</small></>, "")}</li>)}</ol></div>
    </section>
  );
}

export interface TaskExplorerProps {
  scope?: string;
  projectId?: string;
  source?: ProjectTaskSource;
  renderTaskLink?: RenderTaskLink;
}

export function TaskExplorer({ scope = "global", projectId, source: providedSource, renderTaskLink = defaultRenderTaskLink }: TaskExplorerProps) {
  const defaultSource = useOptionalProjectTaskSource();
  const source = providedSource ?? defaultSource;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskState | "all">("all");
  const sourceTasks = source?.getTasksForScope(projectId) ?? [];
  const tasks = useMemo(() => sourceTasks.filter((task) => { const matchesSearch = !search || `${task.id} ${task.title} ${task.goal}`.toLowerCase().includes(search.toLowerCase()); return matchesSearch && (filter === "all" || task.state === filter); }), [filter, search, sourceTasks]);

  if (!source) return <div className="error-state"><span className="empty-icon empty-icon-danger" aria-hidden="true">!</span><h2>任务暂不可用</h2><p>当前无法读取任务，请稍后再试。</p></div>;
  const view = source.getTaskView(scope);

  return (
    <div className="task-explorer" data-task-scope={scope}>
      {source.notice && <div className="inline-state inline-state-warning" role="status"><span aria-hidden="true">!</span>{source.notice}</div>}
      <div className="task-toolbar"><label className="search-field"><Search size={16} aria-hidden="true" /><span className="sr-only">搜索任务</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务、目标或编号" /></label><label className="filter-field"><SlidersHorizontal size={15} aria-hidden="true" /><span className="sr-only">任务状态筛选</span><Select value={filter} onValueChange={(value) => setFilter(value as TaskState | "all")}><SelectTrigger size="sm" className="task-filter-trigger" aria-label="任务状态筛选"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部状态</SelectItem>{taskStates.map((state) => <SelectItem value={state} key={state}>{state}</SelectItem>)}</SelectGroup></SelectContent></Select></label><TaskViewSwitch source={source} scope={scope} value={view} /></div>
      {source.status === "error" ? <TaskReadRecovery source={source} /> : source.status === "loading" ? <div className="task-loading" aria-busy="true"><span /><span /><span /></div> : source.status === "permission-changed" && !sourceTasks.length ? <TaskReadRecovery source={source} /> : !tasks.length ? <div className="empty-state"><h2>{sourceTasks.length ? "没有符合条件的任务" : "还没有任务数据"}</h2><p>{sourceTasks.length ? "调整搜索或状态筛选后再查看。" : "从当前授权项目创建一项任务，或等待项目范围接入。"}</p></div> : view === "board" ? <TaskBoard source={source} tasks={tasks} renderTaskLink={renderTaskLink} /> : view === "graph" ? <TaskGraph source={source} tasks={tasks} projectId={projectId} renderTaskLink={renderTaskLink} /> : <TaskList source={source} tasks={tasks} renderTaskLink={renderTaskLink} />}
    </div>
  );
}
