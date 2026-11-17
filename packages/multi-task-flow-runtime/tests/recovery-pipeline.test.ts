import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("recovery restores sticky policy before dispatch, two formal turns and CLI task-context", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, "fixtures/recovery-pipeline.ts")],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("PASS: formal dispatch retained");
});
