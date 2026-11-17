import { describe, expect, test } from "bun:test";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import { defaultGroupAtoms, plannedAction, validateLedger } from "../lib/schema";
import { fixtureIdentity } from "./cli-identity-fixture";
import { fixture } from "./engine-fixtures";

function roleOnlyLifecycleLedger(contract: 5 | 6) {
  const ledger: any = structuredClone(fixture());
  const group = ledger.groups[0];
  const plan = ledger.plans[0];
  const atoms = defaultGroupAtoms(group.id);
  group.atoms = atoms;
  plan.group_atoms = atoms.map(({ status: _status, ...atom }) => ({
    ...atom,
    group_id: group.id,
  }));
  plan.atomic_edges = [];
  ledger.schema_version = 2;
  ledger.source_schema_version = null;
  ledger.contract_version = contract;
  ledger.runtime_identity = { ...fixtureIdentity, ledger_contract: contract };
  ledger.execution_plan_id = plan.id;
  return ledger;
}

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

  test("requires canonical lifecycle graphs for fresh contract-6 ledgers but preserves historical reads", () => {
    expect(() => validateLedger(roleOnlyLifecycleLedger(6))).toThrow("canonical atomic nodes");
    expect(() => validateLedger(roleOnlyLifecycleLedger(5))).not.toThrow();
  });
});
