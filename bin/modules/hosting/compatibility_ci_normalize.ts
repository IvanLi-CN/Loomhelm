import { redactProviderValue } from "./redact";
import { HostingError } from "./types";
import type { ProviderResponse } from "./backend";
import { stringValue } from "./compatibility_helpers";
import {
  surfaceError,
  type CiEvidence,
  type GateEffect,
  type PolicyObservation,
  type SurfaceObservation,
} from "./compatibility_ci_policy";
import {
  normalizeChecks,
  normalizeRuns,
  normalizeStatuses,
} from "./compatibility_ci_surfaces";

type EvidenceOutcome = "passed" | "failed" | "pending";

interface EvidenceObservation {
  outcome: EvidenceOutcome;
  freshness: [number, number, number];
}

function numericValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : -Infinity;
}

function timestampValue(record: Record<string, unknown>): number {
  for (const key of [
    "updated_at",
    "completed_at",
    "created_at",
    "started_at",
  ]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return -Infinity;
}

function freshnessOf(
  record: Record<string, unknown>,
): [number, number, number] {
  return [
    timestampValue(record),
    numericValue(record.run_attempt ?? record.attempt),
    numericValue(record.id),
  ];
}

function freshnessCompare(
  left: [number, number, number],
  right: [number, number, number],
): number | undefined {
  const [leftTimestamp, leftAttempt, leftId] = left;
  const [rightTimestamp, rightAttempt, rightId] = right;
  if (
    Number.isFinite(leftTimestamp) &&
    Number.isFinite(rightTimestamp) &&
    leftTimestamp !== rightTimestamp
  )
    return leftTimestamp > rightTimestamp ? 1 : -1;
  if (
    Number.isFinite(leftAttempt) &&
    Number.isFinite(rightAttempt) &&
    leftAttempt !== rightAttempt
  )
    return leftAttempt > rightAttempt ? 1 : -1;
  if (leftId !== rightId && Number.isFinite(leftId) && Number.isFinite(rightId))
    return leftId > rightId ? 1 : -1;
  if (Number.isFinite(leftTimestamp) !== Number.isFinite(rightTimestamp))
    return undefined;
  if (Number.isFinite(leftAttempt) !== Number.isFinite(rightAttempt))
    return undefined;
  return undefined;
}

function outcomeSeverity(outcome: EvidenceOutcome): number {
  return { passed: 1, pending: 2, failed: 3 }[outcome];
}

function statusOutcome(value: unknown): EvidenceOutcome {
  const state = stringValue(value).toLowerCase();
  if (["success", "passed"].includes(state)) return "passed";
  if (
    [
      "failure",
      "failed",
      "error",
      "cancelled",
      "timed_out",
      "action_required",
      "startup_failure",
      "stale",
    ].includes(state)
  )
    return "failed";
  return "pending";
}

function checkOutcome(status: unknown, conclusion: unknown): EvidenceOutcome {
  const value = stringValue(conclusion).toLowerCase();
  const statusResult = statusOutcome(status);
  if (
    statusResult === "failed" &&
    ["success", "skipped", "passed", "neutral"].includes(value)
  )
    return "failed";
  if (["success", "skipped", "passed", "neutral"].includes(value))
    return "passed";
  if (
    [
      "failure",
      "failed",
      "cancelled",
      "timed_out",
      "action_required",
      "startup_failure",
      "stale",
    ].includes(value)
  )
    return "failed";
  return statusOutcome(status);
}

function addOutcome(
  target: Map<string, EvidenceObservation>,
  context: unknown,
  outcome: EvidenceOutcome,
  record: Record<string, unknown>,
): void {
  const name = stringValue(context);
  if (!name) return;
  const next: EvidenceObservation = {
    outcome,
    freshness: freshnessOf(record),
  };
  const current = target.get(name);
  if (!current) {
    target.set(name, next);
    return;
  }
  const freshness = freshnessCompare(next.freshness, current.freshness);
  if (
    freshness === undefined
      ? outcomeSeverity(next.outcome) > outcomeSeverity(current.outcome)
      : freshness > 0 ||
        (freshness === 0 &&
          outcomeSeverity(next.outcome) > outcomeSeverity(current.outcome))
  )
    target.set(name, next);
}

function classifyCiEvidence(
  policy: PolicyObservation,
  statuses: Array<Record<string, unknown>>,
  checks: Array<Record<string, unknown>>,
  runs: Array<Record<string, unknown>>,
  surfaceErrors: Array<{ surface: string; error: Record<string, unknown> }>,
): { ci_evidence: CiEvidence; gate_effect: GateEffect } {
  if (policy.policy_state === "none")
    return { ci_evidence: "not_applicable", gate_effect: "non_blocking" };
  if (policy.policy_state !== "required")
    return { ci_evidence: "unavailable", gate_effect: "not_applicable" };
  const outcomes = new Map<string, EvidenceObservation>();
  for (const status of statuses)
    addOutcome(outcomes, status.context, statusOutcome(status.state), status);
  for (const check of checks)
    addOutcome(
      outcomes,
      check.name,
      checkOutcome(check.status, check.conclusion),
      check,
    );
  for (const run of runs)
    addOutcome(
      outcomes,
      run.name,
      checkOutcome(run.status, run.conclusion),
      run,
    );
  let hasMissing = false;
  let hasPending = false;
  let hasFailed = false;
  let hasUnavailable = false;
  for (const context of policy.required_contexts) {
    const values = outcomes.get(context);
    if (!values) {
      if (
        surfaceErrors.some(({ surface }) =>
          ["ci-status", "ci-checks", "ci-runs"].includes(surface),
        )
      )
        hasUnavailable = true;
      else hasMissing = true;
      continue;
    }
    if (values.outcome === "failed") hasFailed = true;
    else if (values.outcome === "pending") hasPending = true;
  }
  if (hasFailed) return { ci_evidence: "failed", gate_effect: "blocking" };
  if (hasUnavailable)
    return { ci_evidence: "unavailable", gate_effect: "blocking" };
  if (hasPending) return { ci_evidence: "pending", gate_effect: "blocking" };
  if (hasMissing) return { ci_evidence: "absent", gate_effect: "blocking" };
  return { ci_evidence: "passed", gate_effect: "non_blocking" };
}

function normalizeSurface<T>(
  surface: SurfaceObservation,
  operation: string,
  normalize: (response: ProviderResponse) => T,
): { facts: T | null; error?: Record<string, unknown> } {
  if (!surface.response)
    return { facts: null, ...(surface.error ? { error: surface.error } : {}) };
  if (surface.error) return { facts: null, error: surface.error };
  try {
    return { facts: normalize(surface.response) };
  } catch (error) {
    if (error instanceof HostingError && error.code === "stale_ci_evidence")
      throw error;
    return { facts: null, error: surfaceError(error, operation) };
  }
}

export function normalizeCiResult(
  branch: string,
  sha: string,
  policy: PolicyObservation,
  status: SurfaceObservation,
  checks: SurfaceObservation,
  runs: SurfaceObservation,
): Record<string, unknown> {
  const normalizedStatus = normalizeSurface(status, "ci-status", (response) =>
    normalizeStatuses(response, sha),
  );
  const normalizedChecks = normalizeSurface(checks, "ci-checks", (response) =>
    normalizeChecks(response, sha),
  );
  const normalizedRuns = normalizeSurface(runs, "ci-runs", (response) =>
    normalizeRuns(response, sha),
  );
  const surfaceErrors = (
    [
      ["ci-status", normalizedStatus.error],
      ["ci-checks", normalizedChecks.error],
      ["ci-runs", normalizedRuns.error],
    ] as Array<[string, Record<string, unknown> | undefined]>
  ).flatMap(([surface, error]) => (error ? [{ surface, error }] : []));
  const observationErrors = [
    ...(policy.policy_error
      ? [{ surface: "ci-policy", error: policy.policy_error }]
      : []),
    ...surfaceErrors,
  ];
  const classification = classifyCiEvidence(
    policy,
    normalizedStatus.facts ?? [],
    normalizedChecks.facts ?? [],
    normalizedRuns.facts ?? [],
    surfaceErrors,
  );
  const observedAt =
    [
      policy.observed_at,
      status.response?.observedAt,
      checks.response?.observedAt,
      runs.response?.observedAt,
    ]
      .filter((value): value is string => typeof value === "string")
      .sort()
      .at(-1) ?? null;
  return {
    sha,
    branch,
    required_contexts: policy.required_contexts,
    policy_state: policy.policy_state,
    checks_expected: policy.checks_expected,
    ci_evidence: classification.ci_evidence,
    gate_effect: classification.gate_effect,
    policy_observation: {
      state: policy.policy_state,
      source: policy.policy_source,
      error: policy.policy_error,
    },
    observation_errors: observationErrors,
    statuses: normalizedStatus.facts ?? [],
    checks: normalizedChecks.facts ?? [],
    runs: normalizedRuns.facts ?? [],
    observed_at: observedAt,
    raw: {
      protection: redactProviderValue(policy.protection),
      status: redactProviderValue(status.response?.payload ?? null),
      checks: redactProviderValue(checks.response?.payload ?? null),
      runs: redactProviderValue(runs.response?.payload ?? null),
    },
  };
}
