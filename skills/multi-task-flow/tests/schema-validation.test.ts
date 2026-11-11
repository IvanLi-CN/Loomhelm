import { describe, expect, test } from "bun:test";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import { plannedAction, validateLedger } from "../lib/schema";

describe("planned action schema", () => {
  test("accepts a structured task target", () => {
    const action = plannedAction.parse({
      id: "publish-task-branch",
      kind: "publish_branch",
      task_id: "task-a",
      group_id: null,
      target: { type: "task", id: "task-a" },
    });
    expect(action.target).toEqual({ type: "task", id: "task-a" });
    expect(action.target_identity).toBeUndefined();
  });

  test("rejects unknown action fields", () => {
    expect(() =>
      plannedAction.parse({
        id: "publish-task-branch",
        kind: "publish_branch",
        task_id: "task-a",
        group_id: null,
        target: { type: "task", id: "task-a" },
        provider_receipt: {},
      }),
    ).toThrow();
  });

  test("rejects an operation that points at no receipt fact", () => {
    const ledger = createDemoLedger();
    ledger.operations.push({
      id: "operation-orphan",
      kind: "dispatch",
      actor_id: "sample-agent",
      target_id: "other-task",
      status: "claimed",
      request: {},
      expected_sha: null,
      receipt_fact_id: "missing-fact",
      created_at: ledger.updated_at,
      updated_at: ledger.updated_at,
    });
    expect(() => validateLedger(ledger)).toThrow("Operation receipt_fact_id must reference");
  });

  test("rejects a fact whose subject is absent", () => {
    const ledger = createDemoLedger();
    ledger.facts.push({
      id: "fact-orphan",
      kind: "task_quality",
      subject_id: "missing-task",
      status: "passed",
      source: "test",
      observed_at: ledger.updated_at,
      sha: null,
      evidence_ref: "test",
      quality: null,
      receipt: null,
    });
    expect(() => validateLedger(ledger)).toThrow("Fact subject must reference");
  });
});
