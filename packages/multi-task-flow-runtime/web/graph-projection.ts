import type { Node, Task, View } from "./model";
import { stateIconName, stateLabel, type StateIconName } from "./labels";
import type { AtomicEdge, AtomicNode } from "../lib/atomic-orchestration";

export const HIDDEN_BOUNDARY_KINDS = new Set(["main_start", "main_end", "group_start", "group_end"]);

export const GRAPH_LABEL_LIMITS = {
  group: { lines: 2, columns: 14 },
  task: { lines: 3, columns: 10 },
  milestone: { lines: 2, columns: 9 },
  other: { lines: 3, columns: 10 },
} as const;

export const GRAPH_SHAPES = {
  group: "round-rectangle",
  contribution: "round-rectangle",
  release: "hexagon",
  deployment: "rhomboid",
  verification: "ellipse",
  coordination: "octagon",
  milestone: "diamond",
} as const;

export const MAX_GRAPH_PATHS = 512;

export type GraphNodeKind = "group" | "task" | "milestone" | "boundary" | "other";

export type GraphProjectionNode = {
  id: string;
  parentId: string | null;
  nodeKind: GraphNodeKind;
  boundary?: "start" | "end";
  sourceNodeId: string | null;
  refId: string | null;
  groupId: string | null;
  plannedGroupId: string | null;
  taskKind: string | null;
  state: string | null;
  stateLabel: string | null;
  stateIcon: StateIconName | null;
  title: string;
  graphLabel: string;
  fullLabel: string;
  evidence?: string[];
  blocker?: string | null;
  acceptance_count?: number;
};

export type GraphDependencyPath = {
  requires: string[];
  sourceEdgeIds: string[];
  boundaryNodeIds: string[];
  truncated?: boolean;
};

export type GraphProjectionEdge = {
  id: string;
  source: string;
  target: string;
  paths: GraphDependencyPath[];
  crossGroup: "yes" | "no";
};

export type GraphBoundaryDependency = {
  direction: "incoming" | "outgoing";
  nodeId: string;
  paths: GraphDependencyPath[];
};

export type GraphProjection = {
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  boundaryDependencies: GraphBoundaryDependency[];
  warnings: string[];
};

export type AtomicGraphProjectionNode = {
  id: string;
  kind: "work" | "milestone" | "boundary";
  title: string;
  scope: string;
  status: string;
  boundary?: "start" | "end";
  evidence: string[];
  blocker: string | null;
  acceptance_count: number;
};

export type AtomicGraphProjection = {
  nodes: AtomicGraphProjectionNode[];
  edges: { id: string; source: string; target: string; requires: string }[];
};

export function projectAtomicGraph(nodes: readonly AtomicNode[], edges: readonly AtomicEdge[]): AtomicGraphProjection {
  return {
    nodes: nodes.map((node) => {
      if (node.kind === "boundary") return { id: node.id, kind: "boundary", title: node.title, scope: "global", status: node.state, boundary: node.boundary, evidence: [], blocker: null, acceptance_count: 0 };
      if (node.kind === "milestone") return { id: node.id, kind: "milestone", title: node.title, scope: node.scope ? "milestone" : "design", status: node.state, evidence: [], blocker: null, acceptance_count: node.acceptance.length };
      const scope = !node.scope ? "design" : node.scope.kind === "task" ? `task:${node.scope.task_id} / delivery-unit:${node.scope.delivery_unit_id}` : `delivery-unit:${node.scope.delivery_unit_id}`;
      return { id: node.id, kind: "work", title: node.title, scope, status: node.state, evidence: node.result?.evidence_refs ?? node.runtime?.evidence_refs ?? [], blocker: node.blocker?.message ?? null, acceptance_count: node.acceptance.length };
    }),
    edges: edges.map((edge) => ({ id: edge.id, source: edge.from_node_id, target: edge.to_node_id, requires: edge.requires.kind })),
  };
}

