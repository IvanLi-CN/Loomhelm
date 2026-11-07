import { HostingError } from "./types";
import type { ProviderResponse } from "./backend";
import { providerSha, stringValue } from "./compatibility_helpers";
import { redactProviderValue } from "./redact";
import {
  APPLICABLE_CI_EVENTS,
  NON_APPLICABLE_CI_EVENTS,
} from "./compatibility_ci_policy";

export function normalizeStatuses(
  response: ProviderResponse,
  expectedSha: string,
): Array<Record<string, unknown>> {
  const payload = response.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw new HostingError(
      "invalid_provider_response",
      "commit status response is not an object",
      "ci-status",
    );
  const record = payload as Record<string, unknown>;
  const rawResponseSha = record.sha ?? record.commit_id;
  if (typeof rawResponseSha !== "string" || !rawResponseSha.trim())
    throw new HostingError(
      "invalid_provider_response",
      "commit status response has no SHA",
      "ci-status",
    );
  const responseSha = providerSha(rawResponseSha);
  if (!responseSha)
    throw new HostingError(
      "invalid_provider_response",
      "commit status response has a malformed SHA",
      "ci-status",
    );
  if (responseSha !== expectedSha)
    throw new HostingError(
      "stale_ci_evidence",
      "commit status response is not bound to the requested SHA",
      "ci-status",
    );
  const statuses = record.statuses;
  if (!Array.isArray(statuses))
    throw new HostingError(
      "invalid_provider_response",
      "commit status response has no readable statuses",
      "ci-status",
    );
  return statuses.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new HostingError(
        "invalid_provider_response",
        "status row is not an object",
        "ci-status",
      );
    const status = item as Record<string, unknown>;
    const context = stringValue(status.context ?? status.name);
    const state = stringValue(status.state ?? status.status);
    if (!context || !state)
      throw new HostingError(
        "invalid_provider_response",
        "status row has no context or state",
        "ci-status",
      );
    const rawStatusSha = status.sha ?? status.commit_id ?? status.commit_sha;
    if (rawStatusSha !== undefined && typeof rawStatusSha !== "string")
      throw new HostingError(
        "invalid_provider_response",
        "status row SHA is not a string",
        "ci-status",
      );
    const statusSha = providerSha(rawStatusSha);
    if (rawStatusSha !== undefined && !statusSha)
      throw new HostingError(
        "invalid_provider_response",
        "status row SHA is malformed",
        "ci-status",
      );
    if (statusSha && statusSha !== expectedSha)
      throw new HostingError(
        "stale_ci_evidence",
        "status row is not bound to the requested SHA",
        "ci-status",
      );
    return [
      {
        context,
        state: state.toLowerCase(),
        description: stringValue(status.description),
        url: redactProviderValue(status.target_url ?? status.url),
        updated_at: status.updated_at ?? status.created_at,
        created_at: status.created_at,
        id: status.id,
        sha: expectedSha,
        observed_at: response.observedAt,
      },
    ];
  });
}

export function normalizeChecks(
  response: ProviderResponse,
  expectedSha: string,
): Array<Record<string, unknown>> {
  const payload = response.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw new HostingError(
      "invalid_provider_response",
      "check-run response is not an object",
      "ci-checks",
    );
  const checks = (payload as Record<string, unknown>).check_runs;
  if (!Array.isArray(checks))
    throw new HostingError(
      "invalid_provider_response",
      "check-run response has no readable check_runs",
      "ci-checks",
    );
  return checks.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new HostingError(
        "invalid_provider_response",
        "check row is not an object",
        "ci-checks",
      );
    const check = item as Record<string, unknown>;
    const rawCheckSha = check.head_sha ?? check.sha;
    if (typeof rawCheckSha !== "string" || !rawCheckSha.trim())
      throw new HostingError(
        "invalid_provider_response",
        "check run has no SHA",
        "ci-checks",
      );
    const checkSha = providerSha(rawCheckSha);
    if (!checkSha)
      throw new HostingError(
        "invalid_provider_response",
        "check run has a malformed SHA",
        "ci-checks",
      );
    if (checkSha !== expectedSha)
      throw new HostingError(
        "stale_ci_evidence",
        "check run is not bound to the requested SHA",
        "ci-checks",
      );
    if (
      typeof check.name !== "string" ||
      !check.name ||
      typeof check.status !== "string" ||
      !check.status
    )
      throw new HostingError(
        "invalid_provider_response",
        "check row has no name or status",
        "ci-checks",
      );
    return [
      {
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        url: redactProviderValue(
          check.html_url ?? check.details_url ?? check.url,
        ),
        sha: expectedSha,
        id: check.id,
        run_attempt: check.run_attempt,
        started_at: check.started_at,
        completed_at: check.completed_at,
        updated_at: check.updated_at,
        observed_at: response.observedAt,
      },
    ];
  });
}

export function normalizeRuns(
  response: ProviderResponse,
  expectedSha: string,
): Array<Record<string, unknown>> {
  let runs: unknown;
  if (Array.isArray(response.payload)) runs = response.payload;
  else if (response.payload !== null && typeof response.payload === "object") {
    const payload = response.payload as Record<string, unknown>;
    runs = payload.workflow_runs ?? payload.tasks ?? payload.workflow_tasks;
  } else {
    throw new HostingError(
      "invalid_provider_response",
      "workflow run response is not an object or array",
      "ci-runs",
    );
  }
  if (!Array.isArray(runs))
    throw new HostingError(
      "invalid_provider_response",
      "workflow run response has no readable run list",
      "ci-runs",
    );
  return runs.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new HostingError(
        "invalid_provider_response",
        "workflow run row is not an object",
        "ci-runs",
      );
    const run = item as Record<string, unknown>;
    const rawRunSha = run.head_sha ?? run.sha;
    if (typeof rawRunSha !== "string" || !rawRunSha.trim())
      throw new HostingError(
        "invalid_provider_response",
        "workflow run has no SHA",
        "ci-runs",
      );
    const runSha = providerSha(rawRunSha);
    if (!runSha)
      throw new HostingError(
        "invalid_provider_response",
        "workflow run has a malformed SHA",
        "ci-runs",
      );
    if (runSha !== expectedSha) return [];
    const event = stringValue(run.event).toLowerCase();
    if (!APPLICABLE_CI_EVENTS.has(event) || NON_APPLICABLE_CI_EVENTS.has(event))
      return [];
    const name =
      run.name ?? run.display_title ?? run.workflow_name ?? run.workflow_id;
    if (
      typeof name !== "string" ||
      !name ||
      typeof run.status !== "string" ||
      !run.status
    )
      throw new HostingError(
        "invalid_provider_response",
        "workflow run row has no name or status",
        "ci-runs",
      );
    return [
      {
        id: run.id,
        name,
        status: run.status,
        conclusion: run.conclusion,
        url: redactProviderValue(run.html_url ?? run.url),
        head_sha: expectedSha,
        run_attempt: run.run_attempt ?? run.attempt,
        started_at: run.started_at,
        completed_at: run.completed_at ?? run.updated_at,
        updated_at: run.updated_at,
        created_at: run.created_at,
        event: run.event,
        observed_at: response.observedAt,
      },
    ];
  });
}
