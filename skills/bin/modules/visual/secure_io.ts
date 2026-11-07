import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as constants from "node:constants";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { linuxLibraries, loadRenameAt2 } from "./native_rename";
import { openTrustedDirectory } from "./trusted_directory";
import { writeAll } from "./write_all";
const open = fs.openSync,
  read = fs.readSync,
  c = constants;
const directoryFlags = c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW;
type NativeSymbol = "openat" | "fchmod" | "mkdirat" | "renameat" | "unlinkat";
type PosixLibrary = {
  symbols: Record<NativeSymbol, (...args: number[]) => number>;
};
type AtomicContent = string | Uint8Array | ((fileFd: number) => void);
export type DirectoryIdentity = { dev: number; ino: number };
let posixLibrary: PosixLibrary | undefined;
function loadPosix(): PosixLibrary {
  if (posixLibrary) return posixLibrary;
  const libraries =
    process.platform === "darwin" ? ["libSystem.B.dylib"] : linuxLibraries();
  for (const library of libraries) {
    try {
      const symbols = {
        openat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        fchmod: {
          args: [FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        mkdirat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        renameat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
          returns: FFIType.i32,
        },
        unlinkat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      };
      posixLibrary = dlopen(library, symbols) as unknown as PosixLibrary;
      return posixLibrary;
    } catch {}
  }
  throw new Error("native no-follow library is unavailable");
}
function isWithin(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const delta = relative(rootPath, targetPath);
  return (
    delta === "" ||
    (delta !== ".." && !delta.startsWith(`..${sep}`) && !delta.startsWith(sep))
  );
}
function openDirectoryNoFollow(
  path: string,
  stopAt?: string,
  expectedIdentity?: DirectoryIdentity,
): { descriptor: number; canonicalPath: string } {
  const absolute = resolve(path);
  const requestedRoot = resolve(stopAt ?? sep);
  if (stopAt && !isWithin(requestedRoot, absolute))
    throw new Error("path is outside its trusted root");
  let canonicalRoot: string;
  let targetRelative: string;
  let descriptor = -1;
  try {
    if (stopAt) {
      const trustedRoot = openTrustedDirectory(
        requestedRoot,
        directoryFlags,
        openDirectoryNoFollow,
      );
      descriptor = trustedRoot.descriptor;
      canonicalRoot = trustedRoot.canonicalPath;
    } else {
      canonicalRoot = fs.realpathSync(requestedRoot);
    }
    targetRelative = relative(requestedRoot, absolute);
  } catch {
    if (descriptor >= 0) fs.closeSync(descriptor);
    throw new Error("no-follow directory path is unavailable");
  }
  if (!stopAt && process.platform === "darwin") {
    const alias = `/${absolute.split(sep).filter(Boolean)[0] ?? ""}`;
    if (["/etc", "/tmp", "/var"].includes(alias)) {
      canonicalRoot = fs.realpathSync(alias);
      targetRelative = relative(alias, absolute);
    }
  }
  const canonicalTarget = resolve(canonicalRoot, targetRelative);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    if (descriptor >= 0) fs.closeSync(descriptor);
    throw new Error("path escapes its trusted root");
  }
  const parts = relative(canonicalRoot, canonicalTarget)
    .split(sep)
    .filter(Boolean);
  try {
    const api = loadPosix();
    if (descriptor < 0) descriptor = open(canonicalRoot, directoryFlags);
    for (const component of parts) {
      const encoded = new TextEncoder().encode(`${component}\0`);
      const next = api.symbols.openat(
        descriptor,
        ptr(encoded),
        c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | c.O_DIRECTORY,
        0,
      );
      if (next < 0) throw new Error("no-follow directory path opening failed");
      fs.closeSync(descriptor);
      descriptor = next;
    }
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isDirectory() ||
      (expectedIdentity !== undefined &&
        (metadata.dev !== expectedIdentity.dev ||
          metadata.ino !== expectedIdentity.ino))
    )
      throw new Error("no-follow directory identity changed");
    return { descriptor, canonicalPath: canonicalTarget };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}
