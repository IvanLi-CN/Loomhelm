import { expect, test } from 'bun:test';
import { layoutProjection, type PlacedNode } from '../web/graph-layout';
import type { GraphProjection, GraphProjectionNode } from '../web/graph-projection';

function fixture(): GraphProjection {
  const node = (id:string, parentId:string|null=null,group=false):GraphProjectionNode => ({id,parentId,nodeKind:group?'group':'task',sourceNodeId:id,refId:id,groupId:parentId,plannedGroupId:parentId,taskKind:'contribution',state:'running',stateLabel:'执行中',stateIcon:'loader-circle',title:`任务 ${id} 的长中文名称`,graphLabel:id,fullLabel:id});
  return {nodes:[node('group',null,true),...['a','b','c','d'].map(id=>node(id,'group')),node('e')],edges:[['a','b'],['a','c'],['b','d'],['c','d'],['a','d'],['d','e']].map(([source,target],i)=>({id:`e${i}`,source:source!,target:target!,paths:[],crossGroup:'no'})),boundaryDependencies:[],warnings:[]};
}
function onBoundary(p:{x:number;y:number},n:PlacedNode) {
  const epsilon=.01;
  const insideX=p.x>=n.x-epsilon&&p.x<=n.x+n.width+epsilon;
  const insideY=p.y>=n.y-epsilon&&p.y<=n.y+n.height+epsilon;
  return insideX&&insideY&&(Math.abs(p.x-n.x)<epsilon||Math.abs(p.x-n.x-n.width)<epsilon||Math.abs(p.y-n.y)<epsilon||Math.abs(p.y-n.y-n.height)<epsilon);
}
for (const direction of ['DOWN','RIGHT'] as const) test(`${direction}: routes every dependency to exact card boundaries across groups`,async()=>{
  const projection=fixture();const result=await layoutProjection(projection,direction);
  expect(result.nodes).toHaveLength(projection.nodes.length);
  expect(result.edges).toHaveLength(projection.edges.length);
  const byId=new Map(result.nodes.map(n=>[n.node.id,n]));
  for(const edge of result.edges){
    const coordinates=edge.path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    const points=Array.from({length:coordinates.length/2},(_,i)=>({x:coordinates[i*2]!,y:coordinates[i*2+1]!}));
    expect(onBoundary(points[0]!,byId.get(edge.source)!)).toBe(true);
    expect(onBoundary(points.at(-1)!,byId.get(edge.target)!)).toBe(true);
    for(let i=1;i<points.length;i++)expect(Math.abs(points[i]!.x-points[i-1]!.x)<.01||Math.abs(points[i]!.y-points[i-1]!.y)<.01).toBe(true);
  }
  const cards=result.nodes.filter(n=>n.node.nodeKind!=='group');
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
    const a=cards[i]!,b=cards[j]!;
    expect(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y).toBe(true);
  }
});
