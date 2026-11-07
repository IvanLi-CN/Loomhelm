import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseArguments } from "../../modules/core/cli";
import { runProcess } from "../../modules/core/process";
import {
  assertPlanArguments,
  normalizePlanArgumentAliases,
} from "../../modules/plan/cli";

const ROOT = resolve(import.meta.dir, "../../..");

describe("plan CLI argument compatibility", () => {
  test("rejects a missing input before a later repeated value", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "run",
        resolve(ROOT, "bin/plan_acceptance_manifest.ts"),
        "--input",
        "--input=skills/dev-plan/references/plan-cases/positive-fast-track.md",
      ],
      cwd: ROOT,
      env: { ...process.env, PLAN_CONTRACT_REPO_ROOT: ROOT },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("option --input requires a value");
  });

  test("preserves Python's last-value behavior for complete repeats", () => {
    const parsed = parseArguments(
      normalizePlanArgumentAliases(["--input=first.md", "--input=second.md"]),
    );
    expect(() =>
      assertPlanArguments(parsed, { values: ["input"], flags: [] }),
    ).not.toThrow();
    expect(parsed.options.get("input")).toBe("second.md");
  });
});
