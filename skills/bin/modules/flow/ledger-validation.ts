import { createHash } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { FlowError } from "./common";
import { gitCommit, gitTree, requireCleanCurrentHead } from "./git";
import { knownLongBudget, runValidationCommand } from "./process";
import { ensureDirectory } from "./storage";
import { dirname, relative, resolve } from "node:path";
import type { FlowLedger } from "./ledger";
import { recordValidationState, type ValidationOptions } from "./validation";

export function recordValidation(
  ledger: FlowLedger,
  options: ValidationOptions,
): Record<string, unknown> {
  return ledger.withLifecycleLock(() =>
    recordValidationLocked(ledger, options),
  );
}

function recordValidationLocked(
  ledger: FlowLedger,
  options: ValidationOptions,
): Record<string, unknown> {
  if (ledger.repo && !options.preflightOnly && !options.executionVerified)
    throw new FlowError(
      "repository-bound validation results must be produced by runValidation",
    );
  const observedTree =
    ledger.repo && options.observedTree === undefined
      ? gitTree(ledger.repo, "HEAD")
      : options.observedTree;
  return ledger.activeUpdateLocked((current) =>
    recordValidationState(
      current,
      observedTree === undefined ? options : { ...options, observedTree },
      ledger.repo ? gitCommit(ledger.repo, "HEAD") : undefined,
    ),
  );
}

export async function runValidation(
  ledger: FlowLedger,
  command: string,
  toolchainFingerprint: string,
  inputFingerprint: string,
  options: {
    headSha?: string | undefined;
    logPath?: string | undefined;
    retryStateFingerprint?: string | undefined;
    inputPaths?: string[] | undefined;
    acceptanceEvidence?: unknown;
  } = {},
): Promise<Record<string, unknown>> {
  if (!ledger.repo)
    throw new FlowError("command execution requires a repository-bound ledger");
  return ledger.withLifecycleLockAsync(async () => {
    const current = ledger.read();
    const [actualHead, initialTree] = requireCleanCurrentHead(
      ledger.repo!,
      options.headSha,
    );
    const preflight = recordValidationLocked(ledger, {
      command,
      toolchainFingerprint,
      inputFingerprint,
      exitCode: 0,
      logPath: "",
      kind: "validation",
      headSha: actualHead,
      inputPaths: options.inputPaths,
      acceptanceEvidence: options.acceptanceEvidence,
      preflightOnly: true,
      observedTree: initialTree,
    });
    if (preflight.reused) return preflight;
    const [budget, knownLong] = knownLongBudget(
      ledger.repo!,
      command,
      Number(current.command_budget_seconds ?? 1800),
    );
    const preflightIdentity = String(preflight.identity);
    const attempt = Number(preflight.attempt ?? 1);
    const logPath = resolveValidationLogPath(
      ledger.root,
      options.logPath,
      preflightIdentity,
      attempt,
    );
    const result = await runValidationCommand({
      command,
      repo: ledger.repo!,
      budgetSeconds: budget,
      logPath,
    });
    let postExecutionClean = true;
    let exitCode = result.exitCode;
    let postExecutionNote = "";
    try {
      requireCleanCurrentHead(ledger.repo!, actualHead);
    } catch (error) {
      postExecutionClean = false;
      if (exitCode === 0) exitCode = 125;
      postExecutionNote = `\nflow_receipt: post-execution repository check failed: ${error instanceof Error ? error.message : String(error)}\n`;
    }
    if (postExecutionNote) {
      ensureDirectory(dirname(logPath));
      appendFileSync(logPath, postExecutionNote, "utf8");
    }
    return recordValidationLocked(ledger, {
      command,
      toolchainFingerprint,
      inputFingerprint,
      exitCode,
      logPath,
      headSha: actualHead,
      durationSeconds: result.durationSeconds,
      knownLong,
      timedOut: result.timedOut,
      executionVerified: true,
      observedTree: initialTree,
      postExecutionClean,
      logSha256: await hashFile(logPath),
      retryStateFingerprint: options.retryStateFingerprint,
      ...(options.inputPaths === undefined
        ? {}
        : { inputPaths: options.inputPaths }),
      ...(options.acceptanceEvidence === undefined
        ? {}
        : { acceptanceEvidence: options.acceptanceEvidence }),
    });
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function resolveValidationLogPath(
  root: string,
  requested: string | undefined,
  identity: string,
  attempt: number,
): string {
  const identityRoot = resolve(root, "logs", identity, `attempt-${attempt}`);
  const relativePath = requested ?? "command.log";
  if (relativePath.startsWith("/"))
    throw new FlowError(
      "log path must be relative to the execution identity log directory",
    );
  const path = resolve(identityRoot, relativePath);
  if (relative(identityRoot, path).startsWith(".."))
    throw new FlowError(
      "log path escapes the execution identity log directory",
    );
  return path;
}
