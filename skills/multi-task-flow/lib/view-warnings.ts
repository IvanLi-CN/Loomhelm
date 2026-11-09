import type { Plan } from "../lib/schema";

export type PlanWarning = {
  code: string;
  reason: string;
};

export function planWarnings(plan: Plan): PlanWarning[] {
  const taskNodes = plan.nodes.filter((node) => node.kind === "task");
  if (taskNodes.length === 0)
    return [{ code: "legacy_invalid", reason: "历史计划没有任务，只读查看。" }];
  const atomTaskIds = new Set(plan.atoms.map((atom) => atom.task_id));
  const warnings: PlanWarning[] = [];
  for (const node of taskNodes) {
    if (!node.ref_id || !atomTaskIds.has(node.ref_id)) warnings.push({ code: "legacy_invalid", reason: `任务 ${node.label} 缺少原子任务，只读查看。` });
    if (node.estimate_minutes === null) warnings.push({ code: "legacy_invalid", reason: `任务 ${node.label} 缺少估时，只读查看。` });
    if (!node.estimate_basis || !node.estimate_confidence) warnings.push({ code: "legacy_invalid", reason: `任务 ${node.label} 缺少估时依据，只读查看。` });
  }
  return warnings;
}
