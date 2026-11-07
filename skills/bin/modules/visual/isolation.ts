import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } from "node:constants";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { spawnMonitoredSandbox } from "./sandbox_process";
import {
  readRegularNoFollow,
  unlinkNoFollow,
  writeExclusiveNoFollow,
} from "./secure_io";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const REG_CLI_COMMAND = ["npm", "ci"] as const;
export const REG_CLI_VERSION = "0.18.16";

export type FileIdentity = { dev: number; ino: number };
export type RunResult = { runtimeName: string; runtimeIdentity: FileIdentity };

export function identity(path: string): FileIdentity {
  const metadata = lstatSync(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

export function sandboxAvailable(): boolean {
  return (
    process.platform === "darwin" &&
    existsSync(SANDBOX_EXEC) &&
    (() => {
      try {
        return (lstatSync(SANDBOX_EXEC).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    })()
  );
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function snapshotSymlinkReadPaths(directory: string): string[] {
  const paths: string[] = [];
  for (const folder of ["actual", "expected"]) {
    const sourceDirectory = join(directory, folder);
    try {
      if (!lstatSync(sourceDirectory).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const entry of readdirSync(sourceDirectory)) {
      const candidate = join(sourceDirectory, entry);
      let symbolic = false;
      try {
        symbolic = lstatSync(candidate).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!symbolic) continue;
      try {
        paths.push(realpathSync(candidate));
      } catch {
        throw new Error(
          `sandbox snapshot read path is unavailable: ${candidate}`,
        );
      }
    }
  }
  return paths;
}

function sandboxReadPaths(
  directory: string,
  additional: string[],
  includeStaging: boolean,
  includeSnapshotReads: boolean,
): string[] {
  const paths = [
    "/System/Library",
    "/usr/bin",
    "/usr/lib",
    "/usr/share",
    "/bin",
    "/sbin",
    "/private/etc",
    "/dev",
    ...(includeStaging ? [directory] : []),
    ...additional,
    ...(includeSnapshotReads ? snapshotSymlinkReadPaths(directory) : []),
  ];
  const resolved = new Set<string>();
  for (const path of paths) resolved.add(realpathSync(path));
  return [...resolved];
}

export function sandboxProfile(
  directory: string,
  options: {
    executablePaths: string[];
    additionalReadPaths?: string[];
    allowNetwork?: boolean;
    includeStagingRead?: boolean;
    includeSnapshotReads?: boolean;
  },
): string {
  if (!sandboxAvailable())
    throw new Error(
      "reg-cli reports require macOS sandbox-exec; refusing to run unsandboxed",
    );
  const canonicalDirectory = realpathSync(directory);
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow signal (target children))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
  ];
  for (const executable of options.executablePaths) {
    const canonical = realpathSync(executable);
    if (!existsSync(canonical))
      throw new Error(`sandbox executable is unavailable: ${executable}`);
    rules.push(`(allow process-exec (literal ${quote(canonical)}))`);
  }
  rules.push('(allow file-read* (subpath "/"))');
  for (const denied of [
    "/Users",
    "/private/var/folders",
    "/private/tmp",
    "/private/var/tmp",
    "/Volumes",
    "/Network",
    "/Library/Keychains",
    "/opt/homebrew",
    "/usr/local",
  ])
    rules.push(`(deny file-read-data (subpath ${quote(denied)}))`);
  for (const path of sandboxReadPaths(
    canonicalDirectory,
    options.additionalReadPaths ?? [],
    options.includeStagingRead ?? true,
    options.includeSnapshotReads ?? true,
  )) {
    const predicate = (() => {
      try {
        return lstatSync(path).isDirectory() ? "subpath" : "literal";
      } catch {
        return "literal";
      }
    })();
    const rule = `(${predicate} ${quote(path)})`;
    rules.push(
      `(allow file-read-data ${rule})`,
      `(allow file-read-metadata ${rule})`,
    );
  }
  if (options.allowNetwork) rules.push("(allow network-outbound)");
  rules.push(`(allow file-write* (subpath ${quote(canonicalDirectory)}))`);
  return rules.join("\n");
}

function terminateSandboxProcesses(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function runSandboxedCommand(
  directory: string,
  argv: string[],
  options: {
    runtimeDir: string;
    env: Record<string, string>;
    allowNetwork: boolean;
    label: string;
    additionalReadPaths?: string[];
    includeStagingRead?: boolean;
    includeSnapshotReads?: boolean;
    workingDirectory?: string;
    timeoutMs?: number;
  },
): void {
  const executable = realpathSync(argv[0] ?? "");
  const profileOptions: {
    executablePaths: string[];
    additionalReadPaths?: string[];
    allowNetwork?: boolean;
    includeStagingRead?: boolean;
    includeSnapshotReads?: boolean;
  } = {
    executablePaths: [executable],
    allowNetwork: options.allowNetwork,
  };
  if (options.includeStagingRead !== undefined)
    profileOptions.includeStagingRead = options.includeStagingRead;
  if (options.includeSnapshotReads !== undefined)
    profileOptions.includeSnapshotReads = options.includeSnapshotReads;
  if (options.additionalReadPaths)
    profileOptions.additionalReadPaths = options.additionalReadPaths;
  const profile = sandboxProfile(directory, profileOptions);
  mkdirSync(options.runtimeDir, { recursive: true });
  const stdoutPath = join(
    options.runtimeDir,
    `${options.label.replaceAll(" ", "-")}.stdout.log`,
  );
  const stderrPath = join(
    options.runtimeDir,
    `${options.label.replaceAll(" ", "-")}.stderr.log`,
  );
  const stdoutTemp = join(
    options.runtimeDir,
    `.sandbox-stdout-${randomBytes(8).toString("hex")}.tmp`,
  );
  const stderrTemp = join(
    options.runtimeDir,
    `.sandbox-stderr-${randomBytes(8).toString("hex")}.tmp`,
  );
  const workingDirectory = options.workingDirectory ?? directory;
  try {
    if (!lstatSync(realpathSync(workingDirectory)).isDirectory())
      throw new Error();
  } catch {
    throw new Error(
      `${options.label} failed to start: working directory unavailable`,
    );
  }
  const createLog = (path: string): void => {
    const descriptor = openSync(
      path,
      O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY,
      0o600,
    );
    closeSync(descriptor);
  };
  createLog(stdoutTemp);
  createLog(stderrTemp);
  const spawnOptions = {
    cwd: workingDirectory,
    env: options.env,
    input: undefined,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 300_000,
  } as NonNullable<Parameters<typeof spawnSync>[2]>;
  Object.assign(spawnOptions, { detached: process.platform !== "win32" });
  const result = spawnMonitoredSandbox(
    profile,
    executable,
    argv.slice(1),
    stdoutTemp,
    stderrTemp,
    spawnOptions,
  );
  const timedOut = result.error?.message.includes("ETIMEDOUT") ?? false;
  const monitorDetail =
    typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (result.error && !timedOut)
    throw new Error(
      `${options.label} failed to start: ${[result.error.message, monitorDetail].filter(Boolean).join(": ")}`,
    );
  if (process.platform !== "win32") {
    if (!Number.isInteger(result.pid) || result.pid <= 0)
      throw new Error(`${options.label} did not expose a process id`);
    terminateSandboxProcesses(result.pid);
  }
  let stdout: string;
  let stderr: string;
  try {
    stdout = readRegularNoFollow(stdoutTemp, directory).toString("utf8");
    stderr = readRegularNoFollow(stderrTemp, directory).toString("utf8");
  } finally {
    try {
      unlinkNoFollow(stdoutTemp, directory);
    } catch {}
    try {
      unlinkNoFollow(stderrTemp, directory);
    } catch {}
  }
  writeExclusiveNoFollow(stdoutPath, stdout, directory);
  writeExclusiveNoFollow(stderrPath, stderr, directory);
  if (timedOut) {
    const detail = [stderr, stdout, monitorDetail]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${options.label} timed out${detail ? `: ${detail}` : ""}`);
  }
  if (result.targetSignal ?? result.signal) {
    const detail = [stderr, stdout, monitorDetail]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${options.label} terminated by ${result.targetSignal ?? result.signal}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (result.status !== 0) {
    const detail = [stderr, stdout, monitorDetail]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${options.label} failed (exit ${result.status}): ${detail}`,
    );
  }
}

export function cloneReportFile(source: string, destination: string): void {
  if (process.platform !== "darwin")
    throw new Error("APFS copy-on-write cloning is unavailable");
  if (!isIndependentRegularFile(source))
    throw new Error(
      `report output is not an independent regular file: ${source.split("/").at(-1)}`,
    );
  if (existsSync(destination))
    throw new Error(`report output already exists: ${destination}`);
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    clonefile: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const clone = library.symbols.clonefile;
    if (!clone) throw new Error("APFS copy-on-write cloning is unavailable");
    const result = clone(source, destination, 1);
    if (result !== 0) throw new Error(`clonefile failed for ${source}`);
  } finally {
    library.close();
  }
  if (!isIndependentRegularFile(destination))
    throw new Error(
      `cloned report output is not an independent regular file: ${destination.split("/").at(-1)}`,
    );
}

function isIndependentRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && metadata.nlink === 1;
  } catch {
    return false;
  }
}

export function removeStagingPath(path: string, original: FileIdentity): void {
  let quarantine: string | undefined;
  try {
    const current = identity(path);
    if (
      current.dev === original.dev &&
      current.ino === original.ino &&
      lstatSync(path).isDirectory()
    ) {
      quarantine = `${resolve(path, "..")}/.cleanup-${randomBytes(8).toString("hex")}`;
      renameSync(path, quarantine);
      const moved = identity(quarantine);
      if (
        moved.dev !== original.dev ||
        moved.ino !== original.ino ||
        !lstatSync(quarantine).isDirectory()
      )
        return;
      rmSync(quarantine, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function copyForTest(source: string, destination: string): void {
  mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(source, destination);
}
