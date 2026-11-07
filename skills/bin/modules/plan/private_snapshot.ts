import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CString, dlopen, FFIType } from "bun:ffi";

export interface PrivateSnapshot {
  path: string;
  identity: string;
  parentIdentity: string;
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  let current = "/";
  for (const part of absolute.split("/").filter(Boolean)) {
    current = current === "/" ? "/" + part : current + "/" + part;
    if (lstatSync(current).isSymbolicLink())
      throw new Error("DEV_PLAN_SOURCE_SYMLINK_FORBIDDEN: " + current);
  }
}

function assertTrustedDirectory(path: string): string {
  const absolute = resolve(path);
  const canonical = realpathSync(absolute);
  assertNoSymlinkComponents(canonical);
  const entry = statSync(canonical);
  const uid = process.getuid?.() ?? -1;
  if (!entry.isDirectory())
    throw new Error("DEV_PLAN_TEMP_DIRECTORY_INVALID: " + canonical);
  if (entry.uid !== 0 && entry.uid !== uid)
    throw new Error("DEV_PLAN_TEMP_DIRECTORY_OWNER_UNTRUSTED: " + canonical);
  if ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)
    throw new Error("DEV_PLAN_TEMP_DIRECTORY_WRITABLE: " + canonical);
  let current = dirname(canonical);
  while (true) {
    assertNoSymlinkComponents(current);
    const ancestor = statSync(current);
    if (ancestor.uid !== 0 && ancestor.uid !== uid)
      throw new Error("DEV_PLAN_TEMP_ANCESTOR_OWNER_UNTRUSTED: " + current);
    if ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0)
      throw new Error("DEV_PLAN_TEMP_ANCESTOR_WRITABLE: " + current);
    if (current === "/") break;
    current = dirname(current);
  }
  return canonical;
}

function identity(entry: { dev: number; ino: number }): string {
  return String(entry.dev) + ":" + String(entry.ino);
}

