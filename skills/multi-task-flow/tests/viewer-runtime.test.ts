import { afterEach, expect, test } from "bun:test";
import { startSharedViewerGateway, activeViewerGateways } from "../scripts/viewer-gateway";
import { ViewerWorkerPool, createWorkerGeneration, createWorkerId, type ViewerWorker } from "../scripts/viewer-runtime";
import { VersionedViewerWorkers, workerKeyOf } from "../scripts/viewer-worker";

const gateways: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
});

function worker(key: string, body = key, generation?: string): ViewerWorker & { stopped: number } {
  return {
    id: createWorkerId(), key, ...(generation ? { generation } : {}), stopped: 0,
    handle: () => new Response(body, { headers: { "content-type": "text/plain" } }),
    stop() { this.stopped += 1; },
  };
}

test("worker pool isolates versions and expires only idle workers", async () => {
  let now = 0;
  const created: ViewerWorker[] = [];
  const pool = new ViewerWorkerPool({ ttlMs: 100, sweepIntervalMs: 10_000, now: () => now, workerFactory: (key) => {
    const value = worker(key); created.push(value); return value;
  }});
  const first = await pool.acquire("schema-1@release-a");
  const second = await pool.acquire("schema-1@release-b");
  expect(pool.size).toBe(2);
  now = 200;
  expect(await pool.sweep()).toEqual([]);
  first.release(); second.release();
  now = 400;
  expect(await pool.sweep()).toEqual(["schema-1@release-a", "schema-1@release-b"]);
  expect(created.every((value) => value.stopped === 1)).toBe(true);
  await pool.stop();
});

test("gateway shares one listener and releases stream leases after completion", async () => {
  const pool = new ViewerWorkerPool({ ttlMs: 10_000, workerFactory: (key) => worker(key, "ok") });
  const options = {
    port: 0,
    singletonKey: "test-gateway",
    pool,
    resolveRoute: (_request: Request, runId: string) => ({ runId, path: "/api/view", workerKey: "schema-2@release" }),
  };
  const first = await startSharedViewerGateway(options); gateways.push(first);
  const second = await startSharedViewerGateway(options); gateways.push(second);
  expect(first.port).toBe(second.port);
  expect(activeViewerGateways()).toBe(1);
  const response = await fetch(`http://127.0.0.1:${first.port}/runs/demo/api/view`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
  expect(pool.activeRequests()).toBe(0);
});

test("versioned worker selection retains immutable release identities", async () => {
  const selected: string[] = [];
  const versions = new VersionedViewerWorkers(async (key) => {
    selected.push(key);
    return worker(key);
  });
  const version = { dataContract: "schema-2/contract-2", viewerContract: 1, buildId: "release-a" };
  const first = await versions.select(version);
  const second = await versions.select(version);
  expect(first.worker).toBe(second.worker);
  expect(selected).toEqual([workerKeyOf(version)]);
  await versions.stop();
});

test("worker invalidation fences generations and permits a replacement", async () => {
  const created: Array<ViewerWorker & { stopped: number }> = [];
  const key = "schema-2@release-a";
  const pool = new ViewerWorkerPool({
    restartBackoffMs: 0,
    workerFactory: (workerKey) => {
      const value = worker(workerKey, workerKey, createWorkerGeneration(`generation-${created.length + 1}`));
      created.push(value);
      return value;
    },
  });
  const first = await pool.acquire(key);
  expect(await pool.invalidate(key, createWorkerGeneration())).toBe(false);
  expect(pool.generation(key)).toBe(first.generation);
  expect(await pool.invalidate(key, first.generation)).toBe(true);
  expect(pool.size).toBe(0);
  expect(created[0]!.stopped).toBe(1);
  first.release();
  const second = await pool.acquire(key);
  expect(second.generation).not.toBe(first.generation);
  second.release();
  await pool.stop();
});

test("worker restart failures are bounded within a recovery window", async () => {
  let now = 0;
  let attempts = 0;
  const key = "schema-2@broken-release";
  const pool = new ViewerWorkerPool({
    now: () => now,
    maxRestarts: 2,
    restartWindowMs: 1_000,
    restartBackoffMs: 0,
    workerFactory: (workerKey) => {
      attempts += 1;
      if (attempts <= 2) throw new Error("worker boot failed");
      return worker(workerKey);
    },
  });
  await expect(pool.acquire(key)).rejects.toThrow("worker boot failed");
  await expect(pool.acquire(key)).rejects.toThrow("worker boot failed");
  await expect(pool.acquire(key)).rejects.toThrow("restart limit reached");
  expect(pool.failureCount(key)).toBe(2);
  now = 1_000;
  const lease = await pool.acquire(key);
  expect(attempts).toBe(3);
  lease.release();
  await pool.stop();
});
