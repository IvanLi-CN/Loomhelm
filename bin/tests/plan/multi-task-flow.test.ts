import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../../modules/core/process";

const ROOT = resolve(import.meta.dir, "../../..");
const CHECKER = resolve(ROOT, "bin/plan_contract_check.ts");
const MULTI_TASK_PLAN = resolve(
  ROOT,
  "skills/dev-plan/references/plan-cases/positive-multi-task-flow.md",
);

describe("dev-plan and multi-task-flow separation", () => {
  test("dev-plan rejects multi-task-flow as a top-level route", async () => {
    const plan = await Bun.file(MULTI_TASK_PLAN).text();
    const result = await runProcess({
      command: process.execPath,
      args: ["run", CHECKER, "--plan", "-"],
      cwd: ROOT,
      stdin: plan,
      env: { ...process.env, PLAN_CONTRACT_REPO_ROOT: ROOT },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("DEV_PLAN_MULTI_TASK_FLOW_FORBIDDEN");
  });

  test("runtime schema and initializer contain no dev-plan handoff contract", async () => {
    for (const path of [
      "skills/multi-task-flow/scripts/schema.ts",
      "skills/multi-task-flow/scripts/orchestrate.ts",
      "skills/multi-task-flow/scripts/engine.ts",
    ]) {
      const source = await readFile(resolve(ROOT, path), "utf8");
      expect(source).not.toContain("dev_plan_handoff");
      expect(source).not.toContain("devPlanHandoff");
    }
  });
});
