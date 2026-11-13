import React, { memo, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import type { AtomicEdge, AtomicNode } from "../lib/atomic-orchestration";
import { layoutProjection, type Direction, type GraphLayout } from "./graph-layout";
import { accessibleNodeLabel, highlightAccessibleSelection, renderAccessibleNodes, type GraphContext } from "./graph";
import { projectAtomicGraph } from "./graph-projection";
import type { GraphProjection, GraphProjectionNode } from "./graph-projection";

type AtomicCardData = { title: string; kind: string; state: string; scope: string; color: string; direction: Direction; nodeId: string; taskId: string | null; evidence: string[]; blocker: string | null; acceptanceCount: number };

const AtomicCard = memo(function AtomicCard({ data }: NodeProps) {
  const value = data as unknown as AtomicCardData;
  return <div className="dependency-card atomic-dependency-card" data-context-kind={value.taskId ? "task" : undefined} data-context-id={value.taskId ?? value.nodeId} data-state={value.state} style={{ "--node-color": value.color } as React.CSSProperties}>
    <div className="dependency-card-meta"><span>{value.kind}</span><span>{value.state}</span></div>
    <div className="dependency-card-title">{value.title}</div>
    <div className="atomic-dependency-scope">{value.scope}</div>
    <div className="atomic-dependency-facts">验收 {value.acceptanceCount} · 证据 {value.evidence.length}{value.blocker ? ` · 阻塞：${value.blocker}` : ""}</div>
    <Handle id="source" type="source" position={value.direction === "DOWN" ? Position.Bottom : Position.Right} />
    <Handle id="target" type="target" position={value.direction === "DOWN" ? Position.Top : Position.Left} />
  </div>;
});

const AtomicRoutedEdge = memo(function AtomicRoutedEdge(props: EdgeProps) {
  const label = String(props.data?.requires ?? "");
  return <><BaseEdge id={props.id} path={String(props.data?.path ?? "")} markerEnd={props.markerEnd} style={props.style} interactionWidth={16} />{label ? <EdgeLabelRenderer><div className="atomic-dependency-edge-label" style={{ transform: `translate(-50%, -50%) translate(${props.labelX}px,${props.labelY}px)` }}>{label}</div></EdgeLabelRenderer> : null}</>;
});

const nodeTypes = { card: AtomicCard };
const edgeTypes = { routed: AtomicRoutedEdge };

function atomicProjection(nodes: readonly AtomicNode[], edges: readonly AtomicEdge[]): GraphProjection {
  const projected = projectAtomicGraph(nodes, edges);
  const projectionNodes: GraphProjectionNode[] = projected.nodes.map((node) => {
    const source = nodes.find((candidate) => candidate.id === node.id);
    const scope = source?.kind === "work" || source?.kind === "milestone" ? source.scope : undefined;
    const taskId = scope?.kind === "task" ? scope.task_id : null;
    const nodeKind = source?.kind === "milestone" ? "milestone" : taskId ? "task" : "other";
    return {
      id: node.id,
      parentId: null,
      nodeKind,
      sourceNodeId: node.id,
      refId: nodeKind === "task" ? taskId : nodeKind === "milestone" ? node.id : null,
      groupId: scope?.kind === "task" ? scope.delivery_unit_id : scope?.kind === "delivery_unit" ? scope.delivery_unit_id : null,
      plannedGroupId: scope?.kind === "task" ? scope.delivery_unit_id : scope?.kind === "delivery_unit" ? scope.delivery_unit_id : null,
      taskKind: source?.kind === "work" ? source.activity_type : null,
      state: node.status,
      stateLabel: node.status,
      stateIcon: null,
      title: node.title,
      graphLabel: node.title,
      fullLabel: `${node.kind}：${node.title}；范围：${node.scope}；状态：${node.status}；验收条件：${node.acceptance_count}；证据：${node.evidence.length}${node.blocker ? `；阻塞：${node.blocker}` : ""}`,
      evidence: node.evidence,
      blocker: node.blocker,
      acceptance_count: node.acceptance_count,
    };
  });
  const projectionEdges = projected.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    crossGroup: "no" as const,
    paths: [{ requires: [edge.requires], sourceEdgeIds: [edge.id], boundaryNodeIds: [] }],
  }));
  return { nodes: projectionNodes, edges: projectionEdges, boundaryDependencies: [], warnings: [] };
}

