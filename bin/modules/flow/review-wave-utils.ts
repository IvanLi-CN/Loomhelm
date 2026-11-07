import { FlowError } from "./common";

export function sortedStrings(
  values: string[] | undefined,
  label: string,
): string[] {
  const normalized = values ?? [];
  if (normalized.some((value) => !value.trim()))
    throw new FlowError(`${label} must be non-empty strings`);
  return [...new Set(normalized)].sort();
}

export function canonicalList(value: unknown): string {
  return Array.isArray(value) ? [...value].sort().join("\u0000") : "";
}

export function deriveReviewSynthesis(
  wave: Record<string, unknown>,
  findings: Set<string>,
): Record<string, unknown> {
  const sorted = [...findings].sort();
  return {
    groups: sorted.map((fingerprint) => ({
      group_id: `finding-${fingerprint}`,
      finding_fingerprints: [fingerprint],
      blocker: true,
      invariant: `Resolve mandatory review finding ${fingerprint}`,
    })),
    invariants: [],
    coverage: Object.keys((wave.lanes ?? {}) as Record<string, unknown>).sort(),
    conflicts: [],
    conflict_dispositions: [],
    acceptance: [],
  };
}
