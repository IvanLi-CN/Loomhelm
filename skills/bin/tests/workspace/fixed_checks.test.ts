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
    "/candidate/skills/bin/tests/core/package_scripts.test.ts",
    "/candidate/skills/bin/tests/flow/profile.test.ts",
    "/candidate/skills/bin/tests/flow/flow.test.ts",
    "/candidate/skills/bin/tests/checks/checks.test.ts",
    "/candidate/skills/bin/tests/checks/multi-task-flow.test.ts",
    "/candidate/skills/bin/tests/workspace/workspace.test.ts",
  ]);
  expect(checks[1]?.argv).toContain("/candidate/skills/bin/skills_index_check.ts");
  expect(checks[2]?.argv.slice(2)).toEqual([
    "/candidate/skills/bin/tests/plan/shell.test.ts",
    "/candidate/skills/bin/tests/plan/multi-task-flow.test.ts",
    "/candidate/skills/bin/tests/plan/orchestration.test.ts",
    "/candidate/skills/bin/tests/plan/acceptance.test.ts",
    "/candidate/skills/bin/tests/plan/review.test.ts",
    "/candidate/skills/bin/tests/plan/task_migration.test.ts",
  ]);
});
