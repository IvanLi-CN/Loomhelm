import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ledgerContract } from "../lib/service-contract";
import { connectUnixViewerWorker, type UnixViewerWorkerClientOptions } from "./viewer-socket";
import {
  createWorkerId,
  versionedWorkerKey,
  type ViewerWorker,
  type ViewerWorkerKey,
} from "./viewer-runtime";

export type ViewerDataVersion = {
  dataContract: string;
  viewerContract: number;
  buildId?: string;
};
export const viewerDataVersionSchema = z.object({
  dataContract: z.string().min(1),
  viewerContract: z.number().int().positive(),
  buildId: z.string().min(1).optional(),
}).strict();

export type ViewerWorkerModule = {
  default?: ViewerWorker | (() => ViewerWorker | Promise<ViewerWorker>);
  worker?: ViewerWorker | (() => ViewerWorker | Promise<ViewerWorker>);
};

export function dataVersionOf(ledger: unknown, viewerContract: number, buildId?: string): ViewerDataVersion {
  if (!Number.isInteger(viewerContract) || viewerContract <= 0)
    throw new Error("viewer contract must be a positive integer");
  return viewerDataVersionSchema.parse({ dataContract: ledgerContract(ledger), viewerContract, ...(buildId ? { buildId } : {}) });
}

export function workerKeyOf(version: ViewerDataVersion): ViewerWorkerKey {
  viewerDataVersionSchema.parse(version);
  const release = version.buildId ?? `viewer-contract-${version.viewerContract}`;
  return versionedWorkerKey(version.dataContract, release);
}

/** A previous release is never allowed to receive a mutating request. */
export function readOnlyWorkerKeyOf(version: ViewerDataVersion): ViewerWorkerKey {
  const key = workerKeyOf(version);
  return versionedWorkerKey(key, "read-only");
}

export type UnixViewerWorkerOptions = Omit<UnixViewerWorkerClientOptions, "id"> & {
  id?: string;
  stop?: () => void | Promise<void>;
};

/** Adapt a version-fenced Unix-socket worker to the gateway worker contract. */
export function createUnixViewerWorker(
  options: UnixViewerWorkerOptions,
): ViewerWorker {
  const key = options.workerKey;
  const generation = options.generation;
  return {
    id: options.id ?? createWorkerId("unix-viewer-worker"),
    key,
    generation,
    handle(request, _server, _path, context) {
      return connectUnixViewerWorker(
        { ...options, id: options.id },
        request,
        { ...context, ...(context.generation ? {} : { generation }) },
      );
    },
    stop: options.stop,
  };
}

export type WorkerSelection = {
  key: ViewerWorkerKey;
  version: ViewerDataVersion;
  worker: ViewerWorker;
};

/** Selects a worker by the complete data/version identity, never by a mutable latest pointer. */
export class VersionedViewerWorkers {
  private readonly workers = new Map<ViewerWorkerKey, ViewerWorker>();
  private readonly pending = new Map<ViewerWorkerKey, Promise<ViewerWorker>>();

  constructor(private readonly load: (key: ViewerWorkerKey, version: ViewerDataVersion) => ViewerWorker | Promise<ViewerWorker>) {}

  async select(version: ViewerDataVersion): Promise<WorkerSelection> {
    const key = workerKeyOf(version);
    const existing = this.workers.get(key);
    if (existing) return { key, version, worker: existing };
    let pending = this.pending.get(key);
    if (!pending) {
      pending = Promise.resolve(this.load(key, version));
      this.pending.set(key, pending);
    }
    let worker: ViewerWorker;
    try {
      worker = await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
    if (worker.key !== key) {
      await worker.stop?.();
      throw new Error("viewer worker identity does not match selected version");
    }
    this.workers.set(key, worker);
    return { key, version, worker };
  }

  async stop(key?: ViewerWorkerKey): Promise<void> {
    const entries = key ? [[key, this.workers.get(key)] as const] : [...this.workers.entries()];
    for (const [entryKey, worker] of entries) {
      if (!worker) continue;
      this.workers.delete(entryKey);
      await worker.stop?.();
    }
  }

  keys(): ViewerWorkerKey[] {
    return [...this.workers.keys()];
  }
}

export type DynamicWorkerSpec = {
  modulePath: string;
  exportName?: "default" | "worker";
  expectedKey: ViewerWorkerKey;
};

/**
 * Explicit dynamic-loading boundary for same-process releases. The caller must
 * pass a canonical absolute module path and the worker still has to prove its
 * selected key before it is admitted to the pool.
 */
export async function loadDynamicViewerWorker(spec: DynamicWorkerSpec): Promise<ViewerWorker> {
  if (!isAbsolute(spec.modulePath)) throw new Error("viewer worker module path must be absolute");
  if (!existsSync(spec.modulePath) || realpathSync(spec.modulePath) !== spec.modulePath)
    throw new Error("viewer worker module path is not canonical");
  const module = (await import(pathToFileURL(spec.modulePath).href)) as ViewerWorkerModule;
  const value = module[spec.exportName ?? "default"] ?? module.worker;
  const worker = typeof value === "function" ? await value() : value;
  if (!worker || worker.key !== spec.expectedKey)
    throw new Error("viewer worker module returned an unexpected version");
  return worker;
}

export function readLedgerDataContract(path: string): string {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error("ledger path must be canonical");
  return ledgerContract(JSON.parse(readFileSync(path, "utf8")));
}
