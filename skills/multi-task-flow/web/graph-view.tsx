import { TreePalm } from 'lucide';
import React, { memo, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, BaseEdge, Handle, Position, type ReactFlowInstance, type NodeProps, type EdgeProps, type Node, type Edge, MarkerType } from '@xyflow/react';
import { buildGraphProjection, type GraphProjection } from './graph-projection';
import { layoutProjection, type GraphLayout, type Direction } from './graph-layout';
import { accessibleNodeLabel, renderAccessibleNodes, highlightAccessibleSelection, type GraphContext } from './graph';
import { taskKindLabel } from './labels';
import type { Task } from './model';

type CardData = { title: string; kind: string; state: string; idle: boolean; color: string; label: string; ports: {id:string; source:boolean}[]; direction: Direction; group: boolean };
const Card = memo(function Card({data}: NodeProps) {
  const d = data as unknown as CardData;
  return <div className={d.group ? 'dependency-group' : 'dependency-card'} style={{'--node-color':d.color} as React.CSSProperties}>
    <div className="dependency-card-meta"><span>{d.kind}</span><span className={d.idle ? "dependency-state-idle" : undefined}>{d.idle ? <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{TreePalm.map(([tag, props], i) => React.createElement(tag, {...props, key:i}))}</svg> : null}{d.state}</span></div>
    <div className="dependency-card-title">{d.title}</div>
    {d.ports.map(p => <Handle key={p.id} id={p.id} type={p.source?'source':'target'} position={d.direction==='DOWN'?(p.source?Position.Bottom:Position.Top):(p.source?Position.Right:Position.Left)} />)}
  </div>;
});
const Routed = memo(function Routed(props: EdgeProps) { return <BaseEdge id={props.id} path={String(props.data?.path ?? '')} markerEnd={props.markerEnd} style={props.style} interactionWidth={16} />; });
const nodeTypes = {card: Card}, edgeTypes = {routed: Routed};

