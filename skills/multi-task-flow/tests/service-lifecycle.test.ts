import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PortRegistry, RegistryError } from "../../bin/modules/workspace/port_registry";
import { runDaemon } from "../scripts/service-lifecycle";
import { serviceFixture, fixtureRelease } from "./service-fixture";

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
async function fixture() {
  const { root, state } = serviceFixture();
  restores.push(() => rmSync(root, { recursive: true, force: true }));
  const probe = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response()});
  const port = probe.port!; await probe.stop(true);
  const release = fixtureRelease(root);
  state.saveConfig({schema_version: 1, port, registry_dir: join(root, "registry"), current_build: release.manifest.build_id, previous_build: null, agent_ttl_ms: 60000});
  state.renew({id: "agent:fixture", kind: "agent", run_id: "fixture", thread_id: "fixture"}, 60000);
  const ticks = new Map<number, () => unknown>();
  const original = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => unknown, ms: number) => {
    if (ms === 1000 || ms === 30000) { ticks.set(ms, fn); return original(() => {}, 1e9); }
    return original(fn, ms);
  }) as typeof setInterval);
  restores.push(() => timers.mockRestore());
  const daemon = await runDaemon(state, {manifest: release.manifest, assetsDir: join(release.source,"skills/multi-task-flow/dist"), revision: () => "fixture"});
  const http = () => fetch(`http://127.0.0.1:${port}/api/v1/runs`, {signal: AbortSignal.timeout(500)});
  const logs = () => readFileSync(join(state.paths.logs,"viewer.jsonl"),"utf8").trim().split("\n").map(line => JSON.parse(line));
  const tick = async (ms: number, done: () => boolean) => {
    ticks.get(ms)!();
    const deadline = Date.now() + 2000;
    while (!done()) {
      if (Date.now() > deadline) throw Error("Lifecycle did not settle");
      await Bun.sleep(5);
    }
  };
  return {state, daemon, http, logs, tick};
}

test("one registry lock timeout preserves an already reachable viewer and recovers", async () => {
  const f = await fixture();
  const original = PortRegistry.prototype.heartbeat;
  let calls = 0;
  const heartbeat = spyOn(PortRegistry.prototype, "heartbeat").mockImplementation(function (input) {
    if (++calls === 1) return Promise.reject(Object.assign(new RegistryError("sensitive path must not be logged"), {code:"REGISTRY_LOCK_TIMEOUT"}));
    return original.call(this, input);
  });
  try {
    expect((await f.http()).status).toBe(401);
    await f.tick(30000, () => f.logs().some(e => e.event === "maintenance_failed"));
    expect((await f.http()).status).toBe(401);
    await f.tick(30000, () => f.logs().some(e => e.event === "maintenance_recovered"));
    expect(f.state.runtime().phase).toBe("running");
    expect(JSON.stringify(f.logs())).not.toContain("sensitive path");
    expect(f.logs().some(e => e.event === "maintenance_recovered")).toBe(true);
  } finally { heartbeat.mockRestore(); await f.daemon.stop(); }
});

test("persistent registry timeouts close after the bounded retry budget with the real reason", async () => {
  const f = await fixture();
  const heartbeat = spyOn(PortRegistry.prototype,"heartbeat").mockRejectedValue(Object.assign(new RegistryError("secret"),{code:"REGISTRY_LOCK_TIMEOUT"}));
  try {
    for(let i=0;i<3;i++) await f.tick(30000, () => f.logs().filter(e => ["maintenance_failed", "stopped"].includes(e.event)).length === i+1);
    await expect(f.http()).rejects.toThrow();
    const stop = f.logs().find(e=>e.event==="stopped");
    expect(stop.stop_reason).toBe("registry_heartbeat_error");
    expect(Date.parse(stop.stop_started_at)).toBeLessThanOrEqual(Date.parse(stop.stop_completed_at));
    expect(stop.error_code).toBe("REGISTRY_LOCK_TIMEOUT");
  } finally {heartbeat.mockRestore(); await f.daemon.stop();}
});

test("non-transient registry failure stops immediately rather than weakening ownership fencing", async()=>{
 const f=await fixture(); const heartbeat=spyOn(PortRegistry.prototype,"heartbeat").mockRejectedValue(new RegistryError("lease ownership changed"));
 try {await f.tick(30000, () => f.state.runtime().phase === "stopped"); await expect(f.http()).rejects.toThrow(); expect(f.logs().find(e=>e.event==="stopped").stop_reason).toBe("registry_heartbeat_error");}
 finally {heartbeat.mockRestore(); await f.daemon.stop();}
});

test("lease state errors are never logged as OS signals",async()=>{
 const f=await fixture(); const expire=spyOn(f.state,"expire").mockImplementation(()=>{throw Error("secret")});
 try {await f.tick(1000, () => f.state.runtime().phase === "stopped"); expect(f.logs().find(e=>e.event==="stopped").stop_reason).toBe("lease_state_error");}
 finally {expire.mockRestore();await f.daemon.stop();}
});


test("registry lock contention exposes a typed retryable error", async () => {
  const {root} = serviceFixture();
  try {
    const registry = new PortRegistry(join(root,"contended-registry"), {lockFactory: () => null});
    await expect(registry.heartbeat({scopeId: "fixture", service: "viewer", lockTimeoutSec: 0})).rejects.toMatchObject({code: "REGISTRY_LOCK_TIMEOUT"});
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test.each(["SIGTERM", "SIGINT"] as const)("%s gets its own shutdown reason", async (signal) => {
  const f=await fixture();
  try {
    process.emit(signal);
    await f.daemon.stop();
    expect(f.logs().find(e=>e.event==="stopped").stop_reason).toBe(signal);
    await expect(f.http()).rejects.toThrow();
  } finally { await f.daemon.stop(); }
});

test("actual lease expiry closes with leases_expired", async () => {
 const f=await fixture();
 try {
   f.state.release("agent:fixture");
   await f.tick(1000, () => f.state.runtime().phase === "stopped");
   expect(f.logs().find(e=>e.event==="stopped").stop_reason).toBe("leases_expired");
   await expect(f.http()).rejects.toThrow();
 } finally {await f.daemon.stop();}
});
