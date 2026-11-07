import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dispatch } from "../../compatibility_dispatch";
import { historicalSessionFindings } from "../../modules/plan/historical_session";
import { readFileSync } from "node:fs";
const root = resolve(import.meta.dir, "../../../..");
test("Wave Thread Skill and state runtime are removed", async () => {
  for (const path of [
    "skills/wave-thread-flow",
    "skills/bin/modules/waves",
    "skills/bin/wave_thread_flow.ts",
    "skills/bin/wave_thread_plan_contract.ts",
  ])
    expect(existsSync(resolve(root, path))).toBe(false);
  for (const command of [
    "wave_thread_flow",
    "wave_thread_replay_check",
    "wave_thread_roundtrip",
    "wave_thread_route_audit",
  ])
    expect(await dispatch(command, [])).toBe(2);
});
test("historical Wave Thread plans are rejected rather than replayed", () => {
  const session = readFileSync(
    resolve(
      root,
      "skills/dev-plan/references/replay-cases/positive-wave-thread-v2-legacy.jsonl",
    ),
    "utf8",
  );
  expect(
    historicalSessionFindings(session).some(
      (item) => item.code === "RETIRED_FLOW_TYPE",
    ),
  ).toBe(true);
});

import {
  validate,
  parseOrchestration,
  MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS,
} from "../../modules/plan/orchestration";
import {
  canonicalFacts,
  renderProjection,
} from "../../modules/plan/projection";
const activePlan = () =>
  readFileSync(
    resolve(
      root,
      "skills/dev-plan/references/plan-cases/positive-multi-task-flow.md",
    ),
    "utf8",
  );
test("accepts active multi-task orchestration and scoped acceptance", () => {
  const plan = activePlan();
  expect(() =>
    validate(plan, MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS),
  ).not.toThrow();
  const [batches, tasks] = parseOrchestration(
    plan,
    MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS,
  );
  expect(Object.keys(batches)).toEqual(["multi-core"]);
  expect(Object.keys(tasks)).toEqual(["task-a", "task-b", "task-c"]);
  expect(tasks["task-c"]?.fields.depends_on).toBe(
    "task-a/integrated,task-b/integrated",
  );
  expect(tasks["task-a"]?.profile).toEqual({
    model: "gpt-6-luna",
    thinking: "max",
  });
});
test("rejects malformed active multi-task topology, metadata, and nesting", () => {
  const plan = activePlan();
  for (const broken of [
    plan.replace("topology=sibling-prs", "topology=stacked"),
    plan.replace(
      "event_protocol=multi-task-flow/v1",
      "event_protocol=wave-thread/v2",
    ),
    plan.replace("skill=$multi-task-flow", "skill=$wave-thread-flow"),
    plan.replace("[gpt-6-luna, max]", "[unsupported-model, max]"),
    plan.replace("owned_surfaces=src/b", "owned_surfaces=src/a"),
    plan.replace("task-a/integrated,task-b/integrated", "missing/integrated"),
    plan.replace("  - wave: 1", " - wave: 1"),
    plan.replace("scope=`task:task-a`", "scope=`task:missing`"),
  ])
    expect(() =>
      validate(broken, MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS),
    ).toThrow();
});
test("renders the current multi-task fixture with nine owner-facing sections", () => {
  const plan = activePlan();
  const [batches, tasks] = canonicalFacts(plan);
  expect(Object.keys(tasks)).toHaveLength(3);
  const output = renderProjection(plan, batches);
  expect(output.match(/^## /gm)).toHaveLength(9);
  expect(output).toContain("Prepare task A");
  expect(output).toContain("multi-task-flow/v1");
});
