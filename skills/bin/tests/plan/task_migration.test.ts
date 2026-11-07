import { expect, test } from "bun:test";
import { migrateText } from "../../modules/plan/task_migration";

test("task migration converts legacy assignments with flow skill and fallback profile", () => {
  const source = [
    "## Flow Decision",
    "- `flow_type`: `fast-track`",
    "",
    "## Task Orchestration",
    "- assign: main-agent => implement the contract",
    "- assign: sub-agent:review => inspect the contract",
    "",
    "## Acceptance & Validation",
    "- Run the contract replay.",
    "",
  ].join("\n");
  const [updated, converted, notes] = migrateText(source);
  expect(converted).toBe(1);
  expect(updated).toContain(
    "- main-agent => implement the contract (skill: $fast-flow)",
  );
  expect(updated).toContain(
    "- sub-agent:review [gpt-5.6-luna, xhigh] => inspect the contract (skill: $fast-flow)",
  );
  expect(notes).toContain("migrated-to-wave-format");
});

test("task migration preserves the active multi-task flow binding", () => {
  const source = [
    "## Flow Decision",
    "- `flow_type`: `multi-task-flow`",
    "",
    "## Task Orchestration",
    "- assign: task:a => prepare task A",
    "- assign: task:b => prepare task B",
    "",
  ].join("\n");
  const [updated] = migrateText(source);
  expect(updated).toContain(
    "  - task:a [gpt-5.6-luna, xhigh] => prepare task A (skill: $multi-task-flow)",
  );
  expect(updated).toContain(
    "  - task:b [gpt-5.6-luna, xhigh] => prepare task B (skill: $multi-task-flow)",
  );
});

test("task migration preserves dotted multi-task IDs", () => {
  const source = [
    "## Flow Decision",
    "- `flow_type`: `multi-task-flow`",
    "",
    "## Task Orchestration",
    "- assign: task:task.a => prepare task A",
    "- assign: task:task.b => prepare task B",
    "",
  ].join("\n");
  const [updated, converted, notes] = migrateText(source);
  expect(converted).toBe(1);
  expect(notes).toContain("migrated-to-wave-format");
  expect(updated).toContain(
    "  - task:task.a [gpt-5.6-luna, xhigh] => prepare task A (skill: $multi-task-flow)",
  );
  expect(updated).toContain(
    "  - task:task.b [gpt-5.6-luna, xhigh] => prepare task B (skill: $multi-task-flow)",
  );
});

test("task migration keeps multi-task flow binding ahead of stale execution hints", () => {
  const source = [
    "## Flow Decision",
    "- `flow_type`: `multi-task-flow`",
    "",
    "## Execution Steps",
    "- use (skill: $fast-flow)",
    "",
    "## Task Orchestration",
    "- assign: task:a => prepare task A",
    "- assign: task:b => prepare task B",
    "",
  ].join("\n");
  const [updated] = migrateText(source);
  expect(updated).toContain(
    "  - task:a [gpt-5.6-luna, xhigh] => prepare task A (skill: $multi-task-flow)",
  );
  expect(updated).toContain(
    "  - task:b [gpt-5.6-luna, xhigh] => prepare task B (skill: $multi-task-flow)",
  );
});

test("task migration canonicalizes active multi-task flow aliases", () => {
  for (const alias of [
    "multi_task_flow",
    "multi task flow",
    "multi-task",
    "多任务流程",
  ]) {
    const source = [
      "## Flow Decision",
      `- flow_type: ${alias}`,
      "",
      "## Execution Steps",
      "- use (skill: $fast-flow)",
      "",
      "## Task Orchestration",
      "- assign: task:a => prepare task A",
      "- assign: task:b => prepare task B",
      "",
    ].join("\n");
    const [updated] = migrateText(source);
    expect(updated).toContain(
      "  - task:a [gpt-5.6-luna, xhigh] => prepare task A (skill: $multi-task-flow)",
    );
    expect(updated).toContain(
      "  - task:b [gpt-5.6-luna, xhigh] => prepare task B (skill: $multi-task-flow)",
    );
  }
});

test("task migration rejects retired coordination flows", () => {
  for (const flow of [
    "wave-thread",
    "wave_thread",
    "wave-thread-flow",
    "initiative",
    "initiative_flow",
    "parallel-pr",
    "parallel_pr",
    "parallelpr",
    "parallel-pr-flow",
  ])
    expect(() =>
      migrateText("## Flow Decision\n- `flow_type`: `" + flow + "`\n"),
    ).toThrow("Retired coordination flow");
});

test("task migration preserves unsupported orchestration instead of rewriting it", () => {
  const source = "## Task Orchestration\n- sidecar-agent:review => inspect\n";
  const [updated, converted, notes] = migrateText(source);
  expect(updated).toBe(source);
  expect(converted).toBe(0);
  expect(notes).toContain("unsupported-lines:1");
});

test("task migration preserves explicit profiles and strips invalid legacy metadata", () => {
  const explicit =
    "## Task Orchestration\n- sub-agent:analysis [gpt-6-sol, ultra] => inspect\n";
  const [explicitUpdated] = migrateText(explicit);
  expect(explicitUpdated).toContain(
    "sub-agent:analysis [gpt-6-sol, ultra] => inspect (skill: $implement-only-flow)",
  );

  const legacy =
    "## Task Orchestration\n- sub-agent:review => inspect; model=gpt-4; reasoning_effort=bogus\n";
  const [legacyUpdated] = migrateText(legacy);
  expect(legacyUpdated).toContain(
    "sub-agent:review [gpt-5.6-luna, xhigh] => inspect (skill: $implement-only-flow)",
  );
  expect(legacyUpdated).not.toContain("model=");
  expect(legacyUpdated).not.toContain("reasoning_effort=");
});
