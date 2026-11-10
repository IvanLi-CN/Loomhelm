import { randomUUID } from "node:crypto";
import { z } from "zod";

export type ViewerWorkerKey = string;
export const viewerWorkerKeySchema = z.string().min(1).refine((value) => !value.includes("\0"));

export type ViewerWorkerRequestContext = {
  runId: string;
  workerKey: ViewerWorkerKey;
};

export interface ViewerWorker {
  readonly id: string;
  readonly key: ViewerWorkerKey;
  handle(
    request: Request,
    server: unknown,
    path: string,
    context: ViewerWorkerRequestContext,
  ): Response | Promise<Response>;
  stop?(): void | Promise<void>;
}

export type ViewerWorkerFactory = (
  key: ViewerWorkerKey,
) => ViewerWorker | Promise<ViewerWorker>;

type WorkerEntry = {
  worker: ViewerWorker;
  lastUsedAt: number;
  activeRequests: number;
  stopping: Promise<void> | null;
};

export type ViewerWorkerPoolOptions = {
  ttlMs?: number;
  now?: () => number;
  sweepIntervalMs?: number;
  workerFactory: ViewerWorkerFactory;
};

export type ViewerWorkerLease = {
  worker: ViewerWorker;
  release(): void;
};

/**
 * Keeps one worker per immutable data/version key. A worker is never shared
 * across keys, even when the underlying release happens to use the same code.
 * This is the in-process boundary used by the gateway; a release can replace
 * the factory with a socket-backed loader without changing routing or TTL
 * semantics.
 */
export class ViewerWorkerPool {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly workerFactory: ViewerWorkerFactory;
  private readonly entries = new Map<ViewerWorkerKey, WorkerEntry>();
  private readonly pending = new Map<ViewerWorkerKey, Promise<WorkerEntry>>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: ViewerWorkerPoolOptions) {
    if (!Number.isFinite(options.ttlMs ?? 300_000) || (options.ttlMs ?? 300_000) <= 0)
      throw new Error("viewer worker TTL must be positive");
    this.ttlMs = options.ttlMs ?? 300_000;
    this.now = options.now ?? Date.now;
    this.workerFactory = options.workerFactory;
    const interval = options.sweepIntervalMs ?? Math.min(this.ttlMs, 60_000);
    if (!Number.isFinite(interval) || interval <= 0)
      throw new Error("viewer worker sweep interval must be positive");
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, interval);
    this.sweepTimer.unref?.();
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): ViewerWorkerKey[] {
    return [...this.entries.keys()];
  }

  activeRequests(key?: ViewerWorkerKey): number {
    if (key !== undefined) return this.entries.get(key)?.activeRequests ?? 0;
    return [...this.entries.values()].reduce((total, entry) => total + entry.activeRequests, 0);
  }

  async acquire(key: ViewerWorkerKey): Promise<ViewerWorkerLease> {
    if (this.closed) throw new Error("viewer worker pool is stopped");
    viewerWorkerKeySchema.parse(key);
    let entry = this.entries.get(key);
    if (!entry) {
      let creation = this.pending.get(key);
      if (!creation) {
        creation = (async () => {
          const worker = await this.workerFactory(key);
          if (worker.key !== key) {
            await worker.stop?.();
            throw new Error("viewer worker factory returned a mismatched key");
          }
          if (this.closed) {
            await worker.stop?.();
            throw new Error("viewer worker pool is stopped");
          }
          return { worker, lastUsedAt: this.now(), activeRequests: 0, stopping: null };
        })();
        this.pending.set(key, creation);
      }
      try {
        entry = await creation;
        this.entries.set(key, entry);
      } finally {
        if (this.pending.get(key) === creation) this.pending.delete(key);
      }
    }
    if (entry.stopping) {
      await entry.stopping;
      return this.acquire(key);
    }
    entry.lastUsedAt = this.now();
    entry.activeRequests += 1;
    let released = false;
    return {
      worker: entry.worker,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(key);
        if (!current || current.worker !== entry!.worker) return;
        current.activeRequests = Math.max(0, current.activeRequests - 1);
        current.lastUsedAt = this.now();
      },
    };
  }

  async sweep(now = this.now()): Promise<ViewerWorkerKey[]> {
    const removed: ViewerWorkerKey[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.activeRequests > 0 || now - entry.lastUsedAt < this.ttlMs) continue;
      const stopping = Promise.resolve(entry.worker.stop?.()).catch(() => undefined).finally(() => {
        if (this.entries.get(key)?.worker === entry.worker) this.entries.delete(key);
      });
      entry.stopping = stopping;
      await stopping;
      removed.push(key);
    }
    return removed;
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(entries.map(async ([, entry]) => entry.worker.stop?.()));
  }
}

export function versionedWorkerKey(dataContract: string, viewerVersion: string): ViewerWorkerKey {
  if (!dataContract || !viewerVersion) throw new Error("viewer worker version identity is required");
  return `${dataContract}@${viewerVersion}`;
}

export function createWorkerId(prefix = "viewer-worker"): string {
  return `${prefix}-${randomUUID()}`;
}
