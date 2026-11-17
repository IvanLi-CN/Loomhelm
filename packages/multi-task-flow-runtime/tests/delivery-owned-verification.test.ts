import { expect, test } from "bun:test";
import { apply } from "../lib/engine";
import { approve, at, fixture, groupActor, main, request } from "./engine-fixtures";

import { modernFixture, request as modernRequest } from "./role-flow-fixtures";

function verification() {
  const ledger = fixture();
  const task = ledger.tasks[0];
  task.kind = "verification";
  task.execution_owner = "delivery_agent";
  task.conversation_policy = "delivery_owned";
  task.delivery_policy = "evidence";
  task.atoms = [{ id: "verify", title: "Verify", status: "planned" }];
  ledger.plans[0].atoms.push({
    id: "verify",
    title: "Verify",
    task_id: "a",
    purpose: "Verify",
    output: "Evidence",
  });
  approve(ledger);
  return ledger;
}
function update(
  ledger: ReturnType<typeof verification>,
  state: string,
  actor = groupActor as typeof groupActor | typeof main,
) {
  return apply(
    ledger,
    "task-update",
    request(
      ledger,
      `task-${ledger.revision}`,
      {
        task_id: "a",
        state,
        occurred_at: at,
        evidence: "fixture:verified",
        detail: "fixture wait",
      },
      actor,
    ),
  );
}
function atom(ledger: ReturnType<typeof verification>, state: string) {
  return apply(
    ledger,
    "atom-update",
    request(
      ledger,
      `atom-${ledger.revision}`,
      { task_id: "a", atom_id: "verify", state },
      groupActor,
    ),
  );
}
test("bound delivery agent starts, blocks, resumes, updates atoms and completes evidence verification", () => {
  const ledger = verification();
  expect(() => atom(ledger, "running")).toThrow("task owner");
  update(ledger, "running");
  update(ledger, "blocked");
  update(ledger, "running");
  expect(() => update(ledger, "completed")).toThrow("atoms");
  atom(ledger, "running");
  atom(ledger, "completed");
  update(ledger, "completed");
  update(ledger, "closed");
  expect(ledger.tasks[0].state).toBe("closed");
  expect(ledger.tasks[0].thread_id).toBeNull();
  expect(ledger.tasks[0].execution_owner).toBe("delivery_agent");
});
test("main cannot impersonate delivery ownership, including completion of an already running task", () => {
  const ledger = verification();
  expect(() => update(ledger, "running", main)).toThrow("bound delivery agent");
  update(ledger, "running");
  expect(() => update(ledger, "blocked", main)).toThrow("bound delivery agent");
});
test("unbound, foreign group, wrong policy, capacity and inactive group cannot bypass start gates", () => {
  for (const scenario of [
    "unbound",
    "foreign",
    "policy",
    "capacity",
    "inactive",
    "dependency",
  ] as const) {
    const ledger = verification();
    if (scenario === "unbound") ledger.groups[0].agent_thread_id = null;
    if (scenario === "foreign")
      ledger.groups.push({
        ...structuredClone(ledger.groups[0]),
        id: "foreign",
        agent_thread_id: "other-group",
      });
    if (scenario === "policy") {
      ledger.tasks[0].execution_owner = "main";
      ledger.tasks[0].conversation_policy = "main_owned";
    }
    if (scenario === "capacity") {
      ledger.config.max_running_tasks = 1;
      ledger.tasks[1].state = "running";
    }
    if (scenario === "inactive") ledger.groups[0].state = "planned";
    if (scenario === "dependency")
      ledger.plans[0].edges.push({
        id: "pending",
        from_node_id: "node-b",
        to_node_id: "node-a",
        requires: "completed",
      });
    const actor =
      scenario === "foreign" ? { role: "group" as const, thread_id: "other-group" } : groupActor;
    expect(() =>
      apply(
        ledger,
        "task-update",
        request(ledger, "denied", { task_id: "a", state: "running", occurred_at: at }, actor),
      ),
    ).toThrow();
    expect(ledger.tasks[0].state).toBe("planned");
  }
});

test("modern delivery verification requires its prepared workspace and accepts a merged group", () => {
  const ledger = modernFixture();
  const task = ledger.tasks[0];
  task.kind = "verification";
  task.execution_owner = "delivery_agent";
  task.conversation_policy = "delivery_owned";
  task.delivery_policy = "evidence";
  ledger.groups[0].lifecycle.workspace_ready = "unknown";
  const start = () =>
    apply(
      ledger,
      "task-update",
      modernRequest(
        ledger,
        "modern-start",
        { task_id: "task-a", state: "running", occurred_at: at },
        { role: "group", thread_id: "delivery-thread" },
      ),
    );
  expect(() => start()).toThrow("workspace");
  ledger.groups[0].lifecycle.workspace_ready = "passed";
  ledger.groups[0].state = "merged";
  start();
  expect(ledger.tasks[0].state).toBe("running");
});
