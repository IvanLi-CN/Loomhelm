import { expect, test } from "bun:test";
import {
  createDemoLedger,
  createPlanningDemoLedger,
} from "../examples/orchestration-viewer/ledger";
import { lifecycleRoleOf } from "../lib/atomic-orchestration";
import { contractJsonSchema, localSemanticProjection } from "../lib/contract";
import { apply } from "../lib/engine";
import { defaultGroupAtoms, group, validateLedger } from "../lib/schema";
import { buildView } from "../lib/view";

test("rejects runtime group atoms outside the configured stable identity", () => {
  const ledger = createDemoLedger();
  ledger.groups[0]!.atoms[0]!.id = "forged";
  expect(() => validateLedger(ledger)).toThrow("Delivery-unit atoms must match");
});

test("semantic projection preserves the actual ledger contract", () => {
  const ledger = createDemoLedger();
  ledger.contract_version = 2;
  expect(localSemanticProjection(ledger).contract_version).toBe(2);
  ledger.contract_version = 1;
  expect(localSemanticProjection(ledger).contract_version).toBe(1);
  expect(contractJsonSchema()["x-contract-version"]).toBe(6);
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
  expect(view.groups.every((group: any) => group.atoms.length === 0)).toBe(true);
  expect(view.tasks.every((task: any) => task.atoms.length === 0)).toBe(true);
});

for (const contamination of ["clean", "binding", "atom", "coordination", "lifecycle"] as const) {
  test(`plan revisions require clean new group runtime: ${contamination}`, () => {
    const ledger = createPlanningDemoLedger();
    const withExplicitRole = (atom: any) => {
      const role = lifecycleRoleOf(atom);
      return role ? { ...atom, lifecycle_role: role } : atom;
    };
    ledger.groups = ledger.groups.map((item) => ({
      ...item,
      atoms: item.atoms.map(withExplicitRole),
    }));
    ledger.tasks = ledger.tasks.map((item) => ({
      ...item,
      atoms: item.atoms.map(withExplicitRole),
    }));
    ledger.plans = ledger.plans.map((item) => ({
      ...item,
      atoms: item.atoms.map(withExplicitRole),
      group_atoms: item.group_atoms.map(withExplicitRole),
    }));
    const proposed = structuredClone(ledger.plans[0]!);
    const taskGroup = new Map(ledger.tasks.map((task) => [task.id, task.group_id]));
    const roleOrder = new Map([
      ["prepare-parent", 0],
      ["prepare-branch", 0],
      ["create-pr", 1],
      ["merge-pr", 2],
      ["closeout", 3],
    ]);
    proposed.atoms = proposed.atoms.map(withExplicitRole);
    proposed.group_atoms = proposed.group_atoms.map(withExplicitRole);
    proposed.atomic_nodes = [...proposed.atoms, ...proposed.group_atoms].map((atom: any) => ({
      kind: "work",
      id: atom.id,
      title: atom.title,
      purpose: atom.purpose,
      output: atom.output,
      acceptance: [],
      activity_type: "verification",
      state: "planned",
      scope:
        typeof atom.task_id === "string"
          ? { kind: "task", task_id: atom.task_id, delivery_unit_id: taskGroup.get(atom.task_id) }
          : { kind: "delivery_unit", delivery_unit_id: atom.group_id },
      ...(atom.lifecycle_role ? { lifecycle_role: atom.lifecycle_role } : {}),
    }));
    const lifecycleEdges = [...proposed.atoms, ...proposed.group_atoms].flatMap((atom: any) => {
      const ownerKey = typeof atom.task_id === "string" ? "task_id" : "group_id";
      const ownerId = atom[ownerKey];
      const atoms = [...proposed.atoms, ...proposed.group_atoms]
        .filter((candidate: any) => candidate[ownerKey] === ownerId && lifecycleRoleOf(candidate))
        .sort(
          (left: any, right: any) =>
            (roleOrder.get(lifecycleRoleOf(left)!) ?? 99) -
            (roleOrder.get(lifecycleRoleOf(right)!) ?? 99),
        );
      if (atoms[0]?.id !== atom.id) return [];
      return atoms.slice(1).map((next: any, index: number) => ({
        id: `lifecycle-${ownerId}-${index}`,
        from_node_id: atoms[index]!.id,
        to_node_id: next.id,
        requires: { kind: "source_terminal_success" },
      }));
    });
    proposed.atomic_edges = lifecycleEdges;
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
    const incomingNodes = proposed.group_atoms
      .filter((atom: any) => atom.group_id === incoming.id)
      .map((atom: any) => ({
        kind: "work",
        id: atom.id,
        title: atom.title,
        purpose: atom.purpose,
        output: atom.output,
        acceptance: [],
        activity_type: "verification",
        state: "planned",
        scope: { kind: "delivery_unit", delivery_unit_id: incoming.id },
        lifecycle_role: atom.lifecycle_role,
      }));
    proposed.atomic_nodes.push(...incomingNodes);
    const incomingRoles = incomingNodes
      .slice()
      .sort(
        (left: any, right: any) =>
          (roleOrder.get(lifecycleRoleOf(left)!) ?? 99) -
          (roleOrder.get(lifecycleRoleOf(right)!) ?? 99),
      );
    proposed.atomic_edges.push(
      ...incomingRoles.slice(1).map((atom: any, index: number) => ({
        id: `lifecycle-${incoming.id}-${index}`,
        from_node_id: incomingRoles[index]!.id,
        to_node_id: atom.id,
        requires: { kind: "source_terminal_success" },
      })),
    );
    if (contamination === "binding") incoming.agent_thread_id = "forged-thread";
    if (contamination === "atom") incoming.atoms[0]!.status = "completed";
    if (contamination === "coordination") incoming.coordination_execution.state = "running";
    if (contamination === "lifecycle") incoming.lifecycle.workspace_ready = "passed";
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
      expect(propose).toThrow("Initial groups and tasks must be unbound and planned");
      expect(JSON.stringify(ledger)).toBe(before);
    }
  });
}
