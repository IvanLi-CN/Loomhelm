import cytoscape, { type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, Hourglass, LoaderCircle } from "lucide";
import type { Task, View } from "./model";
import { dependencyLabel, taskKindLabel, type StateIconName } from "./labels";
import { buildGraphProjection, GRAPH_SHAPES, type GraphDependencyPath, type GraphProjection, type GraphProjectionNode } from "./graph-projection";

cytoscape.use(dagre);

type GraphContext = {
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
  getSelected: () => { task: string | null; group: string | null };
};

const GRAPH_STATUS_ICONS: Record<StateIconName, typeof CircleAlert> = {
  "circle-alert": CircleAlert,
  "circle-check": CircleCheck,
  "circle-dashed": CircleDashed,
  "circle-dot": CircleDot,
  hourglass: Hourglass,
  "loader-circle": LoaderCircle,
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character] ?? character);
}

function statusIconDataUrl(iconName: StateIconName | null, color: string): string | null {
  if (!iconName) return null;
  const icon = GRAPH_STATUS_ICONS[iconName];
  if (!icon) return null;
  const body = icon.map(([tag, attributes]) => {
    const values = Object.entries(attributes).map(([key, value]) => `${key}="${escapeXml(String(value))}"`).join(" ");
    return `<${tag}${values ? ` ${values}` : ""} />`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${escapeXml(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function graphNodeData(node: GraphProjectionNode, context: GraphContext): Record<string, unknown> {
  const ready = node.state === "planned" && node.stateIcon === "circle-dot";
  const data: Record<string, unknown> = {
    id: node.id,
    label: node.graphLabel,
    fullLabel: node.fullLabel,
    ref: node.refId,
    nodeKind: node.nodeKind,
    taskKind: node.taskKind,
    state: node.state,
    stateLabel: node.stateLabel,
    stateIcon: node.stateIcon,
    statusIcon: statusIconDataUrl(node.stateIcon, node.state ? context.stateColor(node.state, ready) : context.css("--muted", "#6b777b")),
    groupId: node.groupId,
    plannedGroupId: node.plannedGroupId,
    color: node.nodeKind === "group" ? context.groupColor(node.groupId) : graphNodeColor(node, context),
  };
  if (node.nodeKind !== "group" && node.parentId) data.parent = node.parentId;
  return data;
}

function graphNodeColor(node: GraphProjectionNode, context: GraphContext): string {
  if (node.nodeKind === "milestone") return context.css("--graph-milestone", "#3f6f92");
  switch (node.taskKind) {
    case "contribution": return context.css("--graph-contribution", "#2e76b5");
    case "release": return context.css("--graph-release", "#a16e1a");
    case "deployment": return context.css("--graph-deployment", "#7656a4");
    case "verification": return context.css("--graph-verification", "#287d65");
    default: return context.css("--graph-coordination", "#6b7c80");
  }
}

function nodeForSelection(graph: cytoscape.Core, selected: { task: string | null; group: string | null }) {
  if (selected.task) return graph.nodes().filter((node) => node.data("nodeKind") === "task" && node.data("ref") === selected.task);
  if (selected.group) return graph.nodes().filter((node) => node.data("nodeKind") === "group" && node.data("ref") === selected.group);
  return graph.collection();
}

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

function accessibleNodeLabel(node: GraphProjectionNode, projection: GraphProjection): string {
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
  else if (node.nodeKind === "group" || node.nodeKind === "milestone") context.selectGroup(node.refId);
}

function renderAccessibleNodes(projection: GraphProjection, context: GraphContext): void {
  const container = context.element("graph-a11y");
  container.replaceChildren();
  container.setAttribute("aria-label", `依赖图节点列表，共 ${projection.nodes.length} 个节点`);
  for (const node of projection.nodes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "graph-a11y-node";
    button.dataset.graphNodeId = node.id;
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

function highlightAccessibleSelection(projection: GraphProjection | null, context: GraphContext): void {
  const selected = context.getSelected();
  for (const button of context.element("graph-a11y").querySelectorAll<HTMLButtonElement>("[data-graph-node-id]")) {
    const node = projection?.nodes.find((item) => item.id === button.dataset.graphNodeId);
    const active = Boolean(node && ((node.nodeKind === "task" && node.refId === selected.task) || ((node.nodeKind === "group" || node.nodeKind === "milestone") && node.refId === selected.group)));
    button.setAttribute("aria-pressed", String(active));
  }
}

function graphElements(projection: GraphProjection, context: GraphContext): ElementDefinition[] {
  return [
    ...projection.nodes.map((node) => ({ data: graphNodeData(node, context) })),
    ...projection.edges.map((edge) => ({ data: { id: edge.id, source: edge.source, target: edge.target, paths: edge.paths, crossGroup: edge.crossGroup } })),
  ];
}

export function createGraphController(context: GraphContext) {
  let graph: cytoscape.Core | null = null;
  let rankDir: "TB" | "LR" | null = null;
  let projection: GraphProjection | null = null;
  const fitPadding = (): number => window.innerWidth < 768 ? 18 : window.innerWidth < 1600 ? 64 : 30;

  const highlightSelection = (): void => {
    highlightAccessibleSelection(projection, context);
    if (!graph) return;
    graph.elements().unselect();
    const target = nodeForSelection(graph, context.getSelected());
    if (target?.nonempty()) target.select();
  };

  const render = (tasks: Task[]): void => {
    const data = context.getData();
    if (!data) return;
    const wanted = new Set(tasks.map((task) => task.id));
    projection = buildGraphProjection(data, wanted);
    const visibleCount = projection.nodes.filter((node) => node.nodeKind !== "group").length;
    context.element("graph-empty").hidden = visibleCount > 0;
    const warning = context.element("graph-projection-warning");
    warning.hidden = projection.warnings.length === 0;
    warning.textContent = projection.warnings.join(" ");
    renderAccessibleNodes(projection, context);
    graph?.destroy();
    rankDir = window.innerWidth < 768 ? "TB" : "LR";
    graph = cytoscape({
      container: context.element("graph"),
      elements: graphElements(projection, context),
      style: [
        {
          selector: 'node[nodeKind = "group"]',
          style: {
            shape: GRAPH_SHAPES.group,
            label: "data(label)",
            color: context.css("--accent", "#176b70"),
            "font-size": 12,
            "font-weight": 700,
            "text-valign": "top",
            "text-halign": "left",
            "text-margin-x": 14,
            "text-margin-y": 11,
            "text-wrap": "wrap",
            "text-max-width": 190,
            "background-color": "data(color)",
            "background-opacity": 0.1,
            "border-color": "data(color)",
            "border-width": 2,
            "border-style": "dashed",
            padding: "22px",
            "compound-sizing-wrt-labels": "include",
            "background-image": "data(statusIcon)",
            "background-image-containment": "inside",
            "background-fit": "none",
            "background-repeat": "no-repeat",
            "background-width": 16,
            "background-height": 16,
            "background-position-x": "88%",
            "background-position-y": "18%",
          },
        },
        {
          selector: 'node[nodeKind = "task"]',
          style: {
            label: "data(label)",
            color: context.css("--text", "#17262b"),
            "font-size": 11,
            "font-weight": 600,
            "text-wrap": "wrap",
            "text-max-width": 156,
            "text-valign": "center",
            "text-halign": "center",
            "background-color": context.css("--surface", "#ffffff"),
            "background-opacity": 0.94,
            "border-color": "data(color)",
            "border-width": 2,
            width: 180,
            height: 76,
            "overlay-opacity": 0,
            "background-image": "data(statusIcon)",
            "background-image-containment": "inside",
            "background-fit": "none",
            "background-repeat": "no-repeat",
            "background-width": 16,
            "background-height": 16,
            "background-position-x": "88%",
            "background-position-y": "18%",
          },
        },
        { selector: 'node[taskKind = "contribution"]', style: { shape: GRAPH_SHAPES.contribution } },
        { selector: 'node[taskKind = "release"]', style: { shape: GRAPH_SHAPES.release } },
        { selector: 'node[taskKind = "deployment"]', style: { shape: GRAPH_SHAPES.deployment } },
        { selector: 'node[taskKind = "verification"]', style: { shape: GRAPH_SHAPES.verification } },
        { selector: 'node[taskKind = "coordination"]', style: { shape: GRAPH_SHAPES.coordination } },
        { selector: 'node[state = "blocked"]', style: { "border-color": context.css("--negative", "#a8443e"), "background-color": context.css("--negative", "#a8443e"), "background-opacity": 0.16, "border-width": 3 } },
        {
          selector: 'node[nodeKind = "milestone"]',
          style: {
            shape: GRAPH_SHAPES.milestone,
            label: "data(label)",
            color: context.css("--text", "#17262b"),
            "font-size": 10,
            "font-weight": 700,
            "text-wrap": "wrap",
            "text-max-width": 106,
            "text-valign": "center",
            "text-halign": "center",
            "background-color": context.css("--surface", "#ffffff"),
            "background-opacity": 1,
            "border-color": "data(color)",
            "border-width": 3,
            width: 144,
            height: 82,
          },
        },
        { selector: 'node[nodeKind = "other"]', style: { shape: GRAPH_SHAPES.coordination, width: 180, height: 76, "text-wrap": "wrap", "text-max-width": 156 } },
        {
          selector: "edge",
          style: {
            width: 1.8,
            "line-color": context.css("--border", "#789096"),
            "target-arrow-color": context.css("--border", "#789096"),
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.85,
            "overlay-opacity": 0,
          },
        },
        { selector: 'edge[crossGroup = "yes"]', style: { "line-color": context.css("--accent", "#176b70"), "target-arrow-color": context.css("--accent", "#176b70"), "line-style": "dashed" } },
        { selector: ":selected", style: { "border-width": 4, "border-color": context.css("--text", "#102327"), "line-color": context.css("--text", "#102327"), "target-arrow-color": context.css("--text", "#102327") } },
      ] as any,
      layout: { name: "dagre", rankDir, nodeSep: 36, edgeSep: 20, rankSep: 78, padding: 42, animate: false } as any,
      minZoom: 0.2,
      maxZoom: 2.5,
      userZoomingEnabled: false,
      wheelSensitivity: 0.18,
    });
    graph.on("tap", "node", (event) => {
      const node = event.target;
      const ref = node.data("ref") as string | null;
      if (node.data("nodeKind") === "group" && ref) context.selectGroup(ref);
      else if (node.data("nodeKind") === "task" && ref) context.selectTask(ref);
      else if (node.data("nodeKind") === "milestone" && ref) context.selectGroup(ref);
    });
    graph.on("mouseover", "node", (event) => {
      const node = event.target;
      const ref = node.data("ref") as string | null;
      if (!ref) return;
      context.recordPointerType((event as { originalEvent?: { pointerType?: string } }).originalEvent?.pointerType ?? null);
      const graphRect = context.element("graph").getBoundingClientRect();
      const box = node.renderedBoundingBox();
      const anchor = new DOMRect(graphRect.left + box.x1, graphRect.top + box.y1, box.w, box.h);
      const task = data.tasks.find((item) => item.id === ref);
      const group = data.groups.find((item) => item.id === ref);
      if (task) context.showHoverPreview(context.taskPreview(task), anchor);
      else if (group) context.showHoverPreview(context.groupPreview(group), anchor);
    });
    graph.on("mouseout", "node", context.hideHoverPreview);
    graph.on("zoom", () => context.setZoom(Math.round(graph!.zoom() * 100) / 100));
    graph.ready(() => {
      if (context.getViewState().zoom !== 1) graph?.zoom(context.getViewState().zoom);
      else {
        graph?.fit(undefined, fitPadding());
        if (graph) context.setZoom(Math.round(graph.zoom() * 100) / 100);
      }
      highlightSelection();
    });
  };

  const handleWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || !graph || event.deltaY === 0) return;
    event.preventDefault();
    const rect = context.element("graph").getBoundingClientRect();
    const scale = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    graph.zoom({ level: graph.zoom() * scale, renderedPosition: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
  };

  context.element("graph").addEventListener("wheel", handleWheel, { passive: false });
  return {
    render,
    highlightSelection,
    zoomIn: () => graph?.zoom({ level: graph.zoom() * 1.2, renderedPosition: { x: context.element("graph").clientWidth / 2, y: context.element("graph").clientHeight / 2 } }),
    zoomOut: () => graph?.zoom({ level: graph.zoom() / 1.2, renderedPosition: { x: context.element("graph").clientWidth / 2, y: context.element("graph").clientHeight / 2 } }),
    fit: () => { graph?.fit(undefined, fitPadding()); if (graph) context.setZoom(Math.round(graph.zoom() * 100) / 100); },
    rankDir: () => rankDir,
    projection: () => projection,
  };
}
