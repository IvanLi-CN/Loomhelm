import { constants, open, realpath } from "node:fs/promises";
import {
  closeSync,
  fstatSync,
  fchmodSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

interface PosixLibrary {
  symbols: {
    flock(fd: number, operation: number): number;
    openat(
      directoryFd: number,
      path: number,
      flags: number,
      mode: number,
    ): number;
    close(fd: number): number;
  };
}

let posixLibrary: PosixLibrary | undefined;

function hasTrustedLockAncestors(path: string, currentUid: number): boolean {
  let directory = path;
  while (true) {
    const entry = statSync(directory);
    const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      (entry.uid !== currentUid && entry.uid !== 0) ||
      ((entry.mode & 0o022) !== 0 && !stickyRoot)
    ) {
      return false;
    }
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

function loadPosix(): PosixLibrary {
  if (posixLibrary) return posixLibrary;
  const muslArch: Record<string, string> = {
    x64: "x86_64",
    arm64: "aarch64",
  };
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
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      }) as PosixLibrary;
      return posixLibrary;
    } catch {}
  }
  throw new Error("native_library_unavailable");
}

export async function readRegularNoFollow(path: string): Promise<Uint8Array> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("native_path_unavailable");
  }
  const absolute = resolve(path);
  const parent = await open(
    dirname(absolute),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const resolvedParent = await realpath(dirname(absolute));
    if (dirname(absolute) !== resolvedParent) {
      throw new Error("secure_path_ancestor_rejected");
    }
    const api = loadPosix();
    const openedParent = fstatSync(parent.fd);
    const canonicalParent = statSync(resolvedParent);
    if (
      openedParent.dev !== canonicalParent.dev ||
      openedParent.ino !== canonicalParent.ino
    ) {
      throw new Error("secure_path_parent_changed");
    }
    const fileName = new TextEncoder().encode(`${basename(absolute)}\0`);
    const fd = api.symbols.openat(
      parent.fd,
      ptr(fileName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (fd < 0) throw new Error("secure_file_open_failed");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("secure_file_type_rejected");
      const chunks: Buffer[] = [];
      const chunk = Buffer.alloc(64 * 1024);
      while (true) {
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        chunks.push(Buffer.from(chunk.subarray(0, count)));
      }
      return Buffer.concat(chunks);
    } finally {
      api.symbols.close(fd);
    }
  } finally {
    await parent.close();
  }
}

export function tryLockFile(
  path: string,
  createIfMissing = true,
  expectedParentIdentity?: { dev: number; ino: number },
  expectedFileIdentity?: { dev: number; ino: number },
): { release(): void } | null {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("native_lock_unavailable");
  }
  const api = loadPosix();
  const absolute = resolve(path);
  const parentFd = openSync(
    dirname(absolute),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  let fd = -1;
  try {
    const canonicalParent = realpathSync(dirname(absolute));
    const openedParent = fstatSync(parentFd);
    const pathParent = statSync(canonicalParent);
    const currentUid = process.getuid?.();
    if (
      canonicalParent !== dirname(absolute) ||
      currentUid === undefined ||
      openedParent.uid !== currentUid ||
      (openedParent.mode & 0o022) !== 0 ||
      !hasTrustedLockAncestors(canonicalParent, currentUid) ||
      openedParent.dev !== pathParent.dev ||
      openedParent.ino !== pathParent.ino ||
      (expectedParentIdentity !== undefined &&
        (openedParent.dev !== expectedParentIdentity.dev ||
          openedParent.ino !== expectedParentIdentity.ino))
    ) {
      throw new Error("secure_lock_parent_rejected");
    }
    const fileName = new TextEncoder().encode(`${basename(absolute)}\0`);
    const createFlags = createIfMissing
      ? constants.O_CREAT | constants.O_EXCL
      : 0;
    fd = api.symbols.openat(
      parentFd,
      ptr(fileName),
      createFlags | constants.O_RDWR | constants.O_NOFOLLOW,
      createIfMissing ? 0o600 : 0,
    );
    const created = createIfMissing && fd >= 0;
    if (fd < 0 && createIfMissing) {
      fd = api.symbols.openat(
        parentFd,
        ptr(fileName),
        constants.O_RDWR | constants.O_NOFOLLOW,
        0,
      );
    }
    if (fd < 0) throw new Error("secure_lock_open_failed");
    try {
      const openedFile = fstatSync(fd);
      const pathFile = statSync(absolute);
      if (
        !openedFile.isFile() ||
        openedFile.nlink !== 1 ||
        openedFile.dev !== pathFile.dev ||
        openedFile.ino !== pathFile.ino ||
        (expectedFileIdentity !== undefined &&
          (openedFile.dev !== expectedFileIdentity.dev ||
            openedFile.ino !== expectedFileIdentity.ino))
      ) {
        throw new Error("secure_lock_file_changed");
      }
      if (created) fchmodSync(fd, 0o600);
    } catch (error) {
      closeSync(fd);
      fd = -1;
      throw error;
    }
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    throw error;
  } finally {
    closeSync(parentFd);
  }
  const lockExclusive = 2;
  const lockNonBlocking = 4;
  if (api.symbols.flock(fd, lockExclusive | lockNonBlocking) !== 0) {
    closeSync(fd);
    return null;
  }
  try {
    const lockedFile = fstatSync(fd);
    const pathFile = statSync(absolute);
    if (
      !lockedFile.isFile() ||
      lockedFile.nlink !== 1 ||
      lockedFile.dev !== pathFile.dev ||
      lockedFile.ino !== pathFile.ino ||
      (expectedFileIdentity !== undefined &&
        (lockedFile.dev !== expectedFileIdentity.dev ||
          lockedFile.ino !== expectedFileIdentity.ino))
    ) {
      throw new Error("secure_lock_file_changed");
    }
  } catch (error) {
    api.symbols.flock(fd, 8);
    closeSync(fd);
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      api.symbols.flock(fd, 8);
      closeSync(fd);
    },
  };
}
