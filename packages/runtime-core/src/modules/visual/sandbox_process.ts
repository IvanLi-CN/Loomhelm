import { spawnSync } from "node:child_process";

const MONITOR_SIGNAL_PREFIX = "codex-sandbox-signal:";

const MONITOR_SCRIPT = String.raw`
const { closeSync, openSync, readFileSync, writeSync } = await import("node:fs");
const { O_APPEND, O_NOFOLLOW, O_WRONLY } = await import("node:constants");
const { spawn } = await import("node:child_process");
const spec = JSON.parse(readFileSync(0, "utf8"));
let stdoutFd = -1;
let stderrFd = -1;
let target;
let parentWatcher;
let finished = false;
const scheduleGroupCleanup = () => {
  try {
    const cleaner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "setTimeout(() => { try { process.kill(-" +
          process.pid +
          ', "SIGKILL"); } catch {} }, 50);',
      ],
      { cwd: "/", env: { PATH: "/usr/bin:/bin" }, detached: true, stdio: "ignore" },
    );
    cleaner.unref();
  } catch {}
};
const finish = (code, signal, detail) => {
  if (finished) return;
  finished = true;
  if (parentWatcher) clearInterval(parentWatcher);
  scheduleGroupCleanup();
  if (detail)
    try {
      if (stderrFd >= 0) writeSync(stderrFd, detail + "\\n");
      else process.stderr.write(detail + "\\n");
    } catch {}
  if (stdoutFd >= 0) closeSync(stdoutFd);
  if (stderrFd >= 0) closeSync(stderrFd);
  if (signal) {
    process.stdout.end(${JSON.stringify(MONITOR_SIGNAL_PREFIX)} + signal, () =>
      process.exit(1),
    );
    return;
  }
  process.exit(code ?? 1);
};

try {
  stdoutFd = openSync(spec.stdoutPath, O_APPEND | O_NOFOLLOW | O_WRONLY);
  stderrFd = openSync(spec.stderrPath, O_APPEND | O_NOFOLLOW | O_WRONLY);
  target = spawn("/usr/bin/sandbox-exec", [
    "-p",
    spec.profile,
    spec.executable,
    ...(spec.args ?? []),
  ], {
    cwd: spec.workingDirectory,
    env: spec.environment,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  target.on("error", (error) =>
    finish(
      1,
      undefined,
      error instanceof Error ? error.message : String(error),
    ),
  );
  target.on("exit", (code, signal) => finish(code, signal));
  if (spec.parentPid)
    parentWatcher = setInterval(() => {
      if (process.ppid === spec.parentPid) return;
      scheduleGroupCleanup();
      process.exit(1);
    }, 100);
} catch (error) {
  finish(1, undefined, error instanceof Error ? error.message : String(error));
}
`;

type MonitoredSandboxResult = ReturnType<typeof spawnSync> & {
  targetSignal?: NodeJS.Signals;
};

function monitorSignal(output: unknown): NodeJS.Signals | undefined {
  if (typeof output !== "string" || !output.startsWith(MONITOR_SIGNAL_PREFIX))
    return undefined;
  const signal = output.slice(MONITOR_SIGNAL_PREFIX.length);
  return signal ? (signal as NodeJS.Signals) : undefined;
}

export function spawnMonitoredSandbox(
  profile: string,
  executable: string,
  args: string[],
  stdoutPath: string,
  stderrPath: string,
  options: NonNullable<Parameters<typeof spawnSync>[2]>,
): MonitoredSandboxResult {
  const targetEnvironment = options.env ?? process.env;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", MONITOR_SCRIPT],
    {
      ...options,
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      input: JSON.stringify({
        profile,
        executable,
        args,
        stdoutPath,
        stderrPath,
        workingDirectory: options.cwd,
        environment: targetEnvironment,
        parentPid: process.pid,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const targetSignal = monitorSignal(result.stdout);
  return targetSignal ? { ...result, targetSignal } : result;
}
