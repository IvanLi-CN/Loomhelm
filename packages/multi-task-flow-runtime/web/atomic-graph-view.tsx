import React, { memo, useEffect, useState } from "react";
import { createPortal, createRoot } from "react-dom/client";
import { BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import type { AtomicEdge, AtomicNode } from "../lib/atomic-orchestration";
import { inspectAtomicGraph } from "../lib/atomic-graph-order";
import { layoutProjection, type Direction, type GraphLayout } from "./graph-layout";
import { accessibleNodeLabel, highlightAccessibleSelection, renderAccessibleNodes, type GraphContext } from "./graph";
import { projectAtomicGraph } from "./graph-projection";
import type { GraphProjection, GraphProjectionNode } from "./graph-projection";
import { dependencyLabel } from "./labels";

type AtomicCardData = { title: string; kind: string; state: string; scope: string; color: string; direction: Direction; nodeId: string; nodeKind: "task" | "group" | "milestone" | "boundary"; boundary: "start" | "end" | null; taskId: string | null; groupId: string | null; evidence: string[]; blocker: string | null; acceptanceCount: number; diagnostics: string[]; displayMode: "compact" | "full"; interaction: "current" | "related" | "dim" | "none"; atomRole: "branch" | "implementation" | "pr-create" | "pr-merge" | "closeout" | "verification" | "other" };

function kindGlyph(kind: AtomicCardData["nodeKind"], boundary: AtomicCardData["boundary"], role: AtomicCardData["atomRole"]): React.ReactNode {
  const path = role === "branch"
    ? "M7 20V7m0 0 5-4m-5 4 5 4M7 13h7m0 0 3-3m-3 3 3 3"
    : role === "pr-create"
      ? "M5 4h10l4 4v12H5z M15 4v5h5 M8 14h8 M8 17h5"
      : role === "pr-merge"
        ? "M7 5v14m0-7h10m0 0-3-3m3 3-3 3 M17 5v4"
        : role === "closeout"
          ? "M5 12l4 4L19 6 M12 3a9 9 0 1 0 0 18 9 9 0 0 0-18Z"
          : kind === "group"
            ? "M12 3 20 7 12 11 4 7 12 3Z M4 12 12 16 20 12 M4 17 12 21 20 17"
            : kind === "milestone"
              ? "M12 3 21 12 12 21 3 12 12 3Z M12 8.5v7 M8.5 12h7"
              : kind === "boundary"
                ? (boundary === "start" ? "M12 3a9 9 0 1 0 0 18 9 9 0 0 0-18Z M10 8l6 4-6 4Z" : "M5 5h14v14H5Z M9 9l6 6 M15 9l-6 6")
                : role === "verification"
                  ? "M12 3l2.2 5.2L20 10l-5.8 1.8L12 17l-2.2-5.2L4 10l5.8-1.8L12 3Z M12 17v4"
                  : "M7 3.5h7l3 3V20.5H7a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 7 3.5Z M14 3.5v4h4 M8.5 12h6 M8.5 15.5h6";
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={path} /></svg>;
}

const AtomicCard = memo(function AtomicCard({ data }: NodeProps) {
  const value = data as unknown as AtomicCardData;
  if (value.nodeKind === "boundary") return <div className="dependency-card atomic-dependency-card atomic-boundary-card" data-boundary={value.boundary} data-state={value.state} data-diagnostic={value.diagnostics.length ? "true" : undefined} title={value.diagnostics.join("；")} style={{ "--node-color": value.color } as React.CSSProperties}>
    <div className="atomic-boundary-kind">{value.boundary === "start" ? "起点" : "终点"}</div>
    <div className="atomic-boundary-title">{value.title}</div>
    <Handle id="source" type="source" position={value.direction === "DOWN" ? Position.Bottom : Position.Right} />
    <Handle id="target" type="target" position={value.direction === "DOWN" ? Position.Top : Position.Left} />
  </div>;
  const compact = value.displayMode === "compact";
  const preset = value.nodeKind === "group" || value.nodeKind === "boundary" || value.nodeKind === "milestone" || ["branch", "pr-create", "pr-merge", "closeout"].includes(value.atomRole);
  const semanticLabel = `${value.kind}：${value.title}；${value.scope}；状态：${value.state}`;
  return <div className="dependency-card atomic-dependency-card" tabIndex={0} data-context-kind={value.taskId ? "task" : undefined} data-context-id={value.taskId ?? value.nodeId} data-atom-role={value.atomRole} data-state={value.state} data-interaction={value.interaction} data-display-mode={value.displayMode} data-diagnostic={value.diagnostics.length ? "true" : undefined} title={semanticLabel} aria-label={semanticLabel} onFocus={() => document.dispatchEvent(new CustomEvent("loomhelm:atomic-node-focus", { detail: { nodeId: value.nodeId, action: "focus" } }))} onBlur={() => document.dispatchEvent(new CustomEvent("loomhelm:atomic-node-focus", { detail: { nodeId: value.nodeId, action: "blur" } }))} style={{ "--node-color": value.color } as React.CSSProperties}>
    {compact ? (preset ? <div className="atomic-dependency-icon">{kindGlyph(value.nodeKind, value.boundary, value.atomRole)}</div> : <div className="atomic-custom-label">{value.title}</div>) : <>
      <div className="dependency-card-meta"><span>{value.kind}</span><span>{value.state}</span></div>
      <div className="dependency-card-title">{value.diagnostics.length ? "⚠ " : ""}{value.title}</div>
      <div className="atomic-dependency-scope">{value.scope}</div>
      <div className="atomic-dependency-facts">验收 {value.acceptanceCount} · 证据 {value.evidence.length}{value.blocker ? ` · 阻塞：${value.blocker}` : ""}</div>
    </>}
    <Handle id="source" type="source" position={value.direction === "DOWN" ? Position.Bottom : Position.Right} />
    <Handle id="target" type="target" position={value.direction === "DOWN" ? Position.Top : Position.Left} />
  </div>;
});

function atomicEdgeLabel(value: string): string {
  return value
    .split("、")
    .map((item) => item.trim())
    .filter((item) => item && item !== "source_terminal_success")
    .map((item) => item === "source_evidence" ? "证据条件" : dependencyLabel(item))
    .join("、");
}

function atomRole(title: string, nodeKind: AtomicCardData["nodeKind"]): AtomicCardData["atomRole"] {
  if (nodeKind === "milestone") return "verification";
  if (/准备.*分支/u.test(title)) return "branch";
  if (/创建.*PR/u.test(title)) return "pr-create";
  if (/合并.*PR/u.test(title)) return "pr-merge";
  if (/收口|验收/u.test(title)) return "closeout";
  if (/验证|核验|证据/u.test(title)) return "verification";
  return "implementation";
}

const AtomicRoutedEdge = memo(function AtomicRoutedEdge(props: EdgeProps) {
  const label = atomicEdgeLabel(String(props.data?.requires ?? ""));
  return <><BaseEdge id={props.id} path={String(props.data?.path ?? "")} markerEnd={props.markerEnd} style={props.style} interactionWidth={16} />{label ? <EdgeLabelRenderer><div className="atomic-dependency-edge-label" style={{ transform: `translate(-50%, -50%) translate(${props.labelX}px,${props.labelY}px)` }}>{label}</div></EdgeLabelRenderer> : null}</>;
});

const nodeTypes = { card: AtomicCard };
const edgeTypes = { routed: AtomicRoutedEdge };

function atomicProjection(nodes: readonly AtomicNode[], edges: readonly AtomicEdge[]): GraphProjection {
  const projected = projectAtomicGraph(nodes, edges);
  const inspection = inspectAtomicGraph(nodes, edges);
  const projectionNodes: GraphProjectionNode[] = projected.nodes.map((node) => {
    const source = nodes.find((candidate) => candidate.id === node.id);
    const scope = source?.kind === "work" || source?.kind === "milestone" ? source.scope : undefined;
    const taskId = scope?.kind === "task" ? scope.task_id : null;
    const groupId = scope?.kind === "task" || scope?.kind === "delivery_unit" ? scope.delivery_unit_id : null;
    const nodeKind = source?.kind === "boundary" ? "boundary" : source?.kind === "milestone" ? "milestone" : scope?.kind === "delivery_unit" ? "group" : taskId ? "task" : "other";
    return {
      id: node.id,
      parentId: null,
      nodeKind,
      sourceNodeId: node.id,
      refId: nodeKind === "task" ? taskId : nodeKind === "group" ? groupId : nodeKind === "milestone" ? node.id : null,
      groupId,
      plannedGroupId: groupId,
      taskKind: source?.kind === "work" ? source.activity_type : null,
      boundary: source?.kind === "boundary" ? source.boundary : undefined,
      state: node.status,
      stateLabel: node.status,
      stateIcon: null,
      title: node.title,
      graphLabel: node.title,
      fullLabel: `${node.kind}：${node.title}；范围：${node.scope}；状态：${node.status}；验收条件：${node.acceptance_count}；证据：${node.evidence.length}${node.blocker ? `；阻塞：${node.blocker}` : ""}`,
      evidence: node.evidence,
      blocker: node.blocker,
      acceptance_count: node.acceptance_count,
      diagnostics: inspection.nodeDiagnostics.get(node.id)?.map((code) => inspection.diagnostics.find((item) => item.code === code)?.message ?? code) ?? [],
    };
  });
  const projectionEdges = projected.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    crossGroup: "no" as const,
    paths: [{ requires: [edge.requires], sourceEdgeIds: [edge.id], boundaryNodeIds: [] }],
    diagnostics: inspection.edgeDiagnostics.get(edge.id)?.map((code) => inspection.diagnostics.find((item) => item.code === code)?.message ?? code) ?? [],
  }));
  return { nodes: projectionNodes, edges: projectionEdges, boundaryDependencies: [], warnings: inspection.diagnostics.map((item) => item.message) };
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
  let displayMode: "compact" | "full" = localStorage.getItem(`loomhelm:atomic-display-mode:${location.pathname}`) === "full" ? "full" : "compact";
  let interaction: { nodeId: string | null; scopeIds: Set<string>; source: "hover" | "selection" | "details" | null } = { nodeId: null, scopeIds: new Set(), source: null };

  function setInteraction(nodeId: string | null, source: typeof interaction.source): void {
    const item = projection?.nodes.find((node) => node.id === nodeId);
    const scopeIds = new Set<string>();
    if (item && item.nodeKind !== "boundary") {
      projection?.nodes.forEach((candidate) => {
        if (candidate.nodeKind !== "boundary" && candidate.nodeKind === item.nodeKind && candidate.groupId === item.groupId && (item.nodeKind !== "task" || candidate.refId === item.refId)) scopeIds.add(candidate.id);
      });
    }
    interaction = { nodeId, scopeIds, source };
    update?.();
  }

  function moveToNode(nodeId: string): void {
    const node = layout?.nodes.find((candidate) => candidate.node.id === nodeId);
    if (!node || !instance) return;
    instance.setCenter(node.x + node.width / 2, node.y + node.height / 2, { duration: 280, zoom: Math.max(0.75, Math.min(1.25, context.getViewState().zoom)) });
  }

  function Surface() {
    const [, refresh] = useState(0);
    useEffect(() => { update = () => refresh((value) => value + 1); return () => { update = null; }; }, []);
    const selected = context.getSelected();
    const nodes: Node[] = (layout?.nodes ?? []).map((placed) => {
      const node = placed.node;
      const taskId = node.nodeKind === "task" ? node.refId : null;
      const current = interaction.nodeId === node.id;
      const related = !current && interaction.scopeIds.has(node.id);
      const dim = Boolean(interaction.nodeId) && !current && !related;
      return {
        id: node.id,
        type: "card",
        position: { x: placed.x, y: placed.y },
        width: placed.width,
        height: placed.height,
        draggable: false,
        selectable: true,
        selected: taskId ? selected.task === taskId && (!selected.atom || selected.atom === node.id) : node.nodeKind === "group" ? selected.group === node.groupId && selected.atom === node.id : node.nodeKind === "milestone" && selected.milestone === node.id,
        style: { width: placed.width, height: placed.height },
        data: {
          title: node.title,
          kind: node.nodeKind === "boundary" ? (node.boundary === "start" ? "起点" : "终点") : node.nodeKind === "milestone" ? "里程碑" : "原子任务",
          state: node.stateLabel ?? "",
          scope: (() => { const view = context.getData(); if (node.nodeKind === "task" && taskId) { const task = view?.tasks.find((candidate) => candidate.id === taskId); return task ? `任务：${task.title}` : `任务：${taskId}`; } if (node.nodeKind === "group" && node.groupId) { const group = view?.groups.find((candidate) => candidate.id === node.groupId); return group ? `交付单元：${group.title}` : `交付单元：${node.groupId}`; } return node.groupId ? `交付单元：${node.groupId}` : "设计阶段"; })(),
          color: node.state ? context.stateColor(node.state) : context.css("--accent", "#5889c4"),
          direction,
          nodeId: node.id,
          nodeKind: node.nodeKind === "boundary" ? "boundary" : node.nodeKind === "milestone" ? "milestone" : node.nodeKind === "group" ? "group" : "task",
          boundary: node.boundary ?? null,
          taskId,
          groupId: node.groupId,
          evidence: node.evidence ?? [],
          blocker: node.blocker ?? null,
          acceptanceCount: node.acceptance_count ?? 0,
          diagnostics: node.diagnostics ?? [],
          atomRole: atomRole(node.title, node.nodeKind === "boundary" ? "boundary" : node.nodeKind === "milestone" ? "milestone" : node.nodeKind === "group" ? "group" : "task"),
          displayMode,
          interaction: current ? "current" : related ? "related" : dim ? "dim" : "none",
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
      data: { path: edge.path, requires: edge.paths.flatMap((path) => path.requires).join("、"), diagnostics: edge.paths.flatMap((path) => path.sourceEdgeIds).flatMap((id) => projection?.edges.find((item) => item.id === id)?.diagnostics ?? []) },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: context.css("--muted", "#789096") },
      style: { stroke: (edge.paths.flatMap((path) => path.sourceEdgeIds).some((id) => projection?.edges.find((item) => item.id === id)?.diagnostics?.length) ? context.css("--negative", "#e85d75") : context.css("--muted", "#789096")), strokeWidth: interaction.nodeId && (edge.source === interaction.nodeId || edge.target === interaction.nodeId) ? 3 : 1.5, opacity: interaction.nodeId && edge.source !== interaction.nodeId && edge.target !== interaction.nodeId ? 0.28 : 1 },
    }));
    return <>
      {projection?.warnings.length ? <div className="atomic-graph-warning" role="alert"><strong>依赖图存在异常</strong><span>{projection.warnings.length} 项节点或连线需要核查；异常事实仍保留在图中。</span></div> : null}
      <div className="dependency-layout-tools"><span><strong>原子依赖图</strong><small>{projection?.nodes.length ?? 0} 个节点 · {projection?.edges.length ?? 0} 条依赖</small></span></div>
      <ReactFlow className={`atomic-react-flow ${displayMode}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(value) => { instance = value; }} deleteKeyCode={null} nodesConnectable={false} nodesDraggable={false} elementsSelectable zoomOnScroll={false} zoomOnPinch panOnScroll panOnDrag preventScrolling={false} minZoom={0.15} maxZoom={2.5} onMoveEnd={(_, value) => context.setZoom(Math.round(value.zoom * 100) / 100)} onNodeClick={(_, node) => { const item = projection?.nodes.find((candidate) => candidate.id === node.id); if (!item) return; setInteraction(item.id, "selection"); moveToNode(item.id); if (item.nodeKind === "task" && item.refId) context.selectTask(item.refId, item.id); else if (item.nodeKind === "group" && item.refId) context.selectGroup(item.refId, item.id); else if (item.nodeKind === "milestone") context.selectMilestone(item.id); }} onNodeMouseEnter={(event, node) => { const item = projection?.nodes.find((candidate) => candidate.id === node.id); if (!item) return; setInteraction(item.id, "hover"); const view = context.getData(); if (!item.refId || item.nodeKind !== "task" || !view) return; const task = view.tasks.find((candidate) => candidate.id === item.refId); if (task) context.showHoverPreview(context.taskPreview(task), (event.currentTarget as HTMLElement).getBoundingClientRect()); }} onNodeMouseLeave={() => { if (interaction.source === "hover") setInteraction(null, null); context.hideHoverPreview(); }} proOptions={{ hideAttribution: false }} />
      {pending ? <span className="dependency-layout-pending" role="status">正在计算布局…</span> : null}
      {createPortal(<><label>显示 <select aria-label="节点显示" value={displayMode} onChange={(event) => { displayMode = event.target.value as "compact" | "full"; localStorage.setItem(`loomhelm:atomic-display-mode:${location.pathname}`, displayMode); signature = ""; render(latestNodes, latestEdges); }}><option value="compact">简略</option><option value="full">完整</option></select></label><label>方向 <select aria-label="排列方向" value={direction} onChange={(event) => { direction = event.target.value as Direction; signature = ""; render(latestNodes, latestEdges); }}><option value="DOWN">从上到下</option><option value="RIGHT">从左到右</option></select></label><button type="button" onClick={() => { instance?.fitView({ padding: 0.16, duration: 280 }); }}>适配画布</button></>, document.getElementById("atomic-view-tools")!)}
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
    if (!localStorage.getItem(`loomhelm:atomic-display-mode:${location.pathname}`) && projection.nodes.length < 40) displayMode = "full";
    layoutProjection(projection, direction, displayMode).then((result) => {
      if (serial !== generation) return;
      layout = result;
      pending = false;
      container.style.height = `${Math.max(420, result.height + 80)}px`;
      update?.();
      requestAnimationFrame(() => { if (serial !== generation) return; instance?.setViewport({ x: Math.max(24, (container.clientWidth - result.width) / 2), y: Math.max(24, (container.clientHeight - result.height) / 2), zoom: 1 }); context.setZoom(1); highlightAccessibleSelection(projection, context); });
    }).catch(() => { if (serial !== generation) return; pending = false; update?.(); });
  }

  function highlightSelection() { highlightAccessibleSelection(projection, context); update?.(); }
  const handleDetails = (event: Event) => { const detail = (event as CustomEvent<{ atomId?: string; parentKind?: "task" | "group"; parentId?: string; action?: "hover" | "leave" | "click" }>).detail; if (!detail?.atomId) return; if (detail.action === "leave") { if (interaction.source === "details") setInteraction(null, null); return; } const item = projection?.nodes.find((node) => node.id === detail.atomId); if (!item) return; setInteraction(item.id, "details"); if (detail.action === "click") moveToNode(item.id); };
  const handleNodeFocus = (event: Event) => { const detail = (event as CustomEvent<{ nodeId?: string; action?: "focus" | "blur" }>).detail; if (!detail?.nodeId) return; if (detail.action === "blur" && interaction.source === "hover") setInteraction(null, null); else if (detail.action === "focus") setInteraction(detail.nodeId, "hover"); };
  document.addEventListener("loomhelm:atomic-details", handleDetails);
  document.addEventListener("loomhelm:atomic-node-focus", handleNodeFocus);
  return { render, highlightSelection, zoomIn: () => instance?.zoomIn(), zoomOut: () => instance?.zoomOut(), fit: () => instance?.fitView({ padding: 0.08 }) };
}
