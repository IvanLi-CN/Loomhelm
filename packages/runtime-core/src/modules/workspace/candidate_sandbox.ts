import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "../core/process";

type Runner = (request: ProcessRequest) => Promise<ProcessResult>;

const SAFE_VARIABLES = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CI",
  "NO_COLOR",
]);
const MAX_CHECK_TIME_MS = 5 * 60 * 1000;
const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;

export class CandidateSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateSandboxError";
  }
}

export interface CandidateSandbox {
  environment: Record<string, string | undefined>;
  run: Runner;
  redactOutput(value: string): string;
  cleanup(): void;
}

function sandboxBinary(): string {
  const candidates =
    process.platform === "linux"
      ? ["/usr/bin/bwrap", "/bin/bwrap"]
      : ["/usr/bin/sandbox-exec"];
  const binary = candidates.find((path) => existsSync(path));
  if (!binary)
    throw new CandidateSandboxError(
      `candidate validation requires ${process.platform === "linux" ? "bubblewrap" : "sandbox-exec"}`,
    );
  return binary;
}

function isolatedEnvironment(
  source: Record<string, string | undefined>,
  home: string,
  temporary: string,
): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const name of SAFE_VARIABLES)
    if (source[name] !== undefined) clean[name] = source[name];
  clean.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  clean.HOME = home;
  clean.TMPDIR = temporary;
  clean.TMP = temporary;
  clean.TEMP = temporary;
  clean.XDG_CONFIG_HOME = join(home, ".config");
  clean.XDG_CACHE_HOME = join(home, ".cache");
  clean.BUN_CONFIG = "/dev/null";
  clean.BUN_CONFIG_PATH = "/dev/null";
  return clean;
}

function parentDirectories(path: string): string[] {
  const result: string[] = [];
  let current = dirname(path);
  while (current !== "/") {
    result.unshift(current);
    current = dirname(current);
  }
  return result;
}

function linuxArgs(
  binary: string,
  candidate: string,
  request: ProcessRequest,
  environment: Record<string, string | undefined>,
  metadataPaths: string[],
): string[] {
  const boundRoots = [
    "/usr",
    "/usr/local",
    "/bin",
    "/lib",
    "/lib64",
    "/etc",
    "/dev",
    "/proc",
  ];
  const runtimePaths = [process.execPath];
  try {
    runtimePaths.push(realpathSync(process.execPath));
  } catch {
    /* The sandbox will fail closed if the executable cannot be read. */
  }
  const extraRuntimePaths = [...runtimePaths, ...metadataPaths].filter(
    (path, index, paths) =>
      !boundRoots.some(
        (root) => path === root || path.startsWith(`${root}/`),
      ) && paths.indexOf(path) === index,
  );
  const directories = new Set(parentDirectories(candidate));
  for (const path of extraRuntimePaths)
    for (const parent of parentDirectories(path)) directories.add(parent);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-net",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/usr/local",
    "/usr/local",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  for (const parent of directories) args.push("--dir", parent);
  args.push("--ro-bind", candidate, candidate);
  for (const path of extraRuntimePaths) args.push("--ro-bind", path, path);
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined)
      args.push(
        "--setenv",
        name,
        ["TMPDIR", "TMP", "TEMP"].includes(name) ? "/tmp" : value,
      );
  args.push(
    "--chdir",
    candidate,
    "--",
    request.command,
    ...(request.args ?? []),
  );
  return [binary, ...args];
}

function quoteProfilePath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function macArgs(
  binary: string,
  candidate: string,
  temporary: string,
  request: ProcessRequest,
  metadataPaths: string[],
): string[] {
  const runtimePaths = [process.execPath];
  try {
    runtimePaths.push(realpathSync(process.execPath));
  } catch {
    /* The sandbox will fail closed if the executable cannot be read. */
  }
  const readPaths = [
    candidate,
    "/usr",
    "/bin",
    "/System",
    "/private/etc",
    "/opt/homebrew",
    "/private/var/db/timezone",
    ...runtimePaths,
    ...metadataPaths,
  ];
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal)",
    "(allow process-info*)",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    "(deny network*)",
    '(allow file-read* file-write* (literal "/dev/null"))',
    ...parentDirectories(candidate).map(
      (path) => `(allow file-read* (literal "${quoteProfilePath(path)}"))`,
    ),
    ...readPaths.map(
      (path) => `(allow file-read* (subpath "${quoteProfilePath(path)}"))`,
    ),
    `(allow file-read* (subpath "${quoteProfilePath(temporary)}"))`,
    `(allow file-write* (subpath "${quoteProfilePath(temporary)}"))`,
  ].join(" ");
  return [binary, "-p", profile, request.command, ...(request.args ?? [])];
}

export function createCandidateSandbox(
  candidate: string,
  source: Record<string, string | undefined>,
  runner: Runner = runProcess,
  metadataPaths: string[] = [],
): CandidateSandbox {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "dot-codex-validation-")),
  );
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const environment = isolatedEnvironment(source, home, temporary);
  const redactedValues = Object.entries(source)
    .filter(
      ([name, value]) =>
        !SAFE_VARIABLES.has(name) && value !== undefined && value.length >= 4,
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  const redactOutput = (value: string): string =>
    redactedValues.reduce(
      (output, secret) => output.replaceAll(secret, "[REDACTED]"),
      value,
    );
  let binary: string | undefined;
  try {
    binary = runner === runProcess ? sandboxBinary() : undefined;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const run: Runner = async (request) => {
    const boundedRequest: ProcessRequest = {
      ...request,
      timeoutMs: Math.min(
        request.timeoutMs ?? MAX_CHECK_TIME_MS,
        MAX_CHECK_TIME_MS,
      ),
      maxCapturedOutputBytes: Math.min(
        request.maxCapturedOutputBytes ?? MAX_CAPTURED_OUTPUT_BYTES,
        MAX_CAPTURED_OUTPUT_BYTES,
      ),
    };
    if (!binary) return runner({ ...boundedRequest, env: environment });
    const args =
      process.platform === "linux"
        ? linuxArgs(
            binary,
            candidate,
            boundedRequest,
            environment,
            metadataPaths,
          )
        : macArgs(binary, candidate, temporary, boundedRequest, metadataPaths);
    return runner({
      ...boundedRequest,
      command: args[0]!,
      args: args.slice(1),
      cwd: process.platform === "linux" ? "/" : candidate,
      env: environment,
    });
  };
  return {
    environment,
    run,
    redactOutput,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