function isNoEntry(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

interface PosixLibrary {
  symbols: {
    openat(
      directoryFd: number,
      path: Uint8Array,
      flags: number,
      mode: number,
    ): number;
    unlinkat(directoryFd: number, path: Uint8Array, flags: number): number;
    dup(fileDescriptor: number): number;
    fdopendir(fileDescriptor: number): number;
    readdir(directory: number): number;
    closedir(directory: number): number;
  };
}

let posixLibrary: PosixLibrary | undefined;

function loadPosix(): PosixLibrary {
  if (posixLibrary) return posixLibrary;
  const muslArch: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
  const libraries =
    process.platform === "darwin"
      ? ["libSystem.B.dylib"]
      : [
          "libc.so.6",
          ...(muslArch[process.arch] === undefined
            ? []
            : [`libc.musl-${muslArch[process.arch]}.so.1`]),
          "libc.so",
        ];
  for (const library of libraries) {
    try {
      posixLibrary = dlopen(library, {
        openat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        unlinkat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        dup: {
          args: [FFIType.i32],
          returns: FFIType.i32,
        },
        fdopendir: {
          args: [FFIType.i32],
          returns: FFIType.ptr,
        },
        readdir: {
          args: [FFIType.ptr],
          returns: FFIType.ptr,
        },
        closedir: {
          args: [FFIType.ptr],
          returns: FFIType.i32,
        },
      }) as PosixLibrary;
      return posixLibrary;
    } catch {}
  }
  throw new Error("DEV_PLAN_TEMP_NATIVE_LIBRARY_UNAVAILABLE");
}

// Pass the owning buffer to Bun FFI; a bare pointer cannot keep it alive.
function cString(value: string): Uint8Array {
  if (value.includes("\0")) throw new Error("native path contains NUL");
  return new TextEncoder().encode(value + "\0");
}

function directoryFlags(): number {
  return (
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK
  );
}

function fileFlags(): number {
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function openAt(directoryFd: number, name: string, flags: number): number {
  const fd = loadPosix().symbols.openat(directoryFd, cString(name), flags, 0);
  if (fd < 0) throw new Error("private snapshot entry open failed: " + name);
  return fd;
}

function unlinkAt(directoryFd: number, name: string, flags: number): void {
  if (loadPosix().symbols.unlinkat(directoryFd, cString(name), flags) < 0)
    throw new Error("private snapshot entry removal failed: " + name);
}

function tryOpenAt(directoryFd: number, name: string, flags: number): number {
  return loadPosix().symbols.openat(directoryFd, cString(name), flags, 0);
}

function directoryNames(directoryFd: number): string[] {
  const duplicate = loadPosix().symbols.dup(directoryFd);
  if (duplicate < 0)
    throw new Error("private snapshot directory duplication failed");
  const directory = loadPosix().symbols.fdopendir(duplicate);
  if (!directory) {
    closeSync(duplicate);
    throw new Error("private snapshot directory open failed");
  }
  const names: string[] = [];
  const nameOffset = process.platform === "darwin" ? 21 : 19;
  try {
    let entry: number | null;
    while (
      (entry = loadPosix().symbols.readdir(directory)) !== null &&
      entry !== 0
    )
      names.push(new CString(entry + nameOffset));
  } finally {
    loadPosix().symbols.closedir(directory);
  }
  return names;
}

function removeDirectoryContents(directoryFd: number): void {
  for (const name of directoryNames(directoryFd)) {
    if (name === "." || name === "..") continue;
    if (!name || name.includes("/"))
      throw new Error(
        "private snapshot entry name changed: " + JSON.stringify(name),
      );
    const childFd = tryOpenAt(directoryFd, name, directoryFlags());
    if (childFd >= 0) {
      try {
        const entry = fstatSync(childFd);
        removeDirectoryContents(childFd);
        const currentFd = tryOpenAt(directoryFd, name, directoryFlags());
        try {
          if (
            currentFd < 0 ||
            identity(fstatSync(currentFd)) !== identity(entry)
          )
            throw new Error("private snapshot directory identity changed");
        } finally {
          if (currentFd >= 0) closeSync(currentFd);
        }
      } finally {
        closeSync(childFd);
      }
      unlinkAt(directoryFd, name, process.platform === "darwin" ? 0x80 : 0x200);
      continue;
    }
    const fileFd = openAt(directoryFd, name, fileFlags());
    try {
      const entry = fstatSync(fileFd);
      if (!entry.isFile())
        throw new Error("private snapshot entry type changed");
      const currentFd = tryOpenAt(directoryFd, name, fileFlags());
      try {
        if (currentFd < 0 || identity(fstatSync(currentFd)) !== identity(entry))
          throw new Error("private snapshot file identity changed");
      } finally {
        if (currentFd >= 0) closeSync(currentFd);
      }
    } finally {
      closeSync(fileFd);
    }
    unlinkAt(directoryFd, name, 0);
  }
}

export function cleanupPrivateSnapshot(
  path: string,
  expectedIdentity: string,
  expectedParentIdentity = "",
): void {
  if (!path || !/\/plan-review\.[^/]+$/.test(path)) return;
  const parent = dirname(path);
  let parentIdentity: string;
  let parentFd = -1;
  let snapshotFd = -1;
  try {
    if (assertTrustedDirectory(parent) !== parent)
      throw new Error("parent canonicalization changed");
    parentIdentity = identity(lstatSync(parent));
    if (expectedParentIdentity && parentIdentity !== expectedParentIdentity)
      throw new Error("private snapshot parent identity changed");
    parentFd = openSync(parent, directoryFlags());
    if (identity(fstatSync(parentFd)) !== parentIdentity)
      throw new Error("private snapshot parent identity changed");
  } catch (error) {
    if (parentFd >= 0) closeSync(parentFd);
    throw new Error(
      "DEV_PLAN_TEMP_CLEANUP_FAILED: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    const initial = lstatSync(path);
    if (
      !initial.isDirectory() ||
      initial.isSymbolicLink() ||
      identity(initial) !== expectedIdentity
    )
      throw new Error("private snapshot identity changed");
  } catch (error) {
    if (isNoEntry(error)) {
      closeSync(parentFd);
      parentFd = -1;
      return;
    }
    closeSync(parentFd);
    parentFd = -1;
    throw new Error(
      "DEV_PLAN_TEMP_CLEANUP_FAILED: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    const name = path.slice(parent.length + 1);
    snapshotFd = openAt(parentFd, name, directoryFlags());
    const entry = fstatSync(snapshotFd);
    if (!entry.isDirectory() || identity(entry) !== expectedIdentity)
      throw new Error("private snapshot identity changed");
    removeDirectoryContents(snapshotFd);
    if (identity(lstatSync(parent)) !== parentIdentity)
      throw new Error("private snapshot parent changed during cleanup");
    const current = lstatSync(path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      identity(current) !== expectedIdentity
    )
      throw new Error("private snapshot identity changed");
    const currentFd = tryOpenAt(parentFd, name, directoryFlags());
    try {
      if (currentFd < 0 || identity(fstatSync(currentFd)) !== expectedIdentity)
        throw new Error("private snapshot identity changed");
    } finally {
      if (currentFd >= 0) closeSync(currentFd);
    }
    closeSync(snapshotFd);
    snapshotFd = -1;
    unlinkAt(parentFd, name, process.platform === "darwin" ? 0x80 : 0x200);
  } catch (error) {
    let missing = false;
    try {
      lstatSync(path);
    } catch (currentError) {
      missing = isNoEntry(currentError);
    }
    const parentChanged =
      error instanceof Error && error.message.includes("parent changed");
    if (snapshotFd >= 0) closeSync(snapshotFd);
    if (parentFd >= 0) closeSync(parentFd);
    if (missing && !parentChanged) return;
    throw new Error(
      "DEV_PLAN_TEMP_CLEANUP_FAILED: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    if (
      identity(lstatSync(parent)) !== parentIdentity ||
      identity(fstatSync(parentFd)) !== parentIdentity
    )
      throw new Error("private snapshot parent changed during cleanup");
  } catch (error) {
    throw new Error(
      "DEV_PLAN_TEMP_CLEANUP_FAILED: " +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (snapshotFd >= 0) closeSync(snapshotFd);
    if (parentFd >= 0) closeSync(parentFd);
  }
}

export function createPrivateSnapshot(): PrivateSnapshot {
  const parent = assertTrustedDirectory(tmpdir());
  const parentIdentity = identity(lstatSync(parent));
  const created = mkdtempSync(join(parent, "plan-review."));
  let createdIdentity = "";
  try {
    createdIdentity = identity(lstatSync(created));
    chmodSync(created, 0o700);
    const canonical = realpathSync(created);
    const current = lstatSync(canonical);
    if (
      !current.isDirectory() ||
      identity(current) !== createdIdentity ||
      identity(lstatSync(parent)) !== parentIdentity
    )
      throw new Error("DEV_PLAN_TEMP_DIRECTORY_CHANGED: " + created);
    return { path: canonical, identity: createdIdentity, parentIdentity };
  } catch (error) {
    try {
      const cleanupIdentity = createdIdentity || identity(lstatSync(created));
      cleanupPrivateSnapshot(created, cleanupIdentity, parentIdentity);
    } catch {}
    throw error;
  }
}
