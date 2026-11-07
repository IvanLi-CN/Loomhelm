import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dlopen, FFIType, ptr } from "bun:ffi";

interface PrivateSnapshot {
  path: string;
  identity: string;
  parentIdentity: string;
}

interface PrivateSnapshotModule {
  cleanupPrivateSnapshot(
    path: string,
    expectedIdentity: string,
    expectedParentIdentity?: string,
  ): void;
  createPrivateSnapshot(): PrivateSnapshot;
}

interface PosixLibrary {
  symbols: {
    openat(
      directoryFd: number,
      path: number,
      flags: number,
      mode: number,
    ): number;
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
      }) as PosixLibrary;
      return posixLibrary;
    } catch {}
  }
  throw new Error("DEV_PLAN_SOURCE_NATIVE_LIBRARY_UNAVAILABLE");
}

function cString(value: string): number {
  return ptr(new TextEncoder().encode(value + "\0"));
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
  if (fd < 0) throw new Error("DEV_PLAN_SOURCE_OPEN_FORBIDDEN: " + name);
  return fd;
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

function openDirectoryNoFollow(path: string): number {
  const absolute = resolve(path);
  let directoryFd = openSync("/", directoryFlags());
  try {
    for (const component of absolute.slice(1).split("/").filter(Boolean)) {
      const nextFd = openAt(directoryFd, component, directoryFlags());
      closeSync(directoryFd);
      directoryFd = nextFd;
    }
    return directoryFd;
  } catch (error) {
    closeSync(directoryFd);
    throw error;
  }
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = current === "/" ? "/" + part : current + "/" + part;
    if (lstatSync(current).isSymbolicLink())
      throw new Error("DEV_PLAN_SOURCE_SYMLINK_FORBIDDEN: " + current);
  }
}

function assertCandidateRootStable(root: string): void {
  const fd = openDirectoryNoFollow(root);
  try {
    if (!fstatSync(fd).isDirectory())
      throw new Error("DEV_PLAN_CANDIDATE_ROOT_INVALID: " + root);
  } finally {
    closeSync(fd);
  }
}

function assertSecureCandidateTree(root: string): void {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink())
      throw new Error("DEV_PLAN_SOURCE_SYMLINK_FORBIDDEN: " + current);
    if (entry.isDirectory()) {
      for (const child of readdirSync(current))
        pending.push(join(current, child));
      continue;
    }
    if (!entry.isFile())
      throw new Error("DEV_PLAN_SOURCE_TYPE_FORBIDDEN: " + current);
    if (entry.nlink !== 1)
      throw new Error("DEV_PLAN_SOURCE_HARDLINK_FORBIDDEN: " + current);
  }
}

function writeAll(fd: number, value: Uint8Array): void {
  let offset = 0;
  while (offset < value.length) {
    const count = writeSync(fd, value, offset, value.length - offset, null);
    if (count <= 0) throw new Error("DEV_PLAN_SOURCE_SNAPSHOT_WRITE_FAILED");
    offset += count;
  }
  fsyncSync(fd);
}

function readCandidateFile(
  sourcePath: string,
  sourceFd: number,
  name: string,
): Buffer {
  const fd = openAt(sourceFd, name, fileFlags());
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1)
      throw new Error(
        "DEV_PLAN_SOURCE_FILE_FORBIDDEN: " + join(sourcePath, name),
      );
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new Error("DEV_PLAN_SOURCE_CHANGED_DURING_SNAPSHOT: " + name);
    return contents;
  } finally {
    closeSync(fd);
  }
}

