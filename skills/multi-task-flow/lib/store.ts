import { readStoredLedger } from "../lib/store-ledger";
import {
  ensureDirectory,
  readRegular,
  syncDirectory,
  writeAtomic,
  withExclusiveLock,
} from "../lib/store-io";
export {
  ensureDirectory,
  readRegular,
  syncDirectory,
  writeAtomic,
  withExclusiveLock,
} from "../lib/store-io";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError, requireCondition } from "../lib/errors";
import {
  identity,
  removeStagingPath,
  type FileIdentity,
} from "../../bin/modules/visual/isolation";
import {
  createDirectoryNoFollow,
  readRegularNoFollow,
  renameNoReplace,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
  type DirectoryIdentity,
} from "../../bin/modules/visual/secure_io";
import { normalizeLegacyLedger } from "../lib/schema";
import { orchestrationRoot } from "../lib/service-paths";
import { requireLedgerCompatibility } from "../lib/service-contract";
import {
  migrateLocked,
  type LedgerMigrationRequest,
  type LockedLedgerMigrationContext,
} from "../lib/store-migration";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function safeId(id: unknown): string {
  requireCondition(
    typeof id === "string" && idPattern.test(id),
    "INVALID_ID",
    "Invalid identifier",
  );
  return id;
}
export function defaultRoot(): string {
  return orchestrationRoot();
}
function requireDirectory(path: string): void {
  requireCondition(existsSync(path), "RUN_NOT_FOUND", "Run does not exist", 2);
  requireCondition(
    !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory(),
    "UNSAFE_PATH",
    "Directory must not be a symlink",
  );
  requireCondition(
    realpathSync(path) === resolve(path),
    "UNSAFE_PATH",
    "Directory path must not traverse symlinks",
  );
}
function directoryIdentity(path: string): FileIdentity | undefined {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory()
      ? { dev: metadata.dev, ino: metadata.ino }
      : undefined;
  } catch {
    return undefined;
  }
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
type StoreBoundary = {
  run: FileIdentity;
  locks: FileIdentity;
  lock: FileIdentity;
};
export class LedgerStore {
  readonly rootPath: string;
  readonly runPath: string;
  readonly ledgerPath: string;
  readonly lockPath: string;
  private activeRunIdentity: FileIdentity | undefined;
  constructor(
    root: string,
    runId: string,
    private readonly onStage?: (stage: string) => void,
  ) {
    requireCondition(
      isAbsolute(root),
      "INVALID_ROOT",
      "Data root must be absolute",
    );
    this.rootPath = resolve(root);
    this.runPath = join(this.rootPath, "runs", safeId(runId));
    this.ledgerPath = join(this.runPath, "ledger.json");
    this.lockPath = join(this.runPath, "locks", "ledger.lock");
  }
  create(initial: unknown): void {
    ensureDirectory(this.rootPath);
    return withExclusiveLock(join(this.rootPath, ".maintenance.lock"), () =>
      this.createUnlocked(initial),
    );
  }
  private createUnlocked(initial: unknown): void {
    const runs = dirname(this.runPath);
    ensureDirectory(runs);
    const runsIdentity = directoryIdentity(runs);
    requireCondition(
      runsIdentity,
      "UNSAFE_PATH",
      "Runs directory is unavailable",
      5,
    );
    withExclusiveLock(
      join(runs, ".create.lock"),
      () => {
        syncDirectoryNoFollow(runs, this.rootPath, runsIdentity);
        try {
          lstatSync(this.runPath);
          throw new ContractError("RUN_EXISTS", "Run already exists", 3);
        } catch (error: any) {
          if (error instanceof ContractError || error.code !== "ENOENT")
            throw error;
        }
        const stagingPath = join(
          runs,
          `.run-${safeId(basename(this.runPath))}-${randomUUID()}`,
        );
        let stagingIdentity: FileIdentity | undefined;
        let destinationIdentity: FileIdentity | undefined;
        let renamed = false;
        let published = false;
        try {
          createDirectoryNoFollow(
            stagingPath,
            this.rootPath,
            0o700,
            runsIdentity,
          );
          stagingIdentity = identity(stagingPath);
          const stagingLocksPath = join(stagingPath, "locks");
          createDirectoryNoFollow(
            stagingLocksPath,
            this.rootPath,
            0o700,
            stagingIdentity,
          );
          const stagingLocksIdentity = directoryIdentity(stagingLocksPath);
          requireCondition(
            stagingLocksIdentity,
            "UNSAFE_PATH",
            "Staging lock directory is unavailable",
            5,
          );
          const lockPath = join(stagingLocksPath, "ledger.lock");
          writeExclusiveNoFollow(
            lockPath,
            "",
            this.rootPath,
            stagingLocksIdentity,
          );
          syncDirectoryNoFollow(
            stagingLocksPath,
            this.rootPath,
            stagingLocksIdentity,
          );
          writeAtomicNoFollow(
            join(stagingPath, "ledger.json"),
            JSON.stringify(initial, null, 2) + "\n",
            this.rootPath,
            undefined,
            stagingIdentity,
          );
          syncDirectoryNoFollow(
            stagingLocksPath,
            this.rootPath,
            stagingLocksIdentity,
          );
          syncDirectoryNoFollow(stagingPath, this.rootPath, stagingIdentity);
          try {
            renameNoReplace(
              stagingPath,
              this.runPath,
              this.rootPath,
              runsIdentity,
            );
          } catch (error: any) {
            if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
              throw new ContractError("RUN_EXISTS", "Run already exists", 3);
            throw error;
          }
          renamed = true;
          destinationIdentity = directoryIdentity(this.runPath);
          requireCondition(
            stagingIdentity !== undefined &&
              destinationIdentity !== undefined &&
              sameIdentity(destinationIdentity, stagingIdentity),
            "UNSAFE_PATH",
            "Published run does not match its staging directory",
            5,
          );
          // The directory is published even when its parent fsync is uncertain.
          // Leave it in place so recovery can inspect the exact published inode.
          published = true;
          try {
            syncDirectoryNoFollow(runs, this.rootPath, runsIdentity);
          } catch (error) {
            throw new ContractError(
              "RUN_PUBLISHED_UNCERTAIN",
              "Run was published but durability is unknown; inspect it before retrying",
              5,
            );
          }
        } finally {
          const cleanupIdentity = renamed
            ? (destinationIdentity ?? stagingIdentity)
            : stagingIdentity;
          if (!published && cleanupIdentity)
            removeStagingPath(
              renamed ? this.runPath : stagingPath,
              cleanupIdentity,
            );
        }
      },
      30_000,
      true,
      runsIdentity,
    );
  }
  withLock<T>(fn: () => T): T {
    const boundary = this.captureBoundary();
    return withExclusiveLock(
      this.lockPath,
      () => {
        this.assertBoundary(boundary);
        this.activeRunIdentity = boundary.run;
        try {
          const result = fn();
          this.assertBoundary(boundary);
          return result;
        } finally {
          this.activeRunIdentity = undefined;
        }
      },
      10_000,
      false,
      boundary.locks,
      boundary.lock,
    );
  }
  read(): any {
    return this.withLock(() => this.readUnlocked());
  }

