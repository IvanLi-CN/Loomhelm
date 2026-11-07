import { expect, test } from "bun:test";
import { createSingleDeliveryUnitOutputs, singleDeliveryUnitObserver } from "../examples/single-delivery-unit/outputs";
import { latestConversationOutput } from "../scripts/conversation-history";
import { ready } from "../scripts/engine";
import { createSingleDeliveryUnitLedger } from "../examples/single-delivery-unit/ledger";
import { buildView } from "../scripts/view";
import { buildGraphProjection } from "../web/graph-projection";
import { layoutProjection } from "../web/graph-layout";
import type { View } from "../web/model";

test("independent single-unit example is deterministic and uses only mock bindings", async () => {
  const ledger = createSingleDeliveryUnitLedger();
  expect(ledger).toEqual(createSingleDeliveryUnitLedger());
  expect(ledger.groups).toHaveLength(1);
  expect(ledger.tasks).toHaveLength(14);
  expect(ledger.control.owner_thread_id).toBe("mock-thread-main");
  expect(ledger.groups.every(group => group.agent_thread_id?.startsWith("mock-thread-") && group.parent_pr?.url?.startsWith("https://example.invalid/"))).toBe(true);
  expect(ledger.tasks.every(task => (!task.thread_id || task.thread_id.startsWith("mock-thread-")) && (!task.pr || task.pr.url?.startsWith("https://example.invalid/")))).toBe(true);
  expect(ledger.operations).toEqual([]);
  const projection = buildGraphProjection(buildView(ledger) as View);
  expect(projection.nodes.filter(node => node.nodeKind === "milestone")).toHaveLength(2);
  expect(projection.nodes.filter(node => node.nodeKind === "group")).toHaveLength(1);
  expect(projection.nodes.filter(node => node.nodeKind === "task")).toHaveLength(14);
  const layout = await layoutProjection(projection, "RIGHT");
  expect(layout.edges).toHaveLength(projection.edges.length);
  expect(layout.width).toBeGreaterThan(layout.height);
});


test("snapshot aligns unit lifecycle, task prerequisites, timestamps and assistant output", async () => {
  const ledger = createSingleDeliveryUnitLedger();
  const outputs = createSingleDeliveryUnitOutputs(ledger);
  const view = buildView(ledger, undefined, outputs) as View;
  expect(view.warnings).toEqual([]);
  const group = ledger.groups[0]!;
  expect(group.atoms.map(atom => atom.status)).toEqual(["completed", "completed", "planned", "planned", "planned"]);
  expect(group.lifecycle).toMatchObject({ workspace_ready: "passed", pr_created: "passed", pr_merged: "pending", closed: "pending" });
  expect(group.coordination_execution.state).toBe("waiting");
  expect(group.merge_sha).toBeNull();
  const connection = await singleDeliveryUnitObserver(ledger)(() => {}, () => {});
  for (const task of ledger.tasks) {
    const output = outputs[task.id]!;
    if (task.state === "planned") {
      expect(task.thread_id).toBeNull();
      expect(task.started_at).toBeNull();
      expect(task.pr).toBeNull();
      expect(output.state).toBe("no_conversation");
    } else {
      expect(task.thread_id).toBeTruthy();
      expect(task.pr).toBeTruthy();
      expect(task.started_at).toBeTruthy();
      expect(ready(ledger, task.id)).toBe(true);
      expect(output.state).toBe("available");
      expect(output.text).toBeTruthy();
      expect(output.message_status).toBe(task.state === "running" ? "in_progress" : "completed");
      const nativeShape = await latestConversationOutput(task.thread_id!, connection);
      expect(nativeShape?.text).toBe(output.text);
      expect(nativeShape?.message_status).toBe(output.message_status);
      const incoming = ledger.plans[0]!.edges.filter(edge => edge.to_node_id === task.id);
      for (const edge of incoming) {
        const predecessor = ledger.tasks.find(item => item.id === edge.from_node_id);
        if (predecessor) expect(Date.parse(predecessor.finished_at!)).toBeLessThanOrEqual(Date.parse(task.started_at!));
      }
      if (task.finished_at) expect(Date.parse(task.finished_at)).toBeLessThanOrEqual(Date.parse(ledger.updated_at));
    }
  }
  expect(view.tasks.filter(task => task.is_ready).map(task => task.id)).toEqual(["switch"]);
  connection.close();
});
