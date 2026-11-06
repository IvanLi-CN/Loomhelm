import { FlowError, isRecord, isoNow } from "./common";

export function recordReviewHistory(
  review: Record<string, unknown>,
  epoch: Record<string, unknown>,
  waveId: string,
  blockers: string[],
  synthesis: Record<string, unknown>,
  options: { recordBlockerHistory?: boolean } = {},
): void {
  if (options.recordBlockerHistory ?? true) {
    const blockerHistory = Array.isArray(epoch.blocker_history)
      ? epoch.blocker_history
      : [];
    epoch.blocker_history = [
      ...blockerHistory,
      {
        wave_id: waveId,
        blockers,
        blocker_fingerprints: synthesis.blocker_fingerprints,
        finding_to_group: synthesis.finding_to_group,
        invariants: synthesis.invariants,
        at: isoNow(),
      },
    ];
  }
  if (!isRecord(review.cumulative)) return;
  const cumulative = review.cumulative;
  const previousGroups = isRecord(cumulative.finding_to_group)
    ? cumulative.finding_to_group
    : {};
  for (const [finding, group] of Object.entries(
    synthesis.finding_to_group as Record<string, string>,
  )) {
    if (
      previousGroups[finding] !== undefined &&
      previousGroups[finding] !== group
    )
      throw new FlowError(
        "review synthesis remaps a cumulative finding to another root group",
      );
    previousGroups[finding] = group;
  }
  cumulative.finding_to_group = previousGroups;
  cumulative.blocker_fingerprints = sortedStrings([
    ...(Array.isArray(cumulative.blocker_fingerprints)
      ? (cumulative.blocker_fingerprints as string[])
      : []),
    ...(synthesis.blocker_fingerprints as string[]),
  ]);
  cumulative.invariants = sortedStrings([
    ...(Array.isArray(cumulative.invariants)
      ? (cumulative.invariants as string[])
      : []),
    ...(synthesis.invariants as string[]),
  ]);
  cumulative.coverage_lanes = sortedStrings([
    ...(Array.isArray(cumulative.coverage_lanes)
      ? (cumulative.coverage_lanes as string[])
      : []),
    ...(synthesis.coverage as string[]),
  ]);
}

function sortedStrings(values: string[]): string[] {
  if (values.some((value) => !value.trim()))
    throw new FlowError("review history values must be non-empty strings");
  return [...new Set(values)].sort();
}
