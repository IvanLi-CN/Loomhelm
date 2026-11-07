import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { runProcess, type ProcessResult } from "../core/process";
import { FlowError, isoNow } from "./common";
import { ensureDirectory } from "./storage";

export interface ValidationProcessResult extends ProcessResult {
  command: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  logPath?: string | undefined;
}

export function validationSubprocessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return { ...environment };
}

export function knownLongBudget(
  repo: string,
  command: string,
  defaultBudget: number,
): [number, boolean] {
  const path = resolve(repo, ".codex-flow.json");
  if (!existsSync(path)) return [defaultBudget, false];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FlowError(".codex-flow.json is invalid", { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray((value as Record<string, unknown>).known_long_commands)
  )
    throw new FlowError(".codex-flow.json known_long_commands must be a list");
  for (const entry of (value as Record<string, unknown>)
    .known_long_commands as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new FlowError(
        ".codex-flow.json known_long_commands entries must be objects",
      );
    if ((entry as Record<string, unknown>).command !== command) continue;
    const budget = (entry as Record<string, unknown>).budget_seconds;
    if (
      typeof budget !== "number" ||
      !Number.isInteger(budget) ||
      budget <= defaultBudget
    )
      throw new FlowError(
        ".codex-flow.json known-long budget must exceed the default budget",
      );
    return [budget, true];
  }
  return [defaultBudget, false];
}

export async function runValidationCommand(options: {
  command: string;
  repo: string;
  budgetSeconds: number;
  logPath?: string | undefined;
  runner?: typeof runProcess;
}): Promise<ValidationProcessResult> {
  const startedAt = isoNow();
  const started = Date.now();
  const runner = options.runner ?? runProcess;
  let logFd: number | undefined;
  let sinkWrote = false;
  if (options.logPath) {
    ensureDirectory(dirname(options.logPath));
    logFd = openSync(
      options.logPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
  }
  const outputSink =
    logFd === undefined
      ? undefined
      : (_stream: "stdout" | "stderr", chunk: Uint8Array): void => {
          writeAll(logFd!, chunk);
          sinkWrote = true;
        };
  let result: ProcessResult | undefined;
  try {
    result = await runner({
      command: "/bin/sh",
      args: ["-c", options.command],
      cwd: options.repo,
      env: validationSubprocessEnvironment(),
      timeoutMs: options.budgetSeconds * 1000,
      outputSink,
      maxCapturedOutputBytes: 1024 * 1024,
    });
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
  if (!result)
    throw new FlowError("validation process did not return a result");
  const finishedAt = isoNow();
  const durationSeconds = (Date.now() - started) / 1000;
  if (options.logPath && !sinkWrote) {
    const fallback = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
    if (fallback) appendFileSync(options.logPath, fallback, "utf8");
  }
  let timeoutNote = "";
  if (result.timedOut)
    timeoutNote = `\nflow_receipt: command timed out after ${options.budgetSeconds} seconds\n`;
  if (options.logPath && timeoutNote)
    appendFileSync(options.logPath, timeoutNote, "utf8");
  return {
    ...result,
    exitCode: result.timedOut ? 124 : result.exitCode,
    command: options.command,
    startedAt,
    finishedAt,
    durationSeconds,
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
  };
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
    if (written <= 0) throw new FlowError("validation log write failed");
    offset += written;
  }
}

export function validationExitCode(
  result: ProcessResult,
  budgetSeconds: number,
): number {
  if (result.timedOut) return 124;
  if (result.exitCode === 0) return 0;
  if (result.exitCode < 0) return 128 + Math.abs(result.exitCode);
  if (result.exitCode > budgetSeconds * 1000)
    throw new FlowError("validation process returned an invalid exit code");
  return result.exitCode;
}

export function processLogBytes(result: ProcessResult): Uint8Array {
  return Buffer.from(
    `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
    "utf8",
  );
}
