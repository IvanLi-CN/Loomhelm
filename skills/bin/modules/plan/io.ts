import { randomUUID } from "node:crypto";
import {
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { assertDirectoryIdentity } from "./parent_identity";

interface PosixLibrary {
  symbols: {
    openat(
      directoryFd: number,
      path: number,
      flags: number,
      mode: number,
    ): number;
    renameat(
      oldDirectoryFd: number,
      oldPath: number,
      newDirectoryFd: number,
      newPath: number,
    ): number;
    unlinkat(directoryFd: number, path: number, flags: number): number;
    close(fd: number): number;
  };
}

let posixLibrary: PosixLibrary | undefined;

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
        renameat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
          returns: FFIType.i32,
        },
        unlinkat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      }) as PosixLibrary;
      return posixLibrary;
    } catch {}
  }
  throw new Error("native_library_unavailable");
}

function cString(value: string): number {
  return ptr(new TextEncoder().encode(`${value}\0`));
}

function openAt(
  directoryFd: number,
  name: string,
  flags: number,
  mode = 0,
): number {
  const fd = loadPosix().symbols.openat(
    directoryFd,
    cString(name),
    flags,
    mode,
  );
  if (fd < 0) throw new Error(`secure candidate open failed: ${name}`);
  return fd;
}

function closeFd(fd: number): void {
  loadPosix().symbols.close(fd);
}

export function closeCandidateFd(fd: number): void {
  closeFd(fd);
}

function openDirectoryNoFollow(path: string): number {
  const absolute = resolve(path);
  let directoryFd = openSync(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const component of absolute.slice(1).split("/").filter(Boolean)) {
      const nextFd = openAt(
        directoryFd,
        component,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeFd(directoryFd);
      directoryFd = nextFd;
    }
    return directoryFd;
  } catch (error) {
    closeFd(directoryFd);
    throw error;
  }
}

function openDirectoryFromRoot(
  rootFd: number,
  root: string,
  directory: string,
): number {
  const relativePath = relative(root, directory);
  const components = relativePath
    .split("/")
    .filter((component) => component.length > 0 && component !== ".");
  let directoryFd = rootFd;
  try {
    for (const component of components) {
      const nextFd = openAt(
        directoryFd,
        component,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeFd(directoryFd);
      directoryFd = nextFd;
    }
    return directoryFd;
  } catch (error) {
    closeFd(directoryFd);
    throw error;
  }
}

function openCandidateRoot(root: string, expectedIdentity = "") {
  const absolute = resolve(root);
  const expected = lstatSync(absolute);
  if (!expected.isDirectory())
    throw new Error("candidate root must be a regular directory");
  const fd = openDirectoryNoFollow(absolute);
  try {
    const opened = fstatSync(fd);
    const openedId = `${opened.dev}:${opened.ino}`;
    if (
      !opened.isDirectory() ||
      openedId !== `${expected.dev}:${expected.ino}` ||
      (expectedIdentity !== "" && openedId !== expectedIdentity)
    )
      throw new Error("candidate root changed while opening");
    return { absolute, fd };
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

function openRegularFromRoot(
  rootFd: number,
  root: string,
  path: string,
): number {
  const parentFd = openDirectoryFromRoot(rootFd, root, dirname(path));
  let fd = -1;
  try {
    fd = openAt(
      parentFd,
      basename(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const entry = fstatSync(fd);
    if (!entry.isFile())
      throw new Error("candidate input must be a regular file");
    if (entry.nlink !== 1)
      throw new Error("candidate input hardlinks are forbidden");
    const result = fd;
    fd = -1;
    return result;
  } finally {
    if (fd >= 0) closeFd(fd);
    closeFd(parentFd);
  }
}

function readAll(fd: number): Uint8Array {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(64 * 1024);
  while (true) {
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks);
}

function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (count <= 0) throw new Error("secure candidate write failed");
    offset += count;
  }
  fsyncSync(fd);
}

function unlinkAt(directoryFd: number, name: string): void {
  loadPosix().symbols.unlinkat(directoryFd, cString(name), 0);
}

function renameAt(directoryFd: number, source: string, target: string): void {
  if (
    loadPosix().symbols.renameat(
      directoryFd,
      cString(source),
      directoryFd,
      cString(target),
    ) < 0
  )
    throw new Error(`secure candidate rename failed: ${target}`);
}

function moduleRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function candidateRoot(): string {
  return process.env.PLAN_CONTRACT_REPO_ROOT ?? moduleRoot();
}

export function assertInsideCandidate(
  path: string,
  root = candidateRoot(),
): string {
  const absoluteRoot = resolve(root);
  const absolutePath = isAbsolute(path)
    ? resolve(path)
    : resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  )
    throw new Error("candidate path escapes PLAN_CONTRACT_REPO_ROOT");
  return absolutePath;
}

export function assertCandidateRootStable(root = candidateRoot(), id = "") {
  const handle = openCandidateRoot(root, id);
  closeFd(handle.fd);
}

export async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = absolute.startsWith("/") ? "/" : "";
  let current = root;
  for (const component of absolute
    .slice(root.length)
    .split("/")
    .filter(Boolean)) {
    current = current === "/" ? `/${component}` : `${current}/${component}`;
    const entry = await lstat(current);
    if (entry.isSymbolicLink())
      throw new Error(`candidate path contains a symlink: ${current}`);
  }
}

export async function readCandidateText(
  path: string,
  root = candidateRoot(),
): Promise<string> {
  const absolute = assertInsideCandidate(path, root);
  await assertNoSymlinkComponents(absolute);
  const handle = openCandidateRoot(root);
  const fd = openRegularFromRoot(handle.fd, handle.absolute, absolute);
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(readAll(fd));
  } finally {
    closeFd(fd);
  }
}

