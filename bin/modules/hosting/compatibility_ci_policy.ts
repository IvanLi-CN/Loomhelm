import { HostingError } from "./types";
import type { HostingBackend, ProviderResponse } from "./backend";
import { providerRecord } from "./compatibility_helpers";

export type CiPolicyState = "required" | "none" | "unknown" | "unavailable";
export type ChecksExpected = "yes" | "no" | "unknown";
export type CiEvidence =
  "passed" | "failed" | "pending" | "absent" | "unavailable" | "not_applicable";
export type GateEffect = "blocking" | "non_blocking" | "not_applicable";

export interface PolicyObservation {
  policy_state: CiPolicyState;
  checks_expected: ChecksExpected;
  required_contexts: string[];
  protection: unknown;
  policy_source: string;
  policy_error: Record<string, unknown> | null;
  observed_at: string | null;
}

export interface SurfaceObservation {
  response?: ProviderResponse;
  error?: Record<string, unknown>;
}

export const APPLICABLE_CI_EVENTS = new Set([
  "push",
  "pull_request",
  "pull_request_target",
]);

export const NON_APPLICABLE_CI_EVENTS = new Set([
  "deployment",
  "deployment_status",
  "deploy",
  "publish",
  "release",
  "schedule",
  "workflow_dispatch",
]);

export function errorStatus(error: unknown): number | null | undefined {
  if (!(error instanceof HostingError)) return undefined;
  const status = error.details.status;
  return typeof status === "number" || status === null ? status : undefined;
}

export function policyStateForStatus(
  status: number | null,
): "unknown" | "unavailable" {
  return status === null || [401, 403, 429].includes(status) || status >= 500
    ? "unavailable"
    : "unknown";
}

function policyError(
  state: "unknown" | "unavailable",
  error: unknown,
  fallbackOperation: string,
): Record<string, unknown> {
  const sourceCode =
    error instanceof HostingError ? error.code : "unknown_error";
  const operation =
    error instanceof HostingError ? error.operation : fallbackOperation;
  const status = errorStatus(error);
  return {
    code: `ci_policy_${state}`,
    source_code: sourceCode,
    operation,
    ...(status === undefined ? {} : { status }),
  };
}

export function policyObservation(
  state: CiPolicyState,
  requiredContexts: string[],
  protection: unknown,
  source: string,
  observedAt: string | null,
  error: Record<string, unknown> | null = null,
): PolicyObservation {
  const checksExpected: ChecksExpected =
    state === "required" ? "yes" : state === "none" ? "no" : "unknown";
  return {
    policy_state: state,
    checks_expected: checksExpected,
    required_contexts: requiredContexts,
    protection,
    policy_source: source,
    policy_error: error,
    observed_at: observedAt,
  };
}

export function policyFailure(
  state: "unknown" | "unavailable",
  protection: unknown,
  source: string,
  error: unknown,
  operation: string,
  observedAt: string | null = null,
): PolicyObservation {
  return policyObservation(
    state,
    [],
    protection,
    source,
    observedAt,
    policyError(state, error, operation),
  );
}

export function responsePolicyError(
  state: "unknown" | "unavailable",
  operation: string,
  status: number | null,
  sourceCode = "http_status",
): Record<string, unknown> {
  return {
    code: `ci_policy_${state}`,
    source_code: sourceCode,
    operation,
    status,
  };
}

export function surfaceError(
  error: unknown,
  fallbackOperation: string,
  status?: number | null,
): Record<string, unknown> {
  const sourceCode =
    error instanceof HostingError ? error.code : "unknown_error";
  const operation =
    error instanceof HostingError ? error.operation : fallbackOperation;
  const errorObservedStatus = errorStatus(error);
  const observedStatus =
    errorObservedStatus !== undefined ? errorObservedStatus : status;
  return {
    code: "ci_surface_unavailable",
    source_code: sourceCode,
    operation,
    ...(observedStatus === undefined ? {} : { status: observedStatus }),
  };
}

export async function readCiSurface(
  backend: HostingBackend,
  endpoint: string,
  operation: string,
): Promise<SurfaceObservation> {
  try {
    const response = await backend.request(endpoint, {
      include: true,
      check: false,
      operation,
    });
    if (
      response.status === null ||
      response.status < 200 ||
      response.status >= 300
    )
      return {
        response,
        error: surfaceError(
          new HostingError(
            "provider_request_failed",
            `${operation} provider response is not successful`,
            operation,
            { status: response.status },
          ),
          operation,
          response.status,
        ),
      };
    return { response };
  } catch (error) {
    return { error: surfaceError(error, operation) };
  }
}

export function contextsFromPolicy(
  payload: unknown,
  operation: string,
): string[] {
  const record = providerRecord(payload, operation);
  const contexts = record.contexts;
  const checks = record.checks;
  if (
    (contexts !== undefined &&
      (!Array.isArray(contexts) ||
        !contexts.every((item) => typeof item === "string"))) ||
    (checks !== undefined &&
      (!Array.isArray(checks) ||
        !checks.every(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof (item as Record<string, unknown>).context === "string",
        ))) ||
    (contexts === undefined && checks === undefined)
  )
    throw new HostingError(
      "invalid_provider_response",
      "required-check policy has no readable contexts",
      operation,
    );
  const checkContexts = Array.isArray(checks)
    ? checks.map((item) => (item as Record<string, unknown>).context as string)
    : [];
  return Array.from(
    new Set(
      [...(Array.isArray(contexts) ? contexts : []), ...checkContexts]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}
