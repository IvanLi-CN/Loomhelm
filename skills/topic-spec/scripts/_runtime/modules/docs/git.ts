import { execFileSync } from "node:child_process";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

export function runGit(repoRoot: string, args: string[]): GitCommandResult {
  try {
    const stdout = execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: text(stdout), stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      exitCode: failure.status ?? 1,
      stdout: text(failure.stdout),
      stderr: text(failure.stderr),
    };
  }
}

export function gitText(repoRoot: string, args: string[]): string | null {
  const result = runGit(repoRoot, args);
  return result.exitCode === 0 ? result.stdout : null;
}

export function gitRefExists(repoRoot: string, ref: string): boolean {
  return runGit(repoRoot, ["rev-parse", "--verify", ref]).exitCode === 0;
}

export function gitFileText(
  repoRoot: string,
  ref: string,
  path: string,
): string | null {
  return gitText(repoRoot, [
    "show",
    ref === ":" ? `:${path}` : `${ref}:${path}`,
  ]);
}
