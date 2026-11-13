import { expect, test } from "bun:test";
import { DesktopOutputState } from "../lib/desktop-output-state";
const agent=(id:string,text:string,completedAtMs:number|null=null)=>({type:"agentMessage",id,text,phase:"commentary",completedAtMs});
const snapshot=(revision=1)=>({type:"snapshot",revision,conversationState:{turns:[],turnHistory:{history:{islands:[{entries:[{key:"old",value:"old"},{key:"new",value:"new"}]}],entitiesByKey:{new:{turnId:"t2",status:"inProgress",items:[{type:"reasoning",id:"secret",text:"hidden"},agent("a","partial")],completedItemIds:{}},old:{turnId:"t1",status:"completed",items:[agent("old","final",10)]}}}}}});
const path=["turnHistory","history","entitiesByKey","new","items",1];
test("follows platform island/item order, ignores private items, and applies contiguous streaming patches",()=>{
 const state=new DesktopOutputState();expect(state.update(snapshot())).toMatchObject({turnId:"t2",item:{id:"a",text:"partial"},complete:false});
 expect(state.update({type:"patches",baseRevision:1,revision:2,patches:[{op:"replace",path:[...path,"text"],value:"partial answer"}]})).toMatchObject({item:{text:"partial answer"},complete:false});
 expect(state.update({type:"patches",baseRevision:2,revision:3,patches:[{op:"replace",path,value:agent("a","complete",20)}]})).toMatchObject({item:{text:"complete"},complete:true});
 expect(state.update({type:"patches",baseRevision:1,revision:2,patches:[]})).toBeNull();
 expect(()=>state.update({type:"patches",baseRevision:4,revision:5,patches:[]})).toThrow("gap");
 expect(state.update(snapshot(6))).toMatchObject({item:{text:"partial"}});
 expect(JSON.stringify(state)).not.toContain("hidden");
});
test("rejects unsafe paths and unsupported patches without exposing private updates",()=>{
 const state=new DesktopOutputState();state.update(snapshot());
 expect(()=>state.update({type:"patches",baseRevision:1,revision:2,patches:[{op:"replace",path:["__proto__","polluted"],value:true}]})).toThrow("path");
 expect(state.update({type:"patches",baseRevision:1,revision:3,patches:[{op:"replace",path:[...path.slice(0,-1),0,"text"],value:"new secret"}]})).toMatchObject({item:{text:"partial"}});
 expect(JSON.stringify(state)).not.toContain("new secret");
});
