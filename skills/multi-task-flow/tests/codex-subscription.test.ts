import { expect, test } from "bun:test";
import { LoadedThreadSubscriptions } from "../scripts/codex-subscription";
import type { JsonRecord } from "../scripts/codex-socket";

test("only rejoins bound loaded threads, without overrides or turns, deduplicates and releases subscriptions", async () => {
  const calls: Array<[string, JsonRecord]> = [];
  const subscription = new LoadedThreadSubscriptions(async (method, params) => {
    calls.push([method, params]);
    return method === "thread/loaded/list" ? (params.cursor ? {data:["live"]} : {data:["unrelated"],nextCursor:"second"}) : {};
  });
  subscription.retain(["live", "cold"]);
  await subscription.ensure("unbound"); expect(calls).toHaveLength(0);
  await Promise.all([subscription.ensure("live"),subscription.ensure("live")]);
  expect(calls).toEqual([["thread/loaded/list",{limit:100}],["thread/loaded/list",{limit:100,cursor:"second"}],["thread/resume",{threadId:"live",excludeTurns:true}]]);
  await subscription.ensure("live");expect(calls).toHaveLength(3);
  await subscription.ensure("cold");expect(calls.filter(([m])=>m==="thread/resume")).toHaveLength(1);
  subscription.retain([]);
  expect(calls.at(-1)).toEqual(["thread/unsubscribe",{threadId:"live"}]);
});

test("rebinding during a loaded-list read cannot resume the former binding", async () => {
  let resolve!: (v:JsonRecord)=>void;const calls:string[]=[];
  const subscription=new LoadedThreadSubscriptions(async m=>{calls.push(m);return await new Promise(r=>{resolve=r})});
  subscription.retain(["live"]);const pending=subscription.ensure("live");
  subscription.retain([]);subscription.retain(["live"]);
  resolve({data:["live"]});await pending;expect(calls).toEqual(["thread/loaded/list"]);
});

test("stop cancels pending joins and a removed subscription is released after resume completes", async () => {
  for(const stop of [false,true]) {
    let resolve!: (v:JsonRecord)=>void;const calls:string[]=[];
    const subscription=new LoadedThreadSubscriptions(async m=>{calls.push(m);return m==="thread/resume"?await new Promise(r=>{resolve=r}):{data:["live"]}});
    subscription.retain(["live"]);const pending=subscription.ensure("live");await Promise.resolve();
    if(stop)subscription.close();else subscription.retain([]);
    resolve({});await pending;
    expect(calls).toEqual(stop?["thread/loaded/list","thread/resume"]:["thread/loaded/list","thread/resume","thread/unsubscribe"]);
  }
});
