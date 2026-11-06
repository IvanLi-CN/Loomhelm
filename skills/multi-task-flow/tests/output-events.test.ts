import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunDashboard } from "../scripts/server";
import { LedgerStore } from "../scripts/store";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import type { JsonRecord } from "../scripts/codex-agent-api";

test("SSE output and API snapshots update with an unchanged ledger; cancellation closes the observer", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "output-events-"));
  const assets = join(root, "assets"); mkdirSync(assets); writeFileSync(join(assets, "index.html"), "demo");
  const ledger = createDemoLedger(1_767_200_000_000); ledger.orchestration_id = "run";
  const store = new LedgerStore(root, "run"); store.create(ledger);
  const before = readFileSync(store.ledgerPath, "utf8");
  let notify!: (event: JsonRecord) => void; let closes = 0;
  const run = createRunDashboard({ root, runId: "run", assetsDir: assets, port: 0, connectObserver: async callback => { notify = callback; return { request: async () => ({ data: [] }), close: () => { closes++; } }; } });
  const request = (path: string) => run.handle(new Request("http://127.0.0.1" + path), { timeout() {} }, path);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await request("/api/events"); reader = response.body!.getReader();
    await reader.read(); await new Promise(resolve => setTimeout(resolve, 0));
    const initial = await (await request("/api/view")).json();
    const task = ledger.tasks.find(t => t.thread_id)!;
    notify({ method: "item/completed", params: { threadId: task.thread_id, turnId: "turn", item: { id: "final", type: "agentMessage", phase: "final_answer", text: "native final" } } });
    const after = await (await request("/api/view")).json();
    expect(after.revision).toBe(initial.revision);
    expect(after.output_revision).toBeGreaterThan(initial.output_revision);
    expect(after.view.tasks.find((t: any) => t.id === task.id).latest_agent_output.text).toBe("native final");
    let payload = "";
    while (!payload.includes("native final")) { const part = await reader.read(); if (part.done) break; payload += new TextDecoder().decode(part.value); }
    expect(payload).toContain("event: agent-output");
    expect(readFileSync(store.ledgerPath, "utf8")).toBe(before);
    await reader.cancel(); expect(closes).toBe(1); expect(run.subscriberCount).toBe(0);
  } finally { await reader?.cancel(); run.stop(); rmSync(root, { recursive: true, force: true }); }
}, 5000);