function nativeOpenError(path: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  try {
    fs.lstatSync(path);
    error.code = "EEXIST";
  } catch (probe) {
    error.code = (probe as NodeJS.ErrnoException).code ?? "EIO";
  }
  return error;
}
export function readRegularNoFollow(
  path: string,
  stopAt?: string,
  onChunk?: (chunk: Buffer) => void,
  maxBytes = Number.MAX_SAFE_INTEGER,
  expectedParentIdentity?: DirectoryIdentity,
): Buffer {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("platform lacks no-follow path opening");
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const leaf = basename(absolute);
  const api = loadPosix();
  const directory = openDirectoryNoFollow(
    parent,
    stopAt,
    expectedParentIdentity,
  );
  const encoded = new TextEncoder().encode(`${leaf}\0`);
  let descriptor = api.symbols.openat(
    directory.descriptor,
    ptr(encoded),
    c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK,
    0,
  );
  try {
    if (descriptor < 0) throw new Error("no-follow path opening failed");
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1)
      throw new Error("no-follow path is not a regular file");
    if (metadata.size > maxBytes) throw new Error("file exceeds read limit");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    let length = 0;
    while ((length = read(descriptor, chunk, 0, chunk.length, null)) > 0) {
      total += length;
      if (total > maxBytes) throw new Error("file exceeds read limit");
      const bytes = chunk.subarray(0, length);
      if (onChunk) onChunk(bytes);
      else chunks.push(Buffer.from(bytes));
    }
    return onChunk ? Buffer.alloc(0) : Buffer.concat(chunks, total);
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
    fs.closeSync(directory.descriptor);
  }
}
export function writeExclusiveNoFollow(
  path: string,
  content: string | Uint8Array,
  stopAt?: string,
  expectedParentIdentity?: DirectoryIdentity,
): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("sandbox log path lacks no-follow support");
  const absolute = resolve(path);
  if (!basename(absolute) || basename(absolute) === sep)
    throw new Error("sandbox log path must be a file");
  const api = loadPosix();
  const directory = openDirectoryNoFollow(
    dirname(absolute),
    stopAt,
    expectedParentIdentity,
  );
  const directoryFd = directory.descriptor;
  let fileFd = -1;
  let created = false;
  let completed = false;
  try {
    const leaf = new TextEncoder().encode(`${basename(absolute)}\0`);
    fileFd = api.symbols.openat(
      directoryFd,
      ptr(leaf),
      c.O_RDWR | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW,
      0o600,
    );
    if (fileFd < 0)
      throw nativeOpenError(
        absolute,
        "sandbox log path is already present or unsafe",
      );
    created = true;
    if (api.symbols.fchmod(fileFd, 0o600) !== 0)
      throw new Error("sandbox log permissions could not be secured");
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    writeAll(fileFd, bytes, "sandbox log write failed");
    fs.fsyncSync(fileFd);
    completed = true;
  } finally {
    if (fileFd >= 0) fs.closeSync(fileFd);
    if (created && !completed)
      api.symbols.unlinkat(
        directoryFd,
        ptr(new TextEncoder().encode(`${basename(absolute)}\0`)),
        0,
      );
    fs.closeSync(directoryFd);
  }
}

