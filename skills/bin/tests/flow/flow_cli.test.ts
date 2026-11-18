import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(process.cwd(), "skills/bin/flow_receipt.ts");

async function withTemp<T>(
  prefix: string,
  callback: (root: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCli(root: string, args: string[]): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

function expectCliFailure(root: string, args: string[], message: string): void {
  try {
    runCli(root, args);
    throw new Error("CLI unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error)) throw error;
    expect(String((error as Error & { stdout?: unknown }).stdout)).toContain(
      message,
    );
  }
}

describe("flow receipt CLI replay", () => {
  test("records the parent request and requires a CLI attempt id", async () => {
    await withTemp("flow-cli-review-", async (root) => {
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "flow@example.test"]);
      git(["config", "user.name", "Flow Test"]);
      await writeFile(join(root, "README.md"), "base\n");
      git(["add", "README.md"]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      await writeFile(join(root, "README.md"), "review CLI fixture\n");
      git(["add", "README.md"]);
      git(["commit", "-qm", "candidate"]);
      const head = git(["rev-parse", "HEAD"]);
      git(["branch", "base", base]);

      runCli(root, [
        "init",
        "--repo",
        root,
        "--run-id",
        "cli-review-run",
        "--flow-type",
        "local-merge",
        "--base-sha",
        base,
        "--head-sha",
        "HEAD",
      ]);
      runCli(root, [
        "review-assess",
        "--repo",
        root,
        "--tier",
        "3",
        "--reason",
        "CLI replay",
      ]);
      const opened = runCli(root, [
        "review-wave",
        "open",
        "--repo",
        root,
        "--stage",
        "initial",
        "--base-ref",
        "base",
        "--head-sha",
        head,
        "--lane",
        "contract:gpt-6-luna:max",
        "--lane",
        "state-concurrency:gpt-6-luna:max",
        "--lane",
        "failure-data-safety:gpt-6-luna:max",
        "--lane",
        "test-platform:gpt-6-luna:max",
      ]);
      const openedWave = opened.wave as Record<string, unknown>;
      const waveId = String(openedWave.wave_id);
      const result = JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation:
          "Inspected the candidate diff and confirmed the complete CLI result.",
        overall_confidence_score: 1,
      });
      const recorded = runCli(root, [
        "record",
        "--repo",
        root,
        "--kind",
        "review",
        "--base-ref",
        "base",
        "--head-sha",
        head,
        "--review-profile",
        "pr-convergence",
        "--review-attempt-id",
        "cli-attempt",
        "--review-result-json",
        result,
        "--wave-id",
        waveId,
        "--lane",
        "contract",
      ]);
      expect(recorded.receipt).toMatchObject({
        requested_profile: { model: "gpt-6-luna", effort: "max" },
        attempt_key: "cli-attempt",
        reported_profile: null,
        profile_verification: "request_recorded",
        effective_profile: null,
      });

      expectCliFailure(
        root,
        [
          "record",
          "--repo",
          root,
          "--kind",
          "review",
          "--base-ref",
          "base",
          "--head-sha",
          head,
          "--review-profile",
          "pr-convergence",
          "--review-result-json",
          result,
          "--wave-id",
          waveId,
          "--lane",
          "state-concurrency",
        ],
        "missing required option --review-attempt-id",
      );

      for (const [lane, attempt] of [
        ["state-concurrency", "cli-state"],
        ["failure-data-safety", "cli-failure"],
        ["test-platform", "cli-test"],
      ])
        runCli(root, [
          "record",
          "--repo",
          root,
          "--kind",
          "review",
          "--base-ref",
          "base",
          "--head-sha",
          head,
          "--review-profile",
          "pr-convergence",
          "--review-attempt-id",
          attempt,
          "--review-result-json",
          result,
          "--wave-id",
          waveId,
          "--lane",
          lane,
        ]);
      const finalized = runCli(root, [
        "review-wave",
        "finalize",
        "--repo",
        root,
        "--wave-id",
        waveId,
      ]);
      expect(finalized.next).toBe("merge-ready");
    });
  });
});
