import { MAX_CONVERGENCE_ROUNDS, isoNow } from "./common";

export function recordLegacyConvergence(
  current: Record<string, unknown>,
  blockers: string[],
): Record<string, unknown> {
  const convergence = current.convergence as Record<string, unknown>;
  const previous = Array.isArray(convergence.blockers)
    ? (convergence.blockers as string[]).slice().sort()
    : [];
  const normalized = blockers.slice().sort();
  const round = Number(convergence.round ?? 0);
  const repair = Number(convergence.repair_round ?? 0);
  let state = "complete";
  const currentCounts = new Map<string, number>();
  const previousCounts = new Map<string, number>();
  for (const blocker of normalized)
    currentCounts.set(blocker, (currentCounts.get(blocker) ?? 0) + 1);
  for (const blocker of previous)
    previousCounts.set(blocker, (previousCounts.get(blocker) ?? 0) + 1);
  const reduced =
    [...currentCounts].every(
      ([fingerprint, count]) => count <= (previousCounts.get(fingerprint) ?? 0),
    ) && JSON.stringify(normalized) !== JSON.stringify(previous);
  if (normalized.length && round === 0) state = "initial";
  else if (repair >= MAX_CONVERGENCE_ROUNDS) {
    state = "NON_CONVERGENT";
    current.state = state;
  } else if (reduced) {
    const nextRepair = repair + 1;
    convergence.repair_round = nextRepair;
    state = !normalized.length
      ? "complete"
      : nextRepair >= MAX_CONVERGENCE_ROUNDS
        ? "NON_CONVERGENT"
        : "progress";
    if (state === "NON_CONVERGENT") current.state = state;
  } else if (convergence.diagnostic_used) {
    state = "NON_CONVERGENT";
    current.state = state;
  } else {
    state = convergence.diagnostic_used
      ? "NON_CONVERGENT"
      : "diagnostic_required";
    convergence.diagnostic_used = true;
    convergence.repair_round = repair + 1;
  }
  convergence.round = round + 1;
  convergence.state = state;
  convergence.blockers = normalized;
  current.events = [
    ...(Array.isArray(current.events) ? current.events : []),
    { type: "convergence", state, blockers: normalized, at: isoNow() },
  ];
  return { state, ...convergence };
}
