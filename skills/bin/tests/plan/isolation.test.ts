import { expect, test } from "bun:test";
import { exists, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");

test("legacy shell business entrypoints are removed", async () => {
  expect(await exists(resolve(ROOT, "skills/bin/plan_contract_check.sh"))).toBe(false);
  expect(await exists(resolve(ROOT, "skills/bin/plan_review_view.sh"))).toBe(false);
  expect(await exists(resolve(ROOT, "skills/bin/plan-cli.sh"))).toBe(true);
});

test("finalizer has no runtime orchestration side effects", async () => {
  const implementation = await readFile(
    resolve(ROOT, "skills/bin/modules/plan/review.ts"),
    "utf8",
  );
  for (const forbidden of [
    "multi-task-flow",
    "multi_task_flow",
    "dev_plan_handoff",
    "attachDevPlanHandoff",
    "handoff_digest",
    "ledger.json",
    "Bun.spawn",
    "child_process",
    "runProcess",
  ]) {
    expect(implementation).not.toContain(forbidden);
  }
});