export async function openCandidateRegular(
  path: string,
  root = candidateRoot(),
): Promise<number> {
  const absolute = assertInsideCandidate(path, root);
  await assertNoSymlinkComponents(absolute);
  const handle = openCandidateRoot(root);
  return openRegularFromRoot(handle.fd, handle.absolute, absolute);
}

export async function writeCandidateText(
  path: string,
  value: string,
  root = candidateRoot(),
): Promise<void> {
  const absolute = assertInsideCandidate(path, root);
  await assertNoSymlinkComponents(dirname(absolute));
  const handle = openCandidateRoot(root);
  const rootIdentity = `${fstatSync(handle.fd).dev}:${fstatSync(handle.fd).ino}`;
  const parentFd = openDirectoryFromRoot(
    handle.fd,
    handle.absolute,
    dirname(absolute),
  );
  const parentIdentity = fstatSync(parentFd);
  const temporary = `.plan-output-${process.pid}-${randomUUID()}.tmp`;
  let temporaryFd = -1;
  let temporaryExists = false;
  try {
    assertCandidateRootStable(root, rootIdentity);
    await assertDirectoryIdentity(dirname(absolute), parentIdentity);
    const existing = await lstat(absolute).catch(() => null);
    if (existing?.isSymbolicLink())
      throw new Error("candidate output contains a symlink");
    if (existing && !existing.isFile())
      throw new Error("candidate output must be a regular file");
    if (existing && existing.nlink !== 1)
      throw new Error("candidate output hardlinks are forbidden");
    temporaryFd = openAt(
      parentFd,
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    const entry = fstatSync(temporaryFd);
    if (!entry.isFile() || entry.nlink !== 1)
      throw new Error("candidate output must be a regular file");
    fchmodSync(temporaryFd, 0o600);
    writeAll(temporaryFd, value);
    assertCandidateRootStable(root, rootIdentity);
    await assertDirectoryIdentity(dirname(absolute), parentIdentity);
    renameAt(parentFd, temporary, basename(absolute));
    temporaryExists = false;
    const publishedFd = openAt(
      parentFd,
      basename(absolute),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const published = fstatSync(publishedFd);
      if (
        !published.isFile() ||
        published.nlink !== 1 ||
        published.dev !== entry.dev ||
        published.ino !== entry.ino
      )
        throw new Error("candidate output changed while publishing");
    } finally {
      closeFd(publishedFd);
    }
    closeFd(temporaryFd);
    temporaryFd = -1;
  } finally {
    if (temporaryFd >= 0) closeFd(temporaryFd);
    if (temporaryExists) unlinkAt(parentFd, temporary);
    closeFd(parentFd);
  }
}

export async function assertRegularCandidate(
  path: string,
  root = candidateRoot(),
): Promise<void> {
  const absolute = assertInsideCandidate(path, root);
  await assertNoSymlinkComponents(absolute);
  const handle = openCandidateRoot(root);
  const fd = openRegularFromRoot(handle.fd, handle.absolute, absolute);
  closeFd(fd);
}
