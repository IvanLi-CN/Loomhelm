import { describe, expect, test } from "bun:test";
import { topologicalOrder, validateGrouping } from "../scripts/graph";

describe("task dependencies", () => {
  test("independent tasks remain runnable while a dependent task waits", () => {
    expect(topologicalOrder(["a", "b", "c"], [{ from: "a", to: "c" }])).toEqual(["a", "b", "c"]);
  });

  test("rejects a grouping that creates a task-level cycle", () => {
    expect(() => validateGrouping(
      [{ id: "a1", task_id: "a" }, { id: "b1", task_id: "b" }, { id: "a2", task_id: "a" }],
      [{ from_atom_id: "a1", to_atom_id: "b1" }, { from_atom_id: "b1", to_atom_id: "a2" }],
    )).toThrow("cycle");
  });

  test("allows a grouped dependency that delays a downstream task", () => {
    expect(() => validateGrouping(
      [{ id: "a1", task_id: "a" }, { id: "a2", task_id: "a" }, { id: "b1", task_id: "b" }],
      [{ from_atom_id: "a1", to_atom_id: "b1" }],
    )).not.toThrow();
  });
});
