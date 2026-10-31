import type { ProjectTaskSource } from "@/features/tasks/types";

export type ProjectDeleteState = "idle" | "pending" | "success";

export function shouldShowProjectLoadingState(
  status: ProjectTaskSource["status"] | undefined,
  hasDisplayedProject: boolean,
  deleteState: ProjectDeleteState
): boolean {
  return status === "loading" && deleteState === "idle" && !hasDisplayedProject;
}
