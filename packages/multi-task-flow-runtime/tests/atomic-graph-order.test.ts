import { describe, expect, test } from "bun:test";
import { inspectAtomicGraph, type AtomicGraphEdgeLike, type AtomicGraphNodeLike } from "../lib/atomic-graph-order";

const node = (id: string, boundary?: "start" | "end"): AtomicGraphNodeLike => ({ id, kind: boundary ? "boundary" : "work", ...(boundary ? { boundary } : {}) });
const edge = (id: string, from_node_id: string, to_node_id: string): AtomicGraphEdgeLike => ({ id, from_node_id, to_node_id });

describe("inspectAtomicGraph", () => {
  test("derives the same stable order regardless of input order", () => {
    const nodes = [node("end", "end"), node("b"), node("start", "start"), node("m"), node("a")];
    const edges = [edge("m-end", "m", "end"), edge("start-b", "start", "b"), edge("b-m", "b", "m"), edge("a-m", "a", "m"), edge("start-a", "start", "a")];
    const first = inspectAtomicGraph(nodes, edges);
    const second = inspectAtomicGraph([...nodes].reverse(), [...edges].reverse());
    expect(first.order).toEqual(["start", "a", "b", "m", "end"]);
    expect(second.order).toEqual(first.order);
    expect(first.diagnostics).toEqual([]);
  });

  test("keeps cycles in the order and marks every cycle node and edge", () => {
    const result = inspectAtomicGraph([node("start", "start"), node("a"), node("b"), node("end", "end")], [edge("s-a", "start", "a"), edge("a-b", "a", "b"), edge("b-a", "b", "a"), edge("b-e", "b", "end")]);
    expect(result.order).toEqual(["start", "a", "b", "end"]);
    expect(result.diagnostics.some((item) => item.code === "cycle")).toBe(true);
    expect(result.nodeDiagnostics.get("a")).toContain("cycle");
    expect(result.edgeDiagnostics.get("a-b")).toContain("cycle");
  });

  test("marks missing-node edges and orphan nodes without dropping them", () => {
    const result = inspectAtomicGraph([node("start", "start"), node("a"), node("end", "end"), node("orphan")], [edge("s-a", "start", "a"), edge("a-e", "a", "end"), edge("bad", "a", "missing")]);
    expect(result.order).toEqual(["orphan", "start", "a", "end"]);
    expect(result.edgeDiagnostics.get("bad")).toContain("missing_node");
    expect(result.nodeDiagnostics.get("orphan")).toContain("orphan");
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["missing_node", "orphan"]));
  });
});