export function createAtomicGraphController(context: GraphContext) {
  const container = context.element("atomic-graph");
  const root = createRoot(container);
  let projection: GraphProjection | null = null;
  let layout: GraphLayout | null = null;
  let instance: ReactFlowInstance | null = null;
  let direction: Direction = "RIGHT";
  let generation = 0;
  let pending = false;
  let signature = "";
  let latestNodes: readonly AtomicNode[] = [];
  let latestEdges: readonly AtomicEdge[] = [];
  let update: (() => void) | null = null;

  function Surface() {
    const [, refresh] = useState(0);
    useEffect(() => { update = () => refresh((value) => value + 1); return () => { update = null; }; }, []);
    const selected = context.getSelected();
    const nodes: Node[] = (layout?.nodes ?? []).map((placed) => {
      const node = placed.node;
      const taskId = node.nodeKind === "task" ? node.refId : null;
      return {
        id: node.id,
        type: "card",
        position: { x: placed.x, y: placed.y },
        width: placed.width,
        height: placed.height,
        draggable: false,
        selectable: true,
        selected: taskId ? selected.task === taskId : node.nodeKind === "milestone" && selected.milestone === node.id,
        style: { width: placed.width, height: placed.height },
        data: {
          title: node.title,
          kind: node.nodeKind === "milestone" ? "里程碑" : "原子任务",
          state: node.stateLabel ?? "",
          scope: node.groupId ? `交付单元 ${node.groupId}` : "设计阶段",
          color: node.state ? context.stateColor(node.state) : context.css("--accent", "#5889c4"),
          direction,
          nodeId: node.id,
          taskId,
          evidence: node.evidence ?? [],
          blocker: node.blocker ?? null,
          acceptanceCount: node.acceptance_count ?? 0,
        },
      };
    });
    const edges: Edge[] = (layout?.edges ?? []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "routed",
      sourceHandle: "source",
      targetHandle: "target",
      data: { path: edge.path, requires: edge.paths.flatMap((path) => path.requires).join("、") },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: context.css("--muted", "#789096") },
      style: { stroke: context.css("--muted", "#789096"), strokeWidth: 1.5 },
    }));
    return <>
      <div className="dependency-layout-tools"><span>原子任务 → 后续原子任务 · 条件连线</span><label>排列方向 <select value={direction} onChange={(event) => { direction = event.target.value as Direction; signature = ""; render(latestNodes, latestEdges); }}><option value="DOWN">从上到下</option><option value="RIGHT">从左到右</option></select></label><button onClick={() => { instance?.setViewport({ x: 24, y: 24, zoom: 1 }); context.setZoom(1); }}>100% 阅读</button></div>
      <ReactFlow className="atomic-react-flow" nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(value) => { instance = value; }} deleteKeyCode={null} nodesConnectable={false} nodesDraggable={false} elementsSelectable zoomOnScroll={false} zoomOnPinch panOnScroll panOnDrag preventScrolling={false} minZoom={0.15} maxZoom={2.5} onMoveEnd={(_, value) => context.setZoom(Math.round(value.zoom * 100) / 100)} onNodeClick={(_, node) => { const item = projection?.nodes.find((candidate) => candidate.id === node.id); if (!item) return; if (item.nodeKind === "task" && item.refId) context.selectTask(item.refId); else if (item.nodeKind === "milestone") context.selectMilestone(item.id); }} onNodeMouseEnter={(event, node) => { const item = projection?.nodes.find((candidate) => candidate.id === node.id); const view = context.getData(); if (!item?.refId || item.nodeKind !== "task" || !view) return; const task = view.tasks.find((candidate) => candidate.id === item.refId); if (task) context.showHoverPreview(context.taskPreview(task), (event.currentTarget as HTMLElement).getBoundingClientRect()); }} onNodeMouseLeave={context.hideHoverPreview} proOptions={{ hideAttribution: false }} />
      {pending ? <span className="dependency-layout-pending" role="status">正在计算布局…</span> : null}
    </>;
  }

  root.render(<Surface />);

  function render(nodes: readonly AtomicNode[], edges: readonly AtomicEdge[]) {
    latestNodes = nodes;
    latestEdges = edges;
    projection = atomicProjection(nodes, edges);
    renderAccessibleNodes(projection, context);
    const key = JSON.stringify([direction, projection.nodes.map((node) => [node.id, node.title]), projection.edges.map((edge) => [edge.id, edge.source, edge.target])]);
    if (key === signature) { highlightAccessibleSelection(projection, context); update?.(); return; }
    signature = key;
    const serial = ++generation;
    pending = true;
    update?.();
    layoutProjection(projection, direction).then((result) => {
      if (serial !== generation) return;
      layout = result;
      pending = false;
      container.style.height = `${Math.max(420, result.height + 80)}px`;
      update?.();
      requestAnimationFrame(() => { if (serial !== generation) return; instance?.setViewport({ x: Math.max(24, (container.clientWidth - result.width) / 2), y: 24, zoom: 1 }); context.setZoom(1); highlightAccessibleSelection(projection, context); });
    }).catch(() => { if (serial !== generation) return; pending = false; update?.(); });
  }

  function highlightSelection() { highlightAccessibleSelection(projection, context); update?.(); }
  return { render, highlightSelection, zoomIn: () => instance?.zoomIn(), zoomOut: () => instance?.zoomOut(), fit: () => instance?.fitView({ padding: 0.08 }) };
}