export function createGraphController(context: GraphContext, calculateLayout = layoutProjection) {
  const container = context.element('graph');
  const root = createRoot(container);
  let projection: GraphProjection | null = null, instance: ReactFlowInstance | null = null;
  let direction: Direction = 'RIGHT', generation = 0;
  let latest: Task[] = [], update: (() => void) | null = null;
  let layout: GraphLayout | null = null, error = '', pending = false;
  let signature = '', viewportInitialized = false;
  const highlightSelection = () => { highlightAccessibleSelection(projection, context); update?.(); };
  function Surface() {
    const [, refresh] = useState(0);
    useEffect(() => { update = () => refresh(v=>v+1); return () => {update=null;}; }, []);
    const selected = context.getSelected();
    const nodes: Node[] = (layout?.nodes ?? []).map(({node:n,x,y,width,height}) => ({
      id:n.id, type:'card', position:{x,y}, width,height,
      zIndex:n.nodeKind==='group'?-1:1,
      selectable: true, draggable:false,
      ariaLabel: projection ? accessibleNodeLabel(n, projection) : n.title,
      selected:n.nodeKind==='task'?selected.task===n.refId:selected.group===n.refId,
      style:{width,height},
      data:{title:n.title,group:n.nodeKind==='group',kind:n.nodeKind==='group'?'交付单元':n.nodeKind==='milestone'?'里程碑':taskKindLabel(n.taskKind??'coordination').split(' ')[0],state:n.stateLabel??'',idle:n.state==='agent_idle',direction,
        color:n.nodeKind==='group'?context.groupColor(n.groupId):n.state?context.stateColor(n.state):context.css('--accent','#5889c4'),
        ports:(projection?.edges??[]).filter(e=>e.source===n.id||e.target===n.id).map(e=>({id:`port:${e.id}:${e.source===n.id?'source':'target'}`,source:e.source===n.id})),},
    }));
    const edges: Edge[] = (layout?.edges??[]).map(e=>({id:e.id,source:e.source,target:e.target,type:'routed',sourceHandle:`port:${e.id}:source`,targetHandle:`port:${e.id}:target`,data:{path:e.path},markerEnd:{type:MarkerType.ArrowClosed,width:16,height:16,color:context.css('--muted','#789096')},style:{stroke:context.css('--muted','#789096'),strokeWidth:1.5}}));
    return <><div className="dependency-layout-tools"><span>前置任务 → 后续任务 · 正交连线</span><label>排列方向 <select value={direction} onChange={e=>{direction=e.target.value as Direction;signature='';viewportInitialized=false;render(latest);}}><option value="DOWN">从上到下</option><option value="RIGHT">从左到右</option></select></label><button onClick={()=>{instance?.setViewport({x:24,y:24,zoom:1});context.setZoom(1);}}>100% 阅读</button></div>{error?<div role="alert" className="notice notice-warning">{error}</div>:null}<ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onInit={i=>{instance=i;}} deleteKeyCode={null} nodesConnectable={false} nodesDraggable={false} elementsSelectable={true} minZoom={0.15} maxZoom={2.5}
      zoomOnScroll={false} zoomOnPinch={true} panOnScroll={true} panOnDrag={true} preventScrolling={false}
      onMoveEnd={(_,v)=>context.setZoom(Math.round(v.zoom*100)/100)}
      onNodeClick={(_,n)=>{const item=projection?.nodes.find(p=>p.id===n.id);if(item?.refId){if(item.nodeKind==='task')context.selectTask(item.refId);else context.selectGroup(item.refId);}}}
      onNodeMouseEnter={(event,n)=>{const data=context.getData(), item=projection?.nodes.find(p=>p.id===n.id);if(!item?.refId||!data)return;const target=event.currentTarget as HTMLElement;const task=data.tasks.find(t=>t.id===item.refId),group=data.groups.find(g=>g.id===item.refId);if(task)context.showHoverPreview(context.taskPreview(task),target.getBoundingClientRect());else if(group)context.showHoverPreview(context.groupPreview(group),target.getBoundingClientRect());}}
      onNodeMouseLeave={context.hideHoverPreview} proOptions={{hideAttribution:false}} />{pending?<span className="dependency-layout-pending" role="status">正在计算布局…</span>:null}</>;
  }
  root.render(<Surface/>);
  function render(tasks: Task[]) {
    latest=tasks;const data=context.getData();if(!data)return;
    const next=buildGraphProjection(data,new Set(tasks.map(t=>t.id)));
    context.element('graph-empty').hidden=next.nodes.some(n=>n.nodeKind!=='group');
    const warning=context.element('graph-projection-warning');warning.hidden=!next.warnings.length;warning.textContent=next.warnings.join(' ');
    projection=next;renderAccessibleNodes(next,context);
    const key=JSON.stringify([direction,next.nodes.map(n=>[n.id,n.parentId,n.title]),next.edges.map(e=>[e.id,e.source,e.target])]);
    if(key===signature){if(layout){const byId=new Map(next.nodes.map(n=>[n.id,n]));layout={...layout,nodes:layout.nodes.map(p=>({...p,node:byId.get(p.node.id)!}))};}highlightSelection();return;}
    signature=key;layout=null;const serial=++generation;pending=true;error='';update?.();
    calculateLayout(next,direction).then(result=>{
      if(serial!==generation)return;const byId=new Map(projection!.nodes.map(n=>[n.id,n]));layout={...result,nodes:result.nodes.map(p=>({...p,node:byId.get(p.node.id)!}))};pending=false;container.style.height = `${Math.max(420,result.height+80)}px`;update?.();
      requestAnimationFrame(()=>{if(serial!==generation)return;if(!viewportInitialized){instance?.setViewport({x:Math.max(24,(container.clientWidth-result.width)/2),y:24,zoom:1});context.setZoom(1);viewportInitialized=true;} highlightSelection();});
    }).catch(e=>{if(serial!==generation)return;pending=false;error=`依赖图布局失败：${e instanceof Error?e.message:String(e)}`;signature='';update?.();});
  }
  return {render,highlightSelection,zoomIn:()=>instance?.zoomIn(),zoomOut:()=>instance?.zoomOut(),fit:()=>instance?.fitView({padding:0.08}),rankDir:()=>direction==='DOWN'?'TB':'LR',projection:()=>projection};
}
