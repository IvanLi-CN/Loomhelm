import type { AgentOutput } from "./agent-output";
/** Idle is a task state; observation never overrides waiting, blocked or terminal tasks. */
export function runtimeTaskState(task: {state: string; disposition?: string; agent_resume_state?: "starting" | "running"}, output?: AgentOutput): string {
  if ((task.disposition && task.disposition !== "active") || !["starting", "running", "agent_idle"].includes(task.state)) return task.state;
  if (!output) return task.state;
  if (!output.stale && output.agent_state === "idle" && !!output.runtime_turn_id) return "agent_idle";
  return task.state === "agent_idle" ? task.agent_resume_state ?? "running" : task.state;
}
