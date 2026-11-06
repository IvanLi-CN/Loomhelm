import { apply } from "../scripts/engine";
import { expect, test } from "bun:test";
import {
  createDemoLedger,
  createPlanningDemoLedger,
} from "../examples/orchestration-viewer/ledger";
import { defaultGroupAtoms, group, validateLedger } from "../scripts/schema";
import { buildView } from "../scripts/view";
import {
  contractJsonSchema,
  localSemanticProjection,
} from "../scripts/contract";

test("rejects runtime group atoms outside the configured stable identity", () => {
  const ledger = createDemoLedger();
  ledger.groups[0]!.atoms[0]!.id = "forged";
  expect(() => validateLedger(ledger)).toThrow(
    "Delivery-unit atoms must match",
  );
});

test("semantic projection preserves the actual ledger contract", () => {
  const ledger = createDemoLedger();
  ledger.contract_version = 2;
  expect(localSemanticProjection(ledger).contract_version).toBe(2);
  ledger.contract_version = 1;
  expect(localSemanticProjection(ledger).contract_version).toBe(1);
  expect(contractJsonSchema()["x-contract-version"]).toBe(2);
});

test("an unconfigured historical plan does not borrow runtime atoms", () => {
  const ledger = createDemoLedger();
  const historical = structuredClone(ledger.plans[0]!);
  historical.id = "historical";
  historical.group_atoms = [];
  historical.atoms = [];
  historical.atomic_edges = [];
  ledger.plans.push(historical);
  const view = buildView(ledger, historical.id) as any;
  expect(view.groups.every((group: any) => group.atoms.length === 0)).toBe(
    true,
  );
  expect(view.tasks.every((task: any) => task.atoms.length === 0)).toBe(true);
});

for (const contamination of [
  "clean",
  "binding",
  "atom",
  "coordination",
  "lifecycle",
] as const) {
  test(`plan revisions require clean new group runtime: ${contamination}`, () => {
    const ledger = createPlanningDemoLedger();
    const proposed = structuredClone(ledger.plans[0]!);
    proposed.id = `new-group-${contamination}`;
    proposed.supersedes_id = ledger.execution_plan_id;
    proposed.approval_id = null;
    proposed.lifecycle = "proposed";
    proposed.revision = null;
    const incoming = group.parse({
      ...ledger.groups[0],
      id: "new-group",
      agent_thread_id: null,
      state: "planned",
      parent_branch: null,
      current_sha: null,
      requirements_path: null,
      lifecycle: undefined,
      atoms: defaultGroupAtoms("new-group"),
    });
    proposed.nodes.push({
      ...proposed.nodes[0]!,
      id: "new-group-start",
      kind: "group_start",
      ref_id: null,
      group_id: incoming.id,
    });
    proposed.group_atoms.push(
      ...incoming.atoms.map(({ status, ...atom }) => ({
        ...atom,
        group_id: incoming.id,
      })),
    );
    if (contamination === "binding") incoming.agent_thread_id = "forged-thread";
    if (contamination === "atom") incoming.atoms[0]!.status = "completed";
    if (contamination === "coordination")
      incoming.coordination_execution.state = "running";
    if (contamination === "lifecycle")
      incoming.lifecycle.workspace_ready = "passed";
    const before = JSON.stringify(ledger);
    const propose = () =>
      apply(ledger, "plan-propose", {
        run_id: ledger.orchestration_id,
        actor: { role: "main", thread_id: ledger.control.owner_thread_id! },
        request_id: `propose-${contamination}`,
        expected_revision: ledger.revision,
        payload: {
          plan: proposed,
          groups: [...structuredClone(ledger.groups), incoming],
          tasks: structuredClone(ledger.tasks),
        },
      });
    if (contamination === "clean") {
      propose();
      expect(
        validateLedger(ledger)
          .groups.at(-1)!
          .atoms.every((atom) => atom.status === "planned"),
      ).toBe(true);
    } else {
      expect(propose).toThrow(
        "Initial groups and tasks must be unbound and planned",
      );
      expect(JSON.stringify(ledger)).toBe(before);
    }
  });
}
