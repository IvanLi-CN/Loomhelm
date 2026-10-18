const BUSINESS_STATES = ["待办", "进行中", "阻塞", "完成", "取消"];

const STATE_TOKENS = {
  "待办": "todo",
  "进行中": "progress",
  "阻塞": "blocked",
  "完成": "done",
  "取消": "cancelled"
};

const EXECUTION_TOKENS = {
  "未开始": "not-started",
  "执行中": "running",
  "等待审批": "approval",
  "等待输入": "input",
  "已结束": "done"
};

const localEscape = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[character]));

const valueText = (value, fallback = "") => value === null || value === undefined || value === "" ? fallback : String(value);

const relationIds = value => {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(item => valueText(item)).filter(Boolean))];
};

const safeToken = value => valueText(value, "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "unknown";

export function renderTasks({
  tasks = [],
  allTasks,
  projects = [],
  view = "list",
  scope = "global",
  query = "",
  status = "全部状态",
  icon,
  esc
} = {}) {
  const visibleTasks = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const completeTasks = Array.isArray(allTasks) ? allTasks.filter(Boolean) : visibleTasks;
  const escape = typeof esc === "function" ? esc : localEscape;
  const renderIcon = name => typeof icon === "function" ? icon(name) : "";
  const projectById = new Map(projects.filter(Boolean).map(project => [valueText(project.id), project]));
  const taskId = task => valueText(task?.id, "未命名任务");
  const taskTitle = task => valueText(task?.title, "未命名任务");
  const taskState = task => valueText(task?.state, "待办");
  const taskExecution = task => valueText(task?.execution, "未开始");
  const projectName = projectId => projectById.get(valueText(projectId))?.name || valueText(projectId, "未归属项目");
  const scopeName = scope === "global" || !scope ? "全部项目" : projectName(scope);
  const hasFilter = Boolean(valueText(query).trim()) || (status && status !== "全部状态");
  const newTaskButton = `<button type="button" class="button primary task-new-button" data-action="new-task">${renderIcon("plus")}<span>新建任务</span></button>`;

  const stateToken = task => STATE_TOKENS[taskState(task)] || safeToken(taskState(task));
  const executionToken = task => EXECUTION_TOKENS[taskExecution(task)] || safeToken(taskExecution(task));
  const openTaskButton = (task, className, body) => `<button type="button" class="button quiet ${className}" data-open-task="${escape(taskId(task))}" aria-label="打开任务 ${escape(taskId(task))}：${escape(taskTitle(task))}">${body}</button>`;

  const emptyState = () => {
    const title = hasFilter ? "没有匹配的任务" : "这里还没有任务";
    const message = hasFilter ? "试试其他关键词或任务状态。" : "先建立一项有明确目标的任务，再进入它的主会话开展工作。";
    return `<div class="empty task-empty" role="status">${renderIcon("task")}<h2>${title}</h2><p>${message}</p>${newTaskButton}</div>`;
  };

  const renderList = () => {
    if (!visibleTasks.length) return emptyState();
    const rows = visibleTasks.map(task => `<tr class="task-list-row">
      <td class="task-list-task" data-label="任务">
        ${openTaskButton(task, "task-open-button", `<span class="task-id">${escape(taskId(task))}</span><strong class="task-title">${escape(taskTitle(task))}</strong>`)}
      </td>
      <td class="task-list-project" data-label="项目"><span class="task-project-name">${escape(projectName(task.project))}</span></td>
      <td class="task-list-state" data-label="任务状态"><span class="badge task-state-badge" data-task-state="${escape(stateToken(task))}">${escape(taskState(task))}</span></td>
      <td class="task-list-execution" data-label="执行状态"><span class="task-execution" data-task-execution="${escape(executionToken(task))}">${escape(taskExecution(task))}</span></td>
    </tr>`).join("");
    return `<section class="task-list-view" aria-label="${escape(scopeName)}任务列表"><div class="task-list-frame"><table class="task-list-table"><caption class="task-sr-only">${escape(scopeName)}任务列表，共 ${visibleTasks.length} 项</caption><thead><tr><th scope="col">任务</th><th scope="col">项目</th><th scope="col">任务状态</th><th scope="col">执行状态</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  };

  const renderBoardCard = task => openTaskButton(task, "task-board-card", `<span class="task-card-heading"><span class="task-id">${escape(taskId(task))}</span><span class="meta task-card-project">${escape(projectName(task.project))}</span></span><strong class="task-card-title">${escape(taskTitle(task))}</strong><span class="task-card-goal muted">${escape(valueText(task.goal, "未填写目标"))}</span><span class="task-card-footer"><span class="badge task-state-badge" data-task-state="${escape(stateToken(task))}">${escape(taskState(task))}</span><span class="meta">${escape(taskExecution(task))}</span></span>`);

  const renderBoard = () => {
    const columns = BUSINESS_STATES.map(state => {
      const columnTasks = visibleTasks.filter(task => taskState(task) === state);
      return `<section class="task-board-column" data-task-state="${escape(STATE_TOKENS[state])}" aria-label="${escape(state)}，${columnTasks.length} 项"><div class="task-board-column-heading"><h2>${escape(state)}</h2><span class="meta">${columnTasks.length}</span></div><div class="task-board-items">${columnTasks.map(renderBoardCard).join("") || `<p class="meta task-board-empty">暂无任务</p>`}</div></section>`;
    }).join("");
    const emptyMessage = visibleTasks.length ? "" : emptyState();
    return `<section class="task-board-view" aria-label="${escape(scopeName)}任务看板">${emptyMessage}<div class="task-board-viewport" role="region" aria-label="任务状态看板，可横向浏览"><div class="task-board-grid">${columns}</div></div></section>`;
  };

  const renderGraph = () => {
    if (!visibleTasks.length) return emptyState();

    const allById = new Map();
    for (const task of completeTasks) allById.set(taskId(task), task);
    for (const task of visibleTasks) allById.set(taskId(task), task);

    const visibleIds = new Set(visibleTasks.map(taskId));
    const graphIds = new Set(visibleIds);
    const addNode = id => {
      const normalizedId = valueText(id);
      if (!normalizedId || graphIds.has(normalizedId) || !allById.has(normalizedId)) return false;
      graphIds.add(normalizedId);
      return true;
    };

    for (const task of visibleTasks) {
      addNode(task.parentId);
      relationIds(task.dependsOn).forEach(addNode);
    }

    for (const task of completeTasks) {
      const parentId = valueText(task.parentId);
      const dependencies = relationIds(task.dependsOn);
      if (visibleIds.has(parentId) || dependencies.some(id => visibleIds.has(id))) addNode(taskId(task));
    }

    const pending = [...graphIds];
    while (pending.length) {
      const task = allById.get(pending.shift());
      if (!task) continue;
      if (addNode(task.parentId)) pending.push(valueText(task.parentId));
      for (const dependencyId of relationIds(task.dependsOn)) if (addNode(dependencyId)) pending.push(dependencyId);
    }

    const graphTaskList = [...graphIds].map(id => allById.get(id)).filter(Boolean);
    const graphTaskIds = new Set(graphTaskList.map(taskId));
    const NODE_WIDTH = 236;
    const NODE_HEIGHT = 108;
    const PROJECT_WIDTH = 184;
    const X_STEP = 292;
    const Y_STEP = 132;
    const depthCache = new Map();

    const hierarchyDepth = (id, trail = new Set()) => {
      if (depthCache.has(id)) return depthCache.get(id);
      if (trail.has(id)) return 0;
      const task = allById.get(id);
      const parentId = valueText(task?.parentId);
      if (!task || !parentId || !graphTaskIds.has(parentId)) {
        depthCache.set(id, 0);
        return 0;
      }
      const nextTrail = new Set(trail);
      nextTrail.add(id);
      const depth = hierarchyDepth(parentId, nextTrail) + 1;
      depthCache.set(id, depth);
      return depth;
    };

    const hierarchyOrder = group => {
      const groupIds = new Set(group.map(taskId));
      const childrenByParent = new Map();
      for (const task of group) {
        const parentId = valueText(task.parentId);
        if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
        childrenByParent.get(parentId).push(task);
      }
      for (const children of childrenByParent.values()) children.sort((left, right) => taskId(left).localeCompare(taskId(right)));
      const ordered = [];
      const visited = new Set();
      const visit = task => {
        const id = taskId(task);
        if (visited.has(id)) return;
        visited.add(id);
        ordered.push(task);
        for (const child of childrenByParent.get(id) || []) visit(child);
      };
      group.filter(task => !groupIds.has(valueText(task.parentId))).sort((left, right) => taskId(left).localeCompare(taskId(right))).forEach(visit);
      group.slice().sort((left, right) => taskId(left).localeCompare(taskId(right))).forEach(task => {
        if (!visited.has(taskId(task))) visit(task);
      });
      return ordered;
    };

    const projectOrder = new Map(projects.map((project, index) => [valueText(project.id), index]));
    const graphProjects = [...new Set(graphTaskList.map(task => valueText(task.project, "unassigned")))];
    graphProjects.sort((left, right) => {
      const leftIndex = projectOrder.has(left) ? projectOrder.get(left) : Number.MAX_SAFE_INTEGER;
      const rightIndex = projectOrder.has(right) ? projectOrder.get(right) : Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.localeCompare(right);
    });
    const graphTasks = graphProjects.flatMap(projectId => hierarchyOrder(graphTaskList.filter(task => valueText(task.project, "unassigned") === projectId)));
    const nodeById = new Map();
    graphTasks.forEach((task, index) => {
      const depth = hierarchyDepth(taskId(task));
      nodeById.set(taskId(task), { task, depth, x: PROJECT_WIDTH + 72 + depth * X_STEP, y: 24 + index * Y_STEP, width: NODE_WIDTH, height: NODE_HEIGHT });
    });

    const projectGroups = new Map();
    for (const node of nodeById.values()) {
      const projectId = valueText(node.task.project, "unassigned");
      if (!projectGroups.has(projectId)) projectGroups.set(projectId, []);
      projectGroups.get(projectId).push(node);
    }
    const projectNodes = [...projectGroups.entries()].map(([projectId, nodes]) => ({
      projectId,
      name: projectName(projectId === "unassigned" ? "" : projectId),
      x: 24,
      y: Math.min(...nodes.map(node => node.y)) + 24,
      width: PROJECT_WIDTH,
      height: 60
    }));
    const projectByGraphId = new Map(projectNodes.map(node => [node.projectId, node]));
    const stageWidth = Math.max(760, PROJECT_WIDTH + 72 + Math.max(...[...nodeById.values()].map(node => node.depth), 0) * X_STEP + NODE_WIDTH + 72);
    const stageHeight = Math.max(248, graphTasks.length * Y_STEP + 28);

    const connector = (source, target, relation, markerId = "") => {
      const reverse = source.x > target.x;
      const sourceX = reverse ? source.x : source.x + source.width;
      const targetX = reverse ? target.x + target.width : target.x;
      const sourceY = source.y + source.height / 2;
      const targetY = target.y + target.height / 2;
      const bend = Math.max(44, Math.abs(targetX - sourceX) * 0.45);
      const firstControl = sourceX + (reverse ? -bend : bend);
      const secondControl = targetX - (reverse ? -bend : bend);
      return `<path class="task-graph-edge task-graph-edge-${relation}" data-relation="${relation}" d="M${sourceX},${sourceY} C${firstControl},${sourceY} ${secondControl},${targetY} ${targetX},${targetY}"${relation === "dependency" ? ` marker-end="url(#${markerId})"` : ""}/>`;
    };

    const hierarchyEdges = [];
    for (const node of nodeById.values()) {
      const parent = nodeById.get(valueText(node.task.parentId));
      if (parent) {
        hierarchyEdges.push(connector(parent, node, "hierarchy"));
      } else if (!valueText(node.task.parentId)) {
        const projectNode = projectByGraphId.get(valueText(node.task.project, "unassigned"));
        if (projectNode) hierarchyEdges.push(connector(projectNode, node, "hierarchy"));
      }
    }

    const dependencyEdges = [];
    for (const node of nodeById.values()) {
      for (const dependencyId of relationIds(node.task.dependsOn)) {
        const dependency = nodeById.get(dependencyId);
        if (dependency) dependencyEdges.push(connector(dependency, node, "dependency", `task-dependency-arrow-${safeToken(scope)}`));
      }
    }

    const markerId = `task-dependency-arrow-${safeToken(scope)}`;
    const graphNodes = [...nodeById.values()].map(node => {
      const task = node.task;
      const external = !visibleIds.has(taskId(task));
      const dependencyCount = relationIds(task.dependsOn).length;
      const relationText = valueText(task.parentId) ? `上级任务 ${task.parentId}` : "无上级任务";
      const dependencyText = dependencyCount ? `前置依赖 ${dependencyCount} 项` : "无前置依赖";
      const label = `${taskId(task)}，${taskTitle(task)}，项目 ${projectName(task.project)}，业务状态 ${taskState(task)}，执行状态 ${taskExecution(task)}，${relationText}，${dependencyText}${external ? "，筛选外的关联任务" : ""}`;
      return `<button type="button" class="button quiet task-graph-node${external ? " task-graph-node-external" : ""}" data-open-task="${escape(taskId(task))}" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;min-height:${node.height}px" aria-label="${escape(label)}"><span class="task-graph-node-kicker"><span class="task-id">${escape(taskId(task))}</span><span>${escape(taskState(task))}</span></span><strong class="task-graph-node-title">${escape(taskTitle(task))}</strong><span class="task-graph-node-project">${escape(projectName(task.project))}</span><span class="meta">执行：${escape(taskExecution(task))}</span></button>`;
    }).join("");

    const projectMarkup = projectNodes.map(node => `<div class="task-graph-project-node" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;min-height:${node.height}px" role="group" aria-label="项目 ${escape(node.name)}"><span class="meta">项目</span><strong>${escape(node.name)}</strong></div>`).join("");
    const nodeList = graphTasks.map(task => `<li>${openTaskButton(task, "task-graph-list-link", `<span class="task-id">${escape(taskId(task))}</span><strong>${escape(taskTitle(task))}</strong><span class="meta">${escape(projectName(task.project))} · ${escape(taskState(task))} · 执行：${escape(taskExecution(task))}</span>`)}</li>`).join("");

    return `<section class="task-graph-view" aria-label="${escape(scopeName)}任务关系图谱"><div class="task-graph-header"><div class="task-graph-legend" aria-label="关系图例"><span class="task-legend-item"><span class="task-legend-swatch task-legend-hierarchy" aria-hidden="true"></span>项目／父子层级</span><span class="task-legend-item"><span class="task-legend-swatch task-legend-dependency" aria-hidden="true"></span>前置任务 → 后续任务</span></div><div class="task-graph-zoom-controls" role="group" aria-label="图谱缩放"><button type="button" class="button quiet task-zoom-button" data-task-zoom="out" aria-label="缩小图谱">${renderIcon("minus")}</button><button type="button" class="button quiet task-zoom-button" data-task-zoom="in" aria-label="放大图谱">${renderIcon("plus")}</button><button type="button" class="button quiet task-zoom-reset" data-task-zoom="reset">重置</button></div></div><p class="task-sr-only">实线表示项目与父子任务的层级关系；虚线箭头从前置任务指向后续任务。图谱仅用于查看，节点不可拖动。</p><div class="task-graph-viewport" role="region" aria-label="任务关系图谱，可横向和纵向浏览"><div class="task-graph-stage" style="width:${stageWidth}px;height:${stageHeight}px"><svg class="task-graph-connectors" width="${stageWidth}" height="${stageHeight}" viewBox="0 0 ${stageWidth} ${stageHeight}" aria-hidden="true" focusable="false"><defs><marker id="${markerId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="task-graph-arrow" d="M0 0L8 4L0 8Z"/></marker></defs>${hierarchyEdges.join("")}${dependencyEdges.join("")}</svg>${projectMarkup}${graphNodes}</div></div><nav class="task-graph-node-list" aria-label="图谱任务节点"><h2>节点列表</h2><ol>${nodeList}</ol></nav></section>`;
  };

  if (view === "board") return renderBoard();
  if (view === "graph") return renderGraph();
  return renderList();
}
