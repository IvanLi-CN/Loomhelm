import { describe, expect, test } from "bun:test";
import { runProcess } from "../../modules/core/process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const LAUNCHER = resolve(ROOT, "bin/plan-cli.sh");
const DIRECT_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/positive-fast-track.md",
);

describe("trusted dev-plan launcher", () => {
  test("clears hostile preload variables and forwards help", async () => {
    const result = await runProcess({
      command: LAUNCHER,
      args: ["--help"],
      cwd: ROOT,
      env: {
        ...process.env,
        BUN_OPTIONS: "--preload=/tmp/hostile.ts",
        NODE_OPTIONS: "--require=/tmp/hostile.js",
        BUN_CONFIG: "/tmp/hostile-bunfig.toml",
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("usage:");
    expect(result.stdout + result.stderr).not.toContain("hostile");
  }, 15000);

  test("forwards file input and emits one projection", async () => {
    const result = await runProcess({
      command: LAUNCHER,
      args: ["--input", DIRECT_PLAN],
      cwd: ROOT,
      env: { ...process.env },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("## 1. 决策卡");
    expect(result.stdout.match(/<proposed_plan>/g)?.length).toBe(1);
    expect(result.stdout.match(/<\/proposed_plan>/g)?.length).toBe(1);
    expect(result.stderr).toBe("");
  }, 15000);

  test("rejects invalid stdin without emitting a projection", async () => {
    const result = await runProcess({
      command: LAUNCHER,
      args: ["--input", "-"],
      cwd: ROOT,
      stdin: "## Summary\n- invalid\n",
      env: { ...process.env },
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain("status: reject");
    expect(result.stderr).toContain("output: none");
    expect(result.stdout).toBe("");
  }, 15000);

  test("rejects a non-Bun BUN_BIN override", async () => {
    const result = await runProcess({
      command: LAUNCHER,
      args: ["--help"],
      cwd: ROOT,
      env: { ...process.env, BUN_BIN: "/bin/echo" },
    });
    expect(result.exitCode, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("repository-approved runtime");
  }, 15000);
});
