import type { Plan } from "./schema";

export type PlanWarning = {
  code: "missing_start_at";
  reason: string;
};

export function planWarnings(plan: Plan): PlanWarning[] {
  if (plan.start_at || !plan.nodes.some((node) => node.kind === "task"))
    return [];
  return [
    {
      code: "missing_start_at",
      reason:
        "The selected plan has no start time, so theoretical intervals cannot be calculated.",
    },
  ];
}
