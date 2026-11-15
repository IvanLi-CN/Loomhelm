export type AtomicGraphNodeLike = {
  id: string;
  kind?: string;
  boundary?: "start" | "end";
};

export type AtomicGraphEdgeLike = {
  id: string;
  from_node_id: string;
  to_node_id: string;
};

export type AtomicGraphDiagnostic = {
  code: "cycle" | "orphan" | "missing_node" | "boundary_direction";
  message: string;
  node_ids: string[];
  edge_ids: string[];
};

export type AtomicGraphInspection = {
  order: string[];
  diagnostics: AtomicGraphDiagnostic[];
  nodeDiagnostics: Map<string, string[]>;
  edgeDiagnostics: Map<string, string[]>;
};

function stableIds(ids: Iterable<string>): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function addDiagnostic(target: Map<string, string[]>, id: string, code: string): void {
  const values = target.get(id) ?? [];
  if (!values.includes(code)) values.push(code);
  target.set(id, values);
}

function stronglyConnectedComponents(
  ids: readonly string[],
  edges: readonly AtomicGraphEdgeLike[],
): string[][] {
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (outgoing.has(edge.from_node_id) && outgoing.has(edge.to_node_id))
      outgoing.get(edge.from_node_id)?.push(edge.to_node_id);
  }
  for (const targets of outgoing.values()) targets.sort((left, right) => left.localeCompare(right));
  let index = 0;
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    indexes.set(id, index);
    lowlinks.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowlinks.set(id, Math.min(lowlinks.get(id)!, lowlinks.get(target)!));
      } else if (onStack.has(target)) {
        lowlinks.set(id, Math.min(lowlinks.get(id)!, indexes.get(target)!));
      }
    }
    if (lowlinks.get(id) !== indexes.get(id)) return;
    const component: string[] = [];
    while (true) {
      const current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
      if (current === id) break;
    }
    components.push(stableIds(component));
  };
  for (const id of stableIds(ids)) if (!indexes.has(id)) visit(id);
  return components;
}

function componentOrder(
  ids: readonly string[],
  edges: readonly AtomicGraphEdgeLike[],
  components: readonly string[][],
): string[] {
  const componentByNode = new Map(
    components.flatMap((component, index) => component.map((id) => [id, index] as const)),
  );
  const outgoing = new Map(components.map((_, index) => [index, new Set<number>()]));
  const incoming = new Map(components.map((_, index) => [index, 0]));
  for (const edge of edges) {
    const from = componentByNode.get(edge.from_node_id);
    const to = componentByNode.get(edge.to_node_id);
    if (from === undefined || to === undefined || from === to || outgoing.get(from)?.has(to))
      continue;
    outgoing.get(from)?.add(to);
    incoming.set(to, incoming.get(to)! + 1);
  }
  const key = (index: number) => components[index]?.[0] ?? "";
  const queue = components
    .map((_, index) => index)
    .filter((index) => incoming.get(index) === 0)
    .sort((left, right) => key(left).localeCompare(key(right)));
  const ordered: number[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const target of [...outgoing.get(current)!].sort((left, right) =>
      key(left).localeCompare(key(right)),
    )) {
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) {
        queue.push(target);
        queue.sort((left, right) => key(left).localeCompare(key(right)));
      }
    }
  }
  if (ordered.length !== components.length) return stableIds(ids);
  return ordered.flatMap((index) => components[index]!);
}

export function inspectAtomicGraph(
  nodes: readonly AtomicGraphNodeLike[],
  edges: readonly AtomicGraphEdgeLike[],
): AtomicGraphInspection {
  const ids = stableIds(nodes.map((node) => node.id));
  const nodeSet = new Set(ids);
  const nodeDiagnostics = new Map<string, string[]>();
  const edgeDiagnostics = new Map<string, string[]>();
  const diagnostics: AtomicGraphDiagnostic[] = [];
  const validEdges: AtomicGraphEdgeLike[] = [];
  for (const edge of edges) {
    if (!nodeSet.has(edge.from_node_id) || !nodeSet.has(edge.to_node_id)) {
      diagnostics.push({
        code: "missing_node",
        message: `依赖边 ${edge.id} 引用了不存在的原子节点。`,
        node_ids: [edge.from_node_id, edge.to_node_id].filter((id) => nodeSet.has(id)),
        edge_ids: [edge.id],
      });
      addDiagnostic(edgeDiagnostics, edge.id, "missing_node");
      for (const id of [edge.from_node_id, edge.to_node_id])
        if (nodeSet.has(id)) addDiagnostic(nodeDiagnostics, id, "missing_node");
      continue;
    }
    validEdges.push(edge);
  }
  const components = stronglyConnectedComponents(ids, validEdges);
  for (const component of components) {
    const internal = validEdges.filter(
      (edge) => component.includes(edge.from_node_id) && component.includes(edge.to_node_id),
    );
    const cyclic =
      component.length > 1 || internal.some((edge) => edge.from_node_id === edge.to_node_id);
    if (!cyclic) continue;
    const edgeIds = internal.map((edge) => edge.id).sort();
    diagnostics.push({
      code: "cycle",
      message: `原子依赖存在环：${component.join("、")}。`,
      node_ids: component,
      edge_ids: edgeIds,
    });
    for (const id of component) addDiagnostic(nodeDiagnostics, id, "cycle");
    for (const id of edgeIds) addDiagnostic(edgeDiagnostics, id, "cycle");
  }
  const starts = nodes
    .filter((node) => node.kind === "boundary" && node.boundary === "start")
    .map((node) => node.id);
  const ends = nodes
    .filter((node) => node.kind === "boundary" && node.boundary === "end")
    .map((node) => node.id);
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of validEdges) {
    outgoing.get(edge.from_node_id)?.push(edge.to_node_id);
    incoming.get(edge.to_node_id)?.push(edge.from_node_id);
  }
  const reachable = (sources: string[], direction: "outgoing" | "incoming"): Set<string> => {
    const seen = new Set<string>();
    const queue = [...sources];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of (direction === "outgoing" ? outgoing : incoming).get(id) ?? [])
        queue.push(next);
    }
    return seen;
  };
  if (starts.length && ends.length) {
    const fromStart = reachable(starts, "outgoing");
    const toEnd = reachable(ends, "incoming");
    for (const id of ids) {
      if (fromStart.has(id) && toEnd.has(id)) continue;
      diagnostics.push({
        code: "orphan",
        message: `原子节点 ${id} 不在开始到结束的完整路径上。`,
        node_ids: [id],
        edge_ids: [],
      });
      addDiagnostic(nodeDiagnostics, id, "orphan");
    }
  }
  for (const edge of validEdges) {
    const from = nodes.find((node) => node.id === edge.from_node_id);
    const to = nodes.find((node) => node.id === edge.to_node_id);
    if (from?.boundary === "start" || to?.boundary === "end") continue;
    if (from?.boundary === "end" || to?.boundary === "start") {
      diagnostics.push({
        code: "boundary_direction",
        message: `边 ${edge.id} 违反开始/结束边界方向。`,
        node_ids: [edge.from_node_id, edge.to_node_id],
        edge_ids: [edge.id],
      });
      addDiagnostic(edgeDiagnostics, edge.id, "boundary_direction");
      addDiagnostic(nodeDiagnostics, edge.from_node_id, "boundary_direction");
      addDiagnostic(nodeDiagnostics, edge.to_node_id, "boundary_direction");
    }
  }
  return {
    order: componentOrder(ids, validEdges, components),
    diagnostics,
    nodeDiagnostics,
    edgeDiagnostics,
  };
}
