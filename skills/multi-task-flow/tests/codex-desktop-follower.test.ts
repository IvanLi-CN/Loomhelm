import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDesktopFollower } from "../lib/codex-desktop-follower";
import type { JsonRecord } from "../lib/codex-socket";
const wait=async(condition:()=>boolean)=>{for(let i=0;i<100&&!condition();i++)await Bun.sleep(5);expect(condition()).toBe(true)};
test("desktop follower receives fragmented snapshots, native text patches and completion without execution requests",async()=>{
 const root=mkdtempSync(join(tmpdir(),"desktop-follow-")),path=join(root,"ipc.sock");let socket!:Socket;const calls:JsonRecord[]=[],events:JsonRecord[]=[];let failures=0;
 const send=(m:JsonRecord,fragment=false)=>{const text=Buffer.from(JSON.stringify(m));const head=Buffer.alloc(4);head.writeUInt32LE(text.length);const bytes=Buffer.concat([head,text]);if(fragment){socket.write(bytes.subarray(0,3));socket.write(bytes.subarray(3))}else socket.write(bytes)};
 const server=createServer(s=>{socket=s;let buffer=Buffer.alloc(0);s.on("data",(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const length=buffer.readUInt32LE(0);if(buffer.length<length+4)return;const m=JSON.parse(buffer.subarray(4,length+4).toString());buffer=buffer.subarray(length+4);calls.push(m);if(m.method==="initialize")send({type:"response",requestId:m.requestId,method:m.method,resultType:"success",result:{clientId:"observer"}});if(m.method==="thread-owner-discovery")send({type:"response",requestId:m.requestId,method:m.method,resultType:"success",handledByClientId:"owner",result:{}})}})});
 await new Promise<void>(r=>server.listen(path,r));const follower=new CodexDesktopFollower(path,e=>events.push(e),()=>failures++);follower.retain(["bound"]);
 const broadcast=(change:JsonRecord,owner="owner",version=11)=>send({type:"broadcast",method:"thread-stream-state-changed",version,sourceClientId:owner,params:{hostId:"local",conversationId:"bound",change}},true);
 try{
 await wait(()=>calls.some(c=>c.method==="thread-stream-following-changed"));
 broadcast({type:"snapshot",revision:1,conversationState:{turns:[{id:"turn",status:"inProgress",items:[{id:"a",type:"agentMessage",text:"first",phase:"commentary",completedAtMs:null}]}]}});
 await wait(()=>events.length===1);
 broadcast({type:"patches",baseRevision:1,revision:2,patches:[{op:"replace",path:["turns",0,"items",0,"text"],value:"first more"}]});
 await wait(()=>events.length===2);expect(events[1]).toMatchObject({method:"item/agentMessage/delta",params:{itemId:"a",delta:" more"}});
 broadcast({type:"patches",baseRevision:2,revision:3,patches:[{op:"replace",path:["turns",0,"items",0,"completedAtMs"],value:20}]});
 await wait(()=>events.length===3);expect(events[2]).toMatchObject({method:"item/completed",params:{item:{text:"first more"}}});
 broadcast({type:"patches",baseRevision:3,revision:4,patches:[]},"stranger");await Bun.sleep(5);expect(events).toHaveLength(3);
 broadcast({type:"patches",baseRevision:8,revision:9,patches:[]});await wait(()=>calls.filter(c=>c.method==="thread-owner-discovery").length===2);
 expect(calls.map(c=>c.method).every(m=>["initialize","thread-owner-discovery","thread-stream-following-changed"].includes(String(m)))).toBe(true);
 expect(calls.filter(c=>c.method==="thread-owner-discovery").every(c=>(c.params as JsonRecord).conversationId==="bound")).toBe(true);
 expect(failures).toBe(0);
 }finally{follower.close();socket?.destroy();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true})}
},5000);
