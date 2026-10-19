import {
  Columns3,
  GitBranch,
  List,
  Minus,
  Plus,
  Search,
  SlidersHorizontal
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { getProject, useDemoRuntime } from "@/demo/context";
import { taskStates, type DemoTask, type TaskState, type TaskView } from "@/demo/types";

const taskStateLabels: Record<TaskState, string> = {
  待办: "待办",
  进行中: "进行中",
  阻塞: "阻塞",
  完成: "完成",
  取消: "取消"
};

const stateClass: Record<TaskState, string> = {
  待办: "state-todo",
  进行中: "state-progress",
  阻塞: "state-blocked",
  完成: "state-done",
  取消: "state-cancelled"
};

export function TaskStateBadge({ state }: { state: TaskState }) {
  return <span className={`task-state-badge ${stateClass[state]}`}>{taskStateLabels[state]}</span>;
}

function ExecutionPill({ execution }: { execution: DemoTask["execution"] }) {
  return <span className={`execution-pill execution-${execution}`}>{execution}</span>;
}

function TaskViewSwitch({ scope, value }: { scope: string; value: TaskView }) {
  const runtime = useDemoRuntime();
  const options = [
    ["list", "列表", List],
    ["board", "看板", Columns3],
    ["graph", "图谱", GitBranch]
  ] as const;
  return (
    <div className="view-switch" role="group" aria-label="任务视图">
      {options.map(([option, label, Icon]) => (
        <button
          type="button"
          className={`button button-secondary view-switch-button ${value === option ? "is-selected" : ""}`}
          aria-pressed={value === option}
          key={option}
          onClick={() => runtime.setTaskView(scope, option)}
        >
          <Icon size={15} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function TaskList({ tasks }: { tasks: DemoTask[] }) {
  const runtime = useDemoRuntime();
  return (
    <div className="task-list-frame">
      <table className="task-list-table">
        <thead>
          <tr>
            <th scope="col">任务</th>
            <th scope="col">项目</th>
            <th scope="col">业务状态</th>
            <th scope="col">执行</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const project = getProject(runtime.fixtures, task.projectId);
            return (
              <tr key={task.id} className="task-list-row">
                <td className="task-list-task" data-label="任务">
                  <Link to="/tasks/$taskId" params={{ taskId: task.id }} className="task-open-button">
                    <span className="task-id">{task.id}</span>
                    <strong className="task-title">{task.title}</strong>
                    <span className="task-goal">{task.goal}</span>
                    {(task.parentId || task.dependsOn.length > 0) && (
                      <span className="task-relations">{task.parentId ? `父任务 ${task.parentId}` : ""}{task.parentId && task.dependsOn.length ? " · " : ""}{task.dependsOn.length ? `前置 ${task.dependsOn.join(", ")}` : ""}</span>
                    )}
                  </Link>
                </td>
                <td className="task-list-project" data-label="项目"><span className="task-project-name">{project?.name ?? "未归属项目"}</span></td>
                <td className="task-list-state" data-label="业务状态"><TaskStateBadge state={task.state} /></td>
                <td className="task-list-execution" data-label="执行"><ExecutionPill execution={task.execution} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskBoard({ tasks }: { tasks: DemoTask[] }) {
  const runtime = useDemoRuntime();
  return (
    <div className="task-board-viewport">
      <div className="task-board-grid">
        {taskStates.map((state) => {
          const columnTasks = tasks.filter((task) => task.state === state);
          return (
            <section className={`task-board-column ${stateClass[state]}`} key={state} aria-label={`${state}任务`}>
              <div className="task-board-column-heading"><h2>{state}</h2><span className="count">{columnTasks.length}</span></div>
              <div className="task-board-items">
                {columnTasks.length ? columnTasks.map((task) => (
                  <Link to="/tasks/$taskId" params={{ taskId: task.id }} className="task-board-card" key={task.id}>
                    <span className="task-card-heading"><span className="task-id">{task.id}</span><TaskStateBadge state={task.state} /></span>
                    <strong className="task-card-title">{task.title}</strong>
                    <span className="task-card-goal">{task.goal}</span>
                    <span className="task-card-footer"><span className="task-card-project">{getProject(runtime.fixtures, task.projectId)?.name}</span><ExecutionPill execution={task.execution} /></span>
                  </Link>
                )) : <p className="task-board-empty">当前没有任务</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface GraphNode {
  task: DemoTask;
  x: number;
  y: number;
}

function TaskGraph({ tasks }: { tasks: DemoTask[] }) {
  const runtime = useDemoRuntime();
  const [zoom, setZoom] = useState(1);
  const nodeIds = new Set(tasks.map((task) => task.id));
  const nodes: GraphNode[] = tasks.map((task, index) => ({
    task,
    x: index % 2 === 0 ? 36 : 382,
    y: 32 + Math.floor(index / 2) * 140
  }));
  const byId = new Map(nodes.map((node) => [node.task.id, node]));
  const width = 700;
  const height = Math.max(260, Math.ceil(nodes.length / 2) * 140 + 32);

  const edge = (source: GraphNode, target: GraphNode, dependency: boolean) => {
    const sourceX = source.x + 236;
    const targetX = target.x;
    const sourceY = source.y + 52;
    const targetY = target.y + 52;
    const mid = (sourceX + targetX) / 2;
    return <path key={`${source.task.id}-${target.task.id}-${dependency ? "dependency" : "hierarchy"}`} className={dependency ? "task-graph-edge task-graph-edge-dependency" : "task-graph-edge"} d={`M ${sourceX} ${sourceY} C ${mid} ${sourceY}, ${mid} ${targetY}, ${targetX} ${targetY}`} markerEnd={dependency ? "url(#task-arrow)" : undefined} />;
  };

  return (
    <section className="task-graph-view" aria-label="任务关系图谱">
      <div className="task-graph-header">
        <div className="task-graph-legend" aria-label="关系图例">
          <span><i className="legend-line" aria-hidden="true" />项目／父子层级</span>
          <span><i className="legend-line legend-line-dashed" aria-hidden="true" />前置任务 → 后续任务</span>
        </div>
        <div className="task-graph-controls" role="group" aria-label="图谱缩放">
          <button type="button" className="icon-button icon-button-subtle" aria-label="缩小图谱" title="缩小图谱" onClick={() => setZoom((value) => Math.max(0.7, Number((value - 0.1).toFixed(1))))}><Minus size={16} aria-hidden="true" /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-button icon-button-subtle" aria-label="放大图谱" title="放大图谱" onClick={() => setZoom((value) => Math.min(1.4, Number((value + 0.1).toFixed(1))))}><Plus size={16} aria-hidden="true" /></button>
          <button type="button" className="button button-secondary" onClick={() => setZoom(1)}>重置</button>
        </div>
      </div>
      <p className="task-graph-summary">当前范围 · {tasks.length} 项任务 · 跨项目关系保留实际项目标签</p>
      {tasks.length ? (
        <div className="task-graph-viewport" role="region" aria-label="任务关系图谱，可横向和纵向浏览">
          <div className="task-graph-stage" style={{ width, height }}>
            <div className="task-graph-zoom-layer" style={{ width, height, transform: `scale(${zoom})` }}>
              <svg className="task-graph-connectors" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
                <defs><marker id="task-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" className="task-graph-arrow" /></marker></defs>
                {nodes.flatMap((node) => [
                  ...(node.task.parentId && byId.has(node.task.parentId) ? [edge(byId.get(node.task.parentId)!, node, false)] : []),
                  ...node.task.dependsOn.filter((id) => nodeIds.has(id)).map((id) => edge(byId.get(id)!, node, true))
                ])}
              </svg>
              {nodes.map(({ task, x, y }) => {
                const external = task.projectId !== tasks[0]?.projectId;
                return (
                  <Link to="/tasks/$taskId" params={{ taskId: task.id }} className={`task-graph-node ${external ? "task-graph-node-external" : ""}`} style={{ left: x, top: y }} key={task.id}>
                    <span className="task-graph-node-kicker"><span className="task-id">{task.id}</span><TaskStateBadge state={task.state} /></span>
                    <strong>{task.title}</strong>
                    <span>{getProject(runtime.fixtures, task.projectId)?.name} · 执行：{task.execution}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      ) : <div className="empty-inline">当前范围没有可显示的关系。</div>}
      <div className="task-graph-node-list">
        <h2>节点列表</h2>
        <ol>{tasks.map((task) => <li key={task.id}><Link to="/tasks/$taskId" params={{ taskId: task.id }}><span className="task-id">{task.id}</span><strong>{task.title}</strong><small>{getProject(runtime.fixtures, task.projectId)?.name} · {task.state}</small></Link></li>)}</ol>
      </div>
    </section>
  );
}

export function TaskExplorer({ scope = "global", projectId }: { scope?: string; projectId?: string }) {
  const runtime = useDemoRuntime();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskState | "all">("all");
  const view = runtime.taskViews[scope] ?? "list";
  const sourceTasks = projectId ? runtime.fixtures.tasks.filter((task) => task.projectId === projectId) : runtime.fixtures.tasks;
  const tasks = useMemo(() => sourceTasks.filter((task) => {
    const matchesSearch = !search || `${task.id} ${task.title} ${task.goal}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (filter === "all" || task.state === filter);
  }), [filter, search, sourceTasks]);

  return (
    <div className="task-explorer">
      <div className="task-toolbar">
        <label className="search-field">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">搜索任务</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务、目标或编号" />
        </label>
        <label className="filter-field">
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span className="sr-only">任务状态筛选</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as TaskState | "all")}>
            <option value="all">全部状态</option>
            {taskStates.map((state) => <option value={state} key={state}>{state}</option>)}
          </select>
        </label>
        <TaskViewSwitch scope={scope} value={view} />
      </div>
      {runtime.scene === "loading" ? <div className="task-loading" aria-busy="true"><span /><span /><span /></div> : runtime.dataMode === "empty" || !tasks.length ? (
        <div className="empty-state"><h2>{runtime.dataMode === "empty" ? "还没有任务数据" : "没有符合条件的任务"}</h2><p>{runtime.dataMode === "empty" ? "切换到完整数据夹具，或从工作台创建一项模拟任务。" : "调整搜索或状态筛选后再查看。"}</p></div>
      ) : view === "board" ? <TaskBoard tasks={tasks} /> : view === "graph" ? <TaskGraph tasks={tasks} /> : <TaskList tasks={tasks} />}
    </div>
  );
}
