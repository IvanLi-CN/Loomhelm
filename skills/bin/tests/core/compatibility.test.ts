import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatch } from "../../compatibility_dispatch";

async function runCompatibilityCommand(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const script = resolve(
    fileURLToPath(new URL("../../compatibility_cli.ts", import.meta.url)),
  );
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("wave compatibility entrypoints retain distinct baseline contracts", async () => {
  expect(await dispatch("wave_thread_flow", [])).toBe(2);
  expect(await dispatch("wave_thread_replay_check", [])).toBe(2);
  expect(await dispatch("wave_thread_roundtrip", [])).toBe(2);
});

test("compatibility CLI preserves documented command and cases routes", async () => {
  const command = await runCompatibilityCommand(["wave_thread_roundtrip"]);
  expect(command.exitCode).not.toBe(0);
  const cases = await runCompatibilityCommand([
    "browser_policy_replay_check",
    "--cases",
    "skills/docs/vendor/dot-codex/specs/gui-escalation-gate/replay/cases.txt",
  ]);
  expect(cases.exitCode).toBe(0);
  expect(cases.stdout).toContain("PASS file=");
  const summary = await runCompatibilityCommand([
    "pr_skill_replay_check",
    "--summary",
    "--cases",
    "skills/docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/cases.txt",
  ]);
  expect(summary.exitCode).toBe(0);
  expect(summary.stdout).toContain("SUMMARY file=");
  expect(summary.stdout).not.toContain("SUMMARY cases=");
  const directSummary = await runCompatibilityCommand([
    "pr_skill_replay_check",
    "--summary",
    "skills/docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/negative-session-approval-evidence-ignored.jsonl",
  ]);
  expect(directSummary.exitCode).toBe(1);
  expect(directSummary.stdout).toContain("codes=");
});

test("summary replay cases retain mismatch diagnostics", async () => {
  const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  const temporary = await mkdtemp(join(tmpdir(), "dot-codex-cases-"));
  const cases = join(temporary, "cases.txt");
  try {
    await writeFile(
      cases,
      `pass ${join(
        root,
        "skills/docs/vendor/dot-codex/specs/pr-skill-diagnosis-thinning/replay/negative-session-approval-evidence-ignored.jsonl",
      )} -\n`,
    );
    const result = await runCompatibilityCommand([
      "pr_skill_replay_check",
      "--summary",
      "--cases",
      cases,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERROR file=");
    expect(result.stderr).toContain("saw findings");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live instruction replay keeps the model-runner interface", async () => {
  expect(await dispatch("instruction_behavior_replay", ["--help"])).toBe(0);
  expect(
    await dispatch("instruction_behavior_replay", ["--model", "fixture"]),
  ).toBe(2);
});
