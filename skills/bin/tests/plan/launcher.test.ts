import { describe, expect, test } from "bun:test";
import { runProcess } from "../../modules/core/process";
import { join, resolve } from "node:path";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "../../../..");
const LAUNCHER = resolve(ROOT, "skills/bin/plan-cli.sh");
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
    expect(result.stderr).toContain("repository-approved Bun runtime");
  }, 15000);
});

for (const target of ["modules/plan/private_snapshot.ts", "modules/plan/review.ts", "modules/plan"]) {
  test("refuses writable snapshot source " + target + " before execution", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-source-permissions-")));
    try {
      const bin = join(root,"skills/bin"); cpSync(join(ROOT,"skills/bin"),bin,{recursive:true});
      const path = join(bin,target), marker = join(root,"executed");
      if (target.endsWith(".ts")) writeFileSync(path,`import {writeFileSync as __permissionMarker} from "node:fs"; __permissionMarker(${JSON.stringify(marker)},"unsafe");\n`+readFileSync(path,"utf8"));
      chmodSync(path,target.endsWith(".ts") ? 0o666 : 0o777);
      const result=await runProcess({command:join(bin,"plan-cli.sh"),args:["--input","-"],cwd:root,stdin:"invalid",env:{...process.env},timeoutMs:15000});
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("DEV_PLAN_SOURCE_PERMISSIONS_FORBIDDEN");
      expect(result.stdout).toBe("");
      expect(existsSync(marker)).toBe(false);
    } finally {rmSync(root,{recursive:true,force:true});}
  },20000);
}
