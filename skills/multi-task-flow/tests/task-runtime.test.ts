import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { serviceFixture, fixtureRun } from "./service-fixture";
import { observeTaskRuntime } from "../scripts/task-runtime";
import { runtimeTaskState } from "../web/task-state";
import { initialOutput, type AgentOutput } from "../web/agent-output";

test("runtime observer persists state once, checks binding, and restores starting after uncertainty", () => {
  const { root, state } = serviceFixture();
  try {
    const { store } = fixtureRun(state.paths.data);
    const task = store.read().tasks.find((item: any) => item.thread_id)!;
    store.update(raw => { const t = raw.tasks.find((item: any) => item.id === task.id); t.state = "starting"; });
    const output: AgentOutput = { ...initialOutput(task.thread_id), stale: false, agent_state: "idle", runtime_turn_id: "turn", turn_id: "turn" };
    let revision = 0;
    const observe = () => observeTaskRuntime(store, { output_epoch: "fixture", output_revision: ++revision, outputs: { [task.id]: output } });
    observe();
    expect(store.read().tasks.find((item: any) => item.id === task.id)).toMatchObject({ state: "agent_idle", agent_resume_state: "starting" });
    const after = store.read().revision;
    observe();
    expect(store.read().revision).toBe(after);
    output.thread_id = "different-thread"; output.agent_state = "active";
    observe();
    expect(store.read().revision).toBe(after);
    output.thread_id = task.thread_id; output.agent_state = "idle"; output.runtime_turn_id = null;
    observe();
    expect(store.read().tasks.find((item: any) => item.id === task.id).state).toBe("starting");
    expect(store.read().events.filter((event: any) => event.type === "task_runtime_observed")).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime observations preserve explicit waiting, blocked and terminal task states", () => {
  const output = { ...initialOutput("thread"), stale: false, agent_state: "idle" as const };
  for (const state of ["waiting", "blocked", "completed", "closed", "integrated", "planned"])
    expect(runtimeTaskState({ state, disposition: "active" }, output)).toBe(state);
  expect(runtimeTaskState({ state: "agent_idle", agent_resume_state: "starting" })).toBe("agent_idle");
  expect(runtimeTaskState({ state: "running", disposition: "abandoned" }, output)).toBe("running");
});
