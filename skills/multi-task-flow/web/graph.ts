import type { Task, View } from "./model";
import { dependencyLabel, taskKindLabel } from "./labels";
import type { GraphDependencyPath, GraphProjection, GraphProjectionNode } from "./graph-projection";
export { createGraphController } from "./graph-view";

export type GraphContext = {
  element: <T extends HTMLElement>(id: string) => T;
  getData: () => View | null;
  getViewState: () => { zoom: number };
  setZoom: (zoom: number) => void;
  css: (name: string, fallback: string) => string;
  stateColor: (state: string, ready?: boolean) => string;
  groupColor: (groupId: string | null) => string;
  taskPreview: (task: Task) => HTMLElement;
  groupPreview: (group: View["groups"][number]) => HTMLElement;
  showHoverPreview: (content: HTMLElement, anchor: DOMRect) => void;
  hideHoverPreview: () => void;
  recordPointerType: (pointerType: string | null) => void;
  selectTask: (id: string) => void;
  selectGroup: (id: string) => void;
  selectMilestone: (id: string) => void;
  getSelected: () => { task: string | null; group: string | null; milestone: string | null };
};

function nodeKindLabel(node: GraphProjectionNode): string {
  if (node.nodeKind === "group") return "交付单元";
  if (node.nodeKind === "task") return taskKindLabel(node.taskKind ?? "coordination");
  if (node.nodeKind === "milestone") return "里程碑 milestone";
  return "节点";
}

function pathLabel(path: GraphDependencyPath): string {
  const conditions = path.requires.length ? path.requires.map(dependencyLabel).join(" → ") : "未声明条件";
  const edges = path.sourceEdgeIds.length ? path.sourceEdgeIds.join("、") : "无";
  return `条件：${conditions}；原始边：${edges}${path.truncated ? "；其余路径已省略" : ""}`;
}

function dependencyLabels(projection: GraphProjection, nodeId: string, direction: "incoming" | "outgoing"): string[] {
  const values = projection.edges
    .filter((edge) => direction === "incoming" ? edge.target === nodeId : edge.source === nodeId)
    .map((edge) => {
      const neighborId = direction === "incoming" ? edge.source : edge.target;
      const neighbor = projection.nodes.find((node) => node.id === neighborId)?.fullLabel ?? neighborId;
      return `${neighbor}（${edge.paths.map(pathLabel).join("；")}）`;
    });
  values.push(...projection.boundaryDependencies
    .filter((item) => item.direction === direction && item.nodeId === nodeId)
    .map((item) => `${direction === "incoming" ? "计划入口" : "计划出口"}（${item.paths.map(pathLabel).join("；")}）`));
  return values;
}

export function accessibleNodeLabel(node: GraphProjectionNode, projection: GraphProjection): string {
  const parts = [`${nodeKindLabel(node)}：${node.title}`];
  if (node.stateLabel) parts.push(`状态：${node.stateLabel}`);
  const incoming = dependencyLabels(projection, node.id, "incoming");
  const outgoing = dependencyLabels(projection, node.id, "outgoing");
  if (incoming.length) parts.push(`前驱：${incoming.join("；")}`);
  if (outgoing.length) parts.push(`后继：${outgoing.join("；")}`);
  return parts.join("；");
}

function selectedProjectionNode(node: GraphProjectionNode, context: GraphContext): void {
  if (!node.refId) return;
  if (node.nodeKind === "task") context.selectTask(node.refId);
  else if (node.nodeKind === "group") context.selectGroup(node.refId);
  else if (node.nodeKind === "milestone") context.selectMilestone(node.id);
}

export function renderAccessibleNodes(projection: GraphProjection, context: GraphContext): void {
  const container = context.element("graph-a11y");
  container.replaceChildren();
  container.setAttribute("aria-label", `依赖图节点列表，共 ${projection.nodes.length} 个节点`);
  for (const node of projection.nodes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "graph-a11y-node";
    button.dataset.graphNodeId = node.id;
    if ((node.nodeKind === "task" || node.nodeKind === "group" || node.nodeKind === "milestone") && node.refId) {
      button.dataset.contextKind = node.nodeKind === "task" ? "task" : node.nodeKind === "milestone" ? "milestone" : "group";
      button.dataset.contextId = node.nodeKind === "milestone" ? node.id : node.refId;
      if (node.nodeKind === "task") button.dataset.contextTask = node.refId;
    }
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", accessibleNodeLabel(node, projection));
    button.textContent = `${node.title}${node.stateLabel ? ` · ${node.stateLabel}` : ""}`;
    button.addEventListener("click", () => selectedProjectionNode(node, context));
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    item.append(button);
    container.append(item);
  }
}

export function highlightAccessibleSelection(projection: GraphProjection | null, context: GraphContext): void {
  const selected = context.getSelected();
  for (const button of context.element("graph-a11y").querySelectorAll<HTMLButtonElement>("[data-graph-node-id]")) {
    const node = projection?.nodes.find((item) => item.id === button.dataset.graphNodeId);
    const active = Boolean(node && ((node.nodeKind === "task" && node.refId === selected.task) || (node.nodeKind === "group" && node.refId === selected.group) || (node.nodeKind === "milestone" && node.id === selected.milestone)));
    button.setAttribute("aria-pressed", String(active));
  }
}
