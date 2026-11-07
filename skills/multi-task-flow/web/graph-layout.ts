import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { GraphProjection, GraphProjectionNode } from './graph-projection';

export const CARD_WIDTH = 184;
export const CARD_HEIGHT = 76;

export function cardSize(title: string): {width:number;height:number} {
  const glyphWidth = (char:string) => /[\u2e80-\uffff]/u.test(char) ? 15 : /[A-ZMW]/.test(char) ? 10 : /\s/.test(char) ? 4 : 8;
  const textWidth = Array.from(title).reduce((sum,char)=>sum+glyphWidth(char),0);
  const width = Math.max(136,Math.min(CARD_WIDTH,Math.ceil(textWidth+24)));
  let lines=1,used=0;
  for(const char of title){const next=glyphWidth(char);if(used+next>width-24){lines++;used=0;}used+=next;}
  return {width,height:Math.max(CARD_HEIGHT,38+lines*21)};
}
export type Direction = 'DOWN' | 'RIGHT';
export type PlacedNode = { node: GraphProjectionNode; x: number; y: number; width: number; height: number };
export type RoutedEdge = { id: string; source: string; target: string; path: string };
export type GraphLayout = { nodes: PlacedNode[]; edges: RoutedEdge[]; width: number; height: number };
const elk = new ELK();

// Keep the semantic projection intact. Each dependency gets its own two ports.
export async function layoutProjection(projection: GraphProjection, direction: Direction): Promise<GraphLayout> {
  const ports = new Map<string, NonNullable<ElkNode['ports']>>();
  for (const n of projection.nodes) ports.set(n.id, []);
  const edges: ElkExtendedEdge[] = projection.edges.map(e => {
    const source = `port:${e.id}:source`, target = `port:${e.id}:target`;
    ports.get(e.source)?.push({ id: source, width: 0, height: 0, layoutOptions: { 'elk.port.side': direction === 'DOWN' ? 'SOUTH' : 'EAST' } });
    ports.get(e.target)?.push({ id: target, width: 0, height: 0, layoutOptions: { 'elk.port.side': direction === 'DOWN' ? 'NORTH' : 'WEST' } });
    return { id: e.id, sources: [source], targets: [target] };
  });
  const entries = new Map(projection.nodes.map(n => [n.id, {
    id: n.id, ...(n.nodeKind === 'group' ? {} : cardSize(n.title)),
    ports: ports.get(n.id),
    layoutOptions: n.nodeKind === 'group' ? { 'elk.padding': '[top=38,left=16,bottom=16,right=16]' } : { 'elk.portConstraints': 'FIXED_SIDE' },
    ...(n.nodeKind === 'group' ? {children: []} : {}),
  } as ElkNode]));
  const children: ElkNode[] = [];
  for (const n of projection.nodes) {
    const child = entries.get(n.id)!;
    const parent = n.parentId ? entries.get(n.parentId) : undefined;
    if (parent?.children) parent.children.push(child); else children.push(child);
  }
  const input = { id: 'layout-root', children, edges, layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': '16', 'elk.layered.spacing.nodeNodeBetweenLayers': '24',
    'elk.layered.spacing.edgeNodeBetweenLayers': '8', 'elk.spacing.edgeEdge': '6',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.mergeEdges': 'true',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.padding': '[top=12,left=12,bottom=12,right=12]',
  }};
  const result = await elk.layout<ElkNode>(JSON.parse(JSON.stringify(input)));
  const nodes: PlacedNode[] = [], routed: RoutedEdge[] = [];
  const nodeById = new Map(projection.nodes.map(n => [n.id, n]));
  const edgeById = new Map(projection.edges.map(e => [e.id, e]));
  const offsets = new Map<string, {x:number;y:number}>();
  const collect = (container: ElkNode, x:number, y:number) => {
    offsets.set(container.id, {x,y});
    for (const child of container.children ?? []) collect(child,x+(child.x??0),y+(child.y??0));
  };
  collect(result,0,0);
  const visit = (container: ElkNode, x: number, y: number) => {
    for (const e of container.edges ?? []) {
      // ELK may retain an edge on the root while routing it in a nested container.
      const origin = offsets.get((e as ElkExtendedEdge & {container?:string}).container ?? container.id) ?? {x,y};
      const edge = edgeById.get(e.id);
      if (!edge) continue;
      const path = (e.sections ?? []).map(s => {
        const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        return points.map((p, i) => `${i ? 'L' : 'M'} ${p.x + origin.x} ${p.y + origin.y}`).join(' ');
      }).join(' ');
      if (!path) throw new Error(`No route for dependency ${e.id}`);
      routed.push({ id: e.id, source: edge.source, target: edge.target, path });
    }
    for (const child of container.children ?? []) {
      const px = x + (child.x ?? 0), py = y + (child.y ?? 0);
      const node = nodeById.get(child.id);
      if (node) nodes.push({ node, x: px, y: py, width: child.width!, height: child.height! });
      visit(child, px, py);
    }
  };
  visit(result, 0, 0);
  if (routed.length !== projection.edges.length) throw new Error('Incomplete dependency routes');
  return { nodes, edges: routed, width: result.width ?? 0, height: result.height ?? 0 };
}
