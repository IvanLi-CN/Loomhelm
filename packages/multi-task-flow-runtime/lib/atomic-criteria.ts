import type { AtomicNode } from "./atomic-orchestration";

export type MilestoneCriterion = Extract<AtomicNode, { kind: "milestone" }>["acceptance"][number];

export function canEvaluateAtomicCriterion(
  criterion: MilestoneCriterion,
): criterion is Extract<
  MilestoneCriterion,
  { kind: "node_satisfied" | "pr_published" | "pr_merged" }
> {
  return (
    criterion.kind === "node_satisfied" ||
    criterion.kind === "pr_published" ||
    criterion.kind === "pr_merged"
  );
}
