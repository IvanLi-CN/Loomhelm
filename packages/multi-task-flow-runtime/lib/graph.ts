import { ContractError, requireCondition } from "../lib/errors";

export interface GraphEdge {
  from: string;
  to: string;
}

export function topologicalOrder(ids: string[], edges: GraphEdge[]): string[] {
  const nodes = new Set(ids);
  requireCondition(
    nodes.size === ids.length,
    "DUPLICATE_ID",
    "Graph node IDs must be unique",
  );
  const incoming = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    requireCondition(
      nodes.has(edge.from) && nodes.has(edge.to),
      "UNKNOWN_NODE",
      "Edge references an unknown node",
    );
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    next.get(edge.from)!.push(edge.to);
  }
  const queue = ids.filter((id) => incoming.get(id) === 0);
  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const child of next.get(id)!) {
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  if (ordered.length !== ids.length)
    throw new ContractError("CYCLE", "Dependencies contain a cycle");
  return ordered;
}

export function validateGrouping(
  atoms: { id: string; task_id: string }[],
  edges: { from_atom_id: string; to_atom_id: string }[],
): void {
  topologicalOrder(
    atoms.map((atom) => atom.id),
    edges.map((edge) => ({ from: edge.from_atom_id, to: edge.to_atom_id })),
  );
  const owner = new Map(atoms.map((atom) => [atom.id, atom.task_id]));
  const taskIds = [...new Set(atoms.map((atom) => atom.task_id))];
  const taskEdges = edges
    .map((edge) => ({
      from: owner.get(edge.from_atom_id)!,
      to: owner.get(edge.to_atom_id)!,
    }))
    .filter((edge) => edge.from !== edge.to);
  topologicalOrder(taskIds, taskEdges);
  const positions = new Map(atoms.map((atom, index) => [atom.id, index]));
  for (const edge of edges) {
    if (owner.get(edge.from_atom_id) === owner.get(edge.to_atom_id)) {
      requireCondition(
        positions.get(edge.from_atom_id)! < positions.get(edge.to_atom_id)!,
        "ATOM_ORDER",
        "Atoms within a task must follow dependency order",
      );
    }
  }
}
