import { createConnection } from "node:net";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const FIELDS = [
  "scope_id",
  "project",
  "repo_root",
  "branch",
  "worktree_path",
  "service",
  "port",
  "port_base",
  "block_size",
  "claimed_at",
  "last_seen_at",
  "agent_session",
  "pid",
] as const;
export type LeaseField = (typeof FIELDS)[number];
export type LeaseRow = Record<LeaseField, string>;

export const DEFAULT_START_BASE = 10000;
export const DEFAULT_STEP = 10;
export const DEFAULT_BLOCK_SIZE = 10;
export const DEFAULT_TTL_HOURS = 24;
export const LOCK_WAIT_INTERVAL_MS = 100;

export interface LockHandle {
  release(): void;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RegistryOptions {
  now?: () => Date;
  portListening?: (port: number) => Promise<boolean> | boolean;
  processAlive?: (pid: number | undefined) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  lockFactory?: (path: string) => LockHandle | null;
}

export function utcNowIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseIso(value: string): Date | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function portListening(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  for (const host of ["127.0.0.1", "::1"]) {
    const reachable = await new Promise<boolean>((done) => {
      const socket = createConnection({ host, port });
      const finish = (value: boolean) => {
        socket.destroy();
        done(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(200, () => finish(false));
    });
    if (reachable) return true;
  }
  return false;
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function serviceOffset(service: string): number | undefined {
  const offsets: Record<string, number> = {
    app: 0,
    web: 0,
    frontend: 0,
    api: 1,
    backend: 1,
    db: 2,
    postgres: 2,
    mysql: 2,
    redis: 3,
    cache: 3,
  };
  return offsets[service.trim().toLowerCase()];
}

export function parseIntValue(value: string, field: string): number {
  if (!/^[+-]?\d+$/.test(value.trim()))
    throw new RegistryError(`invalid integer for ${field}: ${value}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RegistryError(`invalid integer for ${field}: ${value}`);
  return result;
}

export function assertTcpPort(port: number, field = "port"): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new RegistryError(`invalid TCP ${field}: ${port} (must be 1..65535)`);
  return port;
}

export function parsePid(value: string | undefined): number | undefined {
  return value?.trim() ? parseIntValue(value, "pid") : undefined;
}

export function defaultRegistryDir(
  environ: Record<string, string | undefined> = process.env,
): string {
  if (environ.CODEX_PORT_REGISTRY_DIR) return environ.CODEX_PORT_REGISTRY_DIR;
  const codexHome = (
    environ.CODEX_HOME ?? resolve(homedir(), ".codex")
  ).replace(/^~(?=\/|$)/, homedir());
  return resolve(codexHome, "state", "port-registry");
}
