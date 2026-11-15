import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { systemClock } from "../core/clock";
import { tryLockFile } from "../core/security_file";
import { FlowError, canonicalJson, sha256Bytes } from "./common";

export interface StableBytes {
  bytes: Uint8Array;
  identity: string;
}

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function withExclusiveLock<T>(
  path: string,
  callback: () => T,
  timeoutMs = 30_000,
  createIfMissing = true,
  expectedParentIdentity?: { dev: number; ino: number },
  expectedFileIdentity?: { dev: number; ino: number },
): T {
  if (createIfMissing) ensureDirectory(dirname(path));
  const started = Date.now();
  while (true) {
    const lock = tryLockFile(
      path,
      createIfMissing,
      expectedParentIdentity,
      expectedFileIdentity,
    );
    if (lock !== null) {
      try {
        return callback();
      } finally {
        lock.release();
      }
    }
    if (Date.now() - started >= timeoutMs)
      throw new FlowError("flow state lock timed out");
    sleepSync(10);
  }
}

export async function withExclusiveLockAsync<T>(
  path: string,
  callback: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  ensureDirectory(dirname(path));
  const started = Date.now();
  while (true) {
    const lock = tryLockFile(path);
    if (lock !== null) {
      try {
        return await callback();
      } finally {
        lock.release();
      }
    }
    if (Date.now() - started >= timeoutMs)
      throw new FlowError("flow state lock timed out");
    await systemClock.sleep(10);
  }
}

export function atomicWriteBytes(path: string, bytes: Uint8Array): void {
  ensureDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1) ?? "state"}.${randomUUID()}.tmp`,
  );
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteBytes(path, Buffer.from(prettyJson(value), "utf8"));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

export function readJson(path: string, errorMessage: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        stableFileBytes(path, errorMessage),
      ),
    );
  } catch (error) {
    throw new FlowError(errorMessage, { cause: error });
  }
}

export function stableFileBytes(path: string, label: string): Uint8Array {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number")
    throw new FlowError(`${label} cannot be read without no-follow support`);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      Math.trunc(before.mtimeMs * 1_000_000) !==
        Math.trunc(after.mtimeMs * 1_000_000) ||
      Math.trunc(before.ctimeMs * 1_000_000) !==
        Math.trunc(after.ctimeMs * 1_000_000)
    )
      throw new FlowError(`${label} changed while being read`);
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof FlowError) throw error;
    throw new FlowError(`${label} cannot be read`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function stableFileDigest(path: string, label: string): string {
  return sha256Bytes(stableFileBytes(path, label));
}

export function archiveImmutable(
  path: string,
  bytes: Uint8Array,
  label: string,
): void {
  ensureDirectory(dirname(path));
  if (existsSync(path)) {
    const current = stableFileBytes(path, label);
    if (Buffer.compare(Buffer.from(current), Buffer.from(bytes)) !== 0) {
      throw new FlowError(`${label} already exists with different content`);
    }
    return;
  }
  atomicWriteBytes(path, bytes);
}

export function readText(path: string, label: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    stableFileBytes(path, label),
  );
}

export function canonicalText(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

export function prettyJson(value: unknown): string {
  const text = `${JSON.stringify(sortJson(value), null, 2)}\n`;
  return text.replace(/[^\x00-\x7f]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function archiveBytes(
  path: string,
  bytes: Uint8Array,
  label: string,
): void {
  ensureDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1) ?? "archive"}.${randomUUID()}.tmp`,
  );
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = stableFileBytes(path, label);
    if (Buffer.compare(Buffer.from(current), Buffer.from(bytes)) !== 0)
      throw new FlowError(`${label} already exists with different content`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
