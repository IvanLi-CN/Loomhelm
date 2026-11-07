import { describe, expect, test } from "bun:test";
import { runProcess } from "../../modules/core/process";
import { mkdtemp, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const LAUNCHER = resolve(ROOT, "skills/bin/plan-cli.sh");

describe("launcher boundary regressions", () => {
  test("does not create a plan or runtime artifact on rejection", async () => {
    const result = await runProcess({
      command: LAUNCHER,
      args: ["--input", "-"],
      cwd: ROOT,
      stdin: "# malformed\n",
      env: { ...process.env },
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("execution: blocked");
  }, 15000);

  test("rejects a user-controlled executable named bun", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dev-plan-bun-"));
    const fake = join(directory, "bun");
    await writeFile(fake, "#!/bin/sh\nprintf hostile\n");
    await chmod(fake, 0o755);
    const result = await runProcess({
      command: LAUNCHER,
      args: ["--help"],
      cwd: ROOT,
      env: { ...process.env, BUN_BIN: fake },
    });
    expect(result.exitCode, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("repository-approved Bun runtime");
  }, 15000);
});
