import { expect, test } from "bun:test";
import { fixedChecks } from "../../modules/workspace/candidate_context";

test("fixed validation covers the migrated repository contract groups", () => {
  const checks = fixedChecks("/candidate");
  expect(checks.map((check) => check.name)).toEqual([
    "repository-contracts",
    "skills-index",
    "plan-contracts",
    "source-policy",
    "typecheck",
  ]);
  expect(checks[0]?.argv.slice(2)).toEqual([
    "/candidate/bin/tests/core/package_scripts.test.ts",
    "/candidate/bin/tests/flow/profile.test.ts",
    "/candidate/bin/tests/flow/flow.test.ts",
    "/candidate/bin/tests/checks/checks.test.ts",
    "/candidate/bin/tests/checks/multi-task-flow.test.ts",
    "/candidate/bin/tests/workspace/workspace.test.ts",
  ]);
  expect(checks[1]?.argv).toContain("/candidate/bin/skills_index_check.ts");
  expect(checks[2]?.argv.slice(2)).toEqual([
    "/candidate/bin/tests/plan/shell.test.ts",
    "/candidate/bin/tests/plan/multi-task-flow.test.ts",
    "/candidate/bin/tests/plan/orchestration.test.ts",
    "/candidate/bin/tests/plan/acceptance.test.ts",
    "/candidate/bin/tests/plan/review.test.ts",
    "/candidate/bin/tests/plan/task_migration.test.ts",
  ]);
});
