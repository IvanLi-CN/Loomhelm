import { randomUUID } from "node:crypto";
import { z } from "zod";

export type ViewerWorkerKey = string;
export const viewerWorkerKeySchema = z.string().min(1).refine((value) => !value.includes("\0"));
export type ViewerWorkerGeneration = string;

export type ViewerWorkerRequestContext = {
  runId: string;
  workerKey: ViewerWorkerKey;
  generation?: ViewerWorkerGeneration;
};

export interface ViewerWorker {
  readonly id: string;
  readonly key: ViewerWorkerKey;
  readonly generation?: ViewerWorkerGeneration;
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
  generation: ViewerWorkerGeneration;
  lastUsedAt: number;
  activeRequests: number;
  stopping: Promise<void> | null;
};

type WorkerFailure = {
  count: number;
  firstFailedAt: number;
  lastFailedAt: number;
};

export type ViewerWorkerPoolOptions = {
  ttlMs?: number;
  now?: () => number;
  sweepIntervalMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  restartBackoffMs?: number;
  workerFactory: ViewerWorkerFactory;
};

export type ViewerWorkerLease = {
  worker: ViewerWorker;
  readonly generation: ViewerWorkerGeneration;
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
  private readonly failures = new Map<ViewerWorkerKey, WorkerFailure>();
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly restartBackoffMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: ViewerWorkerPoolOptions) {
    if (!Number.isFinite(options.ttlMs ?? 300_000) || (options.ttlMs ?? 300_000) <= 0)
      throw new Error("viewer worker TTL must be positive");
    this.ttlMs = options.ttlMs ?? 300_000;
    this.now = options.now ?? Date.now;
    this.workerFactory = options.workerFactory;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.restartWindowMs = options.restartWindowMs ?? 60_000;
    this.restartBackoffMs = options.restartBackoffMs ?? 250;
    if (!Number.isSafeInteger(this.maxRestarts) || this.maxRestarts < 1)
      throw new Error("viewer worker max restarts must be a positive integer");
    if (!Number.isFinite(this.restartWindowMs) || this.restartWindowMs <= 0)
      throw new Error("viewer worker restart window must be positive");
    if (!Number.isFinite(this.restartBackoffMs) || this.restartBackoffMs < 0)
      throw new Error("viewer worker restart backoff must be non-negative");
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

  generation(key: ViewerWorkerKey): ViewerWorkerGeneration | undefined {
    return this.entries.get(key)?.generation;
  }

  failureCount(key: ViewerWorkerKey): number {
    return this.failures.get(key)?.count ?? 0;
  }

  private noteFailure(key: ViewerWorkerKey): void {
    const now = this.now();
    const previous = this.failures.get(key);
    if (!previous || now - previous.firstFailedAt >= this.restartWindowMs) {
      this.failures.set(key, { count: 1, firstFailedAt: now, lastFailedAt: now });
      return;
    }
    previous.count += 1;
    previous.lastFailedAt = now;
  }

  private async waitForRestart(key: ViewerWorkerKey): Promise<void> {
    const failure = this.failures.get(key);
    if (!failure) return;
    const now = this.now();
    if (now - failure.firstFailedAt >= this.restartWindowMs) {
      this.failures.delete(key);
      return;
    }
    if (failure.count >= this.maxRestarts)
      throw new Error("viewer worker restart limit reached");
    const remaining = this.restartBackoffMs - (now - failure.lastFailedAt);
    if (remaining > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }

  async acquire(key: ViewerWorkerKey): Promise<ViewerWorkerLease> {
    if (this.closed) throw new Error("viewer worker pool is stopped");
    viewerWorkerKeySchema.parse(key);
    let entry = this.entries.get(key);
    if (!entry) {
      await this.waitForRestart(key);
      if (this.closed) throw new Error("viewer worker pool is stopped");
      entry = this.entries.get(key);
    }
    if (!entry) {
      let creation = this.pending.get(key);
      if (!creation) {
        creation = (async () => {
          let worker: ViewerWorker | undefined;
          try {
            worker = await this.workerFactory(key);
            if (worker.key !== key)
              throw new Error("viewer worker factory returned a mismatched key");
            if (this.closed) throw new Error("viewer worker pool is stopped");
            const generation = worker.generation ?? createWorkerGeneration();
            if (!generation || generation.includes("\0"))
              throw new Error("viewer worker factory returned an invalid generation");
            return { worker, generation, lastUsedAt: this.now(), activeRequests: 0, stopping: null };
          } catch (error) {
            await Promise.resolve(worker?.stop?.()).catch(() => undefined);
            this.noteFailure(key);
            throw error;
          }
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
      generation: entry.generation,
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

  /** Fence a failed worker generation and make the next lease create a replacement. */
  async invalidate(key: ViewerWorkerKey, generation?: ViewerWorkerGeneration): Promise<boolean> {
    viewerWorkerKeySchema.parse(key);
    const entry = this.entries.get(key);
    if (!entry || (generation !== undefined && entry.generation !== generation)) return false;
    this.noteFailure(key);
    if (!entry.stopping) {
      entry.stopping = Promise.resolve(entry.worker.stop?.()).catch(() => undefined).finally(() => {
        if (this.entries.get(key)?.worker === entry.worker) this.entries.delete(key);
      });
    }
    await entry.stopping;
    return true;
  }

  async sweep(now = this.now()): Promise<ViewerWorkerKey[]> {
    const removed: ViewerWorkerKey[] = [];
    for (const [key, failure] of this.failures) {
      if (now - failure.firstFailedAt >= this.restartWindowMs) this.failures.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (entry.stopping) {
        await entry.stopping;
        removed.push(key);
        continue;
      }
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
    this.failures.clear();
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

export function createWorkerGeneration(prefix = "viewer-generation"): ViewerWorkerGeneration {
  return `${prefix}-${randomUUID()}`;
}
