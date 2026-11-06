import { describe, expect, test } from "bun:test";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import { buildView } from "../scripts/view";
import type { View } from "../web/model";
import { GRAPH_LABEL_LIMITS, GRAPH_SHAPES, MAX_GRAPH_PATHS, buildGraphProjection, fitGraphLabel } from "../web/graph-projection";

function demoView(): View {
  return buildView(createDemoLedger(Date.parse("2026-10-31T00:00:00.000Z"))) as unknown as View;
}

describe("dashboard graph projection", () => {
  test("keeps every task and milestone once while hiding boundary node text", () => {
    const view = demoView();
    const projection = buildGraphProjection(view);
    const sourceNodes = projection.nodes.filter((node) => node.nodeKind !== "group");

    expect(sourceNodes).toHaveLength(view.tasks.length + 2);
    expect(new Set(sourceNodes.map((node) => node.sourceNodeId)).size).toBe(sourceNodes.length);
    expect(sourceNodes.map((node) => node.sourceNodeId)).not.toContain("start");
    expect(sourceNodes.map((node) => node.sourceNodeId)).not.toContain("end");
    expect(sourceNodes.map((node) => node.fullLabel).join(" ")).not.toMatch(/开始|结束/);
  });

  test("collapses only hidden boundary nodes and preserves explicit gate provenance", () => {
    const view = demoView();
    const before = JSON.stringify(view);
    const projection = buildGraphProjection(view);
    const gate = projection.edges.find((edge) => edge.source === "core-merge" && edge.target === "node-integration");

    expect(gate).toEqual(expect.objectContaining({
      paths: [{ requires: ["merged", "completed"], sourceEdgeIds: ["edge-10", "edge-13"], boundaryNodeIds: ["dashboard-start"] }],
      crossGroup: "yes",
    }));
    expect(projection.boundaryDependencies.some((item) => item.direction === "incoming" && item.nodeId === "node-model")).toBe(true);
    expect(projection.boundaryDependencies.some((item) => item.direction === "outgoing" && item.nodeId === "node-verify")).toBe(true);
    expect(projection.edges.some((edge) => edge.source === "node-model" && edge.target === "core-merge")).toBe(false);
    expect(JSON.stringify(view)).toBe(before);
  });

  test("keeps separate dependency paths when visible endpoints collapse to one edge", () => {
    const view = minimalView([
      node("source", "milestone"), node("target", "milestone"), node("hidden-a", "group_start"), node("hidden-b", "group_end"),
    ], [
      edge("source-a", "source", "hidden-a", "integrated"), edge("a-target", "hidden-a", "target", "completed"),
      edge("source-b", "source", "hidden-b", "merged"), edge("b-target", "hidden-b", "target", "published"),
    ]);
    const projected = buildGraphProjection(view);
    const collapsed = projected.edges.find((item) => item.source === "source" && item.target === "target");

    expect(collapsed?.paths).toEqual([
      { requires: ["integrated", "completed"], sourceEdgeIds: ["source-a", "a-target"], boundaryNodeIds: ["hidden-a"] },
      { requires: ["merged", "published"], sourceEdgeIds: ["source-b", "b-target"], boundaryNodeIds: ["hidden-b"] },
    ]);
  });

  test("preserves hidden plan entry and exit metadata without projecting boundary nodes", () => {
    const view = minimalView([
      node("start", "main_start"), node("end", "main_end"), node("target", "milestone"), node("source", "milestone"),
    ], [edge("entry", "start", "target", "completed"), edge("exit", "source", "end", "merged")]);
    const projected = buildGraphProjection(view);

    expect(projected.boundaryDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "incoming", nodeId: "target", paths: [{ requires: ["completed"], sourceEdgeIds: ["entry"], boundaryNodeIds: ["start"] }] }),
      expect.objectContaining({ direction: "outgoing", nodeId: "source", paths: [{ requires: ["merged"], sourceEdgeIds: ["exit"], boundaryNodeIds: ["end"] }] }),
    ]));
    expect(projected.nodes.map((item) => item.id)).not.toEqual(expect.arrayContaining(["start", "end"]));
  });

  test("uses collision-safe edge ids and bounds pathological hidden path expansion", () => {
    const collisionView = minimalView([
      node("a-b", "milestone"), node("c", "milestone"), node("a", "milestone"), node("b-c", "milestone"),
    ], [edge("left", "a-b", "c", "completed"), edge("right", "a", "b-c", "completed")]);
    const collisionEdges = buildGraphProjection(collisionView).edges;
    expect(new Set(collisionEdges.map((item) => item.id)).size).toBe(2);
    expect(collisionEdges.every((item) => !collisionView.nodes.some((node) => node.id === item.id))).toBe(true);

    const layers = Array.from({ length: 16 }, (_, index) => [`layer-${index}-a`, `layer-${index}-b`]);
    const nodes = [node("source", "milestone"), node("target", "milestone"), ...layers.flat().map((id) => node(id, "group_start"))];
    const edges = [edge("source-a", "source", layers[0]![0]!, "completed"), edge("source-b", "source", layers[0]![1]!, "completed")];
    for (let index = 0; index < layers.length - 1; index += 1) for (const from of layers[index]!) for (const to of layers[index + 1]!) edges.push(edge(`${from}-${to}`, from, to, "completed"));
    edges.push(edge("last-a", layers.at(-1)![0]!, "target", "completed"), edge("last-b", layers.at(-1)![1]!, "target", "completed"));
    const bounded = buildGraphProjection(minimalView(nodes, edges));
    expect(bounded.warnings.length).toBeGreaterThan(0);
    expect(bounded.edges[0]?.paths.length).toBeLessThanOrEqual(MAX_GRAPH_PATHS);

    const targets = Array.from({ length: MAX_GRAPH_PATHS + 8 }, (_, index) => `target-${index}`);
    const manyTargetView = minimalView([
      node("source", "milestone"), node("boundary", "group_start"), ...targets.map((id) => node(id, "milestone")),
    ], [
      edge("source-boundary", "source", "boundary", "completed"),
      ...targets.map((id, index) => edge(`boundary-${index}`, "boundary", id, "completed")),
    ]);
    const manyTargetProjection = buildGraphProjection(manyTargetView);
    const sourcePaths = manyTargetProjection.edges.filter((item) => item.source === "source").flatMap((item) => item.paths);
    expect(sourcePaths.length).toBeLessThanOrEqual(MAX_GRAPH_PATHS);

    const terminalNodes = Array.from({ length: MAX_GRAPH_PATHS + 8 }, (_, index) => `terminal-${index}`);
    const terminalProjection = buildGraphProjection(minimalView([
      node("source", "milestone"), node("boundary", "group_start"), ...terminalNodes.map((id) => node(id, "group_end")),
    ], [
      edge("source-boundary", "source", "boundary", "completed"),
      ...terminalNodes.map((id, index) => edge(`boundary-${index}`, "boundary", id, "completed")),
    ]));
    const terminalPaths = terminalProjection.boundaryDependencies.find((item) => item.direction === "outgoing" && item.nodeId === "source")?.paths ?? [];
    expect(terminalPaths.length).toBeLessThanOrEqual(MAX_GRAPH_PATHS);
  });

  test("does not project a visible self-loop through a hidden boundary cycle", () => {
    const projected = buildGraphProjection(minimalView([
      node("source", "milestone"), node("boundary", "group_start"),
    ], [
      edge("into-boundary", "source", "boundary", "completed"),
      edge("back-to-source", "boundary", "source", "completed"),
    ]));

    expect(projected.edges).toEqual([]);
    expect(projected.boundaryDependencies).toEqual([]);
  });

  test("keeps group container ids distinct from source node ids", () => {
    const projected = buildGraphProjection(minimalView([node("group:x", "milestone", "x")], [], [group("x")]));
    const groupNode = projected.nodes.find((item) => item.nodeKind === "group");
    const sourceNode = projected.nodes.find((item) => item.sourceNodeId === "group:x");

    expect(new Set(projected.nodes.map((item) => item.id)).size).toBe(projected.nodes.length);
    expect(groupNode?.id).not.toBe(sourceNode?.id);
    expect(sourceNode?.parentId).toBe(groupNode?.id);
  });

  test("retains current and planned group identity for moved tasks", () => {
    const moved = buildGraphProjection(demoView()).nodes.find((node) => node.refId === "dashboard-ui");
    expect(moved).toEqual(expect.objectContaining({ groupId: "dashboard", plannedGroupId: "core" }));
  });

  test("keeps the approved shape vocabulary distinct by domain kind", () => {
    expect(GRAPH_SHAPES).toEqual({
      group: "round-rectangle",
      contribution: "round-rectangle",
      release: "hexagon",
      deployment: "rhomboid",
      verification: "ellipse",
      coordination: "octagon",
      milestone: "diamond",
    });
    expect(new Set(Object.values(GRAPH_SHAPES)).size).toBe(6);
  });

  test("bounds labels before they reach Cytoscape while retaining the full title", () => {
    const full = "依赖图与甘特图界面交互及实时状态恢复验证 Mixed English Title";
    const fitted = fitGraphLabel(full, GRAPH_LABEL_LIMITS.task);
    const lines = fitted.split("\n");
    expect(lines.length).toBeLessThanOrEqual(GRAPH_LABEL_LIMITS.task.lines);
    expect(lines.every((line) => Array.from(line).length <= GRAPH_LABEL_LIMITS.task.columns)).toBe(true);
    expect(fitted.endsWith("…")).toBe(true);
    expect(buildGraphProjection(demoView()).nodes.find((node) => node.refId === "dashboard-ui")?.fullLabel).toBe("依赖图与甘特图交互验证");
    expect(buildGraphProjection(demoView()).nodes.find((node) => node.refId === "dashboard-ui")).toEqual(expect.objectContaining({
      graphLabel: fitGraphLabel("依赖图与甘特图交互验证", GRAPH_LABEL_LIMITS.task),
      stateLabel: "执行中",
      stateIcon: "loader-circle",
    }));
    expect(buildGraphProjection(demoView()).nodes.find((node) => node.refId === "dashboard-ui")?.graphLabel).not.toContain("执行中");
  });
});

function node(id: string, kind: string, groupId: string | null = null) {
  return { id, kind, ref_id: null, group_id: groupId, planned_group_id: null, label: id };
}

function edge(id: string, from: string, to: string, requires: string) {
  return { id, from_node_id: from, to_node_id: to, requires };
}

function group(id: string) {
  return { id, title: id, agent_thread_id: null, state: "active", parent_pr: null, requirements_path: null };
}

function minimalView(nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], groups: ReturnType<typeof group>[] = []): View {
  return {
    orchestration: { id: "run", repository: { owner: "example", name: "repo", host: "github.com" }, revision: 1, updated_at: "2026-01-01T00:00:00.000Z", display_timezone: "UTC", max_running_tasks: 1, conversation_links_verified: true },
    groups, tasks: [], plans: [], selected_plan_id: "", follow_prs: [], nodes, edges, planned_intervals: [], actual_intervals: [], actual_milestones: [], warnings: [],
  };
}
