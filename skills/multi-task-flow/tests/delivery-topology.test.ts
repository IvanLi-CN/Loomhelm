import { expect, test } from "bun:test";
import { deliveryTopologyForGroup, validateDeliveryTopologies } from "../lib/schema";

const task = (id: string, group_id: string, policy: "shared_delivery_unit" | "child_pr") => ({
  id,
  group_id,
  kind: "contribution" as const,
  disposition: "active" as const,
  execution_owner: policy === "shared_delivery_unit" ? "delivery_agent" as const : "task_agent" as const,
  conversation_policy: policy === "shared_delivery_unit" ? "delivery_owned" as const : "task_agent" as const,
  delivery_policy: policy,
});

test("derives shared topology from one contribution task", () => {
  const tasks = [task("task-a", "du-a", "shared_delivery_unit")];
  expect(deliveryTopologyForGroup(tasks as any, "du-a")).toBe("shared_delivery");
  expect(() => validateDeliveryTopologies(tasks as any, true)).not.toThrow();
});

test("derives multi-task topology without allowing shared policies", () => {
  const tasks = [task("task-a", "du-a", "child_pr"), task("task-b", "du-a", "child_pr")];
  expect(deliveryTopologyForGroup(tasks as any, "du-a")).toBe("multi_task_integration");
  expect(() => validateDeliveryTopologies(tasks as any, true)).not.toThrow();
  expect(() => validateDeliveryTopologies([task("task-a", "du-a", "shared_delivery_unit"), task("task-b", "du-a", "child_pr")] as any, true)).toThrow("multi-task delivery unit");
});

test("does not count verification tasks when deriving topology", () => {
  const tasks = [
    task("task-a", "du-a", "shared_delivery_unit"),
    { id: "verify-a", group_id: "du-a", kind: "verification", disposition: "active" },
  ];
  expect(deliveryTopologyForGroup(tasks as any, "du-a")).toBe("shared_delivery");
});