export function createDirectoryNoFollow(
  path: string,
  stopAt?: string,
  mode = 0o700,
  expectedParentIdentity?: DirectoryIdentity,
): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "directory creation without symlink traversal is unavailable",
    );
  const absolute = resolve(path);
  const directory = openDirectoryNoFollow(
    dirname(absolute),
    stopAt,
    expectedParentIdentity,
  );
  try {
    const leaf = new TextEncoder().encode(`${basename(absolute)}\0`);
    if (
      loadPosix().symbols.mkdirat(directory.descriptor, ptr(leaf), mode) !== 0
    )
      throw nativeOpenError(absolute, "directory creation failed");
  } finally {
    fs.closeSync(directory.descriptor);
  }
}
export function copyFileExclusiveNoFollow(
  source: string,
  destination: string,
  stopAt?: string,
): void {
  const absolute = resolve(destination);
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  writeExclusiveNoFollow(temporary, Buffer.alloc(0), stopAt);
  try {
    const directory = openDirectoryNoFollow(dirname(temporary), stopAt);
    const leaf = new TextEncoder().encode(`${basename(temporary)}\0`);
    let fileFd = loadPosix().symbols.openat(
      directory.descriptor,
      ptr(leaf),
      c.O_RDWR | c.O_NOFOLLOW,
      0,
    );
    try {
      if (fileFd < 0) throw new Error("temporary copy file opening failed");
      readRegularNoFollow(source, undefined, (chunk) =>
        writeAll(fileFd, chunk, "file copy failed"),
      );
    } finally {
      if (fileFd >= 0) fs.closeSync(fileFd);
      fs.closeSync(directory.descriptor);
    }
    renameNoReplace(temporary, absolute, stopAt);
  } catch (error) {
    try {
      unlinkNoFollow(temporary, stopAt);
    } catch {}
    throw error;
  }
}
export function unlinkNoFollow(path: string, stopAt?: string): void {
  const absolute = resolve(path);
  const directory = openDirectoryNoFollow(dirname(absolute), stopAt);
  const name = new TextEncoder().encode(`${basename(absolute)}\0`);
  try {
    if (loadPosix().symbols.unlinkat(directory.descriptor, ptr(name), 0) !== 0)
      throw new Error("no-follow unlink failed");
  } finally {
    fs.closeSync(directory.descriptor);
  }
}
export function writeAtomicNoFollow(
  path: string,
  content: AtomicContent,
  stopAt?: string,
  afterSync?: () => void,
  expectedParentIdentity?: DirectoryIdentity,
): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("atomic no-follow write is unavailable");
  const absolute = resolve(path);
  const directory = openDirectoryNoFollow(
    dirname(absolute),
    stopAt,
    expectedParentIdentity,
  );
  const api = loadPosix();
  const token = randomBytes(8).toString("hex");
  const temporaryName = `.${basename(absolute)}.${token}.tmp`;
  const temporaryPath = join(directory.canonicalPath, temporaryName);
  const encodedTemporary = new TextEncoder().encode(`${temporaryName}\0`);
  const encodedDestination = new TextEncoder().encode(
    `${basename(absolute)}\0`,
  );
  let fileFd = -1;
  let committed = false;
  try {
    fileFd = api.symbols.openat(
      directory.descriptor,
      ptr(encodedTemporary),
      c.O_RDWR | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW,
      0o600,
    );
    if (fileFd < 0)
      throw nativeOpenError(
        temporaryPath,
        "atomic temporary file creation failed",
      );
    if (api.symbols.fchmod(fileFd, 0o600) !== 0)
      throw new Error("atomic output permissions could not be secured");
    if (typeof content === "function") content(fileFd);
    else {
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      writeAll(fileFd, bytes, "atomic output write failed");
    }
    fs.fsyncSync(fileFd);
    afterSync?.();
    fs.closeSync(fileFd);
    fileFd = -1;
    if (
      api.symbols.renameat(
        directory.descriptor,
        ptr(encodedTemporary),
        directory.descriptor,
        ptr(encodedDestination),
      ) !== 0
    )
      throw new Error("atomic output rename failed");
    committed = true;
  } finally {
    if (fileFd >= 0) fs.closeSync(fileFd);
    if (!committed)
      api.symbols.unlinkat(directory.descriptor, ptr(encodedTemporary), 0);
    fs.closeSync(directory.descriptor);
  }
}

export function syncDirectoryNoFollow(
  path: string,
  stopAt?: string,
  expectedIdentity?: DirectoryIdentity,
): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("directory sync is unavailable");
  const directory = openDirectoryNoFollow(path, stopAt, expectedIdentity);
  try {
    fs.fsyncSync(directory.descriptor);
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

export function renameNoReplace(
  source: string,
  destination: string,
  stopAt?: string,
  expectedParentIdentity?: DirectoryIdentity,
): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("atomic no-replace rename is unavailable");
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  const sourceParent = dirname(sourcePath);
  const destinationParent = dirname(destinationPath);
  if (sourceParent !== destinationParent)
    throw new Error("atomic no-replace rename requires one parent directory");
  const directory = openDirectoryNoFollow(
    sourceParent,
    stopAt,
    expectedParentIdentity,
  );
  const directoryFd = directory.descriptor;
  const sourceName = new TextEncoder().encode(`${basename(sourcePath)}\0`);
  const destinationName = new TextEncoder().encode(
    `${basename(destinationPath)}\0`,
  );
  let renameFunction: (...args: number[]) => number;
  let closeLibrary = (): void => {};
  let flags: number;
  try {
    if (process.platform === "darwin") {
      const library = dlopen("libSystem.B.dylib", {
        renameatx_np: {
          args: [
            FFIType.i32,
            FFIType.ptr,
            FFIType.i32,
            FFIType.ptr,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      });
      renameFunction = library.symbols
        .renameatx_np as unknown as typeof renameFunction;
      closeLibrary = () => library.close();
      flags = 0x0004;
    } else {
      renameFunction = loadRenameAt2();
      flags = 0x0001;
    }
    const result = renameFunction(
      directoryFd,
      ptr(sourceName),
      directoryFd,
      ptr(destinationName),
      flags,
    );
    if (result !== 0) {
      const error = new Error(
        "atomic no-replace rename failed or destination already exists",
      ) as NodeJS.ErrnoException;
      try {
        fs.lstatSync(destinationPath);
        error.code = "EEXIST";
      } catch {
        error.code = "EIO";
      }
      throw error;
    }
  } finally {
    closeLibrary();
    fs.closeSync(directoryFd);
  }
}
