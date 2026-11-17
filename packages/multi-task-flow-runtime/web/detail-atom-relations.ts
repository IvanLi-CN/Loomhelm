import { ChevronRight, createElement } from "lucide";
import type { AtomicTask, View } from "./model";

export function atomRelations(
  data: View,
  atom: AtomicTask,
  options: { expanded?: boolean; onToggle?: (expanded: boolean) => void } = {},
): HTMLDetailsElement {
  const names = new Map(
    [...data.groups, ...data.tasks]
      .flatMap((owner) => owner.atoms ?? owner.planned_atoms ?? [])
      .map((node) => [node.id, node.title] as const),
  );
  for (const node of data.atomic_nodes ?? []) names.set(node.id, node.title);
  names.set(atom.id, atom.title);
  const edges =
    data.canonical_atomic_edges ??
    (data.atomic_edges ?? []).map((edge) => ({
      from_node_id: edge.from_atom_id,
      to_node_id: edge.to_atom_id,
    }));
  const before = [
    ...new Set(
      edges.filter((edge) => edge.to_node_id === atom.id).map((edge) => edge.from_node_id),
    ),
  ];
  const after = [
    ...new Set(
      edges.filter((edge) => edge.from_node_id === atom.id).map((edge) => edge.to_node_id),
    ),
  ];
  const disclosure = document.createElement("details");
  disclosure.className = "atom-relations-disclosure";
  disclosure.open = options.expanded ?? false;
  const summary = document.createElement("summary");
  const direction = atom.status === "completed" ? "后继" : "前驱";
  const neighbors = atom.status === "completed" ? after : before;
  const summaryText = document.createElement("span");
  summaryText.textContent = neighbors.length
    ? `${atom.status === "completed" ? "" : `${direction}：`}${neighbors.map((id) => names.get(id) ?? id).join("、")}`
    : `无${direction}`;
  const chevron = createElement(ChevronRight, { "aria-hidden": "true", focusable: "false" });
  chevron.classList.add("atom-relations-chevron");
  summary.append(summaryText, chevron);
  disclosure.append(summary);
  disclosure.addEventListener("toggle", () => options.onToggle?.(disclosure.open));
  const viewport = document.createElement("div");
  viewport.className = "atom-relations-viewport";
  const graph = document.createElement("div");
  graph.className = "atom-relations-graph";
  graph.setAttribute("role", "group");
  graph.setAttribute("aria-label", "原子任务关系图");
  viewport.append(graph);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  graph.append(svg);
  const nodes = new Map<string, HTMLElement>();
  const connections: { from: string; to: string; path: Element }[] = [];
  const connect = (from: string, to: string) => {
    const path = document.createElementNS(svg.namespaceURI, "path");
    svg.append(path);
    connections.push({ from, to, path });
  };
  for (const [column, ids, label] of [
    [0, before, "前驱"],
    [1, [atom.id], "当前原子任务"],
    [2, after, "后继"],
  ] as const) {
    const list = document.createElement("div");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", label);
    graph.append(list);
    if (!ids.length) {
      const empty = document.createElement("span");
      empty.className = "atom-relations-empty";

      empty.textContent = `无${label}`;
      list.append(empty);
    }
    ids.forEach((id) => {
      const node = document.createElement("div");
      node.className = "atom-relations-node";
      node.setAttribute("role", "listitem");
      node.dataset.atomId = id;
      node.dataset.current = String(column === 1);
      nodes.set(`${column}:${id}`, node);
      const title = document.createElement("span");
      title.textContent = names.get(id) ?? id;
      node.title = `${title.textContent}\n${id}`;
      node.append(title);
      list.append(node);
      if (column === 0) connect(`0:${id}`, `1:${atom.id}`);
      if (column === 2) connect(`1:${atom.id}`, `2:${id}`);
    });
  }
  const drawConnections = () => {
    const bounds = graph.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    for (const { from, to, path } of connections) {
      const source = nodes.get(from)!.getBoundingClientRect();
      const target = nodes.get(to)!.getBoundingClientRect();
      const x1 = source.right - bounds.left;
      const y1 = source.top + source.height / 2 - bounds.top;
      const x2 = target.left - bounds.left;
      const y2 = target.top + target.height / 2 - bounds.top;
      const middle = (x1 + x2) / 2;
      path.setAttribute(
        "d",
        `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2 - 2} ${y2} M ${x2 - 6} ${y2 - 3} L ${x2 - 2} ${y2} L ${x2 - 6} ${y2 + 3}`,
      );
    }
  };
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (!graph.isConnected) observer?.disconnect();
          else drawConnections();
        });
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) {
      drawConnections();
      observer?.observe(graph);
    } else observer?.disconnect();
  });
  disclosure.append(viewport);
  return disclosure;
}