  readRaw(): string {
    return this.withLock(() =>
      readRegularNoFollow(
        this.ledgerPath,
        this.rootPath,
        undefined,
        Number.MAX_SAFE_INTEGER,
        this.currentRunIdentity(),
      ).toString("utf8"),
    );
  }

  readUnlocked(): any {
    return readStoredLedger(() =>
      readRegularNoFollow(
        this.ledgerPath,
        this.rootPath,
        undefined,
        Number.MAX_SAFE_INTEGER,
        this.currentRunIdentity(),
      ).toString("utf8"),
    );
  }

  update(fn: (ledger: any) => unknown): unknown {
    return withExclusiveLock(join(this.rootPath, ".maintenance.lock"), () =>
      this.withLock(() => {
        const runIdentity = this.currentRunIdentity();
        const oldContent = readRegularNoFollow(
          this.ledgerPath,
          this.rootPath,
          undefined,
          Number.MAX_SAFE_INTEGER,
          runIdentity,
        ).toString("utf8");
        let ledger: any;
        try {
          ledger = JSON.parse(oldContent);
        } catch {
          throw new ContractError(
            "LEDGER_UNREADABLE",
            "Ledger is unreadable",
            5,
          );
        }
        requireCondition(
          ledger?.schema_version !== 1 && ledger?.schema_version !== undefined,
          "LEGACY_LEDGER_READ_ONLY",
          "Schema v1 ledgers are read-only; initialize or explicitly migrate a new v2 ledger",
          4,
        );
        requireCondition(
          ledger?.schema_version === 2,
          "UNSUPPORTED_SCHEMA",
          "Ledger schema version is unsupported",
          4,
        );
        if (ledger?.schema_version !== undefined)
          requireLedgerCompatibility(ledger, "write");
        ledger = normalizeLegacyLedger(ledger);
        const result = fn(ledger);
        const nextContent = JSON.stringify(ledger, null, 2) + "\n";
        if (nextContent !== oldContent) {
          writeAtomicNoFollow(
            join(this.runPath, "ledger.previous.json"),
            oldContent,
            this.rootPath,
            undefined,
            runIdentity,
          );
          syncDirectoryNoFollow(this.runPath, this.rootPath, runIdentity);
          this.onStage?.("snapshot_committed");
          writeAtomicNoFollow(
            this.ledgerPath,
            nextContent,
            this.rootPath,
            () => this.onStage?.("candidate_synced"),
            runIdentity,
          );
          syncDirectoryNoFollow(this.runPath, this.rootPath, runIdentity);
          this.onStage?.("ledger_committed");
        }
        return result;
      }),
    );
  }

