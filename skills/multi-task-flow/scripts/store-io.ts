import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError, requireCondition } from "./errors";
import type { FileIdentity } from "../../../bin/modules/visual/isolation";
import { withExclusiveLock as withFlowExclusiveLock } from "../../../bin/modules/flow/storage";
export function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    const parent = dirname(path);
    requireCondition(
      parent !== path,
      "UNSAFE_PATH",
      "Cannot create filesystem root",
    );
    ensureDirectory(parent);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
  }
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

export function readRegular(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    requireCondition(
      fstatSync(fd).isFile(),
      "UNSAFE_PATH",
      "File must be a regular file",
    );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeAtomic(
  path: string,
  content: string,
  afterSync?: () => void,
): void {
  const tmp = join(dirname(path), `.ledger-${randomUUID()}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  afterSync?.();
  try {
    renameSync(tmp, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw error;
  }
}

export function withExclusiveLock<T>(
  lockPath: string,
  fn: () => T,
  labelOrTimeout: string | number = "ledger",
  createIfMissing = true,
  expectedParentIdentity?: FileIdentity,
  expectedFileIdentity?: FileIdentity,
): T {
  const timeoutMs =
    typeof labelOrTimeout === "number" ? labelOrTimeout : 10_000;
  const create = typeof labelOrTimeout === "number" ? createIfMissing : true;
  try {
    return withFlowExclusiveLock(
      lockPath,
      fn,
      timeoutMs,
      create,
      expectedParentIdentity,
      expectedFileIdentity,
    );
  } catch (error: any) {
    if (error?.message === "native_lock_unavailable")
      throw new ContractError(
        "UNSUPPORTED_PLATFORM",
        "No native ledger lock is available on this platform",
        6,
      );
    throw error;
  }
}
