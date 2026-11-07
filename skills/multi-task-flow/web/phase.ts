export type DisplayPhase = "planning" | "execution";

export type PhaseTask = { started_at: string | null };

export function derivePhase(tasks: PhaseTask[], executionPhase?: "planning" | "implementation"): DisplayPhase {
  if (executionPhase) return executionPhase === "implementation" ? "execution" : "planning";
  return tasks.some((task) => task.started_at !== null) ? "execution" : "planning";
}
export function defaultTabForPhase(phase: DisplayPhase): "graph" | "actual" {
  return phase === "planning" ? "graph" : "actual";
}