  migrate(request: LedgerMigrationRequest): unknown {
    return this.maintain((context) => migrateLocked(context, request));
  }
  maintain<T>(fn: (context: LockedLedgerMigrationContext) => T): T {
    return withExclusiveLock(join(this.rootPath, ".maintenance.lock"), () =>
      this.withLock(() =>
        fn({
          rootPath: this.rootPath,
          runPath: this.runPath,
          ledgerPath: this.ledgerPath,
          runIdentity: this.currentRunIdentity(),
          onStage: this.onStage,
        }),
      ),
    );
  }
  private captureBoundary(): StoreBoundary {
    requireDirectory(this.runPath);
    requireDirectory(dirname(this.lockPath));
    const run = directoryIdentity(this.runPath);
    const locks = directoryIdentity(dirname(this.lockPath));
    let lock: FileIdentity | undefined;
    try {
      lock = identity(this.lockPath);
    } catch {}
    requireCondition(
      run && locks && lock,
      "UNSAFE_PATH",
      "Ledger storage identity is unavailable",
      5,
    );
    return { run, locks, lock };
  }
  private assertBoundary(boundary: StoreBoundary): void {
    const run = directoryIdentity(this.runPath);
    const locks = directoryIdentity(dirname(this.lockPath));
    let lock: FileIdentity | undefined;
    try {
      lock = identity(this.lockPath);
    } catch {}
    requireCondition(
      run &&
        locks &&
        lock &&
        sameIdentity(run, boundary.run) &&
        sameIdentity(locks, boundary.locks) &&
        sameIdentity(lock, boundary.lock),
      "UNSAFE_PATH",
      "Ledger storage identity changed during the operation",
      5,
    );
  }
  private currentRunIdentity(): DirectoryIdentity {
    const run = this.activeRunIdentity ?? directoryIdentity(this.runPath);
    requireCondition(
      run,
      "UNSAFE_PATH",
      "Run directory identity is unavailable",
      5,
    );
    return run;
  }
}
