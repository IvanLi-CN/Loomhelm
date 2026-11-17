import { expect, test } from "bun:test";
import { atomRelations } from "../../web/detail-atom-relations";
import type { AtomicTask, View } from "../../web/model";

const atom: AtomicTask = { id: "current", title: "当前任务", status: "running" };
const view = {
  groups: [{ atoms: [{ id: "before", title: "准备交付分支" }] }],
  tasks: [{ atoms: [atom, { id: "after", title: "合并实现" }] }],
  atomic_nodes: [{ id: "before", title: "准备父分支" }],
  canonical_atomic_edges: [
    { id: "a", from_node_id: "before", to_node_id: "current" },
    { id: "b", from_node_id: "current", to_node_id: "after" },
    { id: "c", from_node_id: "before", to_node_id: "current" },
    { id: "unrelated", from_node_id: "after", to_node_id: "outside" },
  ],
} as unknown as View;

test("shows deduplicated incoming and outgoing atomic edges and resolves cross-scope names", () => {
  const graph = atomRelations(view, atom);
  expect(graph.querySelectorAll(".atom-relations-node")).toHaveLength(3);
  expect(graph.querySelectorAll(".atom-relations-graph svg path")).toHaveLength(2);
  expect(graph.querySelector('[aria-label="前驱"]')?.textContent).toBe("准备父分支");
  expect(graph.querySelector('[aria-label="后继"]')?.textContent).toBe("合并实现");
  expect(graph.querySelector('[data-current="true"]')?.textContent).toBe("当前任务");
  expect(graph.textContent).not.toContain("outside");
});

test("selection changes reverse which edges appear on each side", () => {
  const graph = atomRelations(view, { id: "after", title: "合并实现", status: "planned" });
  expect(graph.querySelector('[aria-label="前驱"]')?.textContent).toBe("当前任务");
  expect(graph.querySelector('[aria-label="后继"]')?.textContent).toBe("outside");
});

test("respects an explicitly empty canonical graph and keeps an empty-state diagram", () => {
  const graph = atomRelations(
    {
      ...view,
      canonical_atomic_edges: [],
      atomic_edges: [{ id: "old", from_atom_id: "before", to_atom_id: "current" }],
    },
    atom,
  );
  expect(graph.textContent).toContain("无前驱");
  expect(graph.textContent).toContain("无后继");
  expect(graph.querySelectorAll(".atom-relations-graph svg path")).toHaveLength(0);
  expect(graph.querySelectorAll(".atom-relations-node")).toHaveLength(1);
});

test("uses legacy atomic edges when canonical data is absent", () => {
  const graph = atomRelations(
    {
      ...view,
      canonical_atomic_edges: undefined,
      atomic_edges: [{ id: "old", from_atom_id: "before", to_atom_id: "current" }],
    },
    atom,
  );
  expect(graph.querySelector('[aria-label="前驱"]')?.textContent).toBe("准备父分支");
  expect(graph.textContent).toContain("无后继");
});

test("collapses by default and summarizes predecessors for unfinished states", () => {
  for (const status of ["planned", "running", "blocked"] as const) {
    const relations = atomRelations(view, { ...atom, status });
    expect(relations.open).toBe(false);
    expect(relations.querySelector("summary")?.textContent).toBe("前驱：准备父分支");
  }
});

test("summarizes successors for completed atoms, including empty relations", () => {
  const relations = atomRelations(view, { ...atom, status: "completed" });
  expect(relations.querySelector("summary")?.textContent).toBe("合并实现");
  const empty = atomRelations(
    { ...view, canonical_atomic_edges: [] },
    { ...atom, status: "completed" },
  );
  expect(empty.querySelector("summary")?.textContent).toBe("无后继");
});

test("restores expansion and reports toggles without removing the full graph", () => {
  const changes: boolean[] = [];
  const relations = atomRelations(view, atom, {
    expanded: true,
    onToggle: (value) => changes.push(value),
  });
  expect(relations.open).toBe(true);
  expect(relations.querySelectorAll(".atom-relations-node")).toHaveLength(3);
  relations.open = false;
  relations.dispatchEvent(new Event("toggle"));
  expect(changes.at(-1)).toBe(false);
});
