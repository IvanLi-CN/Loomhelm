import { randomUUID } from "node:crypto";
import type { OutputSnapshot } from "../web/agent-output";
import { runtimeTaskState } from "../web/task-state";
import { apply } from "../lib/engine";
import { validateLedger } from "../lib/schema";
import type { LedgerStore } from "../lib/store";

/** Persist only actual transitions, checking current binding inside the ledger lock. */
export function observeTaskRuntime(store: LedgerStore, snapshot: OutputSnapshot): void {
  const ledger = validateLedger(store.read());
  for (const task of ledger.tasks) {
    const output = snapshot.outputs[task.id];
    if (!output || output.thread_id !== task.thread_id || runtimeTaskState(task, output) === task.state) continue;
    store.update(raw => {
      const current = validateLedger(raw);
      const target = current.tasks.find(item => item.id === task.id);
      if (!target || target.thread_id !== output.thread_id || runtimeTaskState(target, output) === target.state) return raw;
      return apply(raw, "task-runtime-observe", {
        run_id: current.orchestration_id,
        actor: {role: "main", thread_id: current.control.owner_thread_id},
        request_id: `runtime-${randomUUID()}`, expected_revision: current.revision,
        payload: {task_id: task.id, thread_id: output.thread_id, turn_id: output.runtime_turn_id, runtime: output.stale || (output.agent_state === "idle" && !output.runtime_turn_id) ? "unknown" : output.agent_state ?? "unknown", observed_at: new Date().toISOString()},
      });
    });
  }
}
