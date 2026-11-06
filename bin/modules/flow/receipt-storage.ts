import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  FlowError,
  canonicalJson,
  deepClone,
  isRecord,
  stableHash,
} from "./common";
import { normalizeLedger } from "./state";
import {
  archiveBytes,
  atomicWriteJson,
  ensureDirectory,
  prettyJson,
  readJson,
  stableFileBytes,
  withExclusiveLock,
  withExclusiveLockAsync,
} from "./storage";

export class ReceiptStorage {
  readonly activePath: string;
  readonly lockPath: string;
  readonly lifecyclePath: string;

  constructor(readonly root: string) {
    this.activePath = join(root, "active.json");
    this.lockPath = join(root, "ledger.lock");
    this.lifecyclePath = join(root, "execution-lifecycle.lock");
  }

  readRaw(): Record<string, unknown> {
    if (!existsSync(this.activePath))
      throw new FlowError("flow receipt ledger is not initialized");
    const value = readJson(this.activePath, "flow receipt ledger is invalid");
    if (!isRecord(value)) throw new FlowError("ledger payload is invalid");
    return value;
  }

  read(): Record<string, unknown> {
    return normalizeLedger(deepClone(this.readRaw()));
  }

  write(value: Record<string, unknown>): void {
    normalizeLedger(value);
    atomicWriteJson(this.activePath, value);
  }

  writeRaw(value: Record<string, unknown>): void {
    atomicWriteJson(this.activePath, value);
  }

  withLock<T>(callback: () => T): T {
    return withExclusiveLock(this.lockPath, callback);
  }

  withLifecycleLock<T>(callback: () => T, timeoutMs = 30_000): T {
    return withExclusiveLock(this.lifecyclePath, callback, timeoutMs);
  }

  withLifecycleLockAsync<T>(
    callback: () => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T> {
    return withExclusiveLockAsync(this.lifecyclePath, callback, timeoutMs);
  }

  archivePath(runId: string): string {
    return join(this.root, "runs", `${stableHash(runId)}.json`);
  }

  archive(value: Record<string, unknown>): string {
    const runId = typeof value.run_id === "string" ? value.run_id : "";
    if (!runId) throw new FlowError("terminal ledger has no run_id");
    const content = Buffer.from(prettyJson(value), "utf8");
    const path = this.archivePath(runId);
    archiveBytes(path, content, "terminal ledger archive");
    return path;
  }

  archiveRaw(runId: string, bytes: Uint8Array): string {
    if (!runId) throw new FlowError("terminal ledger has no run_id");
    const path = this.archivePath(runId);
    archiveBytes(path, bytes, "terminal ledger archive");
    return path;
  }

  recoverStaleTerminalArchive(active: Record<string, unknown>): void {
    const runId = typeof active.run_id === "string" ? active.run_id : "";
    if (!runId) return;
    const path = this.archivePath(runId);
    if (!existsSync(path)) return;
    let archived: unknown;
    try {
      archived = JSON.parse(
        Buffer.from(stableFileBytes(path, "terminal ledger archive")).toString(
          "utf8",
        ),
      );
    } catch (error) {
      throw new FlowError(
        "active ledger conflicts with an invalid terminal archive",
        { cause: error },
      );
    }
    if (
      !isRecord(archived) ||
      archived.run_id !== active.run_id ||
      typeof archived.state !== "string" ||
      archived.state === "active" ||
      typeof archived.closed_at !== "string"
    )
      throw new FlowError("active ledger conflicts with a terminal archive");
    const restored = normalizeLedger(deepClone(archived));
    const identity = normalizeLedger(deepClone(active));
    for (const item of [restored, identity]) {
      delete item.state;
      delete item.closed_at;
      delete item.updated_at;
    }
    if (canonicalJson(restored) !== canonicalJson(identity))
      throw new FlowError("active ledger conflicts with a terminal archive");
    unlinkSync(path);
  }

  rollbackTerminalSeal(
    preClose: Record<string, unknown>,
    terminal: Record<string, unknown>,
  ): void {
    this.writeRaw(preClose);
    const path = this.archivePath(String(terminal.run_id));
    if (!existsSync(path)) return;
    const expected = Buffer.from(prettyJson(terminal), "utf8");
    if (
      Buffer.compare(
        Buffer.from(stableFileBytes(path, "terminal ledger archive")),
        expected,
      ) !== 0
    )
      throw new FlowError("terminal seal rollback found an unexpected archive");
    unlinkSync(path);
  }
}