export function fitGraphLabel(value: string, limit: { lines: number; columns: number }): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const capacity = limit.lines * limit.columns;
  if (!normalized || capacity <= 0) return "";
  const characters = Array.from(normalized);
  const clipped = characters.length > capacity;
  const visible = characters.slice(0, clipped ? Math.max(0, capacity - 1) : capacity);
  const lines: string[] = [];
  for (let index = 0; index < visible.length; index += limit.columns) lines.push(visible.slice(index, index + limit.columns).join(""));
  if (clipped) {
    if (!lines.length) lines.push("…");
    else lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, Math.max(0, limit.columns - 1))}…`;
  }
  return lines.join("\n");
}

function taskForNode(node: Node, tasks: Map<string, Task>): Task | null {
  return node.ref_id ? tasks.get(node.ref_id) ?? null : null;
}

function canonicalTaskKind(kind: string | null): string | null {
  if (kind === "development") return "contribution";
  if (kind === "other") return "coordination";
  return kind;
}

function currentGroupId(node: Node, task: Task | null): string | null {
  if (node.kind === "task" && task) return task.group_id || node.group_id || node.planned_group_id;
  return node.group_id ?? node.planned_group_id;
}

function plannedGroupId(node: Node): string | null {
  return node.planned_group_id ?? node.group_id;
}

function projectionNodeKind(node: Node): GraphNodeKind {
  if (node.kind === "task") return "task";
  if (node.kind === "milestone") return "milestone";
  return "other";
}

function labelLimit(kind: GraphNodeKind): { lines: number; columns: number } {
  return kind === "group" ? GRAPH_LABEL_LIMITS.group : kind === "task" ? GRAPH_LABEL_LIMITS.task : kind === "milestone" ? GRAPH_LABEL_LIMITS.milestone : GRAPH_LABEL_LIMITS.other;
}

function displayEdgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

function pathKey(path: GraphDependencyPath): string {
  return JSON.stringify([path.requires, path.sourceEdgeIds, path.boundaryNodeIds, path.truncated ?? false]);
}

function appendPath(path: GraphDependencyPath, edge: View["edges"][number], boundaryNodeId?: string): GraphDependencyPath {
  return {
    requires: edge.requires ? [...path.requires, edge.requires] : [...path.requires],
    sourceEdgeIds: [...path.sourceEdgeIds, edge.id],
    boundaryNodeIds: boundaryNodeId ? [...path.boundaryNodeIds, boundaryNodeId] : [...path.boundaryNodeIds],
  };
}

function addPath(target: GraphDependencyPath[], path: GraphDependencyPath): boolean {
  if (target.some((item) => pathKey(item) === pathKey(path))) return false;
  target.push(path);
  return true;
}

function uniqueId(candidate: string, usedIds: Set<string>): string {
  let id = candidate;
  let suffix = 2;
  while (usedIds.has(id)) id = `${candidate}:${suffix++}`;
  usedIds.add(id);
  return id;
}

type WalkState = { nodeId: string; path: GraphDependencyPath; visited: Set<string> };

type DisplayDependencyOptions = {
  boundaryEndpointIds?: ReadonlyMap<string, string>;
  syntheticOutgoing?: ReadonlyMap<string, View["edges"]>;
  syntheticBoundaryStarts?: ReadonlyMap<string, string>;
};

function walkHiddenPaths(
  initial: WalkState,
  outgoing: Map<string, View["edges"]>,
  visibleNodeIds: Set<string>,
  nodeById: Map<string, Node>,
  onVisible: (nodeId: string, path: GraphDependencyPath) => void,
  onTerminal: (path: GraphDependencyPath) => void,
  boundaryEndpointIds: ReadonlyMap<string, string> = new Map(),
): boolean {
  const queue: WalkState[] = [initial];
  let processed = 0;
  let emitted = 0;
  let overflow = false;
  while (queue.length) {
    if (processed >= MAX_GRAPH_PATHS) {
      overflow = true;
      break;
    }
    const current = queue.shift()!;
    processed += 1;
    let advanced = false;
    let blocked = false;
    for (const edge of outgoing.get(current.nodeId) ?? []) {
      const visibleTargetId = visibleNodeIds.has(edge.to_node_id)
        ? edge.to_node_id
        : boundaryEndpointIds.get(edge.to_node_id);
      if (visibleTargetId !== undefined) {
        if (visibleTargetId === current.nodeId || visibleTargetId === initial.nodeId) {
          blocked = true;
          continue;
        }
        if (emitted >= MAX_GRAPH_PATHS) {
          overflow = true;
          break;
        }
        emitted += 1;
        advanced = true;
        onVisible(visibleTargetId, appendPath(current.path, edge, visibleTargetId === edge.to_node_id ? undefined : edge.to_node_id));
        continue;
      }
      const hiddenTarget = nodeById.get(edge.to_node_id);
      if (!hiddenTarget || !HIDDEN_BOUNDARY_KINDS.has(hiddenTarget.kind) || current.visited.has(edge.to_node_id)) {
        blocked = true;
        continue;
      }
      advanced = true;
      queue.push({ nodeId: edge.to_node_id, path: appendPath(current.path, edge, edge.to_node_id), visited: new Set([...current.visited, edge.to_node_id]) });
    }
    if (overflow) break;
    if (!advanced && !blocked && current.path.boundaryNodeIds.length) onTerminal(current.path);
  }
  return overflow;
}

function findVisibleWitnesses(initial: WalkState, outgoing: Map<string, View["edges"]>, visibleNodeIds: Set<string>, nodeById: Map<string, Node>, boundaryEndpointIds: ReadonlyMap<string, string> = new Map()): Map<string, GraphDependencyPath> {
  const queue: WalkState[] = [initial];
  const visited = new Set(initial.visited);
  const witnesses = new Map<string, GraphDependencyPath>();
  let processed = 0;
  while (queue.length && processed < MAX_GRAPH_PATHS && witnesses.size < MAX_GRAPH_PATHS) {
    const current = queue.shift()!;
    processed += 1;
    for (const edge of outgoing.get(current.nodeId) ?? []) {
      if (witnesses.size >= MAX_GRAPH_PATHS) break;
      const visibleTargetId = visibleNodeIds.has(edge.to_node_id)
        ? edge.to_node_id
        : boundaryEndpointIds.get(edge.to_node_id);
      if (visibleTargetId !== undefined) {
        if (visibleTargetId !== initial.nodeId && !witnesses.has(visibleTargetId)) witnesses.set(visibleTargetId, appendPath(current.path, edge, visibleTargetId === edge.to_node_id ? undefined : edge.to_node_id));
        continue;
      }
      const hiddenTarget = nodeById.get(edge.to_node_id);
      if (!hiddenTarget || !HIDDEN_BOUNDARY_KINDS.has(hiddenTarget.kind) || visited.has(edge.to_node_id)) continue;
      visited.add(edge.to_node_id);
      if (queue.length < MAX_GRAPH_PATHS) queue.push({ nodeId: edge.to_node_id, path: appendPath(current.path, edge, edge.to_node_id), visited: new Set([edge.to_node_id]) });
    }
  }
  return witnesses;
}

function findTerminalWitnesses(initial: WalkState, outgoing: Map<string, View["edges"]>, visibleNodeIds: Set<string>, nodeById: Map<string, Node>, boundaryEndpointIds: ReadonlyMap<string, string> = new Map()): GraphDependencyPath[] {
  const queue: WalkState[] = [initial];
  const visited = new Set(initial.visited);
  const terminals: GraphDependencyPath[] = [];
  let processed = 0;
  while (queue.length && processed < MAX_GRAPH_PATHS && terminals.length < MAX_GRAPH_PATHS) {
    const current = queue.shift()!;
    processed += 1;
    let advanced = false;
    let blocked = false;
    for (const edge of outgoing.get(current.nodeId) ?? []) {
      if (visibleNodeIds.has(edge.to_node_id) || boundaryEndpointIds.has(edge.to_node_id)) {
        blocked = true;
        continue;
      }
      const hiddenTarget = nodeById.get(edge.to_node_id);
      if (!hiddenTarget || !HIDDEN_BOUNDARY_KINDS.has(hiddenTarget.kind) || visited.has(edge.to_node_id)) {
        blocked = true;
        continue;
      }
      advanced = true;
      visited.add(edge.to_node_id);
      if (queue.length < MAX_GRAPH_PATHS) queue.push({ nodeId: edge.to_node_id, path: appendPath(current.path, edge, edge.to_node_id), visited: new Set([edge.to_node_id]) });
    }
    if (!advanced && !blocked && current.path.boundaryNodeIds.length) terminals.push(current.path);
  }
  return terminals;
}

function makeDisplayDependencies(view: View, visibleNodes: Node[], visibleNodeIds: Set<string>, nodeById: Map<string, Node>, tasks: Map<string, Task>, usedIds: Set<string>, options: DisplayDependencyOptions = {}): { edges: GraphProjectionEdge[]; boundaryDependencies: GraphBoundaryDependency[]; warnings: string[] } {
  const outgoing = new Map<string, View["edges"]>();
  for (const edge of view.edges) outgoing.set(edge.from_node_id, [...(outgoing.get(edge.from_node_id) ?? []), edge]);
  for (const [sourceId, edges] of options.syntheticOutgoing ?? []) outgoing.set(sourceId, edges);
  const collapsed = new Map<string, GraphProjectionEdge>();
  const edgeIds = new Map<string, string>();
  const boundary = new Map<string, GraphBoundaryDependency>();
  const warnings: string[] = [];
  const warn = (scope: string): void => {
    const message = `图投影从 ${scope} 展开的路径超过 ${MAX_GRAPH_PATHS} 条，部分依赖路径未展开。`;
    if (!warnings.includes(message)) warnings.push(message);
  };

  const addBoundary = (direction: "incoming" | "outgoing", nodeId: string, path: GraphDependencyPath): void => {
    const key = `${direction}\u0000${nodeId}`;
    const previous = boundary.get(key);
    if (previous) addPath(previous.paths, path);
    else boundary.set(key, { direction, nodeId, paths: [path] });
  };

  for (const source of visibleNodes) {
    const syntheticBoundaryStart = options.syntheticBoundaryStarts?.get(source.id);
    const initial: WalkState = { nodeId: source.id, path: { requires: [], sourceEdgeIds: [], boundaryNodeIds: syntheticBoundaryStart ? [syntheticBoundaryStart] : [] }, visited: new Set([source.id]) };
    const pathBudget = { value: 0 };
    const addVisiblePath = (targetId: string, path: GraphDependencyPath): void => {
      const target = nodeById.get(targetId);
      if (!target) return;
      const sourceGroup = currentGroupId(source, taskForNode(source, tasks));
      const targetGroup = currentGroupId(target, taskForNode(target, tasks));
      const crossGroup: "yes" | "no" = sourceGroup && targetGroup && sourceGroup !== targetGroup ? "yes" : "no";
      const key = displayEdgeKey(source.id, targetId);
      const previous = collapsed.get(key);
      if (previous?.paths.some((item) => pathKey(item) === pathKey(path))) return;
      if (pathBudget.value >= MAX_GRAPH_PATHS) return;
      let id = edgeIds.get(key);
      if (!id) {
        id = uniqueId(`display-edge:${encodeURIComponent(source.id)}:${encodeURIComponent(targetId)}`, usedIds);
        edgeIds.set(key, id);
      }
      if (previous) addPath(previous.paths, path);
      else collapsed.set(key, { id, source: source.id, target: targetId, paths: [path], crossGroup });
      pathBudget.value += 1;
    };
    const addOutgoingPath = (path: GraphDependencyPath): void => {
      const key = `outgoing\u0000${source.id}`;
      const previous = boundary.get(key);
      if (previous?.paths.some((item) => pathKey(item) === pathKey(path))) return;
      if (pathBudget.value >= MAX_GRAPH_PATHS) return;
      if (previous) addPath(previous.paths, path);
      else addBoundary("outgoing", source.id, path);
      pathBudget.value += 1;
    };
    const overflow = walkHiddenPaths(
      initial,
      outgoing,
      visibleNodeIds,
      nodeById,
      addVisiblePath,
      addOutgoingPath,
      options.boundaryEndpointIds,
    );
    if (overflow) {
      warn(`节点 ${source.id}`);
      for (const [targetId, path] of findVisibleWitnesses(initial, outgoing, visibleNodeIds, nodeById, options.boundaryEndpointIds)) {
        const edge = collapsed.get(displayEdgeKey(source.id, targetId));
        if (!edge?.paths.some((item) => item.truncated)) addVisiblePath(targetId, { ...path, truncated: true });
      }
      for (const path of findTerminalWitnesses(initial, outgoing, visibleNodeIds, nodeById, options.boundaryEndpointIds)) addOutgoingPath({ ...path, truncated: true });
    }
  }

  const hiddenNodeIds = new Set(view.nodes.filter((node) => HIDDEN_BOUNDARY_KINDS.has(node.kind)).map((node) => node.id));
  const incoming = new Map<string, View["edges"]>();
  for (const edge of view.edges) incoming.set(edge.to_node_id, [...(incoming.get(edge.to_node_id) ?? []), edge]);
  const roots = [...hiddenNodeIds].filter((nodeId) => !(incoming.get(nodeId) ?? []).some((edge) => hiddenNodeIds.has(edge.from_node_id) || visibleNodeIds.has(edge.from_node_id)));
  for (const root of roots) {
    const initial: WalkState = { nodeId: root, path: { requires: [], sourceEdgeIds: [], boundaryNodeIds: [root] }, visited: new Set([root]) };
    const pathBudget = { value: 0 };
    const addIncomingPath = (targetId: string, path: GraphDependencyPath): void => {
      const key = `incoming\u0000${targetId}`;
      const previous = boundary.get(key);
      if (previous?.paths.some((item) => pathKey(item) === pathKey(path))) return;
      if (pathBudget.value >= MAX_GRAPH_PATHS) return;
      if (previous) addPath(previous.paths, path);
      else addBoundary("incoming", targetId, path);
      pathBudget.value += 1;
    };
    const overflow = walkHiddenPaths(
      initial,
      outgoing,
      visibleNodeIds,
      nodeById,
      addIncomingPath,
      () => undefined,
      options.boundaryEndpointIds,
    );
    if (overflow) {
      warn(`计划入口 ${root}`);
      for (const [targetId, path] of findVisibleWitnesses(initial, outgoing, visibleNodeIds, nodeById, options.boundaryEndpointIds)) {
        const dependency = boundary.get(`incoming\u0000${targetId}`);
        if (!dependency?.paths.some((item) => item.truncated)) addIncomingPath(targetId, { ...path, truncated: true });
      }
    }
  }

  return { edges: [...collapsed.values()], boundaryDependencies: [...boundary.values()], warnings };
}

export function buildGraphProjection(view: View, visibleTaskIds?: ReadonlySet<string>, visibleGroupIds?: ReadonlySet<string>): GraphProjection {
  const taskById = new Map(view.tasks.map((task) => [task.id, task]));
  const nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  const includedTasks = visibleTaskIds ?? new Set(view.tasks.map((task) => task.id));
  const visibleNodes = view.nodes.filter((node) => !HIDDEN_BOUNDARY_KINDS.has(node.kind) && (node.kind !== "task" || (!!node.ref_id && includedTasks.has(node.ref_id))));
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const groupIds = new Set(visibleNodes.map((node) => currentGroupId(node, taskForNode(node, taskById))).filter((id): id is string => !!id));
  if (visibleGroupIds) for (const groupId of visibleGroupIds) groupIds.add(groupId);
  else if (visibleTaskIds === undefined || view.tasks.every((task) => includedTasks.has(task.id))) for (const group of view.groups) groupIds.add(group.id);
  const usedNodeIds = new Set(visibleNodes.map((node) => node.id));
  const groupNodeIds = new Map<string, string>();

  const groupNodes: GraphProjectionNode[] = view.groups.filter((group) => groupIds.has(group.id)).map((group) => {
    const id = uniqueId(`group:${group.id}`, usedNodeIds);
    groupNodeIds.set(group.id, id);
    return {
      id,
      parentId: null,
      nodeKind: "group",
      sourceNodeId: null,
      refId: group.id,
      groupId: group.id,
      plannedGroupId: group.id,
      taskKind: null,
      state: group.state,
      stateLabel: stateLabel(group.state),
      stateIcon: stateIconName(group.state),
      title: group.title,
      graphLabel: fitGraphLabel(group.title, labelLimit("group")),
      fullLabel: group.title,
    };
  });

  const graphNodes: GraphProjectionNode[] = visibleNodes.map((node) => {
    const task = taskForNode(node, taskById);
    const nodeKind = projectionNodeKind(node);
    const title = task?.title ?? node.label;
    return {
      id: node.id,
      parentId: groupNodeIds.get(currentGroupId(node, task) ?? "") ?? null,
      nodeKind,
      sourceNodeId: node.id,
      refId: node.ref_id,
      groupId: currentGroupId(node, task),
      plannedGroupId: plannedGroupId(node),
      taskKind: canonicalTaskKind(task?.kind ?? null),
      state: task?.state ?? null,
      stateLabel: task ? stateLabel(task.state, task.is_ready) : null,
      stateIcon: task ? stateIconName(task.state, task.is_ready) : null,
      title,
      graphLabel: fitGraphLabel(title, labelLimit(nodeKind)),
      fullLabel: title,
    };
  });

  const nodes = [...groupNodes, ...graphNodes];
  // Empty delivery units need a synthetic endpoint so hidden boundaries still form visible relations.
  const syntheticSources: Node[] = [];
  const syntheticOutgoing = new Map<string, View["edges"]>();
  const syntheticBoundaryStarts = new Map<string, string>();
  const boundaryEndpointIds = new Map<string, string>();
  for (const group of view.groups) {
    const groupNodeId = groupNodeIds.get(group.id);
    if (!groupNodeId || visibleNodes.some((node) => currentGroupId(node, taskForNode(node, taskById)) === group.id)) continue;
    const boundaries = view.nodes.filter((node) => HIDDEN_BOUNDARY_KINDS.has(node.kind) && currentGroupId(node, taskForNode(node, taskById)) === group.id);
    for (const boundary of boundaries) boundaryEndpointIds.set(boundary.id, groupNodeId);
    const exit = boundaries.find((node) => node.kind === "group_end") ?? boundaries.find((node) => node.kind === "group_start");
    if (!exit) continue;
    const source: Node = { id: groupNodeId, kind: "milestone", ref_id: null, group_id: group.id, planned_group_id: group.id, label: group.title };
    syntheticSources.push(source);
    nodeById.set(source.id, source);
    syntheticOutgoing.set(source.id, view.edges.filter((edge) => edge.from_node_id === exit.id));
    syntheticBoundaryStarts.set(source.id, exit.id);
  }
  const dependencyNodes = [...visibleNodes, ...syntheticSources];
  const dependencyNodeIds = new Set(dependencyNodes.map((node) => node.id));
  const dependencies = makeDisplayDependencies(view, dependencyNodes, dependencyNodeIds, nodeById, taskById, new Set(nodes.map((node) => node.id)), { boundaryEndpointIds, syntheticOutgoing, syntheticBoundaryStarts });
  return { nodes, ...dependencies };
}

export function nodeTitle(projection: GraphProjection, nodeId: string): string {
  return projection.nodes.find((node) => node.id === nodeId)?.fullLabel ?? nodeId;
}