function copyCandidateDirectory(
  sourcePath: string,
  sourceFd: number,
  destinationPath: string,
  selectedName?: string,
): void {
  mkdirSync(destinationPath, { mode: 0o700 });
  const names =
    selectedName === undefined ? readdirSync(sourcePath) : [selectedName];
  for (const name of names) {
    if (!name || name === "." || name === ".." || name.includes("/"))
      throw new Error("DEV_PLAN_SOURCE_ENTRY_NAME_INVALID: " + name);
    const destination = join(destinationPath, name);
    let childDirectoryFd = -1;
    try {
      try {
        childDirectoryFd = openAt(sourceFd, name, directoryFlags());
      } catch {}
      if (childDirectoryFd >= 0) {
        try {
          const child = fstatSync(childDirectoryFd);
          if (!child.isDirectory())
            throw new Error("DEV_PLAN_SOURCE_TYPE_FORBIDDEN: " + name);
          copyCandidateDirectory(
            join(sourcePath, name),
            childDirectoryFd,
            destination,
          );
        } finally {
          closeSync(childDirectoryFd);
          childDirectoryFd = -1;
        }
        continue;
      }

      const sourceFileFd = openAt(sourceFd, name, fileFlags());
      try {
        const before = fstatSync(sourceFileFd);
        if (!before.isFile())
          throw new Error("DEV_PLAN_SOURCE_TYPE_FORBIDDEN: " + name);
        if (before.nlink !== 1)
          throw new Error("DEV_PLAN_SOURCE_HARDLINK_FORBIDDEN: " + name);
        const contents = readFileSync(sourceFileFd);
        const after = fstatSync(sourceFileFd);
        if (
          !after.isFile() ||
          after.nlink !== 1 ||
          after.dev !== before.dev ||
          after.ino !== before.ino
        )
          throw new Error("DEV_PLAN_SOURCE_CHANGED_DURING_SNAPSHOT: " + name);
        const destinationFd = openSync(
          destination,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeAll(destinationFd, contents);
        } finally {
          closeSync(destinationFd);
        }
      } finally {
        closeSync(sourceFileFd);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("FORBIDDEN"))
        throw error;
      throw new Error(
        "DEV_PLAN_SOURCE_OPEN_FORBIDDEN: " + join(sourcePath, name),
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function secureCandidateRoot(entrypoint: string): string {
  const root = resolve(dirname(entrypoint), "../..");
  for (const path of [entrypoint, root]) assertNoSymlinkComponents(path);
  assertCandidateRootStable(root);
  assertSecureCandidateTree(resolve(root, "skills/bin"));
  return root;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const entrypoint =
      process.env.PLAN_REVIEW_ENTRYPOINT_PATH ?? fileURLToPath(import.meta.url);
    secureCandidateRoot(entrypoint);
    process.stdout.write("usage: plan-cli.sh [options]\n");
    return 0;
  }
  let parentSignal: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined;
  const abortController = new AbortController();
  const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (signal) =>
      [
        signal,
        () => {
          parentSignal ??= signal;
          abortController.abort();
        },
      ] as const,
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  let failure: unknown;
  let cleanupError: unknown;
  let snapshot: PrivateSnapshot | undefined;
  let privateSnapshotModule: PrivateSnapshotModule | undefined;
  try {
    const entrypoint =
      process.env.PLAN_REVIEW_ENTRYPOINT_PATH ?? fileURLToPath(import.meta.url);
    const root = secureCandidateRoot(entrypoint);
    const sourcePath = resolve(root, "skills/bin");
    let sourceFd = -1;
    let modulesFd = -1;
    let planFd = -1;
    try {
      sourceFd = openDirectoryNoFollow(sourcePath);
      const source = fstatSync(sourceFd);
      if (!source.isDirectory())
        throw new Error("DEV_PLAN_SOURCE_TYPE_FORBIDDEN: " + sourcePath);
      modulesFd = openAt(sourceFd, "modules", directoryFlags());
      planFd = openAt(modulesFd, "plan", directoryFlags());
      const privateSnapshotSource = readCandidateFile(
        join(sourcePath, "modules/plan"),
        planFd,
        "private_snapshot.ts",
      );
      privateSnapshotModule = (await import(
        `data:text/typescript;base64,${privateSnapshotSource.toString("base64")}`
      )) as PrivateSnapshotModule;
      const privateSnapshot = privateSnapshotModule.createPrivateSnapshot();
      snapshot = privateSnapshot;
      copyCandidateDirectory(
        sourcePath,
        sourceFd,
        join(privateSnapshot.path, "bin"),
      );
    } finally {
      if (planFd >= 0) closeSync(planFd);
      if (modulesFd >= 0) closeSync(modulesFd);
      if (sourceFd >= 0) closeSync(sourceFd);
    }

    process.env.PLAN_CONTRACT_REPO_ROOT = root;
    const review = await import(
      pathToFileURL(join(snapshot!.path, "bin/modules/plan/review.ts")).href
    );
    exitCode = await review.cli(process.argv.slice(2), {
      stdout: (value: string) => (stdout += value),
      stderr: (value: string) => (stderr += value),
      signal: abortController.signal,
    });
  } catch (error) {
    failure = error;
  }
  if (snapshot) {
    try {
      if (privateSnapshotModule) {
        privateSnapshotModule.cleanupPrivateSnapshot(
          snapshot.path,
          snapshot.identity,
          snapshot.parentIdentity,
        );
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  // Repeated launcher signals must not bypass a pending process-group escalation.
  if (parentSignal === undefined)
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
  if (parentSignal !== undefined) {
    stdout = "";
    stderr = "";
    exitCode = 1;
  }
  if (failure) stderr += errorMessage(failure) + "\n";
  if (cleanupError) stderr += errorMessage(cleanupError) + "\n";
  if (stderr) process.stderr.write(stderr);
  if (!failure && !cleanupError && exitCode === 0 && stdout)
    process.stdout.write(stdout);
  return failure || cleanupError ? 1 : exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
