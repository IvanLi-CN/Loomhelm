export function normalizeRetiredPlanAlias(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { dev_plan_handoff: retired, ...current } = value;
  return current.plan_handoff === undefined && retired !== undefined
    ? { ...current, plan_handoff: retired }
    : current;
}
