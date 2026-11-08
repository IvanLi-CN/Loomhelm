import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { systemClock } from "../core/clock";
import { tryLockFile } from "../core/security_file";
import {
  FIELDS,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_TTL_HOURS,
  LOCK_WAIT_INTERVAL_MS,
  RegistryError,
  assertTcpPort,
  parseIntValue,
  parseIso,
  parsePid,
  portListening,
  processAlive,
  utcNowIso,
  type LeaseRow,
  type LockHandle,
  type RegistryOptions,
} from "./port_registry_shared";

export class PortRegistryStore {
  readonly root: string;
  readonly tsvPath: string;
  readonly lockPath: string;
  protected readonly options: Required<
    Pick<
      RegistryOptions,
      "now" | "portListening" | "processAlive" | "sleep" | "lockFactory"
    >
  >;

  constructor(rootDir: string, options: RegistryOptions = {}) {
    this.root = resolve(rootDir.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
    this.tsvPath = resolve(this.root, "leases.tsv");
    this.lockPath = resolve(this.root, "leases.lock");
    this.options = {
      now: options.now ?? (() => new Date()),
      portListening: options.portListening ?? portListening,
      processAlive: options.processAlive ?? processAlive,
      sleep: options.sleep ?? ((ms) => systemClock.sleep(ms)),
      lockFactory: options.lockFactory ?? ((path) => tryLockFile(path)),
    };
  }

  async ensureLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = await open(this.lockPath, "a", 0o600);
    await lock.close();
    try {
      await access(this.tsvPath);
    } catch {
      await this.atomicWrite([]);
    }
  }

  private async acquireLock(timeoutSec: number): Promise<LockHandle> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockFile = await open(this.lockPath, "a", 0o600);
    await lockFile.close();
    const deadline = Date.now() + timeoutSec * 1000;
    while (true) {
      const handle = this.options.lockFactory(this.lockPath);
      if (handle) {
        try {
          await access(this.tsvPath);
        } catch {
          await this.atomicWrite([]);
        }
        return handle;
      }
      if (Date.now() >= deadline)
        throw new RegistryError(`timed out waiting for lock: ${this.lockPath}`, "REGISTRY_LOCK_TIMEOUT");
      await this.options.sleep(LOCK_WAIT_INTERVAL_MS);
    }
  }

  async readRows(): Promise<LeaseRow[]> {
    await this.ensureLayout();
    return this.readRowsUnlocked();
  }

  private async readRowsUnlocked(): Promise<LeaseRow[]> {
    const text = await readFile(this.tsvPath, "utf8");
    const rows: LeaseRow[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line || line.startsWith("#")) continue;
      const columns = line.split("\t");
      if (columns.join("\t") === FIELDS.join("\t")) continue;
      if (columns.length !== FIELDS.length)
        throw new RegistryError(
          `invalid column count in ${this.tsvPath}:${index + 1}`,
        );
      const row = Object.fromEntries(
        FIELDS.map((field, fieldIndex) => [field, columns[fieldIndex] ?? ""]),
      ) as LeaseRow;
      row.service = row.service.trim().toLowerCase();
      row.port = String(parseIntValue(row.port, "port"));
      row.block_size = String(
        parseIntValue(
          row.block_size || String(DEFAULT_BLOCK_SIZE),
          "block_size",
        ),
      );
      if (!row.claimed_at) row.claimed_at = utcNowIso(this.options.now());
      if (!row.last_seen_at) row.last_seen_at = row.claimed_at;
      rows.push(row);
    }
    this.validateRows(rows);
    return rows;
  }

  validateRows(rows: LeaseRow[]): void {
    const keys = new Map<string, number>();
    const ports = new Map<number, [string, string]>();
    rows.forEach((row, index) => {
      const key = `${row.scope_id}\0${row.service}`;
      if (keys.has(key))
        throw new RegistryError(
          `duplicate scope/service lease at row ${keys.get(key)} and row ${index + 1}`,
        );
      keys.set(key, index + 1);
      const port = assertTcpPort(parseIntValue(row.port, "port"));
      const previous = ports.get(port);
      if (previous)
        throw new RegistryError(
          `duplicate port lease for ${port}: ${previous[0]}/${previous[1]} and ${row.scope_id}/${row.service}`,
        );
      ports.set(port, [row.scope_id, row.service]);
      if (row.port_base)
        assertTcpPort(parseIntValue(row.port_base, "port_base"), "port_base");
      if (row.pid) parsePid(row.pid);
    });
  }

  async atomicWrite(rows: LeaseRow[]): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = resolve(this.root, `.leases.${randomUUID()}.tmp`);
    const text = [
      "# Active global port leases",
      `# ${FIELDS.join("\t")}`,
      ...rows.map((row) => FIELDS.map((field) => row[field] ?? "").join("\t")),
      "",
    ].join("\n");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.write(text, undefined, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.tsvPath);
      await chmod(this.tsvPath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async withLockedRows<T>(
    timeoutSec: number,
    callback: (rows: LeaseRow[]) => Promise<{ changed: boolean; value: T }>,
  ): Promise<T> {
    const lock = await this.acquireLock(timeoutSec);
    try {
      const rows = await this.readRowsUnlocked();
      const result = await callback(rows);
      if (result.changed) {
        this.validateRows(rows);
        await this.atomicWrite(rows);
      }
      return result.value;
    } finally {
      lock.release();
    }
  }

  protected now(): string {
    return utcNowIso(this.options.now());
  }

  protected async collectGc(
    rows: LeaseRow[],
    ttlHours: number,
  ): Promise<LeaseRow[]> {
    const now = this.options.now().getTime();
    const removed: LeaseRow[] = [];
    const kept: LeaseRow[] = [];
    for (const row of rows) {
      const pid = parsePid(row.pid);
      if (pid !== undefined) {
        const alive = this.options.processAlive(pid);
        const listening = await this.options.portListening(
          parseIntValue(row.port, "port"),
        );
        if (!alive || !listening)
          removed.push({
            ...row,
            gc_reason: !alive ? "pid_dead" : "port_not_listening",
          } as LeaseRow);
        else kept.push(row);
        continue;
      }
      const marker = parseIso(row.last_seen_at) ?? parseIso(row.claimed_at);
      const listening = await this.options.portListening(
        parseIntValue(row.port, "port"),
      );
      if (
        !marker ||
        (now - marker.getTime()) / 3600000 <= ttlHours ||
        listening
      )
        kept.push(row);
      else removed.push(row);
    }
    rows.splice(0, rows.length, ...kept);
    return removed;
  }
}
